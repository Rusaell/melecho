from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import shlex
from dataclasses import dataclass

from melecho.errors import AppError

log = logging.getLogger("melecho")
logging.getLogger("asyncssh").setLevel(logging.WARNING)

SUDO_PATTERNS = [
    # Основной сигнал «нужен пароль». На новых sudo (1.9.15+, Ubuntu 24.04+)
    # формулировка другая — раньше было "a password is required", сейчас
    # "interactive authentication is required" (при sudo -n). Покрываем оба.
    (re.compile(r"a password is required", re.I), "E_SUDO_REQUIRED"),
    (re.compile(r"interactive authentication is required", re.I), "E_SUDO_REQUIRED"),
    (re.compile(r"authentication is required", re.I), "E_SUDO_REQUIRED"),
    (re.compile(r"timed out reading password", re.I), "E_SUDO_TIMEOUT"),
    (re.compile(r"Sorry, try again", re.I), "E_SUDO_WRONG_PASSWORD"),
    (re.compile(r"3 incorrect password attempts", re.I), "E_SUDO_LOCKED"),
    (re.compile(r"you must have a tty to run sudo", re.I), "E_SUDO_REQUIRETTY"),
    (re.compile(r"no tty present and no askpass", re.I), "E_SUDO_NO_TTY_ASKPASS"),
    (re.compile(r"not in the sudoers file|not allowed to execute", re.I), "E_SUDO_NOT_PERMITTED"),
]


@dataclass
class RunResult:
    exit_code: int
    stdout: str
    stderr: str
    sudo_code: str | None = None


def classify_sudo(stderr: str, exit_code: int) -> str | None:
    if exit_code == 0:
        return None
    for rx, code in SUDO_PATTERNS:
        if rx.search(stderr):
            return code
    if "sudo:" in stderr.lower() or "sudo:" in stderr:
        return "E_SUDO_UNKNOWN"
    return None


def fingerprint_sha256(raw: bytes) -> str:
    digest = hashlib.sha256(raw).digest()
    import base64

    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def sh_posix(argv: list[str]) -> str:
    """Готовит строку для передачи в SSH, обёрнутую в `/bin/sh -c '…'`.

    Зачем: sshd передаёт нашу строку в login shell пользователя. Если это
    zsh/fish/csh, POSIX-экранирование от shlex.join может быть истолковано
    иначе, и argv «поплывёт». Явная обёртка в /bin/sh -c гарантирует, что
    финальный разбор argv делает POSIX-shell, независимо от login shell.

    Двойное экранирование (shlex.join(shlex.join(argv))) — ожидаемо и
    безопасно: внешний уровень парсит login shell, внутренний — /bin/sh.
    """
    inner = shlex.join(argv)
    return shlex.join(["/bin/sh", "-c", inner])


class Shell:
    async def run(self, command: str, input_bytes: bytes | None = None, timeout: float = 60) -> RunResult:
        raise NotImplementedError

    async def run_argv(
        self, argv: list[str], input_bytes: bytes | None = None, timeout: float = 60
    ) -> RunResult:
        """Запускает команду, заданную argv-массивом, через детерминированный
        POSIX-shell. Предпочтительный способ для всех команд в проекте."""
        return await self.run(sh_posix(argv), input_bytes=input_bytes, timeout=timeout)

    async def close(self) -> None:
        return None

    def is_alive(self) -> bool:
        return True


