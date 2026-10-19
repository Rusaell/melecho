"""Управление профилями данных Melecho.

Один профиль — изолированный набор данных: БД, ключ аудита, catalog.d/,
manifest.json. Этот модуль работает только с файловой системой и
manifest.json. Загрузка конфига для конкретного профиля — в
config.load_config(profile_slug=...). Переключение «на лету» — в Runtime
(этап 2.2).

Контракты:
  slug — [a-z0-9_-]+, 1..32 символа, ключ каталога в profiles/.
         Генерируется автоматически, не меняется через UI.
  name — человекочитаемое имя, 1..64 символа, правится через UI,
         хранится в manifest.json. Дубликаты name между профилями
         допускаются (slug всё равно уникален).
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from melecho.config import (
    _write_manifest,
    list_profiles,
    profile_dir,
    read_manifest,
)
from melecho.crypto import (
    AAD_PROFILE_EXPORT,
    generate_salt,
    kdf_kek,
    wrap_dek,
)


# Транслит. Простая таблица: строчные русские → латиница.
# Всё, чего нет в таблице, уходит в «-» (пробелы, пунктуация) или
# отбрасывается (не-ASCII нацменьшинства — украинские і/ї/є и т. п.).
_TRANSLIT: dict[str, str] = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}

_SLUG_MAX = 32
_NAME_MAX = 64


def _slug_base(name: str) -> str:
    """Базовая часть слага из имени. Без учёта коллизий."""
    out: list[str] = []
    for ch in name.lower():
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isascii() and ch.isalnum():
            out.append(ch)
        elif ch in "_-":
            out.append(ch)
        elif ch.isspace() or ch in ".,!?;:()[]{}«»\"'*&^%$#@+=|\\/<>~`":
            out.append("-")
        elif not ch.isascii():
            # Не-ASCII, не в таблице транслита: украинские і/ї/є, польские,
            # иероглифы и т. п. Пропускаем, чтобы не плодить «-».
            continue
        else:
            out.append("-")
    s = "".join(out)
    # Сжимаем -- до -, обрезаем до _SLUG_MAX по границе.
    while "--" in s:
        s = s.replace("--", "-")
    s = s.strip("-_")
    if len(s) > _SLUG_MAX:
        s = s[:_SLUG_MAX].rstrip("-_")
    return s or "profile"


def slugify(name: str, existing: set[str]) -> str:
    """Уникальный slug для имени. При коллизии — суффикс -2, -3, ...
    Соглашение: суффикс не сокращает базовое имя без нужды; если
    база длинная, обрезаем под суффикс."""
    base = _slug_base(name)
    if base not in existing:
        return base
    for i in range(2, 10000):
        suffix = f"-{i}"
        room = _SLUG_MAX - len(suffix)
        stem = base[:room].rstrip("-_") if len(base) > room else base
        cand = stem + suffix
        if cand not in existing:
            return cand
    raise ValueError("не удалось подобрать уникальный slug")


def _validate_name(name: str) -> str:
    if not isinstance(name, str):
        raise ValueError("name: строка")
    s = name.strip()
    if not s:
        raise ValueError("name: непустая строка")
    if len(s) > _NAME_MAX:
        raise ValueError(f"name: максимум {_NAME_MAX} символов")
    if any(ord(c) < 32 or ord(c) == 127 for c in s):
        raise ValueError("name: управляющие символы запрещены")
    return s


def create_profile(name: str) -> dict:
    """Создать новый профиль: папка + manifest.json. Пустая БД появится
    при первом load_config с этим slug.

    Возвращает {slug, name}. Ошибки валидации — ValueError."""
    clean = _validate_name(name)
    existing = {p["slug"] for p in list_profiles()}
    slug = slugify(clean, existing)
    d = profile_dir(slug)
    if d.exists():
        # На случай гонки: slugify уже проверил, но между его вызовом и
        # mkdir мог кто-то успеть создать. exist_ok=False явно защищает.
        raise ValueError(f"профиль {slug!r} уже существует")
    d.mkdir(parents=True, exist_ok=False)
    _write_manifest(slug, clean)
    return {"slug": slug, "name": clean}


def rename_profile(slug: str, name: str) -> dict:
    """Переименовать профиль: перезапись manifest.json.
    Slug не меняется — это ключ каталога и active_profile."""
    clean = _validate_name(name)
    d = profile_dir(slug)
    if not d.is_dir():
        raise ValueError(f"профиль {slug!r} не найден")
    _write_manifest(slug, clean)
    return {"slug": slug, "name": clean}


def profile_name(slug: str) -> str:
    """Имя для UI: из manifest.json, fallback — slug."""
    m = read_manifest(slug) or {}
    return str(m.get("name") or slug)


# ---------------------------------------------------------------------------
# Экспорт / Импорт профиля
# ---------------------------------------------------------------------------

EXPORT_MAGIC = b"MELECHO1"
MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB


def export_profile_bytes(
    src_dir: Path,
    dek: bytes,
    password: str,
) -> bytes:
    """Создаёт зашифрованный архив профиля.
    
    Формат: MELECHO1 + salt(16) + nonce(12) + ciphertext.
    Внутри tar.gz: app.db (VACUUM INTO), audit.key, manifest.json, dek.bin, catalog.d/.
    """
    if len(password) < 12:
        raise ValueError("пароль архива не короче 12 символов")

    with tempfile.TemporaryDirectory(prefix="melecho-export-") as tmp:
        tmp_dir = Path(tmp)
        
        # 1. VACUUM INTO для консистентной БД
        src_db = src_dir / "app.db"
        dst_db = tmp_dir / "app.db"
        if not src_db.exists():
            raise ValueError("в профиле нет app.db")
            
        conn = sqlite3.connect(str(src_db))
        try:
            # VACUUM INTO копирует схему и данные без WAL-файлов
            conn.execute(f"VACUUM INTO '{dst_db}'")
        finally:
            conn.close()

        # 2. Готовим dek.bin
        dek_file = tmp_dir / "dek.bin"
        dek_file.write_bytes(dek)

        # 3. Собираем tar.gz
        tar_buf = io.BytesIO()
        with tarfile.open(fileobj=tar_buf, mode="w:gz") as tar:
            tar.add(dst_db, arcname="app.db")
            
            # audit.key (обязателен)
            ak = src_dir / "audit.key"
            if ak.exists():
                tar.add(ak, arcname="audit.key")
                
            # manifest.json
            mf = src_dir / "manifest.json"
            if mf.exists():
                tar.add(mf, arcname="manifest.json")
                
            tar.add(dek_file, arcname="dek.bin")
            
            # catalog.d
            cat = src_dir / "catalog.d"
            if cat.exists() and any(cat.iterdir()):
                tar.add(cat, arcname="catalog.d")
        
        tar_bytes = tar_buf.getvalue()

    # 4. Шифрование
    salt = generate_salt()
    kek = kdf_kek(password, salt)
    nonce = os.urandom(12)
    aes = AESGCM(kek)
    ct = aes.encrypt(nonce, tar_bytes, AAD_PROFILE_EXPORT)
    
    return EXPORT_MAGIC + salt + nonce + ct


def import_profile_bytes(
    data: bytes,
    password: str,
    existing_slugs: set[str],
    profile_name: str | None = None,
) -> dict:
    """Расшифровывает архив и создаёт новый профиль.
    
    Возвращает {slug, name}.
    При любой ошибке (неверный пароль, битый архив) — бросает ValueError,
    и не оставляет «полусозданных» файлов на диске.
    """
    if len(data) < len(EXPORT_MAGIC) + 16 + 12 + 16:
        raise ValueError("файл слишком мал для архива Melecho")
    
    if data[:len(EXPORT_MAGIC)] != EXPORT_MAGIC:
        raise ValueError("не является файлом профиля Melecho (неверный заголовок)")
        
    payload = data[len(EXPORT_MAGIC):]
    salt = payload[:16]
    nonce = payload[16:28]
    ct = payload[28:]
    
    try:
        kek = kdf_kek(password, salt)
        aes = AESGCM(kek)
        tar_bytes = aes.decrypt(nonce, ct, AAD_PROFILE_EXPORT)
    except Exception as e:
        # InvalidTag — неверный пароль или повреждённый файл
        raise ValueError("неверный пароль или повреждённый файл архива") from e

    with tempfile.TemporaryDirectory(prefix="melecho-import-") as tmp:
        tmp_dir = Path(tmp)
        
        # 1. Распаковка tar
        try:
            with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tar:
                # Защита от Path Traversal (CVE-2007-4559)
                for member in tar.getmembers():
                    if member.name.startswith("/") or ".." in member.name:
                        raise ValueError("недопустимый путь внутри архива")
                tar.extractall(tmp_dir)
        except tarfile.TarError as e:
            raise ValueError(f"архив повреждён: {e}") from e

        # 2. Проверка обязательных файлов
        req = ["app.db", "audit.key", "dek.bin", "manifest.json"]
        for r in req:
            if not (tmp_dir / r).exists():
                raise ValueError(f"в архиве отсутствует {r}")

        # 3. Парсим manifest.json
        try:
            manifest = json.loads((tmp_dir / "manifest.json").read_text(encoding="utf-8"))
        except Exception as e:
            raise ValueError("manifest.json повреждён") from e
            
        orig_name = manifest.get("name") or "Профиль"
        target_name = (profile_name or "").strip() or orig_name
        
        # 4. Определяем slug
        from melecho.profiles import slugify
        slug = slugify(target_name, existing_slugs)
        dst_dir = profile_dir(slug)
        
        if dst_dir.exists():
            raise ValueError(f"профиль {slug!r} уже существует")

        # 5. Перемещаем во временную папку назначения
        # (не переносим напрямую в profiles/slug, чтобы не засорять при ошибке)
        try:
            shutil.copytree(tmp_dir, dst_dir)
        except Exception as e:
            raise ValueError(f"ошибка копирования файлов: {e}") from e

        try:
            # 6. Обновляем БД (креды DEK под новый мастер-пароль)
            new_salt = generate_salt()
            new_kek = kdf_kek(password, new_salt)
            dek = (dst_dir / "dek.bin").read_bytes()
            new_blob = wrap_dek(new_kek, dek)
            
            db_path = dst_dir / "app.db"
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('kdf_salt', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (new_salt.hex(),),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('encrypted_dek', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (new_blob,),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('kdf_params_version', '1') "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('crypto_format_version', '1') "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                )
                conn.commit()
            finally:
                conn.close()
                
            # 7. Записываем manifest с новым slug/name
            _write_manifest(slug, target_name)
            
            # 8. Удаляем dek.bin (он больше не нужен на диске)
            (dst_dir / "dek.bin").unlink()
            
        except Exception as e:
            # Откат, если что-то пошло не так с БД
            shutil.rmtree(dst_dir, ignore_errors=True)
            raise ValueError(f"ошибка инициализации БД: {e}") from e

    return {"slug": slug, "name": target_name}
