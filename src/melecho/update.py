"""Проверка обновлений Melecho.

Работает в фоне из runtime (раз в сутки по кэшу). Автоматическое
обновление — только для git-клона (есть .git/ в CWD). Для pipx/PyPI/
Flatpak/AppImage/Docker показываем команду обновления: каждый канал
обновляется своим инструментом.

opt-out: config.updates_check_on_start (дефолт true). Проверка — HTTPS
GET к GitHub Releases API, timeout 2 сек, кэш 24 часа.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

log = logging.getLogger("melecho")


# ---------- Пути ----------

def _xdg_cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    d = Path(base) / "melecho"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return d


def cache_check_path() -> Path:
    """Файл-маркер времени последней HTTP-проверки (mtime)."""
    return _xdg_cache_dir() / "last_update_check"


def cache_result_path() -> Path:
    """JSON с последним известным статусом: есть ли обновление."""
    return _xdg_cache_dir() / "update_available.json"


# ---------- Версии ----------

def parse_version(s: str) -> tuple[int, ...] | None:
    """Парсит '1.0.0' или 'v1.0.0' → (1, 0, 0). None при неудаче.

    Своя реализация — не тянем `packaging` в зависимости ради 5 строк.
    Суффиксы типа -beta/+build отрезаются.
    """
    if not s:
        return None
    t = s.strip().lstrip("vV")
    t = t.split("-", 1)[0].split("+", 1)[0]
    parts = t.split(".")
    out: list[int] = []
    for p in parts:
        if not p.isdigit():
            return None
        out.append(int(p))
    return tuple(out) if out else None


def is_newer(remote: str, current: str) -> bool:
    r = parse_version(remote)
    c = parse_version(current)
    if r is None or c is None:
        return False
    n = max(len(r), len(c))
    return r + (0,) * (n - len(r)) > c + (0,) * (n - len(c))


# ---------- Кэш ----------

def should_check(interval_hours: int) -> bool:
    """True — прошло больше interval_hours с последней HTTP-проверки."""
    p = cache_check_path()
    if not p.exists():
        return True
    try:
        age = time.time() - p.stat().st_mtime
        return age > max(1, interval_hours) * 3600
    except OSError:
        return True


def touch_cache() -> None:
    try:
        p = cache_check_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
    except OSError:
        log.debug("update: не удалось обновить кэш")


def read_cached_result() -> dict | None:
    p = cache_result_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_cached_result(data: dict) -> None:
    try:
        p = cache_result_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        log.debug("update: не удалось записать результат")


# ---------- HTTP ----------

def fetch_latest_version(repo: str, timeout_sec: float = 2.0) -> str | None:
    """GET GitHub Releases API. Возвращает tag_name или None.
    Любые ошибки → None, не бросает."""
    try:
        import httpx
    except ImportError:
        return None
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            r = client.get(url, headers={"Accept": "application/vnd.github+json"})
            if r.status_code != 200:
                log.debug("update: github API %s → HTTP %s", repo, r.status_code)
                return None
            data = r.json()
            tag = data.get("tag_name")
            return tag if isinstance(tag, str) and tag else None
    except Exception as e:
        log.debug("update: fetch failed: %s", e)
        return None


# ---------- Install kind ----------

def detect_install_kind() -> str:
    """Определяет способ установки.

    git      — .git/ в CWD (полное автообновление: git pull + pip install -e .)
    dev      — локальная копия репо без .git/ (pyproject.toml + src/melecho).
               Обновление вручную: скачать свежую версию.
    pipx     — sys.prefix содержит .../pipx/venvs/...
    flatpak  — Flatpak sandbox
    appimage — AppImage
    docker   — контейнер
    pip      — обычный pip (venv или система, установлен из PyPI)
    """
    if os.environ.get("APPIMAGE"):
        return "appimage"
    if os.environ.get("FLATPAK_ID"):
        return "flatpak"
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        return "docker"
    if "pipx/venvs/" in sys.prefix.replace("\\", "/"):
        return "pipx"
    if Path(".git").is_dir():
        return "git"
    # Локальная копия репозитория без .git/ (git clone отсутствует).
    # Признак: pyproject.toml и src/melecho в CWD. Пользователь
    # запускает ./run.sh — venv с editable-установкой.
    if Path("pyproject.toml").is_file() and Path("src/melecho").is_dir():
        return "dev"
    return "pip"


def install_hint(kind: str) -> str | None:
    """Текст-подсказка для не-git каналов. None — автообновление доступно."""
    return {
        "pipx": "pipx upgrade melecho",
        "pip": "pip install --upgrade melecho",
        "dev": "git pull && .venv/bin/pip install -e . --upgrade (если есть .git)",
        "flatpak": "flatpak update (см. ваш app-id)",
        "appimage": "Скачайте новую версию AppImage с github.com/Rusaell/melecho/releases",
        "docker": "docker pull <image> и пересоздайте контейнер",
    }.get(kind)


# ---------- git / pip ----------

def git_status_dirty() -> tuple[bool, list[str]]:
    """True + список файлов, если есть незакоммиченные изменения.
    Используется для предупреждения «есть локальные правки» перед pull."""
    if not shutil.which("git"):
        return False, []
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if r.returncode != 0:
            return False, []
        lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
        return bool(lines), lines[:20]
    except (subprocess.SubprocessError, OSError):
        return False, []


def git_pull() -> tuple[int, str, str]:
    """git pull. Возвращает (exit_code, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["git", "pull"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        return r.returncode, r.stdout or "", r.stderr or ""
    except (subprocess.SubprocessError, OSError) as e:
        return 1, "", str(e)


def pip_install_editable_upgrade() -> tuple[int, str, str]:
    """pip install -e . --upgrade. Возвращает (exit_code, stdout, stderr)."""
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-e", ".", "--upgrade"],
            capture_output=True, text=True, timeout=300, check=False,
        )
        return r.returncode, r.stdout or "", r.stderr or ""
    except (subprocess.SubprocessError, OSError) as e:
        return 1, "", str(e)