class RealShell(Shell):
    def __init__(self, conn):
        self.conn = conn

    def is_alive(self) -> bool:
        try:
            return not self.conn.is_closed()
        except Exception:
            return False

    async def run(self, command: str, input_bytes: bytes | None = None, timeout: float = 60) -> RunResult:
        import asyncssh

        try:
            r = await asyncio.wait_for(
                self.conn.run(command, input=input_bytes, term_type=None, encoding=None),
                timeout=timeout,
            )
        except asyncssh.TimeoutError as e:
            raise AppError("E_TIMEOUT", "таймаут SSH-команды", status=504) from e
        except asyncio.TimeoutError as e:
            raise AppError("E_TIMEOUT", "таймаут SSH-команды", status=504) from e
        except asyncssh.misc.ChannelOpenError as e:
            raise AppError("E_SSH_DISCONNECTED", "SSH-соединение закрыто сервером", status=502) from e
        except asyncssh.misc.ConnectionLost as e:
            raise AppError("E_SSH_DISCONNECTED", "SSH-соединение потеряно", status=502) from e
        except (ConnectionError, OSError) as e:
            raise AppError("E_SSH_DISCONNECTED", "SSH-соединение потеряно", status=502) from e
        stdout = (r.stdout or b"").decode("utf-8", "replace")
        stderr = (r.stderr or b"").decode("utf-8", "replace")
        code = int(r.exit_status or 0)
        return RunResult(code, stdout, stderr, classify_sudo(stderr, code))

    async def close(self) -> None:
        try:
            self.conn.close()
            await self.conn.wait_closed()
        except Exception:
            pass


class SSHManager:
    """Реестр живых SSH-сессий по server_id.

    Не подключается сам — только хранит и закрывает. Соединение открывает Runtime,
    потому что для этого нужны DEK, креды из БД и known_hosts.
    """

    def __init__(self) -> None:
        self._sessions: dict[int, RealShell] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._pending_hostkeys: dict[tuple[str, int], dict] = {}

    def _lock(self, sid: int) -> asyncio.Lock:
        lk = self._locks.get(sid)
        if lk is None:
            lk = asyncio.Lock()
            self._locks[sid] = lk
        return lk

    async def get(self, sid: int) -> RealShell | None:
        sh = self._sessions.get(sid)
        if sh is None:
            return None
        if not sh.is_alive():
            await self.drop(sid)
            return None
        return sh

    def has(self, sid: int) -> bool:
        sh = self._sessions.get(sid)
        return sh is not None and sh.is_alive()

    async def set(self, sid: int, shell: RealShell) -> None:
        async with self._lock(sid):
            old = self._sessions.pop(sid, None)
            if old is not None:
                await old.close()
            self._sessions[sid] = shell

    async def drop(self, sid: int) -> None:
        async with self._lock(sid):
            old = self._sessions.pop(sid, None)
        if old is not None:
            await old.close()

    async def drop_all(self) -> None:
        for sid in list(self._sessions.keys()):
            await self.drop(sid)

    def pending_host_key(self, host: str, port: int) -> dict | None:
        return self._pending_hostkeys.get((host, port))

    def set_pending_host_key(self, host: str, port: int, info: dict) -> None:
        self._pending_hostkeys[(host, port)] = info

    def clear_pending_host_key(self, host: str, port: int) -> None:
        self._pending_hostkeys.pop((host, port), None)


async def _fetch_host_key(host: str, port: int, timeout: int):
    """Pre-fetch host key без аутентификации. Используется только при known_fp=None."""
    import asyncssh

    if not hasattr(asyncssh, "get_server_host_key"):
        raise AppError("E_SSH", "asyncssh не поддерживает get_server_host_key — обновите asyncssh>=2.15", status=500)
    try:
        _opts = asyncssh.SSHClientConnectionOptions(connect_timeout=timeout)
        key = await asyncio.wait_for(
            asyncssh.get_server_host_key(
                host,
                port=port,
                config=None,
                options=_opts,
                server_host_key_algs=HOST_KEY_ALGS,
            ),
            timeout=timeout + 5,
        )
    except TypeError as e:
        raise AppError("E_SSH", f"asyncssh API: {e}", status=500) from e
    except Exception as e:
        msg = str(e).lower()
        if "timed out" in msg or "connection timed out" in msg:
            raise AppError("E_SSH_TIMEOUT", "таймаут получения host key", status=504) from e
        if "connection refused" in msg:
            raise AppError("E_SSH_REFUSED", f"соединение отклонено: {host}:{port}", status=502) from e
        if "no route to host" in msg or "name or service not known" in msg or "name resolution" in msg:
            raise AppError("E_SSH_UNREACHABLE", f"хост недоступен: {host}:{port}", status=502) from e
        raise AppError("E_SSH", f"не удалось получить host key: {e}", status=502) from e
    return key


# Порядок = предпочтение клиента. ed25519 первым — совпадает с modern OpenSSH
# и с тем, что пользователь видит в `ssh-keyscan -t ed25519`.
HOST_KEY_ALGS = (
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
)


