from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from melecho import __version__
from melecho.config import load_config, user_data_dir
from melecho.http import create_app
from melecho.runtime import Runtime
from melecho import runtime_files as rf

log = logging.getLogger("melecho")


# Паттерны, которые не должны попадать в логи в открытом виде.
_SECRET_LOG_PATTERNS = [
    re.compile(r"(?i)\b(password|passphrase|secret|token)\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+"),
    re.compile(r"(?i)Bearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def _redact_match(s: str) -> str:
    i_eq = s.find("=")
    i_col = s.find(":")
    if i_eq < 0 and i_col < 0:
        return "<redacted>"
    if i_eq < 0:
        i = i_col
    elif i_col < 0:
        i = i_eq
    else:
        i = min(i_eq, i_col)
    return s[:i].rstrip() + " <redacted>"


class SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        redacted = msg
        for rx in _SECRET_LOG_PATTERNS:
            redacted = rx.sub(lambda m: _redact_match(m.group(0)), redacted)
        if redacted != msg:
            record.msg = redacted
            record.args = ()
        return True


def _install_log_filter() -> None:
    root = logging.getLogger()
    if any(isinstance(f, SecretRedactionFilter) for f in root.filters):
        return
    root.addFilter(SecretRedactionFilter())


def _build_bootstrap_url(bind: str, port: int, token: str) -> str:
    host = "127.0.0.1" if bind in {"0.0.0.0", "::"} else bind
    return f"http://{host}:{port}/#bootstrap={token}"


def _print_url(url: str) -> None:
    print(url, flush=True)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# CLI-команды, работающие отдельно от запуска сервера.
# ---------------------------------------------------------------------------

def _cmd_status() -> int:
    st = rf.read_status()
    pid = rf.read_pid()
    if not st or not rf.is_alive(pid):
        print("Melecho не запущен.")
        return 1
    started = st.get("started_at", "?")
    port = st.get("port", "?")
    ver = st.get("version", "?")
    up = ""
    try:
        # Простой uptime из started_at.
        t0 = datetime.strptime(started, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        secs = int((datetime.now(timezone.utc) - t0).total_seconds())
        h, m = divmod(secs // 60, 60)
        up = f" · uptime {h}ч {m}м" if h else f" · uptime {m}м"
    except Exception:
        pass
    print(f"Melecho {ver} · PID {pid} · 127.0.0.1:{port} · запущен {started}{up}")
    url = rf.read_bootstrap()
    if url:
        print(f"  {url}")
    return 0


def _cmd_stop() -> int:
    pid = rf.read_pid()
    if pid is None or not rf.is_alive(pid):
        print("Процесс не найден, чищу runtime-файлы.")
        rf.cleanup()
        return 0
    print(f"Останавливаю PID {pid}...")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        rf.cleanup()
        print("Процесс уже завершён.")
        return 0
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not rf.is_alive(pid):
            rf.cleanup()
            print("Остановлен.")
            return 0
        time.sleep(0.1)
    # Принудительно.
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    rf.cleanup()
    print("Процесс не ответил за 5с, послан SIGKILL.")
    return 0


# ---------------------------------------------------------------------------
# Launcher (default): запустить child или приаттачиться.
# ---------------------------------------------------------------------------

def _maybe_prompt_install_desktop(args: argparse.Namespace) -> None:
    """После первого успешного запуска — предложить установить ярлык.

    Условия: TTY, ярлык ещё не установлен, не передан --no-install-desktop.
    Не-TTY (скрипт, CI) — молча пропускаем.
    """
    if getattr(args, "no_install_desktop", False):
        return
    from melecho import desktop
    if desktop.is_installed():
        return
    if not sys.stdin.isatty():
        return
    try:
        answer = input("Установить ярлык Melecho в меню приложений? [Y/n] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return
    if answer in ("", "y", "yes", "д", "да"):
        desktop.install_desktop()


def _launch_detached(args: argparse.Namespace) -> int:
    """Default-путь: если демон жив — приаттачиться, иначе spawn.

    Возвращает exit-code.
    """
    pid = rf.read_pid()
    if rf.is_alive(pid):
        # Демон жив: SIGUSR1 → новый bootstrap → открыть браузер.
        prev = rf.read_bootstrap()
        try:
            os.kill(pid, signal.SIGUSR1)
        except ProcessLookupError:
            print("Демон исчез, чищу runtime-файлы.", file=sys.stderr)
            rf.cleanup()
            return 1
        new_url = rf.wait_for_bootstrap(prev, timeout=3.0)
        if not new_url:
            print("Демон не выпустил новый bootstrap за 3с.", file=sys.stderr)
            return 1
        if not args.no_browser:
            webbrowser.open(new_url)
        _maybe_prompt_install_desktop(args)
        return 0

    # Старые / битые файлы — чистим перед spawn.
    if pid is not None and not rf.is_alive(pid):
        rf.cleanup()

    # Спавним child в фоне.
    log_path = user_data_dir() / "melecho.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_fd = open(log_path, "a", buffering=1)
    child_argv = [
        sys.executable, "-m", "melecho", "--foreground",
    ] + sys.argv[1:]
    try:
        proc = subprocess.Popen(
            child_argv,
            stdout=log_fd, stderr=log_fd, stdin=subprocess.DEVNULL,
            start_new_session=True, close_fds=True,
        )
    finally:
        log_fd.close()

    # Ждём появления bootstrap.url.
    new_url = rf.wait_for_bootstrap(None, timeout=15.0)
    if not new_url:
        # Что-то пошло не так. Покажем хвост лога.
        print(f"Не дождался bootstrap.url за 15с. Смотри {log_path}", file=sys.stderr)
        try:
            tail = log_path.read_text(encoding="utf-8").splitlines()[-20:]
            for line in tail:
                print("  |", line, file=sys.stderr)
        except OSError:
            pass
        return 1
    if not args.no_browser:
        webbrowser.open(new_url)
    print(f"Melecho запущен (PID {proc.pid}). Логи: {log_path}")
    _maybe_prompt_install_desktop(args)
    return 0


# ---------------------------------------------------------------------------
# Foreground: реальный сервер.
# ---------------------------------------------------------------------------

def _run_foreground(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    _install_log_filter()
    logging.getLogger("asyncssh").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Lock: единственный живой сервер.
    lock_fd = rf.acquire_lock()
    if lock_fd is None:
        # Кто-то уже держит.
        print("Melecho уже запущен (lock занят).", file=sys.stderr)
        return 1

    cfg = load_config(Path(args.config) if args.config else None)
    if args.port is not None:
        cfg.http_port = args.port
    if args.bind is not None:
        cfg.bind = args.bind
    cfg.no_browser = True   # в foreground браузер открывает parent
    cfg.no_audit = bool(args.no_audit)
    cfg.dev_refresh_bootstrap = bool(args.dev_refresh_bootstrap)
    if cfg.http_port == 0:
        cfg.http_port = 8765

    # Порт: probe + fallback.
    import socket
    actual_port = cfg.http_port
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((cfg.bind, cfg.http_port))
        s.close()
    except OSError:
        if getattr(cfg, "port_fallback", "ephemeral") == "ephemeral":
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind((cfg.bind, 0))
            actual_port = s.getsockname()[1]
            s.close()
            print(
                f"Порт {cfg.http_port} занят, слушаю на {actual_port}",
                file=sys.stderr,
            )
        else:
            print(f"Порт {cfg.http_port} занят (port_fallback=fail).", file=sys.stderr)
            rf.release_lock(lock_fd)
            return 1
    cfg.http_port = actual_port

    rt = Runtime(cfg)
    app = create_app(rt)

    url = _build_bootstrap_url(cfg.bind, cfg.http_port, rt.bootstrap or "")
    _print_url(url)

    # Записываем runtime-файлы.
    rf.write_pid(os.getpid())
    rf.write_port(cfg.http_port)
    rf.write_bootstrap(url)
    rf.write_status({
        "pid": os.getpid(),
        "port": cfg.http_port,
        "started_at": _utc_now(),
        "version": __version__,
    })

    loop_holder: dict = {}

    def on_usr1(*_):
        loop = loop_holder.get("loop")
        if loop is None:
            return

        def _go():
            tok = rt.invalidate_bootstrap()
            new_url = _build_bootstrap_url(cfg.bind, cfg.http_port, tok)
            _print_url(new_url)
            rf.write_bootstrap(new_url)

        loop.call_soon_threadsafe(_go)

    try:
        signal.signal(signal.SIGUSR1, on_usr1)
    except Exception:
        log.warning("signal handlers not installed")

    if not cfg.no_browser and not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    import uvicorn
    config = uvicorn.Config(
        app, host=cfg.bind, port=cfg.http_port,
        log_level=cfg.log_level.lower(), workers=1,
        timeout_graceful_shutdown=2,
    )
    server = uvicorn.Server(config)

    # Uvicorn при server.serve() перезаписывает обработчики SIGTERM/SIGINT
    # своим server.handle_exit (capture_signals). Наш прежний
    # signal.signal(SIGTERM, on_term) тихо перезаписывался — значит при
    # `--stop` или Ctrl+C rt._signal_shutdown() не вызывался,
    # _shutdown_event оставался unset, SSE-генераторы не закрывались сами,
    # и uvicorn через timeout_graceful_shutdown=2 убивал задачу Cancel'ом
    # («Exception in ASGI application» в логе).
    #
    # Обёртка: сначала _signal_shutdown() (SSE-генераторы увидят сигнал
    # и выйдут сами), затем оригинальный handle_exit (should_exit = True).
    # Ставим ДО server.serve() — capture_signals возьмёт нашу обёртку.
    _orig_handle_exit = server.handle_exit

    def _handle_exit_wrapper(sig, frame):
        try:
            rt._signal_shutdown()
        except Exception:
            log.exception("_signal_shutdown failed")
        _orig_handle_exit(sig, frame)

    server.handle_exit = _handle_exit_wrapper

    async def _serve():
        loop_holder["loop"] = asyncio.get_running_loop()
        loop_holder["server"] = server
        # Callback для /session/logout {stop_backend: true}: graceful
        # shutdown uvicorn. timeout_graceful_shutdown=2 в Config даёт
        # ему 2 секунды на закрытие SSE/HTTP — этого хватает, чтобы
        # --stop и кнопка «Остановить и выйти» завершались без SIGKILL.
        rt.on_shutdown_request = lambda: setattr(server, "should_exit", True)
        # Фоновые задачи (poll_loop, интернет-polling, update-polling).
        # Владелец — Runtime, не этот метод: reload_for_profile (2.2c)
        # останавливает и запускает их при смене профиля.
        await rt.start_background()
        try:
            await server.serve()
        finally:
            await rt.stop_background()
            try:
                rt.db.close()
            except Exception:
                pass
            rf.release_lock(lock_fd)
            rf.cleanup()

    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        # _serve() уже сделал release_lock + cleanup в своём finally.
        # Здесь просто гасим KeyboardInterrupt, чтобы не печатать трейсбек.
        return 0
    return 0


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        prog="melecho",
        description="Melecho — local-first Linux SSH admin",
    )
    p.add_argument("--version", action="version", version=f"melecho {__version__}")
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--bind", default=None)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--no-audit", action="store_true")
    p.add_argument("--dev-refresh-bootstrap", action="store_true")
    p.add_argument("--config", default=None)
    p.add_argument("--foreground", action="store_true",
                   help="Работать в текущем процессе (для отладки).")
    p.add_argument("--status", action="store_true",
                   help="Показать статус запущенного демона.")
    p.add_argument("--stop", action="store_true",
                   help="Остановить запущенный демон.")
    # Заглушки, реализация — в этапе D.
    p.add_argument("--install-desktop", action="store_true",
                   help="Установить ярлык в меню приложений.")
    p.add_argument("--uninstall-desktop", action="store_true",
                   help="Удалить ярлык.")
    p.add_argument("--no-install-desktop", action="store_true",
                   help="Не предлагать установку ярлыка.")
    args = p.parse_args(argv)

    if args.status:
        sys.exit(_cmd_status())
    if args.stop:
        sys.exit(_cmd_stop())
    if args.install_desktop:
        from melecho import desktop
        sys.exit(desktop.install_desktop())
    if args.uninstall_desktop:
        from melecho import desktop
        sys.exit(desktop.uninstall_desktop())

    if args.foreground:
        sys.exit(_run_foreground(args))
    # Проверка обновлений теперь живёт в runtime (фоновый task,
    # раз в сутки по кэшу). Терминального prompt нет — UI в
    # Настройках → Обновления.
    sys.exit(_launch_detached(args))


if __name__ == "__main__":
    main()
