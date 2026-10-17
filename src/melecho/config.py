from __future__ import annotations

import json
import logging
import os
import tomllib
from dataclasses import dataclass, field
from importlib.resources import files as _pkg_files
from pathlib import Path


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(p)).resolve()


def _user_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "melecho" / "config.toml"


def user_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base) / "melecho"


def resolve_runtime_dir() -> Path:
    """$XDG_RUNTIME_DIR/melecho/ с fallback в /tmp (mode 0700).

    Используется для lock-файлов, pid, bootstrap.url, port.
    Не путать с XDG_DATA_HOME — здесь временные файлы сессии.
    """
    base = os.environ.get("XDG_RUNTIME_DIR")
    if base:
        d = Path(base) / "melecho"
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        return d
    fallback = Path(f"/tmp/melecho-{os.getuid()}")
    fallback.mkdir(parents=True, exist_ok=True, mode=0o700)
    return fallback


log = logging.getLogger("melecho")


# ---------------------------------------------------------------------------
# Профили данных.
#
# Один профиль = изолированный набор данных: своя БД, свой ключ аудита,
# свой catalog.d/, свой manifest.json. DEK, LLM-профили и sudo-disk-пароль
# живут в БД и, значит, тоже свои.
#
# Структура:
#   ~/.local/share/melecho/profiles/<slug>/
#     app.db
#     audit.key
#     catalog.d/
#     manifest.json
#
# Активный профиль — в ~/.config/melecho/active_profile (одна строка — slug).
#
# Общий для всех профилей:
#   ~/.local/share/melecho/melecho.log — журнал процесса, не профиля;
#   $XDG_RUNTIME_DIR/melecho/*          — lock, pid, port, bootstrap.url.
# ---------------------------------------------------------------------------

_PROFILE_MANIFEST = "manifest.json"
_PROFILE_SCHEMA_VERSION = 1


def profiles_dir() -> Path:
    return user_data_dir() / "profiles"


def profile_dir(slug: str) -> Path:
    return profiles_dir() / slug


def active_profile_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "melecho" / "active_profile"


def read_active_profile() -> str | None:
    p = active_profile_path()
    if not p.exists():
        return None
    try:
        s = p.read_text(encoding="utf-8").strip()
        return s or None
    except OSError:
        return None


def write_active_profile(slug: str) -> None:
    p = active_profile_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(slug, encoding="utf-8")
    os.replace(tmp, p)


def _manifest_path(slug: str) -> Path:
    return profile_dir(slug) / _PROFILE_MANIFEST


def read_manifest(slug: str) -> dict | None:
    p = _manifest_path(slug)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_manifest(slug: str, name: str) -> None:
    from datetime import datetime, timezone
    p = _manifest_path(slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "slug": slug,
        "name": name,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "schema_version": _PROFILE_SCHEMA_VERSION,
    }
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, p)