def _present_host_key(key) -> dict:
    """SHA256 fingerprint из wire-format blob (тот же алгоритм, что ssh-keygen -lf)."""
    try:
        blob = key.public_data
    except AttributeError:
        raw = key.export_public_key()
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        parts = raw.split(b" ", 2)
        if len(parts) >= 2:
            import base64 as _b64
            blob = _b64.b64decode(parts[1])
        else:
            blob = raw
    fp = fingerprint_sha256(blob)
    try:
        key_type = key.algorithm
        if isinstance(key_type, (bytes, bytearray)):
            key_type = key_type.decode("ascii", "replace")
    except AttributeError:
        try:
            key_type = key.get_algorithm()
            if isinstance(key_type, (bytes, bytearray)):
                key_type = key_type.decode("ascii", "replace")
        except Exception:
            key_type = "unknown"
    try:
        pub = key.export_public_key()
        if isinstance(pub, bytes):
            pub = pub.decode("utf-8", "replace")
    except Exception:
        pub = ""
    return {"fingerprint_sha256": fp, "key_type": key_type, "public_key": pub}


def _fp_from_public_key(public_key: str) -> str | None:
    """SHA256 fingerprint из ASCII-представления OpenSSH-ключа ("ssh-ed25519 AAAA... comment").
    Возвращает None, если строка невалидна."""
    if not public_key:
        return None
    parts = public_key.strip().split()
    if len(parts) < 2:
        return None
    import base64 as _b64
    import hashlib as _hl
    try:
        blob = _b64.b64decode(parts[1], validate=False)
    except Exception:
        return None
    return "SHA256:" + _b64.b64encode(_hl.sha256(blob).digest()).decode("ascii").rstrip("=")


def _known_hosts_line(host: str, port: int, public_key: str) -> tuple[str | None, str | None]:
    """Строит строку формата known_hosts из ASCII-представления публичного ключа.
    Возвращает (line, key_type) или (None, None), если public_key нераспознан."""
    parts = (public_key or "").strip().split()
    if len(parts) < 2:
        return None, None
    entry = f"{parts[0]} {parts[1]}"
    if port == 22:
        line = f"{host} {entry}"
    else:
        line = f"[{host}]:{port} {entry}"
    return line, parts[0]


