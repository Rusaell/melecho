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

from melecho.config import (
    _write_manifest,
    list_profiles,
    profile_dir,
    read_manifest,
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
