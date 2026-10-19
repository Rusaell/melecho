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


def _q_desktop_exec(s: str) -> str:
    """Quote path for .desktop Exec line if it contains space/tab/quote.

    Exec spec: каждый аргумент с пробелом/табом/кавычкой оборачивается в "…".
    """
    if not s or not any(c in s for c in ' \t"\''):
        return s
    return '"' + s.replace('"', '\\"') + '"'


def _resolve_exec() -> str:
    """Возвращает Exec-значение для .desktop-файла.

    Приоритет:
      1. shutil.which('melecho') — pipx / pip --user. Возвращает
         ~/.local/bin/melecho — стабильный симлинк, переживает reinstall.
      2. <venv>/bin/melecho от sys.executable — dev через ./run.sh
         (sys.executable = .venv/bin/python, значит .venv/bin/melecho).
      3. fallback: '<python> -m melecho' — сработает из любого места.

    ВАЖНО: НЕ используем sys.argv[0]. В child-процессе (`python -m melecho
    --foreground` из _launch_detached) sys.argv[0] = __main__.py, а он
    не executable — .desktop-ярлык получался с Exec на .py-файл и падал
    с «Отсутствуют права доступа выполнение программы».
    """
    which = shutil.which("melecho")
    if which:
        # НЕ resolve(): сохраняем симлинк как он есть (см. комментарий выше).
        return _q_desktop_exec(str(Path(which).absolute()))

    venv_bin = Path(sys.executable).parent
    candidate = venv_bin / "melecho"
    if candidate.is_file():
        return _q_desktop_exec(str(candidate.resolve()))

    return f"{_q_desktop_exec(sys.executable)} -m melecho"


def is_installed() -> bool:
    return _desktop_path().exists()


def _refresh_caches() -> None:
    """Best-effort. Отсутствие утилит — не ошибка.

    update-desktop-database / gtk-update-icon-cache — стандарт freedesktop
    (GNOME, Xfce, Cinnamon, MATE, LXQt и др.).
    kbuildsycoca6 / kbuildsycoca5 — KDE Plasma 6/5. У него собственный
    кэш sycoca; update-desktop-database меню KDE не обновляет.
    """
    for cmd in (
        ["update-desktop-database", str(_data_home() / "applications")],
        ["gtk-update-icon-cache", "-f", "-t", str(_data_home() / "icons" / "hicolor")],
        ["kbuildsycoca6"],
        ["kbuildsycoca5"],
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
