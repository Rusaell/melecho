from __future__ import annotations

import hashlib
import logging
import shlex

from melecho.catalog import validate_param_value
from melecho.errors import AppError
from melecho.ssh import RunResult

log = logging.getLogger("melecho")


def substitute_argv(command: str, params: dict[str, str]) -> list[str]:
    argv = shlex.split(command)
    out = []
    for tok in argv:
        if tok.startswith("{") and tok.endswith("}") and len(tok) > 2:
            key = tok[1:-1]
            if key not in params:
                raise AppError("E_PARAM", f"нет значения для {{{key}}}", status=400)
            out.append(params[key])
        else:
            if "{" in tok and "}" in tok:
                raise AppError("E_OP_INVALID", "плейсхолдер должен быть отдельным argv", status=400)
            out.append(tok)
    return out


def redacted_argv(argv: list[str], params_spec: list[dict], params: dict[str, str]) -> list[str]:
    sensitive = {p["name"] for p in params_spec if p.get("sensitive")}
    values = {params[k] for k in sensitive if k in params}
    out = []
    for tok in argv:
        if tok in values:
            # type from spec
            kind = "secret"
            for p in params_spec:
                if p.get("sensitive") and params.get(p["name"]) == tok:
                    kind = p.get("type") or "secret"
            out.append(f"<redacted:{kind}>")
        else:
            out.append(tok)
    return out


async def resolve_name(shell, name: str, path_env: str, use_sudo_n: bool = False, sudo_abs: str | None = None) -> str | None:
    if name.startswith("/"):
        return name
    # PATH-фильтр + `command -v` внутри /bin/sh -c, чтобы login shell
    # пользователя (zsh/fish/csh) не мог повлиять на разбор (F10).
    inner = f"PATH={path_env} command -v {shlex.quote(name)}"
    if use_sudo_n and sudo_abs:
        argv = [sudo_abs, "-n", "/bin/sh", "-c", inner]
    else:
        argv = ["/bin/sh", "-c", inner]
    r = await shell.run_argv(argv)
    path = (r.stdout or "").strip().splitlines()
    if r.exit_code == 0 and path:
        return path[0].strip()
    if r.sudo_code == "E_SUDO_REQUIRED":
        raise AppError("E_SUDO_REQUIRED", "нужен пароль sudo для резолва пути", status=401)
    return None


def wrap_locale(argv: list[str], env_abs: str, sudo_abs: str | None, sudo_mode: str | None) -> list[str]:
    """sudo_mode: None | 'n' | 'S' """
    core = [env_abs, "LC_ALL=C", "LANG=C", *argv]
    if sudo_mode is None:
        return core
    if sudo_mode == "n":
        return [sudo_abs, "-n", *core]
    if sudo_mode == "S":
        return [sudo_abs, "-S", "-p", "", *core]
    raise ValueError(sudo_mode)


def step_wants_sudo(argv: list[str]) -> bool:
    return bool(argv) and argv[0] in {"sudo"} and "-n" in argv[:3]


def drop_sudo_prefix(argv: list[str]) -> list[str]:
    if argv and argv[0] == "sudo":
        rest = argv[1:]
        if rest[:1] == ["-n"]:
            rest = rest[1:]
        return rest
    return argv


class PathCache:
    def __init__(self):
        self._d: dict[tuple[int, str], str] = {}

    def get(self, server_id: int, name: str) -> str | None:
        return self._d.get((server_id, name))

    def put(self, server_id: int, name: str, path: str) -> None:
        self._d[(server_id, name)] = path
        log.debug("resolver %s -> %s", name, path)

    def invalidate(self, server_id: int | None = None) -> None:
        if server_id is None:
            self._d.clear()
        else:
            for k in [k for k in self._d if k[0] == server_id]:
                del self._d[k]


async def resolve_needed(
    shell,
    server_id: int,
    names: list[str],
    cache: PathCache,
    path_env: str,
    env_abs: str,
    allow_sudo: bool,
) -> dict[str, str]:
    found = {}
    missing = []
    for n in names:
        if n == "sh" or n == "/bin/sh":
            found[n] = "/bin/sh"
            continue
        if n.startswith("/"):
            found[n] = n
            continue
        cached = cache.get(server_id, n)
        if cached:
            found[n] = cached
            continue
        path = await resolve_name(shell, n, path_env, use_sudo_n=False)
        if path:
            cache.put(server_id, n, path)
            found[n] = path
        else:
            missing.append(n)
    if missing and allow_sudo:
        sudo_abs = found.get("sudo") or cache.get(server_id, "sudo")
        if sudo_abs is None:
            sudo_abs = await resolve_name(shell, "sudo", path_env)
            if sudo_abs:
                cache.put(server_id, "sudo", sudo_abs)
        for n in list(missing):
            path = await resolve_name(shell, n, path_env, use_sudo_n=True, sudo_abs=sudo_abs)
            if path:
                cache.put(server_id, n, path)
                found[n] = path
                missing.remove(n)
    if missing:
        raise AppError("E_NOT_FOUND_CMD", f"команда не найдена: {', '.join(missing)}", status=400)
    found.setdefault("env", env_abs)
    return found


def command_names_for(op: dict) -> list[str]:
    """Собирает имена команд, пути которых нужно резолвить через `command -v`.

    Для шагов вида `sudo [флаги] <cmd> ...` пропускаем `sudo` и его флаги
    (токены, начинающиеся с `-`). Валидатор каталога уже отклоняет
    sudo с аргументными флагами (`-u root`, `-p ''`), поэтому «первый
    не-флаговый токен» детерминированно является именем команды.
    """
    names = list((op.get("applicability") or {}).get("check_command") or [])
    for group in (op.get("preconditions") or [], op.get("steps") or [], op.get("postconditions") or []):
        for st in group:
            argv = shlex.split(st["command"])
            if not argv:
                continue
            if argv[0] == "sudo":
                i = 1
                while i < len(argv) and argv[i].startswith("-"):
                    i += 1
                if i < len(argv):
                    names.append(argv[i])
            else:
                names.append(argv[0])
    names.extend(["sudo", "sh"])
    out: list[str] = []
    for n in names:
        if n and n not in out:
            out.append(n)
    return out


def bind_params(op: dict, incoming: dict, allowed_units: list[str] | None) -> dict[str, str]:
    out = {}
    for spec in op.get("params") or []:
        val = incoming.get(spec["name"], spec.get("default"))
        if val is None and spec.get("required"):
            raise AppError("E_PARAM", f"нужен параметр {spec['name']}", status=400)
        if val is None:
            continue
        out[spec["name"]] = validate_param_value(spec, val, allowed_units)
    return out


def sha256_text(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8", "replace"))
    return h.hexdigest()


def truncate(s: str, n: int) -> str:
    if len(s.encode("utf-8")) <= n:
        return s
    raw = s.encode("utf-8")[:n]
    return raw.decode("utf-8", "ignore") + "\n…[truncated]"


async def run_step(
    shell,
    argv: list[str],
    timeout: float,
    input_bytes: bytes | None,
    output_limit: int,
) -> RunResult:
    # run_argv гарантирует вызов через /bin/sh -c, независимо от login shell (F10).
    r = await shell.run_argv(argv, input_bytes=input_bytes, timeout=timeout)
    if len(r.stdout.encode("utf-8")) > output_limit:
        r.stdout = truncate(r.stdout, output_limit)
    if len(r.stderr.encode("utf-8")) > output_limit:
        r.stderr = truncate(r.stderr, output_limit)
    return r
