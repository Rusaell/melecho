from __future__ import annotations

import logging
import re
from pathlib import Path

import yaml

from melecho.errors import AppError

log = logging.getLogger("melecho")

CMD_NAME = re.compile(r"^[A-Za-z0-9._+-]{1,64}$")
# id операции: нижний регистр, цифры, "_". Явно ужесточаем правило —
# user-файлы приходят из внешнего источника, и пускать в id "/" или ".."
# нельзя (id попадает в URL, в audit_log.operation_id, в reactions.operation_id).
# Системные 5 YAML (disk_check, systemd_restart, journalctl_view,
# apt_update_and_list, ss_tulpn_view) этому шаблону удовлетворяют.
ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@_.:-]{1,256}$")
META_RE = re.compile(r"[;|&$`<>\n\r()\\]")

# Fallback, если config не задал свой whitelist. Держим синхронным с 5 YAML MVP.
DEFAULT_ALLOWED_COMMANDS = frozenset({
    "findmnt", "systemctl", "journalctl", "apt-get", "apt", "ip", "ss",
})

# Команды, способные выполнить произвольный код из argv или запустить
# произвольную подкоманду. Запрещены в YAML всегда, независимо от whitelist:
# sudo не спасает от `sudo -n awk 'BEGIN{system(...)}'` или `env sh -c ...`.
INTERPRETER_CMDS = frozenset({
    # shells
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "ash",
    # языки
    "awk", "gawk", "mawk", "perl", "python", "python2", "python3",
    "ruby", "node", "php", "lua", "tclsh", "wish", "expect",
    # launchers
    "env", "xargs", "timeout", "nice", "ionice", "nohup", "setsid",
    "at", "batch", "watch", "screen", "tmux",
    # потоковые редакторы
    "sed", "ed",
    # find с -exec
    "find",
})

# Команды, читающие stdin без аргументов. Читать stdin запрещено по дизайну
# каталога: шаги не должны зависеть от внешних данных.
STDIN_CMDS = {"cat", "read", "tee", "head", "tail", "sort", "grep"}


def _flags(raw: dict) -> dict:
    raw = raw or {}
    return {
        "dangerous": bool(raw.get("dangerous", False)),
        "requires_confirmation": bool(raw.get("requires_confirmation", False)),
        "idempotent": bool(raw.get("idempotent", False)),
        "plan_preview_supported": bool(raw.get("plan_preview_supported", False)),
        "reversible": bool(raw.get("reversible", True)),
        "expect_disconnect": bool(raw.get("expect_disconnect", False)),
        "escalatable": bool(raw.get("escalatable", False)),
        "state_changing": bool(raw.get("state_changing", False)),
    }


def _validate_unit(name: str) -> None:
    if not UNIT_RE.match(name) or ".." in name:
        raise AppError("E_INJECTION", "недопустимое имя unit", status=400)
    if name[0] in ".-" or name[-1] in ".-":
        raise AppError("E_INJECTION", "недопустимое имя unit", status=400)
    if "." in name:
        suf = name.rsplit(".", 1)[-1]
        if suf not in {"service", "socket", "target", "timer"}:
            raise AppError("E_INJECTION", "unit должен иметь суффикс .service/.socket/.target/.timer", status=400)


def validate_param_value(spec: dict, value, allowed_units: list[str] | None = None) -> str:
    name = spec["name"]
    raw = "" if value is None else str(value)
    if META_RE.search(raw) or "\n" in raw or "\r" in raw:
        raise AppError("E_INJECTION", f"параметр {name}: запрещённые метасимволы", status=400)
    if spec.get("type") == "int":
        try:
            n = int(raw)
        except (TypeError, ValueError) as e:
            raise AppError("E_PARAM", f"параметр {name}: ожидается целое", status=400) from e
        if spec.get("min") is not None and n < int(spec["min"]):
            raise AppError("E_PARAM", f"параметр {name}: меньше минимума", status=400)
        if spec.get("max") is not None and n > int(spec["max"]):
            raise AppError("E_PARAM", f"параметр {name}: больше максимума", status=400)
        return str(n)
    if spec.get("type") == "enum":
        if spec.get("source") == "server.allowed_units":
            _validate_unit(raw)
            if allowed_units is not None and raw not in allowed_units:
                raise AppError("E_PARAM", f"unit {raw} нет в allowed_units", status=400)
        return raw
    if spec.get("pattern"):
        if not re.fullmatch(spec["pattern"], raw):
            raise AppError("E_PARAM", f"параметр {name}: не соответствует шаблону", status=400)
    return raw


