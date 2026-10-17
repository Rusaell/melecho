"""Установка/удаление .desktop-ярлыка в меню приложений.

Пишет в ~/.local/share/applications/melecho.desktop и
~/.local/share/icons/hicolor/scalable/apps/melecho.svg, а затем
best-effort обновляет кэш (update-desktop-database, gtk-update-icon-cache).
Если кэш-хелперов нет — ничего страшного, большинство современных DE
подхватывают новые .desktop-файлы на лету.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from importlib.resources import files as _pkg_files
from pathlib import Path


def _data_home() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base)


def _desktop_path() -> Path:
    return _data_home() / "applications" / "melecho.desktop"


def _icon_path() -> Path:
    return _data_home() / "icons" / "hicolor" / "scalable" / "apps" / "melecho.svg"


def _resolve_exec() -> str:
    """Абсолютный путь к исполняемому melecho.

    Приоритет:
      1. shutil.which('melecho') — основной случай (pipx / pip в ~/.local/bin).
      2. sys.argv[0], если это файл (dev-режим через .venv/bin/melecho).
      3. fallback: '<python> -m melecho' — сработает, если путь не найден.
    """
    which = shutil.which("melecho")
    if which:
        # НЕ resolve(): сохраняем симлинк как он есть.
        # pipx создаёт ~/.local/bin/melecho -> ~/.local/share/pipx/venvs/melecho/bin/melecho.
        # .resolve() разыменует в venv-путь, и при переустановке pipx (или
        # обновлении melecho) старый venv удаляется — ярлык ломается.
        # Симлинк ~/.local/bin/melecho переживает reinstall, потому что pipx
        # пересоздаёт его в том же месте.
        return str(Path(which).absolute())
    argv0 = Path(sys.argv[0]) if sys.argv and sys.argv[0] else None
    if argv0 and argv0.exists() and argv0.is_file():
        return str(argv0.resolve())
    return f"{sys.executable} -m melecho"


def is_installed() -> bool:
    return _desktop_path().exists()


def _refresh_caches() -> None:
    """Best-effort. Отсутствие утилит — не ошибка."""
    for cmd in (
        ["update-desktop-database", str(_data_home() / "applications")],
        ["gtk-update-icon-cache", "-f", "-t", str(_data_home() / "icons" / "hicolor")],
    ):
        try:
            subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass


def install_desktop() -> int:
    """Установить ярлык. 0 — успех, 1 — ошибка."""
    try:
        pkg = _pkg_files("melecho")
        tmpl = (pkg / "resources" / "melecho.desktop.in").read_text(encoding="utf-8")
        icon_src = pkg / "resources" / "melecho.svg"
        icon_bytes = icon_src.read_bytes()
    except (FileNotFoundError, ModuleNotFoundError) as e:
        print(f"Не нашёл ресурсы пакета: {e}", file=sys.stderr)
        return 1

    exec_path = _resolve_exec()
    desktop_content = tmpl.replace("{exec_path}", exec_path)

    dp = _desktop_path()
    dp.parent.mkdir(parents=True, exist_ok=True)
    dp.write_text(desktop_content, encoding="utf-8")
    dp.chmod(0o644)

    ip = _icon_path()
    ip.parent.mkdir(parents=True, exist_ok=True)
    ip.write_bytes(icon_bytes)

    _refresh_caches()
    print(f"Ярлык установлен: {dp}")
    print(f"Иконка: {ip}")
    print(f"Exec: {exec_path}")
    print("Melecho появится в меню приложений (если не сразу — выйди и зайди снова).")
    return 0


def uninstall_desktop() -> int:
    dp = _desktop_path()
    ip = _icon_path()
    removed = []
    for p in (dp, ip):
        try:
            p.unlink()
            removed.append(p)
        except FileNotFoundError:
            pass
    if not removed:
        print("Ярлык не был установлен.")
        return 0
    _refresh_caches()
    for p in removed:
        print(f"Удалён: {p}")
    return 0