async def connect_real(
    host: str,
    port: int,
    username: str,
    auth_type: str,
    secret: bytes,
    passphrase: bytes | None,
    known_fp: str | None,
    timeout: int,
    key_bytes: bytes | None = None,
    known_public_key: str | None = None,
) -> tuple[RealShell | None, dict]:
    """Открывает SSH-соединение с проверкой host key.

    Флоу:
      1. known_fp is None → pre-fetch host key (без auth), возврат E_TOFU.
      2. known_fp задан и known_public_key есть → create_connection с
         known_hosts=[line]. asyncssh сверит host key сам, до auth.
         Pre-fetch НЕ делается (один handshake, не два).
      3. known_public_key пуст (старые записи в БД) → fallback: pre-fetch,
         сравнить fingerprint, connect с known_hosts=None. Редкий случай.
    """
    import asyncssh

    # 1. TOFU: получаем fingerprint один раз, без аутентификации.
    if known_fp is None:
        key = await _fetch_host_key(host, port, timeout)
        presented = _present_host_key(key)
        return None, {
            "ok": False,
            "code": "E_TOFU",
            "message": "новый host key — подтвердите отпечаток",
            **presented,
        }

    # 2. Подготовка ключей/пароля.
    kwargs: dict = {
        "username": username,
        "port": port,
        "connect_timeout": timeout,
    }
    if key_bytes:
        pw = passphrase.decode("utf-8", "replace") if passphrase else None
        try:
            key_obj = asyncssh.import_private_key(key_bytes, passphrase=pw)
        except Exception as e:
            msg = str(e).lower()
            if "bcrypt" in msg and "kdf" in msg:
                raise AppError("E_KEY_NO_BCRYPT", "для расшифровки OpenSSH-ключа нужен пакет bcrypt", status=500) from e
            if "passphrase" in msg or "password" in msg or "decrypt" in msg or "encryption" in msg:
                raise AppError("E_KEY_PASSPHRASE", "неверная passphrase к приватному ключу", status=400) from e
            raise AppError("E_KEY", f"не удалось импортировать SSH-ключ: {e}", status=400) from e
        kwargs["client_keys"] = [key_obj]
    else:
        kwargs["client_keys"] = None
    password = secret.decode("utf-8", "replace") if secret else None
    kwargs["password"] = password
    if not kwargs.get("client_keys") and not kwargs.get("password"):
        raise AppError("E_PARAM", "нужен пароль SSH или файл ключа", status=400)
    if kwargs.get("client_keys") and kwargs.get("password"):
        kwargs["preferred_auth"] = ("publickey", "keyboard-interactive", "password")
    elif kwargs.get("client_keys"):
        kwargs["preferred_auth"] = ("publickey",)
    else:
        kwargs["preferred_auth"] = ("password", "keyboard-interactive")

    # 3. Проверка host key.
    kh_line, kh_type = _known_hosts_line(host, port, known_public_key or "")
    fallback_prefetch = False
    if kh_line and kh_type:
        # S7 consistency: fingerprint_sha256 и public_key в БД должны быть согласованы.
        # Если это не так (ручная правка БД, битая миграция, частичная подмена) —
        # доверия нет, соединение не открываем.
        if known_fp is not None:
            fp_from_pub = _fp_from_public_key(known_public_key or "")
            if fp_from_pub != known_fp:
                raise AppError(
                    "E_HOSTKEY_MISMATCH",
                    "fingerprint в БД не совпадает с сохранённым public_key. Продолжить нельзя. Используйте ротацию ключа.",
                    status=403,
                    details={"fingerprint_sha256": fp_from_pub or "?", "stored": known_fp},
                )
        # asyncssh: known_hosts как str трактуется как ПУТЬ к файлу.
        # Для содержимого in-memory нужен bytes, не str и не list.
        _line_bytes = (kh_line + chr(10)).encode("utf-8")
        kwargs["known_hosts"] = _line_bytes
        kwargs["server_host_key_algs"] = (kh_type,)
    else:
        # fallback: pre-fetch один раз, сверить, коннектить с known_hosts=None.
        fallback_prefetch = True
        key = await _fetch_host_key(host, port, timeout)
        presented = _present_host_key(key)
        if presented["fingerprint_sha256"] != known_fp:
            raise AppError(
                "E_HOSTKEY_MISMATCH",
                "host key не совпадает с сохранённым. Продолжить нельзя. Используйте ротацию ключа.",
                status=403,
                details={"fingerprint_sha256": presented["fingerprint_sha256"], "stored": known_fp},
            )
        kwargs["known_hosts"] = None
        kwargs["server_host_key_algs"] = HOST_KEY_ALGS

    # 4. Соединение.
    try:
        conn, _client = await asyncssh.create_connection(asyncssh.SSHClient, host, **kwargs)
    except asyncssh.misc.HostKeyNotVerifiable as e:
        raise AppError(
            "E_HOSTKEY_MISMATCH",
            "host key не совпадает с сохранённым. Продолжить нельзя. Используйте ротацию ключа.",
            status=403,
        ) from e
    except Exception as e:
        msg = str(e).lower()
        if "permission denied" in msg or "authentication" in msg:
            raise AppError("E_AUTH", "неверные учётные данные SSH (пароль пользователя или ключ)", status=401) from e
        if "timed out" in msg or "timeout" in msg:
            raise AppError("E_SSH_TIMEOUT", "таймаут подключения к SSH", status=504) from e
        if "connection refused" in msg:
            raise AppError("E_SSH_REFUSED", f"соединение отклонено: {host}:{port}", status=502) from e
        if "no route to host" in msg or "name or service not known" in msg:
            raise AppError("E_SSH_UNREACHABLE", f"хост недоступен: {host}:{port}", status=502) from e
        raise AppError("E_SSH", f"SSH: {e}", status=502) from e

    return RealShell(conn), {"ok": True, "fingerprint_sha256": known_fp, "key_type": kh_type or "", "fallback_prefetch": fallback_prefetch}