def _check_head(name: str, allowed_commands: frozenset[str], ctx: str = "") -> None:
    """Проверка «головы» команды — имени самой программы или того, что стоит
    после `sudo`. Отклоняет абсолютные пути, интерпретаторы и всё, чего нет
    в белом списке."""
    if name.startswith("/"):
        raise ValueError(f"{ctx}абсолютный путь в шаблоне запрещён: {name!r}")
    if not CMD_NAME.match(name):
        raise ValueError(f"{ctx}недопустимое имя команды: {name!r}")
    if name in INTERPRETER_CMDS:
        raise ValueError(f"{ctx}команда-интерпретатор/лаунчер {name!r} запрещена в каталоге")
    if name not in allowed_commands:
        raise ValueError(f"{ctx}команда {name!r} не в белом списке catalog.allowed_commands")


def _check_template(command: str, allowed_commands: frozenset[str]) -> list[str]:
    import shlex

    try:
        argv = shlex.split(command)
    except ValueError as e:
        raise ValueError(f"не разбирается shlex: {e}") from e
    if not argv:
        raise ValueError("пустая команда")

    head = argv[0]
    if head == "sudo":
        # Пропускаем флаги sudo. Сам executor добавляет `-n` или `-S -p ''`,
        # поэтому присутствие `-p`/`--prompt` в YAML — ошибка (мы бы поставили
        # два -p, что сломало бы sudo).
        i = 1
        while i < len(argv) and argv[i].startswith("-"):
            if argv[i] in ("-p", "--prompt"):
                raise ValueError("sudo -p/--prompt в шаблоне запрещён (executor добавит сам)")
            i += 1
        if i >= len(argv):
            raise ValueError("sudo без команды")
        _check_head(argv[i], allowed_commands, ctx="после sudo: ")
    else:
        _check_head(head, allowed_commands)

    if head in STDIN_CMDS and len(argv) == 1:
        raise ValueError(f"команда {head} без аргументов читает stdin — запрещена в каталоге")

    for tok in argv:
        if "{" in tok and "}" in tok:
            inner = tok.strip("{}")
            if tok != "{" + inner + "}":
                raise ValueError(f"плейсхолдер должен быть отдельным argv, не внутри {tok!r}")
            if META_RE.search(tok.replace("{", "").replace("}", "")):
                raise ValueError("метасимволы в шаблоне")
        elif META_RE.search(tok):
            # Здесь же отсекаются && и || — они метасимволы.
            raise ValueError(f"метасимволы в шаблоне: {tok!r}")
    return argv

