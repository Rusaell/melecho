"""Runtime-файлы Melecho: lock, pid, port, bootstrap.url, status.json.

Директория — resolve_runtime_dir() из config.py ($XDG_RUNTIME_DIR/melecho/
или /tmp/melecho-$UID/ при отсутствии XDG_RUNTIME_DIR).

Файлы:
  lock            — flock-файл; удерживается живым демоном
  pid             — PID живого демона
  port            — фактический порт (актуально при port_fallback=ephemeral)
  bootstrap.url   — актуальный bootstrap URL (перезаписывается по SIGUSR1)
  status.json     — {"pid", "port", "started_at", "version"}

Все записи — atomic через .tmp + os.replace.
"""
from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path

from melecho.config import resolve_runtime_dir


def runtime_dir() -> Path:
    return resolve_runtime_dir()


def _path(name: str) -> Path:
    return runtime_dir() / name


def _atomic_write(path: Path, data: str) -> None:
    # Trailing newline — чтобы `cat file` в шелле не склеивал содержимое
    # с приглашением. При чтении .strip() убирает его.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data if data.endswith("\n") else data + "\n", encoding="utf-8")
    os.replace(tmp, path)


# --- lock -----------------------------------------------------------------

def acquire_lock() -> int | None:
    """Пытается взять эксклюзивный flock. Возвращает fd (держать открытым!)
    или None, если лок уже занят. Файл lock сам не удаляется — иначе
    возможны гонки на уровне inode."""
    path = _path("lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def release_lock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


# --- pid ------------------------------------------------------------------

def write_pid(pid: int) -> None:
    _atomic_write(_path("pid"), str(pid))


def read_pid() -> int | None:
    p = _path("pid")
    if not p.exists():
        return None
    try:
        return int(p.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return None


def is_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Процесс есть, но не наш uid — считаем живым (маловероятно).
        return True


# --- port -----------------------------------------------------------------

def write_port(port: int) -> None:
    _atomic_write(_path("port"), str(port))


def read_port() -> int | None:
    p = _path("port")
    if not p.exists():
        return None
    try:
        return int(p.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return None


# --- bootstrap ------------------------------------------------------------

def write_bootstrap(url: str) -> None:
    _atomic_write(_path("bootstrap.url"), url)


def read_bootstrap() -> str | None:
    p = _path("bootstrap.url")
    if not p.exists():
        return None
    try:
        return p.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def wait_for_bootstrap(prev: str | None, timeout: float = 10.0,
                       poll: float = 0.1) -> str | None:
    """Ждём появления/изменения bootstrap.url.

    Если prev=None — ждём появления файла. Если prev задан — ждём, пока
    URL не станет отличным от prev (перезапись по SIGUSR1).
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cur = read_bootstrap()
        if cur and cur != prev:
            return cur
        time.sleep(poll)
    return None


# --- status ---------------------------------------------------------------

def write_status(data: dict) -> None:
    _atomic_write(_path("status.json"), json.dumps(data, sort_keys=True))


def read_status() -> dict | None:
    p = _path("status.json")
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


# --- cleanup --------------------------------------------------------------

def cleanup(keep_lock: bool = False) -> None:
    """Удалить runtime-файлы. lock не трогаем по умолчанию — его
    должен отпустить тот, кто держит fd."""
    for name in ("pid", "port", "bootstrap.url", "status.json"):
        p = _path(name)
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    if not keep_lock:
        # lock-файл оставляем на диске (пустой) — это норма для flock-схем.
        pass