def list_profiles() -> list[dict]:
    """Список профилей для UI стартового экрана. Сортировка — по slug
    (алфавитная): стабильный порядок между запросами."""
    d = profiles_dir()
    if not d.exists():
        return []
    out: list[dict] = []
    for entry in sorted(d.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        slug = entry.name
        m = read_manifest(slug) or {}
        out.append({
            "slug": slug,
            "name": m.get("name") or slug,
            "created_at": m.get("created_at"),
            "has_db": (entry / "app.db").exists(),
        })
    return out


def _safe_move(src: Path, dst: Path) -> None:
    """Переместить src → dst, если src существует и dst — нет.
    Молча выходим в спорных случаях (гонка, повторный вызов).
    Идемпотентно."""
    if not src.exists():
        return
    if dst.exists():
        return
    try:
        os.replace(str(src), str(dst))
    except FileNotFoundError:
        # Проиграли гонку за src — не ошибка.
        pass


def ensure_profiles_layout() -> None:
    """Идемпотентно. Гарантирует:

      1. profiles/ существует.
      2. Есть хотя бы один профиль (при отсутствии создаётся default).
      3. active_profile указывает на существующий профиль.

    Однократно мигрирует старую плоскую установку (app.db / audit.key /
    catalog.d/ прямо в data_root) в profiles/default/. После миграции
    плоские файлы в data_root отсутствуют.
    """
    dr = user_data_dir()
    pd = profiles_dir()
    dr.mkdir(parents=True, exist_ok=True)
    pd.mkdir(parents=True, exist_ok=True)

    existing = sorted(
        p.name for p in pd.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    )

    if not existing:
        # Профилей нет. Либо чистая установка, либо миграция со старой
        # плоской структуры (файлы прямо в data_root).
        had_legacy = (dr / "app.db").exists() or (dr / "audit.key").exists()
        default_dir = profile_dir("default")
        default_dir.mkdir(parents=True, exist_ok=True)
        _safe_move(dr / "app.db", default_dir / "app.db")
        _safe_move(dr / "audit.key", default_dir / "audit.key")
        _safe_move(dr / "catalog.d", default_dir / "catalog.d")
        if not _manifest_path("default").exists():
            _write_manifest("default", "default")
        write_active_profile("default")
        if had_legacy:
            log.info(
                "профили: старая установка мигрирована в profiles/default/"
            )
        return

    # Профили есть. Проверяем active_profile.
    slug = read_active_profile()
    if not slug or slug not in existing:
        write_active_profile(existing[0])



@dataclass
class AppConfig:
    db_path: Path
    audit_key_path: Path
    http_port: int = 8765
    port_fallback: str = "ephemeral"
    bind: str = "127.0.0.1"
    # Legacy-поля: раньше управляли mock-SSH (demo) и preview-режимом.
    # После удаления mock-SSH не используются, но сохранены для
    # обратной совместимости со старыми вызовами (conftest, тесты).
    demo: bool = False
    preview: bool = False
    log_level: str = "INFO"
    env_path: str = "/usr/bin/env"
    resolver_path: str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    no_audit: bool = False
    no_browser: bool = False
    dev_refresh_bootstrap: bool = False
    kdf_params_version: int = 1
    max_servers: int = 20
    max_parallel_ssh: int = 10
    max_parallel_ops: int = 3
    connect_timeout_sec: int = 15
    idle_timeout_sec: int = 60
    op_timeout_sec: int = 300
    step_timeout_sec: int = 60
    step_output_bytes: int = 1048576
    max_steps: int = 20
    sudo_ttl_sec: int = 900
    unlock_max_attempts: int = 5
    unlock_lock_minutes: int = 15
    metrics_interval_sec: int = 30
    downsample_sec: int = 300
    raw_retention_days: int = 7
    agg_retention_days: int = 30
    retention_interval_sec: int = 3600
    ewma_alpha: float = 0.3
    min_warmup_residuals: int = 30
    z_window: int = 60
    z_threshold: float = 3.0
    abs_cpu: float = 90
    abs_ram: float = 90
    abs_disk: float = 90
    abs_load_1m_per_cpu: float = 1.5
    llm_provider: str = "deepseek"
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"
    llm_master_enabled: bool = False
    llm_timeout_sec: int = 30
    llm_cache_ttl_days: int = 30
    # Сеть: различение «нет интернета» / «сервер недоступен».
    # Проверка — TCP-handshake к internet_check_host:port. ICMP не
    # используем (часто блокируется провайдером), UDP не даёт handshake.
    # 1.1.1.1:53 (Cloudflare DNS) — anycast, быстро и стабильно.
    internet_check_host: str = "1.1.1.1"
    internet_check_port: int = 53
    internet_check_timeout_sec: int = 2
    # Backoff активного polling при offline: 5 → 10 → 20 → 30 сек.
    internet_check_poll_sec_min: int = 5
    internet_check_poll_sec_max: int = 30
    # Кэш результата: при массовых провалах SSH (20 серверов разом)
    # не долбим 1.1.1.1 каждым сервером.
    internet_check_cache_sec: int = 60
    # Проверка обновлений для git-клона. opt-in: по умолчанию выключена.
    # Работает только если в корне проекта есть .git/ (dev-сценарий).
    # pipx-установка — не проверяем, только подсказка в --status.
    updates_check_on_start: bool = True
    updates_check_interval_hours: int = 24
    # URL для проверки обновлений (GitHub Releases API).
    updates_github_repo: str = "Rusaell/melecho"
    disk_roles: dict[str, str] = field(default_factory=dict)
    catalog_dir: Path = Path("catalog")
    catalog_user_dir: Path | None = None
    static_dir: Path = Path("static")
    catalog_allowed_commands: frozenset[str] = frozenset()
    # Профиль данных, к которому привязана эта конфигурация.
    # profile_slug — имя каталога в profiles/ (ключ, не меняется через UI).
    # profile_name — человекочитаемое имя из manifest.json (правится в UI).
    # data_dir — <profiles>/<slug>/, куда по умолчанию смотрят db_path,
    #            audit_key_path и catalog_user_dir.
    profile_slug: str = "default"
    profile_name: str = "default"
    data_dir: Path | None = None


def _read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _read_builtin_default() -> dict:
    try:
        ref = _pkg_files("melecho") / "resources" / "default_config.toml"
        return tomllib.loads(ref.read_text(encoding="utf-8"))
    except (FileNotFoundError, ModuleNotFoundError):
        return {}


def _load_raw_config(path: Path | None) -> dict:
    """Приоритет: явный path → $MELECHO_CONFIG → XDG-конфиг → встроенный.

    Пользовательский конфиг может быть частичным — недостающие ключи
    берутся из встроенного (top-level и по секциям).
    """
    builtin = _read_builtin_default()

    user_data: dict = {}
    if path is not None:
        user_data = _read_toml(path)
    else:
        env_path = os.environ.get("MELECHO_CONFIG")
        if env_path:
            user_data = _read_toml(_expand(env_path))
        else:
            xdg = _user_config_path()
            if xdg.exists():
                user_data = _read_toml(xdg)

    merged = dict(builtin)
    merged.update(user_data)
    for sec in ("crypto", "limits", "sudo", "unlock", "metrics",
                "detector", "llm", "catalog", "tabs", "disk_roles",
                "network", "updates"):
        if sec in builtin or sec in user_data:
            sec_merged = dict(builtin.get(sec) or {})
            sec_merged.update(user_data.get(sec) or {})
            merged[sec] = sec_merged
    return merged


def load_config(
    path: Path | None = None,
    root: Path | None = None,
    profile_slug: str | None = None,
) -> AppConfig:
    """Загрузить конфиг.

    path — явный --config (или путь из MELECHO_CONFIG).
    root — DEPRECATED. Раньше обозначал корень репо; сейчас
    игнорируется (все ресурсы через importlib.resources). Принимается
    для обратной совместимости со старыми вызовами в scripts/.
    profile_slug — slug профиля; если None — берётся из active_profile
    (или "default" при его отсутствии). Внутри гарантирует, что
    profiles/<slug>/ существует (см. ensure_profiles_layout).
    """
    del root  # legacy
    ensure_profiles_layout()
    if profile_slug is None:
        profile_slug = read_active_profile() or "default"
    pdir = profile_dir(profile_slug)
    pdir.mkdir(parents=True, exist_ok=True)
    _manifest = read_manifest(profile_slug) or {}
    profile_name = str(_manifest.get("name") or profile_slug)

    data = _load_raw_config(path)

    pkg = _pkg_files("melecho")
    catalog_dir = Path(str(pkg / "catalog"))
    static_dir = Path(str(pkg / "static"))

    # data_dir — профильная папка. db_path, audit_key_path и
    # catalog_user_dir по умолчанию смотрят внутрь неё.
    data_dir = pdir

    raw_db = data.get("db_path")
    db_path = _expand(str(raw_db)) if raw_db else (data_dir / "app.db")

    raw_audit = data.get("audit_key_path")
    audit_key_path = _expand(str(raw_audit)) if raw_audit else (data_dir / "audit.key")

    crypto = data.get("crypto") or {}
    limits = data.get("limits") or {}
    sudo = data.get("sudo") or {}
    unlock = data.get("unlock") or {}
    metrics = data.get("metrics") or {}
    det = data.get("detector") or {}
    llm = data.get("llm") or {}
    net = data.get("network") or {}
    upd = data.get("updates") or {}
    disk_roles = {str(k): str(v) for k, v in (data.get("disk_roles") or {}).items()}
    catalog_cfg = data.get("catalog") or {}
    catalog_allowed = frozenset(
        str(x) for x in (catalog_cfg.get("allowed_commands") or [])
        if isinstance(x, str) and x.strip()
    )

    _user_dir_raw = catalog_cfg.get("user_dir")
    if _user_dir_raw:
        catalog_user_dir = _expand(str(_user_dir_raw))
    else:
        catalog_user_dir = data_dir / "catalog.d"

    return AppConfig(
        db_path=db_path,
        audit_key_path=audit_key_path,
        http_port=int(data.get("http_port", 8765)),
        port_fallback=str(data.get("port_fallback", "ephemeral")),
        bind=str(data.get("bind", "127.0.0.1")),
        log_level=str(data.get("log_level", "INFO")),
        env_path=str(data.get("env_path", "/usr/bin/env")),
        resolver_path=str(data.get("resolver_path", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")),
        kdf_params_version=int(crypto.get("kdf_params_version", 1)),
        max_servers=int(limits.get("max_servers", 20)),
        max_parallel_ssh=int(limits.get("max_parallel_ssh", 10)),
        max_parallel_ops=int(limits.get("max_parallel_ops", 3)),
        connect_timeout_sec=int(limits.get("connect_timeout_sec", 15)),
        idle_timeout_sec=int(limits.get("idle_timeout_sec", 60)),
        op_timeout_sec=int(limits.get("op_timeout_sec", 300)),
        step_timeout_sec=int(limits.get("step_timeout_sec", 60)),
        step_output_bytes=int(limits.get("step_output_bytes", 1048576)),
        max_steps=int(limits.get("max_steps", 20)),
        sudo_ttl_sec=int(sudo.get("ttl_sec", 900)),
        unlock_max_attempts=int(unlock.get("max_attempts", 5)),
        unlock_lock_minutes=int(unlock.get("lock_minutes", 15)),
        metrics_interval_sec=int(metrics.get("interval_sec", 30)),
        downsample_sec=int(metrics.get("downsample_sec", 300)),
        raw_retention_days=int(metrics.get("raw_retention_days", 7)),
        agg_retention_days=int(metrics.get("agg_retention_days", 30)),
        retention_interval_sec=int(metrics.get("retention_interval_sec", 3600)),
        ewma_alpha=float(det.get("ewma_alpha", 0.3)),
        min_warmup_residuals=int(det.get("min_warmup_residuals", 30)),
        z_window=int(det.get("z_window", 60)),
        z_threshold=float(det.get("z_threshold", 3.0)),
        abs_cpu=float(det.get("abs_cpu", 90)),
        abs_ram=float(det.get("abs_ram", 90)),
        abs_disk=float(det.get("abs_disk", 90)),
        abs_load_1m_per_cpu=float(det.get("abs_load_1m_per_cpu", 1.5)),
        llm_provider=str(llm.get("provider", "deepseek")),
        llm_base_url=str(llm.get("base_url", "https://api.deepseek.com")),
        llm_model=str(llm.get("model", "deepseek-chat")),
        llm_master_enabled=bool(llm.get("master_enabled", False)),
        llm_timeout_sec=int(llm.get("timeout_sec", 30)),
        llm_cache_ttl_days=int(llm.get("cache_ttl_days", 30)),
        internet_check_host=str(net.get("internet_check_host", "1.1.1.1")),
        internet_check_port=int(net.get("internet_check_port", 53)),
        internet_check_timeout_sec=int(net.get("internet_check_timeout_sec", 2)),
        internet_check_poll_sec_min=int(net.get("internet_check_poll_sec_min", 5)),
        internet_check_poll_sec_max=int(net.get("internet_check_poll_sec_max", 30)),
        internet_check_cache_sec=int(net.get("internet_check_cache_sec", 60)),
        updates_check_on_start=bool(upd.get("check_on_start", False)),
        updates_check_interval_hours=int(upd.get("check_interval_hours", 24)),
        updates_github_repo=str(upd.get("github_repo", "Rusaell/melecho")),
        disk_roles=disk_roles or {"/": "system", "/var": "system", "/home": "data", "/srv": "data"},
        catalog_allowed_commands=catalog_allowed,
        catalog_dir=catalog_dir,
        catalog_user_dir=catalog_user_dir,
        static_dir=static_dir,
        profile_slug=profile_slug,
        profile_name=profile_name,
        data_dir=pdir,
    )