class Catalog:
    def __init__(
        self,
        directory: Path,
        allowed_commands: frozenset[str] | None = None,
        *,
        user_dir: Path | None = None,
        whitelist_file: Path | None = None,
    ):
        self.directory = directory
        self.user_dir = user_dir
        self.whitelist_file = whitelist_file
        # None → дефолтный whitelist MVP. Пустой set — валидный случай
        # (админ явно запретил все команды), поэтому отличаем None от set().
        # Это БАЗОВЫЙ whitelist; эффективный = базовый ∪ расширения из
        # whitelist_file. Расширения читаются в load().
        self._base_allowed_commands = (
            allowed_commands if allowed_commands is not None else DEFAULT_ALLOWED_COMMANDS
        )
        self.allowed_commands: frozenset[str] = self._base_allowed_commands
        self.ops: dict[str, dict] = {}
        self.load()

    def _load_whitelist(self) -> frozenset[str]:
        """Возвращает базовый whitelist ∪ расширения из whitelist_file.

        Расширение только additive: админ не может случайно отрезать
        системную команду, удалив строку из своего файла — базовый
        список задан в config.toml и остаётся неизменным.

        Плохие строки (мусор, интерпретаторы) пропускаются с log.warning.
        Одна опечатка не должна рушить старт панели; UI-форма записи в
        whitelist (итерация 2) будет валидировать до записи.
        """
        base = self._base_allowed_commands
        path = self.whitelist_file
        if path is None or not path.exists():
            return base
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            log.warning("whitelist %s: не читается (%s) — оставляю базовый", path, e)
            return base
        extra: set[str] = set()
        for lineno, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if not CMD_NAME.match(line):
                log.warning("whitelist %s:%d: недопустимое имя %r — пропущено", path, lineno, line)
                continue
            if line in INTERPRETER_CMDS:
                log.warning("whitelist %s:%d: интерпретатор/лаунчер %r запрещён — пропущено", path, lineno, line)
                continue
            extra.add(line)
        if extra:
            log.info("whitelist: +%d команд (%s)", len(extra), ", ".join(sorted(extra)))
        return base | extra

    def load(self) -> None:
        self.ops = {}
        self.allowed_commands = self._load_whitelist()
        self._load_dir(self.directory, source="system")
        if self.user_dir is not None:
            self._load_dir(self.user_dir, source="user")

    def _load_dir(self, directory: Path, *, source: str) -> None:
        """Загружает каталог операций из directory.

        source="system" — id операции сохраняется как есть (ключ в self.ops).
        source="user"   — ключ с префиксом "user:", и файл НЕ может перезаписать
                          системную операцию (при коллизии id — invalid).
        source помещается в op["source"] и уходит наружу через public().
        """
        if not directory.exists():
            if source == "system":
                log.error("catalog dir missing: %s", directory)
            return
        prefix = "" if source == "system" else "user:"
        for path in sorted(directory.glob("*.yaml")):
            try:
                raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                op = self._parse(raw, path)
                op["source"] = source
                # user-операция не может перезаписать системную (по §6 HANDOFF).
                # Проверяем именно системную: op["id"] без префикса в self.ops.
                if source == "user" and op["id"] in self.ops:
                    raise ValueError(
                        f"id {op['id']!r} уже занят системной операцией — "
                        "user-операция не может её перезаписать"
                    )
                key = prefix + op["id"]
                # op["id"] должен совпадать с ключом в self.ops: именно
                # он уходит наружу через public() в /api/v1/operations,
                # сохраняется в reaction_rules.operation_id и
                # scheduled_checks.operation_id, и используется при
                # execute_op. Если оставить чистый "vpn_check" — get()
                # по нему не найдёт (ключ-то "user:vpn_check") и вся
                # цепочка проверок/реакций сломается.
                op["id"] = key
                if key in self.ops:
                    raise ValueError(
                        f"id {op['id']!r} уже загружен из {self.ops[key].get('file')}"
                    )
                self.ops[key] = op
            except Exception as e:  # noqa: BLE001 — invalid file must not crash process
                log.error("invalid catalog file %s: %s", path, e)
                # Ключ invalid должен быть уникален — иначе два битых файла
                # с одинаковым именем в system/ и user/ затрут друг друга.
                invalid_key = f"invalid:{path.name}"
                if invalid_key in self.ops:
                    invalid_key = f"invalid:{source}:{path.name}"
                self.ops[invalid_key] = {
                    "id": invalid_key,
                    "name": path.stem,
                    "error": str(e),
                    "file": path.name,
                    "valid": False,
                    "source": source,
                    "flags": _flags({}),
                    "params": [],
                }

    def _parse(self, raw: dict, path: Path) -> dict:
        oid = raw.get("id")
        if not oid or not isinstance(oid, str):
            raise ValueError("нет id")
        if not ID_RE.match(oid):
            raise ValueError(
                f"id {oid!r}: ожидается ^[a-z][a-z0-9_]{{0,63}}$ "
                "(нижний регистр, без ':', '/', пробелов)"
            )
        steps = raw.get("steps") or []
        if not steps or len(steps) > 20:
            raise ValueError("steps: 1..20")
        for group in (raw.get("preconditions") or [], steps, raw.get("postconditions") or []):
            for st in group:
                _check_template(st["command"], self.allowed_commands)
        for c in (raw.get("applicability") or {}).get("check_command") or []:
            _check_head(c, self.allowed_commands, ctx="check_command: ")
        return {
            "id": oid,
            "name": raw.get("name") or oid,
            "category": raw.get("category") or "other",
            "version": raw.get("version") or 1,
            "params": raw.get("params") or [],
            "flags": _flags(raw.get("flags")),
            "applicability": raw.get("applicability") or {},
            "preconditions": raw.get("preconditions") or [],
            "steps": steps,
            "postconditions": raw.get("postconditions") or [],
            "file": path.name,
            "valid": True,
            "error": None,
        }

    def list(self) -> list[dict]:
        return [self.public(op) for op in self.ops.values()]

    def get(self, oid: str) -> dict:
        op = self.ops.get(oid)
        if not op:
            raise AppError("E_NOT_FOUND", f"операция {oid} не найдена", status=404)
        if not op.get("valid"):
            raise AppError("E_OP_INVALID", op.get("error") or "операция невалидна", status=400)
        return op

    def public(self, op: dict) -> dict:
        return {
            "id": op["id"],
            "name": op["name"],
            "category": op.get("category"),
            "params": op.get("params") or [],
            "flags": op.get("flags") or {},
            "valid": op.get("valid", True),
            "error": op.get("error"),
            "source": op.get("source", "system"),
        }

    def catalog_ids(self) -> list[str]:
        return [k for k, v in self.ops.items() if v.get("valid")]
