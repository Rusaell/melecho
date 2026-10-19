from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import re
import secrets
import shlex as _shlex
import shutil
import signal
import socket
import stat as _stat
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from melecho.alerts import AlertEngine, fingerprint
from melecho.audit import append_audit, empty_head, sign_head, verify_integrity
import yaml

from melecho.catalog import CMD_NAME, ID_RE, INTERPRETER_CMDS, UNIT_RE, Catalog
from melecho.config import (
    AppConfig,
    list_profiles,
    load_config,
    profile_dir,
    write_active_profile,
)
from melecho.crypto import (
    AAD_LLM,
    aad_cred,
    aad_llm_profile,
    aad_passphrase,
    decrypt_secret,
    encrypt_secret,
    generate_audit_key,
    generate_dek,
    generate_salt,
    kdf_kek,
    unwrap_dek,
    wrap_dek,
)
from melecho.db import Database
from melecho.detector import Detector
from melecho.errors import AppError
from melecho.event_broker import EventBroker
from melecho.executor import (
    PathCache,
    bind_params,
    command_names_for,
    drop_sudo_prefix,
    redacted_argv,
    resolve_needed,
    run_step,
    sha256_text,
    step_wants_sudo,
    substitute_argv,
    wrap_locale,
)
from melecho.llm import (
    LLM_PRESETS,
    build_anomaly_prompt,
    build_chat_system_prompt,
    build_edit_rule_prompt,
    build_explain_alert_prompt,
    build_explain_rule_prompt,
    build_suggest_alert_prompt,
    build_suggest_operation_prompt,
    build_suggest_reaction_prompt,
    extract_yaml_block,
    parse_catalog_ids,
    prompt_hash,
    redact_log_excerpt,
    ttl_until,
    validate_base_url,
)
from melecho.metrics import (
    cpu_percent,
    disk_role,
    parse_findmnt_json,
    parse_free_b,
    parse_loadavg,
    parse_proc_net_dev,
    parse_proc_stat,
    parse_uptime,
    run_downsample,
)
from melecho.retention import run_all_retention
from melecho.ssh import (
    RealShell,
    SSHManager,
    _fetch_host_key,
    _fp_from_public_key,
    _present_host_key,
    connect_real,
)

log = logging.getLogger("melecho")

# ---- suggest-* SSE: модульные хелперы ----
#
# Языки fenced-блока, которые распознаёт построчный парсер. Согласовано
# с _YAML_BLOCK_RE в app/llm.py (```(?:yaml|yml|json)?[ \t]*\n(.*?)```).
# Пустая строка = ``` без языка.
# Языки fenced-блока, которые считаются «своими». Список согласован
# с _YAML_BLOCK_RE в app/llm.py (```(?:yaml|yml|json)?[ \t]*\n(.*?)```):
# стрим и финальный парсер должны распознавать один и тот же набор,
# иначе стрим покажет block, а final скажет «блок не найден».
#
# Всё остальное (```python, ```bash, случайное «```foobar» в тексте)
# блоком не считается и уходит в explanation как обычный chunk.
_FENCE_LANGS = ("yaml", "yml", "json")

# Пробелы до/после fence и языка; язык — ровно один из _FENCE_LANGS
# или отсутствует (пустой fence ```). Регистр не важен.
_FENCE_RE = re.compile(
    r"^\s*(?:`{3,}|~{3,})\s*(" + "|".join(_FENCE_LANGS) + r")?\s*$",
    re.IGNORECASE,
)


def _fence_lang(line: str) -> str | None:
    """Если строка — открывающий/закрывающий fence (``` или ~~~) с
    разрешённым языком или без него — вернуть язык (пустая строка = без
    языка). Иначе None.

    Правила:
      - поддерживает ``` и ~~~ (CommonMark разрешает оба);
      - язык — ровно один из _FENCE_LANGS, либо отсутствует;
      - регистр языка не важен;
      - ведущие/хвостовые пробелы допускаются;
      - строка ЦЕЛИКОМ должна быть fence'ом — иначе это обычный текст.

    Примеры:
      "```yaml"     → "yaml"
      "```YAML"     → "yaml"
      "```"         → ""
      "``` json"    → "json"
      "~~~yml"      → "yml"
      "```python"   → None
      "текст ```"   → None
    """
    m = _FENCE_RE.match(line)
    if m:
        lang = m.group(1)
        return (lang or "").lower()
    # Строка начинается с backtick-а, но fence не распознан (язык вне
    # _FENCE_LANGS, или после ``` есть мусор). Не ошибка: например,
    # ```python в примере кода — это обычный текст. debug-уровень,
    # чтобы не шуметь в проде при каждом explain/suggest.
    if line.lstrip().startswith("`"):
        log.debug("fence-like line not recognized: %r", line)
    return None


def _safe_prefix_len(buf: str) -> int:
    """Сколько символов с начала buf можно безопасно эмитить как обычный
    текст, не дожидаясь \n.

    0 = подождать: buf — пустой, из одних пробелов/табов, либо начинается
    с серии backtick/tilde (потенциальный fence). В любом из этих случаев
    следующая порция символов может превратить строку в fence.

    Иначе — начало точно не fence, эмитим целиком. За счёт этого длинные
    абзацы без переносов печатаются сразу, а не ждут ближайшего \n
    (Gemini/Gemma шлют первый абзац одним куском без внутренних \n;
    без этой функции мы его копили до первой строки блока YAML).
    """
    if not buf:
        return 0
    stripped = buf.lstrip(" \t")
    if not stripped:
        return 0
    first = stripped[0]
    if first in ("`", "~"):
        # Возможный fence. Даже с 3+ символами (``````inline``) держим
        # до \n — простой и предсказуемый критерий, редкий случай.
        return 0
    return len(buf)


def _sse_event(payload: dict) -> bytes:
    """Сериализует payload в SSE-событие: `data: <json>\n\n`."""
    return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")


# Поля AppConfig, которые зависят от профиля. Все остальные — процессные
# (http_port, bind, log_level, env_path, лимиты, llm, network, updates)
# — берутся из ПЕРВОГО конфига и не меняются при reload_for_profile.
# Без этого CLI-оверрайды из __main__ (например, --port) терялись бы
# при switch: load_config() в новом профиле возвращает дефолтный
# http_port=8765, а Perimeter сверяет Host с rt.cfg.http_port — и
# начинает отвергать все запросы с E_HOST.
_PROFILE_CFG_FIELDS = frozenset({
    "db_path", "audit_key_path", "data_dir",
    "catalog_user_dir", "profile_slug", "profile_name",
})


# Границы полей сервера. Защита от мусора из UI/CLI; не security-boundary
# против root на машине админа (у него всё равно есть доступ к БД).

# Hostname, IPv4, IPv6 (со скобками и без). Разрешаем буквы/цифры/._:- [].
# Длина 253 — максимум полного доменного имени по RFC 1035.
HOST_RE = re.compile(r"^[A-Za-z0-9._:\[\]\-]{1,253}$")

# Имя сервера в UI. Любые printable-символы, кроме control (нельзя "\x00",
# "\n", "\r", "\t"). Максимум 100 символов — в карточке больше не нужно.
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")

# POSIX-совместимое имя пользователя (как в /etc/passwd на Debian/Ubuntu).
# Без пробелов, кавычек, точек в начале.
USER_RE = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")


def _validate_host(host: str) -> str:
    host = (host or "").strip()
    if not host:
        raise AppError("E_PARAM", "host не может быть пустым", status=400)
    if not HOST_RE.match(host):
        raise AppError("E_PARAM", "host: недопустимые символы или слишком длинный", status=400)
    return host


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise AppError("E_PARAM", "name не может быть пустым", status=400)
    if not NAME_RE.match(name):
        raise AppError("E_PARAM", "name: управляющие символы или слишком длинное", status=400)
    return name


def _validate_user(user: str) -> str:
    user = (user or "").strip()
    if not user:
        raise AppError("E_PARAM", "user не может быть пустым", status=400)
    if not USER_RE.match(user):
        raise AppError("E_PARAM", "user: недопустимые символы", status=400)
    return user


def _validate_port(port) -> int:
    try:
        p = int(port)
    except (TypeError, ValueError) as e:
        raise AppError("E_PARAM", "port: целое число", status=400) from e
    if p < 1 or p > 65535:
        raise AppError("E_PARAM", "port должен быть в диапазоне 1..65535", status=400)
    return p


def now_z() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# Соответствие «окно → (ms, resolution)» для batch-эндпоинта.
# Должно совпадать с windowSpec в static/app.js.
_WINDOW_MS = {
    "15m": 900_000,
    "1h":  3_600_000,
    "24h": 86_400_000,
    "7d":  604_800_000,
}
_WINDOW_RES = {
    "15m": "30s",
    "1h":  "30s",
    "24h": "5m",
    "7d":  "5m",
}


def parse_z(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


class RateLimit:
    """Оконный rate-limit по строковому ключу.

    Ключи двух видов:
      - фиксированные ("unlock", "session", "sudo", "probe") — глобальные счётчики;
      - per-host ("probe:host.example") — для endpoint'ов, где клиент может
        указать произвольный host и превратить нас в сканер.

    Словарь `hits` держит историю меток времени по ключу. Чтобы не течь
    при большом числе уникальных хостов, раз в N добавлений проходит prune:
    удаляет ключи, у которых все метки старше окна.
    """

    MAX_KEYS = 10_000

    def __init__(self):
        self.hits: dict[str, list[float]] = {}

    def check(self, key: str, n: int, window: float = 60.0) -> None:
        t = time.monotonic()
        q = self.hits.setdefault(key, [])
        q[:] = [x for x in q if t - x < window]
        if len(q) >= n:
            raise AppError("E_RATE", "слишком много запросов", status=429)
        q.append(t)
        if len(self.hits) > self.MAX_KEYS:
            self._prune(t, window)

    def check_per_host(self, prefix: str, host: str, n: int, window: float = 60.0) -> None:
        """Per-host rate-limit. host приводится к lowercase (RFC 4343: DNS
        имена регистронезависимы), чтобы `EXAMPLE.com` и `example.com` не
        получали два независимых бюджета."""
        if not host:
            return
        self.check(f"{prefix}:{host.lower()}", n, window)

    def _prune(self, now: float, window: float) -> None:
        stale = []
        for k, q in self.hits.items():
            q[:] = [x for x in q if now - x < window]
            if not q:
                stale.append(k)
        for k in stale:
            self.hits.pop(k, None)


class Runtime:
    def __init__(self, cfg: AppConfig):
        """Общие для всех профилей поля + начальная загрузка активного
        профиля.

        Поля, которые НЕ зависят от профиля (EventBroker, RateLimit,
        настройки сессии, семафор операций, флаг завершения, очередь
        background-задач), живут в __init__ и НЕ трогаются при
        reload_for_profile (этап 2.2c). Всё профильное (БД, ключ аудита,
        catalog, detector, SSH-сессии, LLM, интернет-состояние) создаётся
        в _load_profile и освобождается в _unload_profile.
        """
        # --- Общие ресурсы процесса ---
        # EventBroker: in-memory pub/sub для SSE. Публикуем алерты,
        # реакции, метрики. Подписчики (SSE-клиенты) живут всю сессию
        # процесса — переживают смену профиля в 2.2c.
        self.events = EventBroker()
        # Rate-limit — общий на процесс; смысла сбрасывать при switch нет.
        self.rate = RateLimit()
        # Session-тайминги — процессные константы, не профильные.
        self.session_idle_sec = 12 * 3600
        self.session_abs_sec = 24 * 3600
        # Время старта процесса (не профиля) — для --status.
        self.started = now_z()
        # Семафор параллельных операций. Уровень процесса: ограничивает
        # нагрузку на CPU админа, не привязан к профилю.
        self.ops_sem = asyncio.Semaphore(cfg.max_parallel_ops)
        # Callback graceful shutdown. Устанавливается в __main__._serve()
        # после создания uvicorn.Server: ставит server.should_exit = True.
        self.on_shutdown_request = None
        self._shutdown_requested = False
        # Фоновые задачи (poll_loop, интернет-polling, update-polling).
        # Владелец — Runtime, не __main__: reload_for_profile (2.2c)
        # останавливает и запускает их при смене профиля.
        self._bg_tasks: list[asyncio.Task] = []
        # Флаг «Runtime завершается или перезагружается». SSE-генераторы
        # (/events/stream) ждут на нём вместе с q.get() и корректно
        # закрываются, не дожидаясь 25-секундного heartbeat-таймаута.
        # Без него uvicorn при Ctrl+C ждёт закрытия SSE до
        # timeout_graceful_shutdown=2 и убивает задачу через
        # Cancel — в логе остаётся «Exception in ASGI application».
        # start_background() очищает event при старте (важно для
        # reload_for_profile в 2.2c).
        self._shutdown_event = asyncio.Event()

        # --- Профиль ---
        self._load_profile(cfg)

    def _load_profile(self, cfg: AppConfig) -> None:
        """Создать все профильные ресурсы: БД, ключ аудита, catalog,
        detector, SSH-менеджер и промежуточное состояние.

        Вызывается из __init__ и из reload_for_profile (2.2c).
        При повторном вызове предыдущие ресурсы должны быть уже
        освобождены через _unload_profile — эта функция НЕ чистит за
        собой.
        """
        # Перенести процессные поля из предыдущего cfg. new_cfg приходит
        # из load_config(profile_slug=...) — там http_port/bind/log_level
        # дефолтные; CLI-оверрайды __main__ живут только в prev. Без
        # переноса rt.cfg.http_port «схлопывался» до 8765 и Perimeter
        # начинал отдавать E_HOST на все запросы с не-дефолтного порта.
        prev = getattr(self, "cfg", None)
        if prev is not None and prev is not cfg:
            for f in cfg.__dataclass_fields__:
                if f in _PROFILE_CFG_FIELDS:
                    continue
                try:
                    setattr(cfg, f, getattr(prev, f))
                except AttributeError:
                    pass
        self.cfg = cfg
        self.db = Database(cfg.db_path)
        self.alerts = AlertEngine(
            self.db,
            on_event=lambda topic, payload: self.events.publish(topic, payload),
        )
        # Пароль sudo в RAM (для режимов session / 30m / 2h / 8h).
        # None → не разблокирован. Профильное: автосудо хранит пароль
        # sudo конкретного пользователя, при смене профиля — сбрасываем.
        self._sudo_session_password: str | None = None
        self._sudo_session_until: float | None = None  # monotonic, None = без TTL (session)
        # user_dir + whitelist_file прокидываем в Catalog. user_dir=None
        # (теоретически возможно) означает «только системный каталог».
        # whitelist_file — файл внутри user_dir; добавляется к базовому
        # whitelist из config.toml (additive, см. Catalog._load_whitelist).
        _user_dir = cfg.catalog_user_dir
        self.catalog = Catalog(
            cfg.catalog_dir,
            cfg.catalog_allowed_commands,
            user_dir=_user_dir,
            whitelist_file=(_user_dir / "_whitelist.txt") if _user_dir else None,
        )
        # Реакции: создаём ПОСЛЕ catalog — ReactionEngine использует
        # runtime.catalog для проверки operation_id и чтения flags.
        from melecho.reactions import ReactionEngine
        self.reactions = ReactionEngine(self)
        self.detector = Detector(cfg)
        self.ssh = SSHManager()
        self.dek: bytes | None = None
        self.audit_key: bytes | None = None
        self.bootstrap: str | None = None
        self.bootstrap_exp = 0.0
        # Токен → {"created": monotonic, "seen": monotonic}.
        self.sessions: dict[str, dict] = {}
        self.sudo: dict[int, tuple[str, float]] = {}
        self.paths = PathCache()
        self.prev_cpu: dict[int, tuple[int, int]] = {}
        self.prev_net: dict[int, tuple[int, int]] = {}
        self.llm = None
        self.collect_errors: dict[int, str] = {}
        # Серверы, для которых collect_server уже сработал (успешно или нет)
        # в этой сессии. Stale-детектор смотрит только на них — иначе на
        # холодном старте он видит last_seen_at от прошлой сессии и создаёт
        # ложные «нет метрик» алерты ещё до первой попытки подключения.
        self._collected_servers: set[int] = set()
        self._retry_delay: dict[int, float] = {}
        self._next_collect: dict[int, float] = {}
        # S7+: один pre-flight host key на старте панели (после unlock).
        # Дешёвый probe + сравнение с known_hosts. При mismatch ставим
        # servers.host_key_mismatch_at, collect_server пропускает сервер.
        self._hostkey_preflight_done: bool = False
        self._down_at = 0.0
        self._retain_at = 0.0
        self._backlog_done = False
        # Состояние интернета. _internet_offline — что показываем в UI
        # (после успешной проверки). _internet_checking — идёт ли прямо
        # сейчас активная проверка (для спиннера). Кэш: результат
        # последнего handshake и до какого момента он считается свежим.
        self._internet_offline: bool = False
        self._internet_checking: bool = False
        self._internet_last_check_at: str | None = None
        self._internet_cache_result: bool = True
        self._internet_cache_until: float = 0.0
        # Backoff активного polling при offline: 5 → 10 → 20 → 30 сек.
        self._internet_poll_backoff: float = 0.0
        self._internet_poll_next_at: float = 0.0
        # Per-server offline. sid → now_z() когда сервер перестал отвечать.
        # Пока sid в этом словаре — collect_server его не трогает, а
        # scheduler/reactions/checks пропускают. Снимается при успешном
        # SSH-коннекте в poll_loop. Не путать с host_key_mismatch —
        # это отдельный, ручной случай.
        self._server_offline: dict[int, str] = {}
        # Состояние проверки обновлений.
        self._update_available: dict | None = None
        self._update_checking: bool = False
        self._update_error: str | None = None
        self._update_last_check_at: str | None = None
        self._update_apply_state: str | None = None
        self._init_audit_key()
        self._init_head()
        self._init_settings_defaults()
        self.mint_bootstrap()

    async def _unload_profile(self) -> None:
        """Освободить ресурсы активного профиля: закрыть SSH-сессии,
        закрыть БД, обнулить ссылки.

        Вызывается из reload_for_profile (2.2c), НЕ из __init__.
        Идемпотентна: повторный вызов на «пустом» профиле — no-op
        (все поля уже None).

        Порядок:
          1. ssh.drop_all() — до обнуления self.ssh, иначе потеряем
             ссылку на SSHManager до того, как закроем сессии.
          2. db.close() — до обнуления self.db.
          3. setattr None для всех профильных полей.

        Общие поля (events, rate, _bg_tasks, _shutdown_event, ...)
        НЕ трогаем — они живут весь процесс.
        """
        # 1. SSH: закрыть все живые сессии этого профиля.
        ssh = getattr(self, "ssh", None)
        if ssh is not None:
            try:
                await ssh.drop_all()
            except Exception:
                log.exception("_unload_profile: ssh.drop_all failed")
        # 2. БД: закрыть соединение.
        db = getattr(self, "db", None)
        if db is not None:
            try:
                db.close()
            except Exception:
                log.exception("_unload_profile: db.close failed")
        # 3. Обнулить ссылки. Спокойно, если поля не было.
        for name in (
            # "cfg" НЕ очищаем: _load_profile читает из него процессные
            # поля (http_port, bind, ...) для переноса на новый профиль.
            # self.cfg всегда указывает на конфиг активного профиля —
            # это и есть «источник процессных параметров».
            "db", "alerts", "reactions", "catalog", "detector", "ssh",
            "dek", "audit_key", "bootstrap", "sessions", "sudo",
            "paths", "prev_cpu", "prev_net", "llm", "collect_errors",
            "_collected_servers", "_retry_delay", "_next_collect",
            "_server_offline",
            "_sudo_session_password", "_sudo_session_until",
            "_internet_last_check_at", "_update_available",
            "_update_error", "_update_last_check_at", "_update_apply_state",
        ):
            setattr(self, name, None)
        # Простые типы — значениями по умолчанию.
        self.bootstrap_exp = 0.0
        self._hostkey_preflight_done = False
        self._down_at = 0.0
        self._retain_at = 0.0
        self._backlog_done = False
        self._internet_offline = False
        self._internet_checking = False
        self._internet_cache_result = True
        self._internet_cache_until = 0.0
        self._internet_poll_backoff = 0.0
        self._internet_poll_next_at = 0.0
        self._update_checking = False

    # ---------- переключение профиля (2.2c) ----------

    async def reload_for_profile(self, slug: str) -> None:
        """Переключиться на другой профиль «на лету».

        Порядок:
          1. Проверка: профиль существует; slug != текущий (иначе no-op).
          2. stop_background() — poll_loop и его соседи прекращают работу.
             Важно ДО _unload_profile: иначе poll_loop бросится в закрытую
             БД на следующем тике.
          3. _unload_profile() — SSH drop_all, db.close(), обнуление полей.
          4. load_config(profile_slug=slug) — новая конфигурация.
          5. write_active_profile(slug) — «последний использованный».
          6. _load_profile(new_cfg) — новая БД, catalog, detector.
          7. start_background() — снова три задачи.

        Сессии инвалидируются при _unload_profile (self.sessions = None),
        bootstrap пересоздаётся в _load_profile (mint_bootstrap). Эндпоинт
        /profiles/switch возвращает новый bootstrap, фронт делает reload
        с фрагментом URL — Root получает session заново.

        Идемпотентность: если slug == cfg.profile_slug, ничего не делаем.
        Это важно, потому что эндпоинт не должен «на всякий случай»
        перезапускать сокет, ронять SSE и т.д.
        """
        if slug == getattr(self.cfg, "profile_slug", None):
            return
        existing = {p["slug"] for p in list_profiles()}
        if slug not in existing:
            raise AppError(
                "E_PROFILE_NOT_FOUND", f"профиль {slug!r} не найден", status=404
            )
        log.info("reload_for_profile: %s → %s", self.cfg.profile_slug, slug)

        # 1. Остановить фоновые задачи ДО освобождения ресурсов.
        await self.stop_background()

        # 2. Освободить профильные ресурсы.
        await self._unload_profile()

        # 3. Загрузить конфиг для нового профиля.
        new_cfg = load_config(profile_slug=slug)

        # 4. Записать активный профиль ДО _load_profile — если внутри
        # что-то упадёт, следующий старт процесса возьмёт тот же профиль.
        write_active_profile(slug)

        # 5. Создать профильные ресурсы заново.
        self._load_profile(new_cfg)

        # 6. Поднять фоновые задачи.
        await self.start_background()
        log.info("reload_for_profile: переключено на %s", slug)

    async def delete_current_profile(self) -> None:
        """Удалить ТЕКУЩИЙ профиль и переключиться на первый оставшийся.

        Защита:
          - нельзя удалить последний профиль (после удаления панель
            не знала бы, какой профиль грузить при старте) — E_PROFILE_LAST;
          - активный профиль нельзя удалить, не переключившись —
            поэтому порядок: выбрать следующий → reload → rmtree
            старого каталога. Если rmtree упадёт, работающая панель
            уже на новом профиле — это безопаснее, чем остаться без
            профиля.

        Файлы профиля (БД, audit.key, manifest.json, catalog.d/)
        удаляются полностью. «Ой, я не то нажал» не откатить — на UI
        поэтому запрашиваем ввод имени профиля как подтверждение.
        """
        current_slug = self.cfg.profile_slug
        all_slugs = [p["slug"] for p in list_profiles()]
        others = [s for s in all_slugs if s != current_slug]
        if not others:
            raise AppError(
                "E_PROFILE_LAST",
                "нельзя удалить последний профиль",
                status=400,
            )
        # Стабильный порядок: первый по алфавиту. Если пользователь
        # удаляет default, а есть rabochiy — переключимся на rabochiy.
        target_slug = sorted(others)[0]
        log.info(
            "delete_current_profile: удаляю %s, переключаюсь на %s",
            current_slug, target_slug,
        )

        # 1-4. Переключиться на новый профиль (это перезапишет
        # active_profile и поднимет полный набор ресурсов).
        await self.reload_for_profile(target_slug)

        # 5. Удалить старый каталог. Если что-то пойдёт не так —
        # логируем, но не роняем панель: она уже работает на новом.
        old_dir = profile_dir(current_slug)
        try:
            shutil.rmtree(old_dir)
            log.info("delete_current_profile: удалён %s", old_dir)
        except Exception:
            log.exception("delete_current_profile: rmtree(%s) failed", old_dir)

    async def unload_for_logout(self) -> None:
        """«Выйти из профиля»: освободить ресурсы активного профиля и
        создать их заново для ТОГО ЖЕ slug.

        Зачем: пользователь хочет вернуться на стартовый экран, чтобы
        выбрать другой профиль (или тот же). При этом процесс backend
        продолжает работать — иначе нельзя будет выбрать профиль без
        перезапуска.

        Что делает: stop_background → _unload_profile → _load_profile
        (тот же slug) → start_background. Внешне похоже на
        reload_for_profile, но с двумя отличиями:
          - slug не меняется (перезагрузка того же профиля);
          - no-op НЕ делается: даже если slug тот же, DEK/SSH/БД
            сбрасываются — пользователь должен снова разблокировать.

        Что происходит с фронтом: сессия инвалидируется (sessions
        обнуляются в _unload_profile), bootstrap пересоздаётся в
        _load_profile. Возвращаем свежий bootstrap, фронт делает
        location.replace("/?pr=...#bootstrap=X") — полный reload,
        стартовый экран.

        active_profile НЕ меняется — остаётся «последним использованным»,
        как задумано (см. бриф). При F5 или следующем запуске панели
        пользователь увидит тот же профиль в селекте.
        """
        log.info("unload_for_logout: перезагрузка профиля %s", self.cfg.profile_slug)
        await self.stop_background()
        await self._unload_profile()
        # load_config() без аргумента прочитает active_profile — тот
        # же slug, что был.
        self._load_profile(load_config())
        await self.start_background()
        log.info("unload_for_logout: готово (профиль тот же)")

    async def export_profile_bytes(self, password: str) -> bytes:
        """Создаёт зашифрованный архив текущего профиля."""
        from melecho.profiles import export_profile_bytes as _export
        self.require_dek()
        if not isinstance(password, str) or len(password) < 12:
            raise AppError("E_PASSWORD", "пароль архива не короче 12 символов", status=400)
        try:
            return await asyncio.to_thread(
                _export, self.cfg.data_dir, self.dek, password,
            )
        except ValueError as e:
            raise AppError("E_PARAM", str(e), status=400) from e

    async def import_profile_bytes(
        self, data: bytes, password: str, profile_name: str | None,
    ) -> dict:
        """Импортирует профиль из архива и переключается на него."""
        from melecho.profiles import import_profile_bytes as _import
        if not isinstance(password, str) or len(password) < 12:
            raise AppError("E_PASSWORD", "пароль архива не короче 12 символов", status=400)
        existing = {p["slug"] for p in list_profiles()}
        try:
            res = await asyncio.to_thread(
                _import, data, password, existing, profile_name,
            )
        except ValueError as e:
            raise AppError("E_PARAM", str(e), status=400) from e
        await self.reload_for_profile(res["slug"])
        return {
            "slug": res["slug"],
            "name": res["name"],
            "bootstrap": self.bootstrap,
        }

    def rename_current_profile(self, name: str) -> dict:
        """Переименовать активный профиль. Меняет manifest.json + кэш
        имени в self.cfg (чтобы UI и логи видели новое имя без
        перезагрузки конфига).

        Slug (ключ каталога) не меняется. Процессный cfg пересоздавать
        не нужно: имя ни на что процессное не влияет.
        """
        from melecho.profiles import rename_profile
        try:
            res = rename_profile(self.cfg.profile_slug, name)
        except ValueError as e:
            raise AppError("E_PARAM", str(e), status=400) from e
        # Обновляем кэш в конфиге — иначе load_config вернёт старое имя
        # в текущей сессии до ближайшего switch/reload.
        self.cfg.profile_name = res["name"]
        log.info("profile %s переименован в %r", res["slug"], res["name"])
        return {"ok": True, "slug": res["slug"], "name": res["name"]}

    # ---------- bootstrap / audit init ----------

    # ---------- bootstrap / audit init ----------

    def _init_audit_key(self) -> None:
        path: Path = self.cfg.audit_key_path
        if self.cfg.no_audit:
            if path.exists():
                self.audit_key = path.read_bytes()
            return
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            key = generate_audit_key()
            path.write_bytes(key)
            os.chmod(path, 0o600)
            log.warning("создан ключ аудита %s (0600). Храните копию отдельно от БД.", path)
        data = path.read_bytes()
        if len(data) != 32:
            raise SystemExit("ключ аудита должен быть 32 байта")
        self.audit_key = data
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    async def _seed_builtin_alerts(self) -> None:
        """Создаёт built-in правила алертов, если их нет. Идемпотентно."""
        try:
            n = await self.alerts.ensure_builtin_rules()
            if n:
                log.info("alerts: создано %s built-in правил", n)
        except Exception:
            log.exception("не удалось создать built-in правила алертов")

    def _init_head(self) -> None:
        raw = self.db.get_setting("audit_head")
        if raw is None and self.audit_key is not None:
            head = sign_head(self.audit_key, empty_head())
            self.db.set_setting(
                "audit_head",
                json.dumps(head, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            )
            self.db.conn.commit()
        if self.db.get_setting("server_alias_counter") is None:
            self.db.set_setting("server_alias_counter", "0")
            self.db.conn.commit()

    def _init_settings_defaults(self) -> None:
        """Инициализация retention.* в settings (один раз при первом старте).

        Дефолты — из RULES в app/retention.py. Для метрик — one-time
        миграция со старых config.toml полей raw_retention_days /
        agg_retention_days, чтобы существующие установки не потеряли
        данные внезапно. После первого запуска config.toml в этих
        ключах больше не участвует — источник правды только settings.
        """
        from melecho.retention import RULES
        for rule in RULES:
            if self.db.get_setting(rule.key) is not None:
                continue
            value = rule.default_days
            if rule.key == "retention.metrics_raw_days" and self.cfg.raw_retention_days:
                value = int(self.cfg.raw_retention_days)
            elif rule.key == "retention.metrics_agg_days" and self.cfg.agg_retention_days:
                value = int(self.cfg.agg_retention_days)
            self.db.set_setting(rule.key, str(value))
        self.db.conn.commit()

    def mint_bootstrap(self) -> str:
        self.bootstrap = secrets.token_urlsafe(24)
        self.bootstrap_exp = time.monotonic() + 60
        return self.bootstrap

    # ---------- Проверка обновлений ----------
    #
    # opt-out: config.updates_check_on_start (дефолт true). HTTPS GET к
    # GitHub Releases API, timeout 2 сек, кэш 24 часа. Только для
    # git-клона. Для pipx/pip/flatpak/appimage/docker — UI показывает
    # команду обновления, кнопки «обновить сейчас» нет.

    def _update_read_cache(self) -> None:
        from melecho import update as _upd
        cached = _upd.read_cached_result()
        if not cached:
            return
        self._update_available = cached.get("available")
        self._update_error = cached.get("error")
        self._update_last_check_at = cached.get("checked_at")

    def _update_write_cache(self) -> None:
        from melecho import update as _upd
        _upd.write_cached_result({
            "available": self._update_available,
            "error": self._update_error,
            "checked_at": self._update_last_check_at,
        })

    async def _update_poll_loop(self) -> None:
        """Фоновый цикл. Раз в минуту проверяет: пора ли делать HTTP.
        Реальный HTTP — не чаще раза в сутки (по mtime кэша)."""
        from melecho import update as _upd
        try:
            self._update_read_cache()
        except Exception:
            log.exception("update: read cache failed")
        while True:
            try:
                await asyncio.sleep(60.0)
                if self.dek is None:
                    continue
                if not self._effective_updates_check_on_start():
                    continue
                if _upd.detect_install_kind() != "git":
                    continue
                if not _upd.should_check(self.cfg.updates_check_interval_hours):
                    continue
                await self._do_update_check()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("update-poll loop")

    async def _do_update_check(self) -> None:
        """Реальный HTTP к GitHub. Выставляет _update_available и кэш."""
        from melecho import update as _upd
        from melecho import __version__ as _ver
        self._update_checking = True
        try:
            tag = _upd.fetch_latest_version(self.cfg.updates_github_repo, 2.0)
            _upd.touch_cache()
            self._update_last_check_at = now_z()
            self._update_error = None
            if tag and _upd.is_newer(tag, _ver):
                self._update_available = {
                    "version": tag.lstrip("vV"),
                    "tag": tag,
                    "url": f"https://github.com/{self.cfg.updates_github_repo}/releases/tag/{tag}",
                }
                log.info("update: доступна версия %s (текущая %s)", tag, _ver)
            else:
                self._update_available = None
            self._update_write_cache()
            self.events.publish("update.available", {
                "available": self._update_available,
                "checking": False,
                "error": self._update_error,
                "last_check_at": self._update_last_check_at,
            })
        except Exception as e:
            self._update_error = str(e)[:200]
            log.exception("update: check failed")
        finally:
            self._update_checking = False

    def update_status(self) -> dict:
        from melecho import update as _upd
        kind = _upd.detect_install_kind()
        return {
            "check_on_start": self._effective_updates_check_on_start(),
            "install_kind": kind,
            "install_hint": _upd.install_hint(kind),
            "can_auto_update": kind == "git",
            "available": self._update_available,
            "checking": self._update_checking,
            "error": self._update_error,
            "last_check_at": self._update_last_check_at,
            "apply_state": self._update_apply_state,
        }

    async def check_updates_now(self) -> dict:
        """Ручная проверка (кнопка «Проверить сейчас»)."""
        self._update_checking = True
        self.events.publish("update.available", {
            "available": self._update_available,
            "checking": True,
            "error": None,
            "last_check_at": self._update_last_check_at,
        })
        try:
            await self._do_update_check()
        finally:
            self._update_checking = False
        return self.update_status()

    async def apply_update(self) -> dict:
        """git pull → pip install -e . --upgrade → graceful shutdown.
        Только для git-клона. При ошибке backend продолжает работать."""
        from melecho import update as _upd
        if _upd.detect_install_kind() != "git":
            raise AppError(
                "E_PARAM",
                "автообновление доступно только для git-клона",
                status=400,
            )
        if self._update_apply_state in ("git_pull", "pip_install"):
            raise AppError("E_STATE", "обновление уже выполняется", status=409)

        self._update_apply_state = "git_pull"
        self.events.publish("update.apply", {
            "state": "git_pull", "message": "git pull…",
        })
        rc, out, err = _upd.git_pull()
        if rc != 0:
            self._update_apply_state = "failed"
            msg = (err or out or f"git pull exit {rc}").strip()[:500]
            log.warning("update: git pull failed: %s", msg)
            self.events.publish("update.apply", {"state": "failed", "message": msg})
            return {"ok": False, "state": "failed", "message": msg}

        self._update_apply_state = "pip_install"
        self.events.publish("update.apply", {
            "state": "pip_install", "message": "pip install -e . --upgrade…",
        })
        rc2, out2, err2 = _upd.pip_install_editable_upgrade()
        if rc2 != 0:
            self._update_apply_state = "failed"
            msg = (err2 or out2 or f"pip exit {rc2}").strip()[-500:]
            log.warning("update: pip install failed: %s", msg)
            self.events.publish("update.apply", {"state": "failed", "message": msg})
            return {"ok": False, "state": "failed", "message": msg}

        self._update_apply_state = "done"
        self.events.publish("update.apply", {
            "state": "done", "message": "обновление установлено, перезапуск…",
        })
        asyncio.create_task(self.request_shutdown())
        return {"ok": True, "state": "done"}

    def _has_external_servers(self) -> bool:
        """Есть ли хоть один сервер с is_local=0.

        Если все серверы локальные — проверка интернета не имеет смысла:
        все они остаются доступны без внешнего интернета. Тогда
        _internet_poll_loop спит, internet_offline всегда false.
        """
        row = self.db.conn.execute(
            "SELECT 1 FROM servers WHERE is_local=0 LIMIT 1"
        ).fetchone()
        return row is not None

    def _effective_updates_check_on_start(self) -> bool:
        """Включена ли авто-проверка обновлений. UI может изменить
        через settings.updates_check_on_start (дефолт из cfg)."""
        v = self.db.get_setting("updates_check_on_start")
        if v is None:
            return bool(self.cfg.updates_check_on_start)
        return v == "1"

    def _effective_internet_check_host(self) -> str:
        """Хост для проверки интернета: override из settings или cfg.

        Пользователь может поменять из UI (Настройки → Сеть). Значение
        хранится в settings.internet_check_host как строка. Пустое/None
        → fallback на cfg (config.toml [network]).
        """
        v = self.db.get_setting("internet_check_host")
        if v and v.strip():
            return v.strip()
        return self.cfg.internet_check_host

    def _effective_internet_check_port(self) -> int:
        """Порт для проверки интернета: override из settings или cfg."""
        v = self.db.get_setting("internet_check_port")
        if v:
            try:
                n = int(v)
                if 1 <= n <= 65535:
                    return n
            except (TypeError, ValueError):
                pass
        return self.cfg.internet_check_port

    def _is_sid_blocked(
        self,
        sid: int,
        *,
        row=None,
        check_offline: bool = True,
        check_internet: bool = True,
    ) -> str | None:
        """Единая точка правды: заблокирован ли сервер сейчас.

        Возвращает код ошибки (E_SERVER_OFFLINE / E_NO_INTERNET) или None.

        check_offline  — учитывать _server_offline (сервер сам не отвечает);
        check_internet — учитывать _internet_offline для ВНЕШНИХ серверов
                         (is_local=0). Локальные серверы при глобальном
                         offline работают штатно.

        Использование:
          - collect_server: check_offline=False (poll_loop сам будит
            offline-серверы, периодически пробуя подключиться);
          - _run_rule_on_server, _flush_detector_alerts: обе проверки;
          - _check_stale_servers, _check_threshold_alerts: check_internet=False
            (для локальных серверов stale/threshold не должны блокироваться
            из-за отсутствия интернета — данные по ним свежие).
        """
        if check_offline and sid in self._server_offline:
            return "E_SERVER_OFFLINE"
        if check_internet and self._internet_offline:
            r = row if row is not None else self.get_server(sid)
            if not bool(r["is_local"] if "is_local" in r.keys() else False):
                return "E_NO_INTERNET"
        return None

    def _finish_internet_check(self, ok: bool) -> None:
        """Завершает проверку интернета одним событием: checking:false +
        offline=not ok.

        Раньше тут было два шага (checking=False, затем offline=...),
        и получалось промежуточное событие {checking:false, offline:true}
        между начальным {checking:true} и финальным {offline:false}.
        При быстром handshake (localhost, ~40мс) все три события летят
        почти одновременно; UI-обработчик успевал схлопнуть баннер по
        промежуточному, и финальное success-событие уже не срабатывало.
        Публикуем сразу финальное состояние.
        """
        changed = False
        if self._internet_checking:
            self._internet_checking = False
            changed = True
        target_offline = not ok
        if self._internet_offline != target_offline:
            self._internet_offline = target_offline
            changed = True
        if changed:
            self.events.publish("net.status", {
                "internet_offline": self._internet_offline,
                "internet_checking": self._internet_checking,
                "next_check_in_sec": self._internet_next_check_in_sec(),
            })

    def _internet_next_check_in_sec(self) -> int | None:
        """Сколько секунд до следующей авто-проверки. None — polling выключен.

        Вычисляется из _internet_poll_next_at (monotonic). Если сейчас
        идёт проверка (checking=True) — возвращаем 0 («прямо сейчас»).
        Клиент показывает это число как countdown рядом с кнопкой.
        """
        if not self._internet_offline:
            return None
        if self._internet_checking:
            return 0
        delta = self._internet_poll_next_at - time.monotonic()
        if delta < 0:
            return 0
        return int(delta) + 1

    def _set_internet_state(
        self, *, offline: bool | None = None, checking: bool | None = None,
    ) -> None:
        """Обновляет состояние интернета и публикует SSE-топик net.status
        при реальной смене. Идемпотентно: если ничего не изменилось —
        событие не шлётся."""
        changed = False
        if offline is not None and offline != self._internet_offline:
            self._internet_offline = offline
            changed = True
        if checking is not None and checking != self._internet_checking:
            self._internet_checking = checking
            changed = True
        if changed:
            self.events.publish("net.status", {
                "internet_offline": self._internet_offline,
                "internet_checking": self._internet_checking,
            })

    async def _internet_reachable(self, force: bool = False) -> bool:
        """TCP-handshake к cfg.internet_check_host:port. True = интернет есть.

        force=False: если в кэше свежий результат — возвращаем без сети.
        force=True: игнорируем кэш, делаем реальный handshake (кнопка
        «Проверить сейчас»). Всегда обновляет _internet_last_check_at.

        При force=True и включении сети сбрасываем backoff poll'а.

        ICMP не используем (часто блокируется провайдером), UDP — не даёт
        handshake. TCP к 1.1.1.1:53 (anycast) — самый дешёвый способ
        отличить «у меня нет интернета» от «сервер недоступен».

        Если все серверы помечены «локальные» — handshake не делаем,
        всегда возвращаем True. Иначе возникает цикл: SSH к локальному
        серверу фейлит (WiFi выкл), мы поднимаем глобальный флаг, а
        _internet_poll_loop сразу его сбрасывает (has_external=False).
        Мигание баннера в UI.
        """
        # Все серверы локальные → интернет для панели не важен.
        # Локальный сервер может быть недоступен по другой причине
        # (WiFi выкл, роутер упал), но это E_SERVER_OFFLINE, а не
        # E_NO_INTERNET.
        if not self._has_external_servers():
            return True
        now = time.monotonic()
        if not force and now < self._internet_cache_until:
            return self._internet_cache_result
        host = self._effective_internet_check_host()
        port = self._effective_internet_check_port()
        timeout = self.cfg.internet_check_timeout_sec
        t0 = time.monotonic()
        ok = False
        err_repr: str | None = None
        writer = None
        try:
            fut = asyncio.open_connection(host, port)
            _reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            err_repr = f"timeout after {timeout}s"
        except (socket.gaierror, OSError) as e:
            err_repr = repr(e)
        except Exception as e:
            err_repr = f"unexpected: {e!r}"
            log.exception("internet check: unexpected error")
        else:
            ok = True
            # Закрываем сокет. Ошибки тут не критичны (например,
            # соединение уже закрыто сервером), но не молчим.
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                log.debug("internet check: close writer failed", exc_info=True)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        # INFO, не WARNING: это нормальное событие, не ошибка. Нужно
        # для диагностики «почему панель считает интернет недоступным,
        # когда он есть» — поэтому не DEBUG. При log_level=INFO видно.
        log.info(
            "internet check: host=%s port=%s force=%s ok=%s elapsed=%dms err=%s",
            host, port, force, ok, elapsed_ms, err_repr or "-",
        )
        self._internet_cache_result = ok
        self._internet_cache_until = now + self.cfg.internet_check_cache_sec
        self._internet_last_check_at = now_z()
        # При возврате связи backoff сбрасывается — следующий возможный
        # offline снова начнёт с 5 секунд.
        if ok:
            self._internet_poll_backoff = 0.0
        # Состояние _internet_checking само не снимаем: это делает
        # вызывающий (check-internet endpoint или poll_loop-тик).
        return ok

    async def check_internet_now(self) -> dict:
        """Ручная проверка (кнопка «Проверить сейчас» в баннере).

        Ставит _internet_checking=true (UI покажет спиннер), делает
        handshake с force=True (игнор кэша), возвращает текущее состояние.
        """
        # Если нет внешних серверов — интернет для панели не важен,
        # сразу отвечаем «всё ок» без handshake. Это и семантически
        # правильно (нет точек отказа), и экономит ресурсы.
        if not self._has_external_servers():
            return {
                "ok": True,
                "internet_offline": False,
                "internet_checking": False,
                "internet_last_check_at": self._internet_last_check_at,
                "next_check_in_sec": None,
            }
        self._set_internet_state(checking=True)
        ok = await self._internet_reachable(force=True)
        # Одно финальное событие. См. _finish_internet_check.
        self._finish_internet_check(ok)
        # Если всё ещё offline — сбрасываем backoff до минимума.
        # Ручная проверка — «показать попытку сейчас», логично что
        # следующая авто-проверка не ждёт 30 сек после долгого offline,
        # а начинается с 5 сек. При успехе backoff уже сброшен внутри
        # _internet_reachable (ok=True).
        if not ok:
            self._internet_poll_backoff = 0.0
            self._internet_poll_next_at = (
                time.monotonic() + self.cfg.internet_check_poll_sec_min
            )
        # Ещё раз публикуем net.status с обновлённым countdown — ручной
        # вызов не менял _internet_offline (если уже был true), значит
        # _set_internet_state выше не сгенерировал событие, а next_check
        # изменился.
        self.events.publish("net.status", {
            "internet_offline": self._internet_offline,
            "internet_checking": self._internet_checking,
            "next_check_in_sec": self._internet_next_check_in_sec(),
        })
        return {
            "ok": ok,
            "internet_offline": self._internet_offline,
            "internet_checking": self._internet_checking,
            "internet_last_check_at": self._internet_last_check_at,
            "next_check_in_sec": self._internet_next_check_in_sec(),
        }

    def _signal_shutdown(self) -> None:
        """Синхронный сигнал SSE-генераторам — вызывается из обработчика
        сигналов (SIGTERM/SIGINT) через loop.call_soon_threadsafe.

        Отдельный метод нужен, потому что request_shutdown — async
        (drop_all SSH), а сигнал обрабатывается в sync-контексте.
        """
        self._shutdown_event.set()

    async def request_shutdown(self) -> None:
        """Graceful shutdown: закрыть SSH-сессии и попросить uvicorn
        завершиться (should_exit = True).

        Вызывается из POST /session/logout {stop_backend: true}.
        Идемпотентно: повторный вызов — no-op.

        Fallback: если uvicorn не завершится за 3 секунды — посылаем
        себе SIGTERM. uvicorn перехватывает SIGTERM и делает graceful
        shutdown; этот путь отлажен — `melecho --stop` работает именно
        так. Fallback нужен, потому что на живом стенде были случаи,
        когда after `should_exit=True` процесс не завершался.
        """
        if self._shutdown_requested:
            log.info("request_shutdown: уже запрошено ранее, пропускаем")
            return
        self._shutdown_requested = True
        # Сигнал SSE-генераторам: закрывайтесь. Без него uvicorn ждёт
        # закрытия соединений до timeout_graceful_shutdown=2 и убивает
        # их Cancel'ом — в логе «Exception in ASGI application».
        self._shutdown_event.set()
        log.info("request_shutdown: начало graceful shutdown по запросу из UI")
        try:
            await self.ssh.drop_all()
            log.info("request_shutdown: SSH-сессии закрыты")
        except Exception:
            log.exception("request_shutdown: drop_all failed")
        cb = self.on_shutdown_request
        if cb is None:
            log.warning(
                "request_shutdown: on_shutdown_request не установлен "
                "(тестовый режим?) — процесс не остановится сам, только SSH закрыты",
            )
        else:
            try:
                cb()
                log.info("request_shutdown: server.should_exit=True отправлен")
            except Exception:
                log.exception("on_shutdown_request callback failed")

        # Fallback: 3 секунды — с запасом хватит, чтобы uvicorn спокойно
        # завершил работу при рабочем should_exit. Если по какой-то
        # причине этого не произошло — завершаемся через SIGTERM,
        # который uvicorn перехватывает сам (см. --stop).
        def _fallback_sigterm():
            log.warning(
                "request_shutdown: uvicorn не завершился за 3с, "
                "шлём SIGTERM себе (pid=%s)",
                os.getpid(),
            )
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            except Exception:
                log.exception("request_shutdown: не удалось послать SIGTERM")

        try:
            asyncio.get_running_loop().call_later(3.0, _fallback_sigterm)
        except RuntimeError:
            # Нет running loop — не должно происходить, но не падаем.
            log.warning("request_shutdown: нет running loop, fallback не установлен")

    async def start_background(self) -> None:
        """Запустить фоновые задачи: poll_loop, активный polling
        интернета, проверка обновлений.

        Идемпотентно: повторный вызов — no-op (задачи уже живы).
        Вызывается из __main__._serve() и из reload_for_profile().
        """
        if self._bg_tasks:
            return
        # При reload_for_profile (2.2c) stop_background уже поставил event —
        # сбрасываем, иначе новые SSE-клиенты закроются мгновенно.
        self._shutdown_event.clear()
        self._bg_tasks = [
            asyncio.create_task(self.poll_loop(), name="melecho.poll_loop"),
            asyncio.create_task(self._internet_poll_loop(), name="melecho.internet_poll"),
            asyncio.create_task(self._update_poll_loop(), name="melecho.update_poll"),
        ]

    async def stop_background(self) -> None:
        """Остановить фоновые задачи и дождаться их завершения.
        Идемпотентно: повторный вызов — no-op.

        Порядок: сначала cancel всем, потом await каждому. Если задача
        сейчас внутри await — CancelledError вылетит из текущей await'а,
        задача завершится; await t поймает CancelledError.
        """
        # Сигнал SSE-клиентам: закрывайтесь. Идёт до cancel'ов, чтобы
        # события в /events/stream успели среагировать и завершиться
        # сами, а не через CancelledError.
        self._shutdown_event.set()
        tasks = self._bg_tasks
        self._bg_tasks = []
        if not tasks:
            return
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("background task failed on shutdown")

    def invalidate_bootstrap(self) -> str:
        return self.mint_bootstrap()

    def first_run(self) -> bool:
        return self.db.get_setting("encrypted_dek") is None

    def locked(self) -> bool:
        return self.dek is None and not self.first_run()

    def lock_until(self) -> str | None:
        return self.db.get_setting("unlock_locked_until_utc")

    def is_lockout(self) -> bool:
        until = self.lock_until()
        if not until:
            return False
        return parse_z(until) > datetime.now(timezone.utc)

    async def audit(self, row: dict) -> None:
        key = self.audit_key
        no = self.cfg.no_audit

        def fn(conn):
            return append_audit(conn, key, no, row)

        await self.db.mutate(fn)

    def integrity(self) -> dict:
        if self.cfg.no_audit:
            return {"ok": True, "code": "AUDIT_DISABLED", "message": "режим --no-audit: записи не пишутся"}
        return verify_integrity(self.db.conn, self.audit_key)

    def session_create(self, token_in: str) -> str:
        now = time.monotonic()
        if not self.bootstrap or token_in != self.bootstrap or now > self.bootstrap_exp:
            raise AppError("E_BOOTSTRAP", "bootstrap недействителен или истёк", status=401)
        self.bootstrap = None
        sess = secrets.token_urlsafe(32)
        now = time.monotonic()
        self.sessions[sess] = {"created": now, "seen": now}
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if runtime_dir:
            p = Path(runtime_dir) / "melecho.token"
            try:
                p.write_text(sess, encoding="utf-8")
                os.chmod(p, 0o600)
            except OSError:
                pass
        return sess

    def session_valid(self, token: str) -> bool:
        """Проверяет токен и обновляет last_seen. Возвращает False при
        истечении idle-TTL или absolute-TTL; просроченный токен удаляется."""
        if not token:
            return False
        s = self.sessions.get(token)
        if s is None:
            return False
        now = time.monotonic()
        if now - s["created"] > self.session_abs_sec:
            self.sessions.pop(token, None)
            return False
        if now - s["seen"] > self.session_idle_sec:
            self.sessions.pop(token, None)
            return False
        s["seen"] = now
        return True

    def session_logout(self, token: str) -> bool:
        return self.sessions.pop(token, None) is not None

    def prune_sessions(self) -> int:
        """Удаляет просроченные сессии. Вызывается из poll_loop."""
        now = time.monotonic()
        dead = [
            t
            for t, s in self.sessions.items()
            if now - s["created"] > self.session_abs_sec or now - s["seen"] > self.session_idle_sec
        ]
        for t in dead:
            self.sessions.pop(t, None)
        return len(dead)

    # ---------- unlock ----------

    async def unlock(self, password: str, confirm: str | None) -> dict:
        if self.is_lockout():
            raise AppError("E_LOCKED", "слишком много попыток, подождите", status=423)
        t0 = time.monotonic()
        if self.first_run():
            if confirm is None or password != confirm:
                raise AppError("E_CONFIRM", "пароли не совпадают", status=400)
            if len(password) < 12:
                raise AppError("E_PASSWORD", "мастер-пароль не короче 12 символов", status=400)
            salt = generate_salt()
            kek = kdf_kek(password, salt)
            dek = generate_dek()
            blob = wrap_dek(kek, dek)

            def fn(conn):
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("kdf_salt", salt.hex()),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("encrypted_dek", blob),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("kdf_params_version", "1"),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("crypto_format_version", "1"),
                )
                append_audit(
                    conn,
                    self.audit_key,
                    self.cfg.no_audit,
                    {
                        "action": "unlock.init",
                        "actor": "admin",
                        "command": None,
                        "duration_ms": int((time.monotonic() - t0) * 1000),
                        "interrupted": False,
                        "operation_id": None,
                        "result_hash": None,
                        "result_meta": None,
                        "server_id": None,
                        "sudo_used": False,
                        "timestamp_utc": now_z(),
                    },
                )

            await self.db.mutate(fn)
            self.dek = dek
            self._apply_llm()
            self._replay_detector_from_db()
            return {"ok": True, "first_run": True}
        failed = int(self.db.get_setting("unlock_failed_count") or "0")
        delays = [1, 2, 4, 8, 16]
        salt_hex = self.db.get_setting("kdf_salt")
        blob = self.db.get_setting("encrypted_dek")
        if not salt_hex or not blob:
            raise AppError("E_STATE", "повреждены параметры KDF", status=500)
        try:
            kek = kdf_kek(password, bytes.fromhex(salt_hex))
            dek = unwrap_dek(kek, blob)
        except Exception:
            failed += 1
            delay = delays[min(failed - 1, len(delays) - 1)]

            def fn(conn):
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('unlock_failed_count', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(failed),),
                )
                if failed >= self.cfg.unlock_max_attempts:
                    until = (datetime.now(timezone.utc) + timedelta(minutes=self.cfg.unlock_lock_minutes)).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    )
                    conn.execute(
                        "INSERT INTO settings(key, value) VALUES ('unlock_locked_until_utc', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (until,),
                    )

            await self.db.mutate(fn)
            await asyncio.sleep(delay)
            raise AppError("E_UNLOCK", "неверный мастер-пароль", status=401)
        self.dek = dek

        def ok(conn):
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('unlock_failed_count', '0') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            )
            conn.execute("DELETE FROM settings WHERE key = 'unlock_locked_until_utc'")
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "unlock.success",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(ok)
        await self._migrate_legacy_llm_settings()
        self._apply_llm()
        self.sudo_autoload()
        self._replay_detector_from_db()
        return {"ok": True, "first_run": False}

    async def change_master_password(
        self,
        old_password: str,
        new_password: str,
        confirm: str,
    ) -> dict:
        """Сменить мастер-пароль.

        DEK НЕ меняется. Меняется только его обёртка (KEK):
          - новая соль (generate_salt → 16 случайных байт);
          - wrap_dek(new_kek, dek) → новый blob в settings.encrypted_dek.

        Что это даёт: DEK — источник для расшифровки всех кредов в БД
        (SSH-пароли, passphrase, LLM-ключи, sudo-disk). Если бы DEK
        менялся, пришлось бы пройтись по всем ciphertext'ам и
        перешифровать. Меняя только KEK, мы избегаем массовой миграции:
        содержимое БД остаётся как есть, читается тем же DEK, только
        получить DEK теперь можно лишь по новому мастер-паролю.

        Сессии НЕ инвалидируются: старый/новый пароль — способ получить
        DEK при unlock, а он уже получен и лежит в self.dek. Смена
        пароля не влияет ни на SSH-соединения, ни на реакций, ни на LLM.

        Ошибка расшифровки старого пароля → E_UNLOCK (консистентно с
        /unlock). Без счётчика неудач и lockout: предполагается, что
        пользователь уже аутентифицирован (require_dek прошёл), это
        не атака на вход, а защита от опечатки.
        """
        if not isinstance(old_password, str) or not old_password:
            raise AppError("E_PARAM", "старый пароль: непустая строка", status=400)
        if not isinstance(new_password, str):
            raise AppError("E_PARAM", "новый пароль: строка", status=400)
        if len(new_password) < 12:
            raise AppError(
                "E_PASSWORD", "мастер-пароль не короче 12 символов", status=400
            )
        if new_password != confirm:
            raise AppError("E_CONFIRM", "пароли не совпадают", status=400)
        if new_password == old_password:
            raise AppError(
                "E_PARAM", "новый пароль совпадает со старым", status=400
            )

        salt_hex = self.db.get_setting("kdf_salt")
        blob = self.db.get_setting("encrypted_dek")
        if not salt_hex or not blob:
            raise AppError("E_STATE", "повреждены параметры KDF", status=500)

        # 1. Расшифровать DEK старым паролем.
        try:
            old_kek = kdf_kek(old_password, bytes.fromhex(salt_hex))
            dek = unwrap_dek(old_kek, blob)
        except Exception:
            raise AppError("E_UNLOCK", "неверный мастер-пароль", status=401)

        # 2. Обернуть тем же DEK под новый пароль.
        new_salt = generate_salt()
        new_kek = kdf_kek(new_password, new_salt)
        new_blob = wrap_dek(new_kek, dek)

        # 3. Записать в одной транзакции. INSERT ... ON CONFLICT —
        # чтобы не полагаться на «строки точно есть»: если БД испорчена
        # и строки нет, UPDATE молча ничего не сделает, а INSERT создаст.
        t0 = time.monotonic()

        def fn(conn):
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('kdf_salt', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (new_salt.hex(),),
            )
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('encrypted_dek', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (new_blob,),
            )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "master_password.change",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        log.info("master_password: смена выполнена (DEK сохранён)")
        return {"ok": True}

    def require_dek(self) -> bytes:
        if self.dek is None:
            raise AppError("E_LOCKED", "сначала разблокируйте хранилище", status=401)
        return self.dek

    def next_alias(self, conn) -> str:
        n = int(self.db.get_setting("server_alias_counter") or "0") + 1
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('server_alias_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(n),),
        )
        return f"server-{n}"

    # ---------- servers CRUD ----------

    async def add_server(self, body: dict) -> dict:
        dek = self.require_dek()
        name = _validate_name(body.get("name"))
        host = _validate_host(body.get("host"))
        user = _validate_user(body.get("user"))
        port = _validate_port(body.get("port") or 22)
        os_family = body.get("os_family") or "ubuntu"
        auth_type = body.get("auth_type") or "key"
        if os_family not in {"debian", "ubuntu"}:
            raise AppError("E_PARAM", "os_family: debian|ubuntu", status=400)
        if auth_type not in {"password", "key"}:
            raise AppError("E_PARAM", "auth_type: password|key", status=400)
        # is_local: флаг «локальный сервер». Дефолт False (внешний) —
        # консервативно. Пользователь осознанно ставит ON, если сервер
        # остаётся доступен без внешнего интернета (localhost, LAN,
        # VPN-туннель, extranet).
        is_local = bool(body.get("is_local", False))
        n = self.db.conn.execute("SELECT COUNT(*) AS c FROM servers").fetchone()["c"]
        if n >= self.cfg.max_servers:
            raise AppError("E_LIMIT", "лимит серверов", status=400)
        secret = (body.get("credential") or body.get("password") or "").encode("utf-8")
        passphrase = (body.get("passphrase") or "") or None
        key_path = os.path.expanduser((body.get("key_path") or "").strip())
        # Правило: должен быть хотя бы один способ аутентификации — ключ
        # или пароль. connect_real сам выберет приоритет, если есть оба
        # (publickey → keyboard-interactive → password). auth_type в
        # connect_real не участвует в ветвлении, только в UI.
        if not key_path and not secret:
            raise AppError(
                "E_PARAM",
                "укажите файл ключа или пароль пользователя",
                status=400,
            )
        # Если файл ключа указан — он должен существовать. Это не даёт
        # опечатке в пути «молча» превратиться в password-only.
        if key_path and not Path(key_path).is_file():
            raise AppError("E_KEY", f"файл ключа не найден: {key_path}", status=400)

        # A2.1: hostkey_mode = legacy | later | confirmed
        hostkey_mode = (body.get("hostkey_mode") or "legacy").strip()
        if hostkey_mode not in {"legacy", "later", "confirmed"}:
            raise AppError("E_PARAM", "hostkey_mode: legacy|later|confirmed", status=400)
        hk_fp = None
        hk_type = None
        hk_pub = None
        if hostkey_mode == "confirmed":
            hk_fp = (body.get("fingerprint_sha256") or "").strip()
            hk_type = (body.get("key_type") or "").strip() or "ssh-ed25519"
            hk_pub = (body.get("public_key") or "").strip()
            if not hk_fp or not hk_pub:
                raise AppError("E_PARAM", "для hostkey_mode=confirmed нужны fingerprint_sha256 и public_key", status=400)
            fp_from_pub = _fp_from_public_key(hk_pub)
            if fp_from_pub != hk_fp:
                raise AppError(
                    "E_HOSTKEY",
                    "fingerprint не совпадает с public_key — отказ",
                    status=400,
                    details={"fingerprint_sha256": fp_from_pub or "?", "stored": hk_fp},
                )

        def fn(conn):
            # host key принадлежит машине (host:port), а не серверу.
            # Два сервера на одном host:port делят один отпечаток, что сбивает
            # UX (см. историю тестирования). Запрещаем дубликат.
            existing = conn.execute(
                "SELECT id, name FROM servers WHERE host=? AND port=?",
                (host, port),
            ).fetchone()
            if existing:
                raise AppError(
                    "E_DUPLICATE",
                    f"сервер {host}:{port} уже добавлен как «{existing['name']}» (id={existing['id']}). "
                    f"Удалите старую запись или измените её имя.",
                    status=400,
                )
            alias = self.next_alias(conn)
            cur = conn.execute(
                """INSERT INTO servers(name, llm_alias, host, port, user, auth_type,
                   allowed_units, os_family, key_path, created_at, credential_version, passphrase_version,
                   is_local)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (name, alias, host, port, user, auth_type, "[]", os_family, key_path or None, now_z(), 1, 1,
                 1 if is_local else 0),
            )
            sid = cur.lastrowid
            if secret:
                nonce, ct = encrypt_secret(dek, secret, aad_cred(sid, 1))
                conn.execute(
                    "UPDATE servers SET encrypted_credential=?, credential_nonce=? WHERE id=?",
                    (ct, nonce, sid),
                )
            if passphrase:
                nonce, ct = encrypt_secret(dek, passphrase.encode("utf-8"), aad_passphrase(sid, 1))
                conn.execute(
                    "UPDATE servers SET encrypted_passphrase=?, passphrase_nonce=? WHERE id=?",
                    (ct, nonce, sid),
                )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "server.create",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"hostkey_mode": hostkey_mode},
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )
            if hostkey_mode == "confirmed":
                conn.execute(
                    """INSERT INTO known_hosts(host, port, key_type, public_key, fingerprint_sha256, added_at, confirmed_by, is_active)
                       VALUES (?,?,?,?,?,?,?,1)""",
                    (host, port, hk_type, hk_pub, hk_fp, now_z(), "admin"),
                )
                append_audit(
                    conn,
                    self.audit_key,
                    self.cfg.no_audit,
                    {
                        "action": "hostkey.confirm",
                        "actor": "admin",
                        "command": None,
                        "duration_ms": 0,
                        "interrupted": False,
                        "operation_id": None,
                        "result_hash": None,
                        "result_meta": {"hostkey_mode": "at_create"},
                        "server_id": sid,
                        "sudo_used": False,
                        "timestamp_utc": now_z(),
                    },
                )
            return sid, alias

        sid, alias = await self.db.mutate(fn)
        return self.public_server(self.db.conn.execute("SELECT * FROM servers WHERE id=?", (sid,)).fetchone())

    def public_server(self, row) -> dict:
        if row is None:
            raise AppError("E_NOT_FOUND", "сервер не найден", status=404)
        d = dict(row)
        for k in (
            "encrypted_credential",
            "credential_nonce",
            "encrypted_passphrase",
            "passphrase_nonce",
        ):
            d.pop(k, None)
        d["allowed_units"] = json.loads(d.get("allowed_units") or "[]")
        d["key_path"] = d.get("key_path") or ""
        d["has_credential"] = bool(row["encrypted_credential"])
        d["has_passphrase"] = bool(row["encrypted_passphrase"])
        d["hostkey"] = bool(self.active_host_key(row["host"], row["port"]))
        # nproc: NULL до первого успешного сбора. Используется для
        # нормировки порога load_1m.
        d["nproc"] = row["nproc"] if "nproc" in row.keys() else None
        # is_local: флаг «локальный сервер». Внешние блокируются при
        # internet_offline, локальные — продолжают работать.
        d["is_local"] = bool(row["is_local"]) if "is_local" in row.keys() else False
        # collect_error — последняя ошибка сбора метрик (для бейджа
        # «недоступен»). Раньше заполнялось только в dashboard(); теперь
        # и здесь — UI-бейдж используется и на детальной странице сервера.
        d["collect_error"] = self.collect_errors.get(row["id"])
        # anomaly — есть ли активная аномалия по любой метрике сервера.
        # Detector держит состояние в памяти; после рестарта сбрасывается
        # (replay из БД частично восстанавливает).
        st = self.detector.state.get(row["id"]) or {}
        d["anomaly"] = any(v.anomaly for v in st.values())
        return d

    def get_server(self, sid: int):
        row = self.db.conn.execute("SELECT * FROM servers WHERE id=?", (sid,)).fetchone()
        if not row:
            raise AppError("E_NOT_FOUND", "сервер не найден", status=404)
        return row

    def active_host_key(self, host: str, port: int):
        return self.db.conn.execute(
            "SELECT * FROM known_hosts WHERE host=? AND port=? AND is_active=1",
            (host, port),
        ).fetchone()

    async def patch_server(self, sid: int, body: dict) -> dict:
        self.require_dek()
        row = self.get_server(sid)
        name = body.get("name")
        dek = self.dek

        def fn(conn):
            changed: list[str] = []
            if name:
                conn.execute("UPDATE servers SET name=? WHERE id=?", (_validate_name(name), sid))
                changed.append("name")
            # is_local: toggle в Настройках сервера. Принимаем строго bool.
            if "is_local" in body and body.get("is_local") is not None:
                il = body["is_local"]
                if not isinstance(il, bool):
                    raise AppError("E_PARAM", "is_local: true|false", status=400)
                conn.execute(
                    "UPDATE servers SET is_local=? WHERE id=?",
                    (1 if il else 0, sid),
                )
                changed.append("is_local")
            if "user" in body and body.get("user") is not None:
                conn.execute(
                    "UPDATE servers SET user=? WHERE id=?",
                    (_validate_user(body["user"]), sid),
                )
                changed.append("user")
            if "auth_type" in body and body.get("auth_type") is not None:
                at = str(body["auth_type"]).strip()
                if at not in {"key", "password"}:
                    raise AppError("E_PARAM", "auth_type: key|password", status=400)
                conn.execute("UPDATE servers SET auth_type=? WHERE id=?", (at, sid))
                changed.append("auth_type")
            # credential: пустая строка = явная очистка (не «не трогать»).
            # Раньше условие if body.get("credential"): молча игнорировало "".
            if "credential" in body:
                cred = body.get("credential") or ""
                if cred:
                    ver = (row["credential_version"] or 1) + 1
                    nonce, ct = encrypt_secret(
                        dek, str(cred).encode("utf-8"), aad_cred(sid, ver),
                    )
                    conn.execute(
                        "UPDATE servers SET encrypted_credential=?, credential_nonce=?, credential_version=? WHERE id=?",
                        (ct, nonce, ver, sid),
                    )
                    changed.append("credential")
                else:
                    conn.execute(
                        "UPDATE servers SET encrypted_credential=NULL, credential_nonce=NULL WHERE id=?",
                        (sid,),
                    )
                    changed.append("credential_cleared")
            # key_path: None = не трогать; "" = очистить; иначе — валидный путь.
            if "key_path" in body and body.get("key_path") is not None:
                kp = os.path.expanduser(str(body.get("key_path") or "").strip())
                if kp and not Path(kp).is_file():
                    raise AppError("E_KEY", f"файл ключа не найден: {kp}", status=400)
                conn.execute("UPDATE servers SET key_path=? WHERE id=?", (kp or None, sid))
                changed.append("key_path")
            # passphrase: пустая строка = явная очистка.
            if "passphrase" in body:
                pp = body.get("passphrase") or ""
                if pp:
                    ver = (row["passphrase_version"] or 1) + 1
                    nonce, ct = encrypt_secret(
                        dek, str(pp).encode("utf-8"), aad_passphrase(sid, ver),
                    )
                    conn.execute(
                        "UPDATE servers SET encrypted_passphrase=?, passphrase_nonce=?, passphrase_version=? WHERE id=?",
                        (ct, nonce, ver, sid),
                    )
                    changed.append("passphrase")
                else:
                    conn.execute(
                        "UPDATE servers SET encrypted_passphrase=NULL, passphrase_nonce=NULL WHERE id=?",
                        (sid,),
                    )
                    changed.append("passphrase_cleared")
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "server.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"fields": changed} if changed else None,
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        # сбрасываем SSH-сессию — креды могли поменяться
        await self.ssh.drop(sid)
        self.paths.invalidate(sid)
        return self.public_server(self.get_server(sid))

    async def delete_server(self, sid: int) -> dict:
        row = self.get_server(sid)
        host, port = row["host"], row["port"]
        self._collected_servers.discard(sid)

        def fn(conn):
            conn.execute("DELETE FROM servers WHERE id=?", (sid,))
            # host key принадлежит машине, но после удаления единственного сервера
            # на этом host:port он теряет смысл — иначе следующий сервер «унаследует»
            # уже подтверждённый отпечаток без явного согласия пользователя.
            conn.execute("DELETE FROM known_hosts WHERE host=? AND port=?", (host, port))
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "server.delete",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        await self.ssh.drop(sid)
        self.paths.invalidate(sid)
        self.detector.reset_server(sid)
        self.collect_errors.pop(sid, None)
        # Закрываем активные алерты сервера — иначе висят вечно с чужим
        # server_id, и мусорят в списке.
        try:
            n = await self.alerts.dismiss_for_server(sid, by="auto")
            if n:
                log.info("alerts: закрыто %s алертов удалённого сервера %s", n, sid)
        except Exception:
            log.exception("dismiss_for_server failed sid=%s", sid)
        return {"ok": True}

    # ---------- creds ----------

    def _cred_bytes(self, row) -> tuple[bytes, bytes | None]:
        dek = self.require_dek()
        secret = b""
        if row["encrypted_credential"] and row["credential_nonce"]:
            secret = decrypt_secret(
                dek,
                row["credential_nonce"],
                row["encrypted_credential"],
                aad_cred(row["id"], row["credential_version"] or 1),
            )
        pp = None
        if row["encrypted_passphrase"] and row["passphrase_nonce"]:
            pp = decrypt_secret(
                dek,
                row["passphrase_nonce"],
                row["encrypted_passphrase"],
                aad_passphrase(row["id"], row["passphrase_version"] or 1),
            )
        return secret, pp

    # Приватный ключ OpenSSH/ed25519/RSA редко превышает 10 KiB.
    # 64 KiB — большой запас: защищаемся от того, что по ошибке указан
    # большой файл (или подсунут симлинк на /dev/urandom).
    MAX_KEY_FILE_BYTES = 64 * 1024

    def _key_bytes(self, row) -> bytes | None:
        try:
            path = row["key_path"] or ""
        except (KeyError, IndexError):
            path = ""
        path = os.path.expanduser(str(path).strip())
        if not path:
            return None
        p = Path(path)
        try:
            st = p.stat()
        except FileNotFoundError:
            raise AppError("E_KEY", f"файл ключа не найден: {p}", status=400)
        except OSError as e:
            raise AppError("E_KEY", f"не удалось получить информацию о файле ключа: {e}", status=400) from e
        # is_file() следует за symlink; st.st_mode — тоже. Нам нужно, чтобы
        # целью был регулярный файл, а не device/fifo/socket.
        if not _stat.S_ISREG(st.st_mode):
            raise AppError("E_KEY", "путь к ключу не является обычным файлом", status=400)
        if st.st_size == 0:
            raise AppError("E_KEY", "файл ключа пуст", status=400)
        if st.st_size > self.MAX_KEY_FILE_BYTES:
            raise AppError(
                "E_KEY",
                f"файл ключа слишком большой ({st.st_size} байт, максимум {self.MAX_KEY_FILE_BYTES})",
                status=400,
            )
        # Читаем на 1 байт больше лимита: если файл вырос между stat и read,
        # увидим len > MAX и явно откажем (TOCTOU).
        try:
            with open(p, "rb") as f:
                data = f.read(self.MAX_KEY_FILE_BYTES + 1)
        except OSError as e:
            raise AppError("E_KEY", f"не удалось прочитать файл ключа: {e}", status=400) from e
        if len(data) > self.MAX_KEY_FILE_BYTES:
            raise AppError("E_KEY", "файл ключа слишком большой", status=400)
        return data

    # ---------- SSH session management ----------

    async def _ensure_shell(self, sid: int) -> RealShell:
        """Гарантирует живую SSH-сессию: возвращает из кэша или открывает заново
        по сохранённым кредам. Требует подтверждённого host key — если его нет,
        бросает E_HOSTKEY.

        S7+: если ранее для этого сервера был зафиксирован mismatch host key
        (pre-flight или предыдущая попытка коннекта) — SSH не открываем, пока
        пользователь не подтвердит новый ключ через rotate/confirm.
        """
        row = self.get_server(sid)
        if "host_key_mismatch_at" in row.keys() and row["host_key_mismatch_at"]:
            raise AppError(
                "E_HOSTKEY_MISMATCH",
                "host key сервера не совпадает с сохранённым — подключение "
                "заблокировано. Сверьте отпечаток в карточке сервера.",
                status=403,
            )
        kh = self.active_host_key(row["host"], row["port"])
        if kh is None:
            raise AppError("E_HOSTKEY", "host key не подтверждён — сначала подтвердите отпечаток", status=409)
        sh = await self.ssh.get(sid)
        if sh is not None:
            return sh
        secret, pp = self._cred_bytes(row)
        key_bytes = None
        if row["auth_type"] == "key":
            key_bytes = self._key_bytes(row)
        try:
            shell, info = await connect_real(
                row["host"],
                row["port"],
                row["user"],
                row["auth_type"],
                secret,
                pp,
                kh["fingerprint_sha256"],
                self.cfg.connect_timeout_sec,
                key_bytes=key_bytes,
                known_public_key=kh["public_key"],
            )
        except AppError as e:
            if e.code == "E_HOSTKEY_MISMATCH":
                fp = (e.details or {}).get("fingerprint_sha256") or ""
                await self._mark_hostkey_mismatch(sid, fp)
            raise
        if shell is None:
            raise AppError(info.get("code") or "E_SSH", info.get("message") or "SSH", status=502)
        await self.ssh.set(sid, shell)
        self.paths.invalidate(sid)
        # Успешный коннект после снятого флага — если флаг был, снимаем.
        if "host_key_mismatch_at" in row.keys() and row["host_key_mismatch_at"]:
            await self._clear_hostkey_mismatch(sid)
        return shell

    async def _mark_hostkey_mismatch(self, sid: int, fp: str) -> None:
        """Записывает флаг mismatch в БД. No-op при ошибке БД."""
        def fn(conn, _sid=sid, _fp=fp):
            conn.execute(
                "UPDATE servers SET host_key_mismatch_at=?, host_key_mismatch_fp=? WHERE id=?",
                (now_z(), _fp or None, _sid),
            )
        try:
            await self.db.mutate(fn)
            log.warning("host key mismatch sid=%s — подключение заблокировано", sid)
        except Exception:
            log.exception("не удалось записать hostkey mismatch sid=%s", sid)

    async def _clear_hostkey_mismatch(self, sid: int) -> None:
        """Сбрасывает флаг mismatch в БД. No-op при ошибке БД."""
        def fn(conn, _sid=sid):
            conn.execute(
                "UPDATE servers SET host_key_mismatch_at=NULL, host_key_mismatch_fp=NULL WHERE id=?",
                (_sid,),
            )
        try:
            await self.db.mutate(fn)
            log.info("host key mismatch снят sid=%s", sid)
        except Exception:
            log.exception("не удалось сбросить hostkey mismatch sid=%s", sid)

    async def _probe_host_key(self, row) -> dict | None:
        """Одноразовое подключение с known_fp=None, чтобы получить предъявленный
        host key. Не сохраняет сессию."""
        secret, pp = self._cred_bytes(row)
        key_bytes = None
        if row["auth_type"] == "key":
            key_bytes = self._key_bytes(row)
        try:
            _shell, info = await connect_real(
                row["host"],
                row["port"],
                row["user"],
                row["auth_type"],
                secret,
                pp,
                None,
                self.cfg.connect_timeout_sec,
                key_bytes=key_bytes,
            )
            return info
        except AppError as e:
            if e.code == "E_HOSTKEY_MISMATCH":
                return {"fingerprint_sha256": (e.details or {}).get("fingerprint_sha256", "")}
            raise

    async def _preflight_host_keys(self) -> None:
        """S7+: один раз после unlock — сверяем host key каждого сервера
        с сохранённым в БД.

        Дешёвый probe: get_server_host_key без аутентификации (как при TOFU).
        При mismatch — ставим флаг, collect_server пропустит сервер, SSH
        не будет открыт, креды не утекут.
        """
        rows = self.db.conn.execute("SELECT id, host, port FROM servers").fetchall()
        for r in rows:
            sid = r["id"]
            kh = self.active_host_key(r["host"], r["port"])
            if kh is None:
                # TOFU ещё не пройден — обрабатывается отдельной веткой.
                continue
            try:
                presented = await self.probe_host_key(r["host"], r["port"])
            except AppError as e:
                # Хост недоступен / таймаут — не наш случай, не флагаем.
                log.info("hostkey preflight sid=%s: probe failed: %s", sid, e.code)
                continue
            except Exception:
                log.exception("hostkey preflight sid=%s: unexpected", sid)
                continue
            fp = presented.get("fingerprint_sha256") or ""
            stored = kh["fingerprint_sha256"]
            if fp and fp != stored:
                log.warning(
                    "hostkey preflight sid=%s (%s): MISMATCH stored=%s presented=%s",
                    sid, r["host"], stored, fp,
                )
                await self._mark_hostkey_mismatch(sid, fp)
            else:
                # Совпало — если флаг почему-то был, снимаем.
                row = self.get_server(sid)
                if "host_key_mismatch_at" in row.keys() and row["host_key_mismatch_at"]:
                    await self._clear_hostkey_mismatch(sid)

    async def _read_nproc(self, shell: RealShell) -> int | None:
        """Читает количество процессоров через /usr/bin/nproc.

        Используется для нормировки порога load-average
        (abs_load_1m_per_cpu × nproc). Fallback — None: detector тогда
        берёт nproc=1. Ошибка SSH / отсутствие coreutils не критичны —
        просто деградация до одного ядра.
        """
        try:
            r = await shell.run_argv(["/usr/bin/nproc"])
        except Exception:
            return None
        if r.exit_code != 0:
            return None
        try:
            n = int((r.stdout or "").strip())
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    # Разделитель для склейки метрик в один SSH-exec. Уникальная строка
    # без '#' — иначе POSIX-shell считает её комментарием (была бага:
    # echo ###__SECTION__### комментировал весь хвост скрипта, из-за чего
    # free/findmnt/net/loadavg/uptime вообще не выполнялись).
    # Префикс __STRZH_ — чтобы точно не пересечься с содержимым /proc/*.
    _METRICS_SEP = "__STRZH_SECT_9f2a__"

    async def _collect_metrics_raw(self, shell: RealShell) -> dict:
        """Собирает все 6 метрик одним SSH-exec.

        Раньше было 6 отдельных run_argv → 6 SSH-каналов + 6 форков
        /bin/sh на сервере на каждый тик. Теперь — 1 канал + 1 sh,
        вывод разделяется маркером _METRICS_SEP.

        Возвращает dict с полями stat/free/findmnt/net/loadavg/uptime
        (raw stdout каждой команды). Парсеры дальше работают как
        раньше — на входе тот же текст, что давал один run_argv.

        stderr игнорируем: free/journalctl могут писать предупреждения,
        exit_code склеенного sh = последней команды. Проверяем каждый
        раздел на пустоту отдельно в парсерах.
        """
        sep = self._METRICS_SEP
        script = " ; ".join([
            "cat /proc/stat",
            f'echo "{sep}"',
            "free -b",
            f'echo "{sep}"',
            "findmnt -J -b -o TARGET,FSTYPE,SIZE,USED,AVAIL",
            f'echo "{sep}"',
            "cat /proc/net/dev",
            f'echo "{sep}"',
            "cat /proc/loadavg",
            f'echo "{sep}"',
            "cat /proc/uptime",
        ])
        r = await shell.run_argv(["/bin/sh", "-c", script])
        parts = (r.stdout or "").split(sep)
        # Ожидаем ровно 6 частей. Если меньше — на сервере что-то упало
        # (например, findmnt отсутствует). Возвращаем что есть, парсеры
        # сами отсеют пустое.
        keys = ("stat", "free", "findmnt", "net", "loadavg", "uptime")
        out: dict[str, str] = {}
        for i, k in enumerate(keys):
            chunk = parts[i] if i < len(parts) else ""
            out[k] = chunk.strip("\n")
        return out

    async def _check_metric_commands(self, shell: RealShell) -> list[str]:
        missing: list[str] = []
        for cmd in ("findmnt", "free", "ss", "systemctl"):
            inner = f"PATH={self.cfg.resolver_path} command -v {_shlex.quote(cmd)}"
            r = await shell.run_argv(["/bin/sh", "-c", inner])
            if r.exit_code != 0:
                missing.append(cmd)
        return missing

    # ---------- probe / test / TOFU / rotate ----------

    async def probe_host_key(self, host: str, port: int) -> dict:
        """Запрашивает предъявленный host key без аутентификации (аналог ssh-keyscan).
        Не требует DEK, не пишет в БД. Используется формой добавления сервера,
        чтобы пользователь сверил fingerprint до сохранения."""
        host = _validate_host(host)
        port = _validate_port(port)
        key = await _fetch_host_key(host, port, self.cfg.connect_timeout_sec)
        return _present_host_key(key)

    async def test_connection(self, sid: int) -> dict:
        row = self.get_server(sid)
        kh = self.active_host_key(row["host"], row["port"])
        secret, pp = self._cred_bytes(row)
        key_bytes = None
        if row["auth_type"] == "key":
            key_bytes = self._key_bytes(row)
        known = None if kh is None else kh["fingerprint_sha256"]
        known_pub = None if kh is None else kh["public_key"]
        try:
            shell, info = await connect_real(
                row["host"],
                row["port"],
                row["user"],
                row["auth_type"],
                secret,
                pp,
                known,
                self.cfg.connect_timeout_sec,
                key_bytes=key_bytes,
                known_public_key=known_pub,
            )
        except AppError as e:
            if e.code == "E_HOSTKEY_MISMATCH":
                fp = (e.details or {}).get("fingerprint_sha256")
                if fp:
                    self.ssh.set_pending_host_key(
                        row["host"],
                        row["port"],
                        {"fingerprint_sha256": fp, "key_type": "?", "public_key": ""},
                    )
            raise
        except Exception as e:
            log.exception("test_connection: unexpected error sid=%s", sid)
            raise AppError("E_SSH", f"внутренняя ошибка SSH: {e}", status=502) from e
        if info.get("code") == "E_TOFU":
            self.ssh.set_pending_host_key(row["host"], row["port"], info)
            return info
        if shell is None:
            raise AppError(info.get("code") or "E_SSH", info.get("message") or "SSH", status=502)
        await self.ssh.set(sid, shell)
        self.paths.invalidate(sid)
        # Проверка команд метрик не критична: если сервер рвёт соединение после
        # первой команды — это не повод считать test_connection неуспешным.
        try:
            missing = await self._check_metric_commands(shell)
        except AppError as e:
            log.warning("test_connection: проверка команд метрик не прошла sid=%s: %s", sid, e.code)
            missing = []
        except Exception:
            log.exception("test_connection: неожиданная ошибка в _check_metric_commands sid=%s", sid)
            missing = []
        await self.db.mutate(lambda c: c.execute("UPDATE servers SET last_seen_at=? WHERE id=?", (now_z(), sid)))
        self.collect_errors.pop(sid, None)
        return {"ok": True, "fingerprint_sha256": info.get("fingerprint_sha256"), "incomplete_metrics": missing}

    async def confirm_host_key(self, sid: int, fingerprint: str) -> dict:
        row = self.get_server(sid)
        presented = self.ssh.pending_host_key(row["host"], row["port"]) or {}
        if not presented or presented.get("fingerprint_sha256") != fingerprint:
            info = await self._probe_host_key(row)
            presented = info or {}
        if fingerprint != presented.get("fingerprint_sha256"):
            raise AppError("E_HOSTKEY", "отпечаток не совпал с предъявленным сервером", status=400)
        if self.active_host_key(row["host"], row["port"]):
            raise AppError("E_HOSTKEY", "ключ уже подтверждён; для смены — rotate", status=409)
        fp = presented.get("fingerprint_sha256") or fingerprint
        kt = presented.get("key_type") or "ssh-ed25519"
        pub = presented.get("public_key") or ""

        def fn(conn):
            conn.execute(
                """INSERT INTO known_hosts(host, port, key_type, public_key, fingerprint_sha256, added_at, confirmed_by, is_active)
                   VALUES (?,?,?,?,?,?,?,1)""",
                (row["host"], row["port"], kt, pub, fp, now_z(), "admin"),
            )
            # Сброс флага mismatch — host key заново подтверждён.
            conn.execute(
                "UPDATE servers SET host_key_mismatch_at=NULL, host_key_mismatch_fp=NULL WHERE id=?",
                (sid,),
            )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "hostkey.confirm",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        self.ssh.clear_pending_host_key(row["host"], row["port"])
        self.collect_errors.pop(sid, None)
        self._next_collect.pop(sid, None)
        return {"ok": True, "fingerprint_sha256": fp}

    async def rotate_host_key(self, sid: int, fingerprint: str, reason: str, confirm: bool, confirm2: bool = False) -> dict:
        if not confirm or not confirm2 or not (reason or "").strip():
            raise AppError("E_CONFIRM", "нужны два подтверждения и обоснование", status=400)
        row = self.get_server(sid)
        presented = self.ssh.pending_host_key(row["host"], row["port"]) or {}
        if not presented or presented.get("fingerprint_sha256") != fingerprint:
            info = await self._probe_host_key(row)
            presented = info or {}
        if fingerprint != presented.get("fingerprint_sha256"):
            raise AppError("E_HOSTKEY", "новый отпечаток не совпал", status=400)
        old = self.active_host_key(row["host"], row["port"])
        kt = presented.get("key_type") or "ssh-ed25519"
        pub = presented.get("public_key") or ""

        def fn(conn):
            if old:
                conn.execute(
                    "UPDATE known_hosts SET is_active=0, replaced_at=? WHERE id=?",
                    (now_z(), old["id"]),
                )
                conn.execute(
                    """INSERT INTO known_hosts_history(host, port, key_type, public_key, fingerprint_sha256, added_at, removed_at, reason)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        old["host"],
                        old["port"],
                        old["key_type"],
                        old["public_key"],
                        old["fingerprint_sha256"],
                        old["added_at"],
                        now_z(),
                        reason.strip(),
                    ),
                )
            conn.execute(
                """INSERT INTO known_hosts(host, port, key_type, public_key, fingerprint_sha256, added_at, confirmed_by, is_active)
                   VALUES (?,?,?,?,?,?,?,1)""",
                (row["host"], row["port"], kt, pub, fingerprint, now_z(), "admin"),
            )
            # Сброс флага mismatch — host key обновлён вручную.
            conn.execute(
                "UPDATE servers SET host_key_mismatch_at=NULL, host_key_mismatch_fp=NULL WHERE id=?",
                (sid,),
            )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "hostkey.rotate",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"code": "rotated"},
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        await self.ssh.drop(sid)
        self.ssh.clear_pending_host_key(row["host"], row["port"])
        self.collect_errors.pop(sid, None)
        self._next_collect.pop(sid, None)
        return {"ok": True}

    # ---------- sudo (per-server TTL-кэш, используется execute_op) ----------

    def provide_sudo(self, sid: int, password: str) -> None:
        self.get_server(sid)
        if "\n" in password or "\r" in password:
            raise AppError("E_PARAM", "пароль sudo не должен содержать перевод строки", status=400)
        ttl = int(self.db.get_setting("sudo_ttl_sec") or self.cfg.sudo_ttl_sec)
        exp = time.monotonic() + ttl if ttl > 0 else time.monotonic() + 1e9
        self.sudo[sid] = (password, exp)

    def forget_sudo(self, sid: int) -> None:
        self.sudo.pop(sid, None)

    def sudo_pw(self, sid: int) -> str | None:
        """Пароль sudo для операции на конкретном сервере.

        Приоритет:
          1. per-server TTL-кэш (заполняется через POST /sudo/provide);
          2. auto-sudo (session / 30m / 2h / 8h / disk) — единый пароль
             для всех серверов, пока пользователь его не отозвал.
        """
        item = self.sudo.get(sid)
        if item:
            pw, exp = item
            if time.monotonic() <= exp:
                return pw
            self.sudo.pop(sid, None)
        # Fallback: пользователь разблокировал автосудо — он явно это
        # разрешил, отдельная подача для сервера не нужна.
        return self.sudo_get_password()

    # ---------- sudo unlock (auto-sudo для реакций) ----------
    #
    # Режимы:
    #   none    — разовая подача (через POST /sudo/provide), не для реакций
    #   session — пароль в RAM, живёт до рестарта процесса
    #   30m/2h/8h — пароль в RAM с TTL
    #   disk    — пароль в RAM + зашифрован DEK в settings (переживает рестарт)
    #
    # При использовании через реакции: runtime.sudo_get_password() возвращает
    # пароль из RAM или из settings (если mode=disk).

    SUDO_MODES = ("none", "session", "30m", "2h", "8h", "disk")
    SUDO_MODE_MINUTES = {"30m": 30, "2h": 120, "8h": 480}

    def sudo_unlock_status(self) -> dict:
        """Возвращает текущее состояние автосудо."""
        mode = self.db.get_setting("sudo_unlock_mode") or "none"
        until = self.db.get_setting("sudo_unlock_until")
        session_valid = False
        if self._sudo_session_password is not None:
            if self._sudo_session_until is None:
                session_valid = True
            else:
                session_valid = time.monotonic() < self._sudo_session_until
                if not session_valid:
                    self._sudo_session_password = None
                    self._sudo_session_until = None
        disk_valid = False
        if mode == "disk":
            disk_valid = bool(self.db.get_setting("sudo_secret_ct"))
        valid = session_valid or disk_valid
        return {
            "mode": mode,
            "until": until,
            "session_valid": session_valid,
            "disk_valid": disk_valid,
            "valid": valid,
        }

    async def sudo_check_password(self, password: str, sid: int | None = None) -> dict:
        """Проверяет пароль sudo через реальный SSH на первом доступном
        сервере (или на указанном).

        Возвращает {"ok": True} или {"ok": False, "code", "message"}.
        Не сохраняет пароль, не трогает settings, не пишет аудит.
        """
        if not password:
            raise AppError("E_PARAM", "пароль пуст", status=400)
        if "\n" in password or "\r" in password:
            raise AppError("E_PARAM", "пароль содержит перевод строки", status=400)

        # Выбор сервера: указанный, либо первый с подтверждённым host key.
        if sid is None:
            row = self.db.conn.execute(
                """SELECT s.* FROM servers s
                   WHERE EXISTS (
                     SELECT 1 FROM known_hosts kh
                     WHERE kh.host=s.host AND kh.port=s.port AND kh.is_active=1
                   )
                   ORDER BY s.id LIMIT 1"""
            ).fetchone()
            if row is None:
                raise AppError("E_NO_SERVER", "нет серверов с подтверждённым host key", status=400)
        else:
            row = self.get_server(sid)
            if self.active_host_key(row["host"], row["port"]) is None:
                raise AppError("E_HOSTKEY", "host key не подтверждён", status=409)

        try:
            shell = await self._ensure_shell(row["id"])
        except AppError as e:
            return {"ok": False, "code": e.code, "message": e.message}

        # Резолвим sudo без sudo (command -v через /bin/sh). Если что — дефолт.
        try:
            paths = await resolve_needed(
                shell, row["id"], ["sudo"], self.paths,
                self.cfg.resolver_path, self.cfg.env_path, allow_sudo=False,
            )
            sudo_abs = paths.get("sudo") or "/usr/bin/sudo"
        except AppError:
            sudo_abs = "/usr/bin/sudo"

        argv = [self.cfg.env_path, "LC_ALL=C", "LANG=C",
                sudo_abs, "-S", "-p", "", "/bin/true"]
        inp = password.encode("utf-8") + b"\n"
        try:
            r = await run_step(shell, argv, 15, inp, 4096)
        except AppError as e:
            return {"ok": False, "code": e.code, "message": e.message}

        if r.exit_code == 0:
            return {"ok": True}

        code = r.sudo_code or "E_SUDO_UNKNOWN"
        msgs = {
            "E_SUDO_WRONG_PASSWORD": "неверный пароль sudo",
            "E_SUDO_LOCKED": "3 неверные попытки — sudo заблокирован на сервере",
            "E_SUDO_REQUIRETTY": "сервер требует TTY для sudo (Defaults requiretty)",
            "E_SUDO_NO_TTY_ASKPASS": "сервер требует TTY/askpass для sudo",
            "E_SUDO_NOT_PERMITTED": "пользователь не в sudoers",
            "E_SUDO_TIMEOUT": "sudo не дождался пароля",
        }
        return {
            "ok": False,
            "code": code,
            "message": msgs.get(code) or (r.stderr or "ошибка sudo")[:200],
        }

    async def sudo_unlock_provide(self, password: str, mode: str) -> dict:
        """Разблокировать автосудо.

        mode: 'session' | '30m' | '2h' | '8h' | 'disk' | 'none'
        """
        if mode not in self.SUDO_MODES:
            raise AppError("E_PARAM", f"mode: {'|'.join(self.SUDO_MODES)}", status=400)
        if "\n" in password or "\r" in password:
            raise AppError("E_PARAM", "пароль sudo не должен содержать перевод строки", status=400)
        if not password:
            raise AppError("E_PARAM", "пароль пуст", status=400)

        if mode == "none":
            # Разовая подача для конкретного сервера — не наш путь. Уходим.
            raise AppError("E_PARAM", "для разовой подачи используйте /sudo/provide с server_id", status=400)

        now_mono = time.monotonic()
        now_str = now_z()
        self._sudo_session_password = password
        if mode in ("session", "disk"):
            # session — до рестарта процесса; disk — тоже RAM, но с
            # дублированием в settings (переживёт рестарт). TTL не нужен.
            self._sudo_session_until = None
        elif mode in self.SUDO_MODE_MINUTES:
            self._sudo_session_until = now_mono + self.SUDO_MODE_MINUTES[mode] * 60
        else:
            # Не должны сюда попасть (mode валидируется выше), но страхуемся.
            self._sudo_session_until = None

        def fn(conn):
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('sudo_unlock_mode', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (mode,),
            )
            until = None
            if mode in self.SUDO_MODE_MINUTES:
                until = (
                    datetime.now(timezone.utc) + timedelta(minutes=self.SUDO_MODE_MINUTES[mode])
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('sudo_unlock_until', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (until or "",),
            )
            if mode == "disk":
                dek = self.require_dek()
                nonce, ct = encrypt_secret(dek, password.encode("utf-8"), b"melecho-sudo-disk-v1")
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('sudo_secret_nonce', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (nonce,),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('sudo_secret_ct', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (ct,),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('sudo_secret_created_at', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (now_str,),
                )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "sudo.unlock_provide",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"mode": mode},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_str,
                },
            )

        await self.db.mutate(fn)
        # Применим _apply_llm не нужно. Возвращаем статус.
        return self.sudo_unlock_status()

    async def sudo_unlock_revoke(self) -> dict:
        """Стереть автосудо из памяти и (если mode=disk) из settings."""

        def fn(conn):
            conn.execute("DELETE FROM settings WHERE key IN "
                         "('sudo_unlock_mode','sudo_unlock_until',"
                         "'sudo_secret_nonce','sudo_secret_ct','sudo_secret_created_at')")
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "sudo.unlock_revoke",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        self._sudo_session_password = None
        self._sudo_session_until = None
        return self.sudo_unlock_status()

    def sudo_get_password(self) -> str | None:
        """Единая точка получения sudo-пароля для реакций и операций.

        Приоритет:
          1. RAM-сессия (session / 30m / 2h / 8h) — если не истекла.
          2. disk — расшифровка из settings.
          3. None.
        """
        # 1. RAM
        if self._sudo_session_password is not None:
            if self._sudo_session_until is None:
                return self._sudo_session_password
            if time.monotonic() < self._sudo_session_until:
                return self._sudo_session_password
            # истёк
            self._sudo_session_password = None
            self._sudo_session_until = None
        # 2. disk
        nonce = self.db.get_setting("sudo_secret_nonce")
        ct = self.db.get_setting("sudo_secret_ct")
        if nonce and ct and self.dek:
            try:
                pw = decrypt_secret(self.dek, nonce, ct, b"melecho-sudo-disk-v1").decode("utf-8")
                # Восстановим in-memory копию, чтобы не дешифровать каждый раз.
                self._sudo_session_password = pw
                self._sudo_session_until = None
                return pw
            except Exception:
                log.warning("не удалось расшифровать sudo-пароль (disk)")
        return None

    def sudo_autoload(self) -> None:
        """Вызывается при unlock: если mode=disk, подгружаем пароль в RAM."""
        mode = self.db.get_setting("sudo_unlock_mode")
        if mode == "disk":
            self.sudo_get_password()

    # ---------- alerts ----------

    async def _flush_detector_alerts(self, sid: int) -> None:
        """Сливает кандидатов детектора в alerts через AlertEngine.

        Detector работает синхронно (в hot path ingest), поэтому генерит
        кандидатов в буфер. Здесь (в async-контексте) мы превращаем их в
        реальные алерты с дедупликацией и auto-resolve.

        Guard: для offline-сервера или при отсутствии интернета — no-op.
        Вызов идёт из collect_server (а тот уже не пускает), но защита
        на будущее: любой другой путь через detector тоже не должен
        сливать candidates для offline sid — статистика по пропущенным
        точкам недостоверна.
        """
        if self._is_sid_blocked(sid):
            return
        # ВАЖНО: auto-resolve проверяем ДО проверки candidates. Иначе
        # при отсутствии новых аномалий (штатный случай, когда метрика
        # вернулась в норму) функция выходит раньше и алерт никогда не
        # закрывается автоматически.
        now_mono = time.monotonic()
        stale_keys = [
            k for k, t0 in self.detector._z_ok_since.items()
            if now_mono - t0 >= 300
        ]
        for (svid, metric) in stale_keys:
            self.detector._z_ok_since.pop((svid, metric), None)
            for name in ("Z-score warning", "Z-score critical"):
                rule = self.alerts.find_builtin(name)
                if rule is None:
                    continue
                fp = fingerprint(rule["id"], svid, metric, metric)
                row = self.alerts.find_active_by_fingerprint(fp)
                if row:
                    await self.alerts.resolve(
                        row["id"],
                        by="auto",
                        reason=f"z-score < 1.5 в течение 5 мин (метрика {metric})",
                    )

        candidates = self.detector.drain_candidates()
        if not candidates:
            return
        # Матчинг: z >= 4.5 → critical, 3.0 <= z < 4.5 → warning.
        rule_warn = self.alerts.find_builtin("Z-score warning")
        rule_crit = self.alerts.find_builtin("Z-score critical")
        for c in candidates:
            if c["kind"] != "anomaly":
                continue
            z = c["z_score"]
            rule = rule_crit if z >= 4.5 else rule_warn
            if rule is None:
                continue
            metric = c["metric"]
            label = self._metric_label(metric)
            title = f"Аномалия {label}"
            # z-score = число стандартных отклонений. Пишем по-человечески.
            # Если метрика — проценты (cpu/ram/disk), показываем как %, иначе
            # просто значение.
            if metric in ("cpu", "ram", "disk"):
                value_repr = f"{c['value']:.1f}%"
            else:
                value_repr = f"{c['value']:.2f}"
            desc = (
                f"отклонение {z:.2f}σ от нормы · значение {value_repr} · "
                f"окно {c['window']}"
            )
            await self.alerts.emit(
                rule,
                server_id=c["server_id"],
                metric=c["metric"],
                value=c["value"],
                threshold=c["threshold"],
                title=title,
                description=desc,
                meta={
                    "z": z,
                    "ewma": c["ewma"],
                    "window": c["window"],
                },
                dimension=c["metric"],
            )

    async def _run_rule_on_server(self, rid: int, sid: int, server_row) -> dict:
        """Запускает operation_check-правило rid на сервере sid.

        Публичный (не underscore в имени у вызывающего) метод — ручной
        запуск через API и scheduler.
        """
        # Offline — не дёргаем SSH, не пишем runs, не эмитим алерт.
        # Scheduler поймает код и не будет двигать next_run_at (см.
        # _run_due_checks) — правило попробует снова на следующем тике.
        # Локальные серверы при internet_offline работают штатно.
        block_code = self._is_sid_blocked(sid)
        if block_code:
            msg = (
                "нет подключения к интернету — проверка операции отложена"
                if block_code == "E_NO_INTERNET"
                else "сервер не отвечает — проверка операции отложена"
            )
            raise AppError(block_code, msg, status=502)
        rule = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=? AND condition_kind='operation_check'",
            (rid,),
        ).fetchone()
        if rule is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        try:
            cj = json.loads(rule["condition_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            cj = {}
        if not isinstance(cj, dict):
            cj = {}
        op_id = cj.get("operation_id") or ""
        params = cj.get("params") or {}
        condition = cj.get("expected") or {"exit": 0}
        if not isinstance(condition, dict):
            condition = {"exit": 0}

        t0 = time.monotonic()
        status = "ok"
        exit_code = None
        audit_id = None
        stdout = ""
        stderr = ""
        error_code = None

        try:
            res = await self.execute_op(op_id, sid, params, use_sudo=None, confirm=True)
            steps = res.get("steps") or []
            run_step = next((s for s in steps if s.get("phase") == "run"), None)
            if run_step:
                exit_code = run_step.get("exit")
                stdout = (run_step.get("stdout") or "")[:8000]
                stderr = (run_step.get("stderr") or "")[:2000]
            exp_exit = condition.get("exit")
            if exp_exit is not None and exit_code != exp_exit:
                status = "fail"
            pat = condition.get("stdout_regex")
            if pat and status == "ok":
                if not re.search(pat, stdout):
                    status = "fail"
        except AppError as e:
            status = "error"
            error_code = e.code
            stderr = (e.message or "")[:500]
        except Exception as e:
            status = "error"
            error_code = "E_INTERNAL"
            stderr = str(e)[:500]

        duration_ms = int((time.monotonic() - t0) * 1000)
        ts = now_z()

        def fn(conn):
            cur = conn.execute(
                """INSERT INTO alert_rule_runs
                   (rule_id, timestamp_utc, server_id, status, exit_code,
                    duration_ms, audit_id, stdout_trunc, stderr_trunc, error_code)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (rid, ts, sid, status, exit_code, duration_ms, audit_id,
                 stdout, stderr, error_code),
            )
            return cur.lastrowid

        run_id = await self.db.mutate(fn)
        self.events.publish("rule.finished", {
            "rule_id": rid,
            "run_id": run_id,
            "server_id": sid,
            "status": status,
            "exit_code": exit_code,
            "error_code": error_code,
        })

        if status != "ok":
            # Эмитим алерт от самого правила operation_check. Раньше создавалось
            # lazy-правило "Check failed: <name>" на каждый check — теперь
            # fingerprint и дедупликация идут через одно правило.
            # source='check' сохранён в правиле, UI отличит.
            title = f"{rule['name']} · {server_row['llm_alias']} · {status}"
            desc = f"exit={exit_code}, error={error_code or '—'}"
            await self.alerts.emit(
                rule,
                server_id=sid,
                metric=None,
                value=None,
                threshold=None,
                title=title,
                description=desc,
                meta={"rule_id": rid, "run_id": run_id, "status": status,
                      "exit": exit_code, "error_code": error_code},
                dimension=f"check:{rid}",
            )

        return {"run_id": run_id, "status": status}

    def _resolve_rule_servers(self, rule) -> list[tuple[int, object]]:
        try:
            servers = json.loads(rule["servers_json"] or '{"all": true}')
        except (json.JSONDecodeError, TypeError):
            servers = {"all": True}
        if not isinstance(servers, dict):
            servers = {"all": True}
        if servers.get("all"):
            rows = self.db.conn.execute(
                "SELECT * FROM servers WHERE last_seen_at IS NOT NULL ORDER BY id"
            ).fetchall()
        else:
            ids = servers.get("ids") or []
            if not ids:
                return []
            ph = ",".join("?" * len(ids))
            rows = self.db.conn.execute(
                f"SELECT * FROM servers WHERE id IN ({ph}) ORDER BY id", ids
            ).fetchall()
        return [(r["id"], r) for r in rows]

    async def _run_due_checks(self) -> None:
        now = now_z()
        rows = self.db.conn.execute(
            """SELECT * FROM alert_rules
               WHERE enabled=1 AND condition_kind='operation_check'
                 AND (next_run_at IS NULL OR next_run_at <= ?)""",
            (now,),
        ).fetchall()
        for r in rows:
            rid = r["id"]
            try:
                servers = self._resolve_rule_servers(r)
                # Если все серверы правила offline (или интернет пропал) —
                # не двигаем next_run_at. Правило не «выполнилось», а
                # «отложено». На следующем тике poll_loop попробует снова.
                any_ran = False
                for sid, srow in servers:
                    try:
                        await self._run_rule_on_server(rid, sid, srow)
                        any_ran = True
                    except AppError as e:
                        if e.code in ("E_NO_INTERNET", "E_SERVER_OFFLINE"):
                            log.info(
                                "scheduler: rule=%s server=%s отложено (%s)",
                                rid, sid, e.code,
                            )
                            continue
                        raise
                if not any_ran:
                    continue
                next_at = (
                    datetime.now(timezone.utc) + timedelta(seconds=r["interval_sec"] or 300)
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                ts = now_z()
                recent = self.db.conn.execute(
                    """SELECT status FROM alert_rule_runs
                       WHERE rule_id=? ORDER BY id DESC LIMIT ?""",
                    (rid, max(1, len(servers))),
                ).fetchall()
                overall = "ok" if recent and all(x["status"] == "ok" for x in recent) else "fail"

                def fn(conn, _ts=ts, _overall=overall, _next=next_at, _rid=rid):
                    conn.execute(
                        "UPDATE alert_rules SET last_run_at=?, last_result=?, next_run_at=? WHERE id=?",
                        (_ts, _overall, _next, _rid),
                    )

                await self.db.mutate(fn)
            except Exception:
                log.exception("rule %s failed", rid)

    # Человекочитаемые названия метрик — используются при формировании
    # title/description алертов. Держим единый словарь, чтобы detector и
    # threshold говорили на одном языке.
    _METRIC_LABELS: dict[str, str] = {
        "cpu": "CPU",
        "ram": "RAM",
        "disk": "Диск",
        "load_1m": "Load 1m",
        "net_rx_bps": "Сеть RX",
        "net_tx_bps": "Сеть TX",
    }

    @classmethod
    def _metric_label(cls, metric: str) -> str:
        return cls._METRIC_LABELS.get(metric, metric)

    def _metric_value_for_threshold(self, row, metric: str) -> float | None:
        """Значение метрики из последней точки metrics_history.

        Поддерживаем только те метрики, что лежат в metrics_history
        прямыми числами или простыми массивами: cpu, ram, disk, load_1m.
        Сетевые rate (net_rx_bps) сознательно не поддерживаем в MVP —
        потребуется пересчёт из cumulative, а сеть обычно мониторят
        z-score'ом, не абсолютным порогом.
        """
        try:
            if metric in ("cpu", "ram", "disk"):
                v = row[metric]
                return None if v is None else float(v)
            if metric == "load_1m":
                raw = row["load_avg"]
                if not raw:
                    return None
                import json as _json
                arr = _json.loads(raw)
                if not isinstance(arr, list) or not arr:
                    return None
                return float(arr[0])
        except (TypeError, ValueError, KeyError):
            return None
        return None

    @staticmethod
    def _threshold_condition_met(
        value: float, cond: dict, *, multiplier: float = 1.0,
    ) -> bool:
        """Проверяет value против condition_json правила source=threshold.

        Поддерживаем value_gte / value_gt / value_lte / value_lt.
        Все указанные условия должны выполняться (логическое И).

        multiplier — для metric=load_1m: порог умножается на nproc сервера.
        Пользователь пишет «value_gte = 1.5» → реальный порог = nproc × 1.5.
        Для остальных метрик multiplier=1.0 (значения абсолютные, проценты).
        """
        if "value_gte" in cond and not (value >= float(cond["value_gte"]) * multiplier):
            return False
        if "value_gt" in cond and not (value > float(cond["value_gt"]) * multiplier):
            return False
        if "value_lte" in cond and not (value <= float(cond["value_lte"]) * multiplier):
            return False
        if "value_lt" in cond and not (value < float(cond["value_lt"]) * multiplier):
            return False
        return True

    # ---------- alert_rules CRUD (Should, iter 4.2d-7b) ----------
    #
    # Пользователь может создавать свои правила, править существующие
    # (включая builtin — например, изменить порог), отключать. Удалять
    # можно только не-builtin. Сброс builtin — восстановление полей из
    # BUILTIN_RULES в app/alerts.py.
    #
    # Валидация намеренно минимальная: name/severity/source/condition_json
    # проверяются, но структуру condition_json НЕ валидируем жёстко —
    # иначе LLM не сможет предложить новые правила, а старый добрый
    # z-score-объект уже работает. Каждый источник сам решает, что
    # ожидает в condition_json.

    # Единая модель правил: каноническое поле — condition_kind (см. PLAN_ALERTS_V2 §2).
    # Колонка alert_rules.source удалена (миграция v13). Маппинг kind → legacy
    # source живёт в alerts.py (CONDITION_KIND_TO_SOURCE) — там же, где
    # заполняется денормализованный alerts.source.
    #
    # На входе API продолжаем принимать и condition_kind, и legacy source
    # (старый UI в Патче 5 ещё не переехал) — маппим source → kind.
    _ALLOWED_CONDITION_KINDS = frozenset({
        "metric_threshold",   # порог метрики
        "metric_zscore",      # z-score (EWMA)
        "metric_stale",       # нет метрик N секунд
        "operation_check",    # периодический запуск операции
        "manual_op_failed",   # провал операции из UI
        "reaction_failed",    # реакция не смогла восстановить
    })
    _SOURCE_TO_KIND_LEGACY = {
        "threshold": "metric_threshold",
        "detector":  "metric_zscore",
        "stale":     "metric_stale",
        "check":     "operation_check",
        "operation": "manual_op_failed",
    }
    _ALLOWED_SEVERITIES = frozenset({"info", "warning", "critical"})

    def _validate_alert_rule_body(self, body: dict, *, partial: bool = False) -> dict:
        """Возвращает нормализованный dict полей для insert/update.

        partial=True (PATCH): берём только присутствующие поля.
        partial=False (POST): обязательны name, source, severity.
        """
        out: dict = {}
        if not partial or "name" in body:
            name = (body.get("name") or "").strip()
            if not name or len(name) > 200:
                raise AppError("E_PARAM", "name: 1..200 символов", status=400)
            out["name"] = name
        # Тип условия: канонически condition_kind. Если клиент прислал legacy
        # source — мапим. Если оба пришли — должны согласовываться.
        has_ck = "condition_kind" in body and body["condition_kind"] is not None
        has_src = "source" in body and body["source"] is not None
        if not partial or has_ck or has_src:
            ck: str | None = None
            if has_ck:
                raw = body["condition_kind"]
                if not isinstance(raw, str):
                    raise AppError("E_PARAM", "condition_kind: строка", status=400)
                ck = raw.strip()
                if ck not in self._ALLOWED_CONDITION_KINDS:
                    raise AppError(
                        "E_PARAM",
                        f"condition_kind: {'|'.join(sorted(self._ALLOWED_CONDITION_KINDS))}",
                        status=400,
                    )
            if has_src:
                raw_src = body["source"]
                if not isinstance(raw_src, str):
                    raise AppError("E_PARAM", "source: строка", status=400)
                src_v = raw_src.strip()
                mapped = self._SOURCE_TO_KIND_LEGACY.get(src_v)
                if mapped is None:
                    raise AppError(
                        "E_PARAM",
                        f"source: {'|'.join(sorted(self._SOURCE_TO_KIND_LEGACY))}",
                        status=400,
                    )
                if ck is not None and ck != mapped:
                    raise AppError(
                        "E_PARAM",
                        "condition_kind и source не согласованы",
                        status=400,
                    )
                ck = mapped
            if ck is None:
                raise AppError(
                    "E_PARAM",
                    "укажите condition_kind (или legacy source)",
                    status=400,
                )
            out["condition_kind"] = ck
        if not partial or "severity" in body:
            severity = (body.get("severity") or "").strip()
            if severity not in self._ALLOWED_SEVERITIES:
                raise AppError("E_PARAM", "severity: info|warning|critical", status=400)
            out["severity"] = severity
        if not partial or "condition_json" in body:
            cond = body.get("condition_json")
            if cond is None:
                cond = {}
            if not isinstance(cond, dict):
                raise AppError("E_PARAM", "condition_json: объект", status=400)
            out["condition_json"] = json.dumps(cond, ensure_ascii=False, sort_keys=True)
        if not partial or "auto_resolve_json" in body:
            ar = body.get("auto_resolve_json")
            if ar is not None and not isinstance(ar, dict):
                raise AppError("E_PARAM", "auto_resolve_json: объект или null", status=400)
            out["auto_resolve_json"] = (
                json.dumps(ar, ensure_ascii=False, sort_keys=True) if ar else None
            )
        if not partial or "server_id" in body:
            sid_raw = body.get("server_id")
            if sid_raw is None:
                out["server_id"] = None
            else:
                try:
                    sid = int(sid_raw)
                except (TypeError, ValueError):
                    raise AppError("E_PARAM", "server_id: целое или null", status=400)
                # get_server бросает E_NOT_FOUND, если такого сервера нет.
                # Это ключевая защита от LLM: модель может «выдумать»
                # server_id, но правило с ним создано не будет.
                # Сообщение явно говорит, что сервера с таким id нет —
                # чтобы в invalid_rules UI было понятно, почему отклонили.
                try:
                    self.get_server(sid)
                except AppError as e:
                    raise AppError(
                        "E_PARAM",
                        f"server_id={sid} не существует "
                        f"(правило с таким сервером создать нельзя)",
                        status=400,
                    ) from e
                out["server_id"] = sid
        if not partial or "cooldown_sec" in body:
            try:
                cd = int(body.get("cooldown_sec", 300))
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "cooldown_sec: целое", status=400)
            if cd < 0 or cd > 86400:
                raise AppError("E_PARAM", "cooldown_sec: 0..86400", status=400)
            out["cooldown_sec"] = cd
        if not partial or "enabled" in body:
            out["enabled"] = 1 if body.get("enabled", True) else 0
        # operation_check-специфичные поля. Валидируются всегда, если
        # присутствуют в body; при kind != operation_check игнорируются
        # на этапе записи (alert_rule_create смотрит на condition_kind).
        if not partial or "interval_sec" in body:
            iv_raw = body.get("interval_sec")
            if iv_raw is not None:
                try:
                    iv = int(iv_raw)
                except (TypeError, ValueError):
                    raise AppError("E_PARAM", "interval_sec: целое", status=400)
                if iv < 60 or iv > 86400:
                    raise AppError("E_PARAM", "interval_sec: 60..86400", status=400)
                out["interval_sec"] = iv
        if not partial or "servers_json" in body:
            sj_raw = body.get("servers_json")
            if sj_raw is not None:
                if not isinstance(sj_raw, dict):
                    raise AppError("E_PARAM", "servers_json: объект", status=400)
                if sj_raw.get("all") is True:
                    norm = {"all": True}
                else:
                    ids = sj_raw.get("ids") or []
                    if not isinstance(ids, list) or not all(isinstance(x, int) for x in ids):
                        raise AppError(
                            "E_PARAM", "servers_json.ids: список целых", status=400,
                        )
                    for sid in ids:
                        try:
                            self.get_server(sid)
                        except AppError as e:
                            raise AppError(
                                "E_PARAM",
                                f"servers_json.ids: сервер #{sid} не существует",
                                status=400,
                            ) from e
                    norm = {"ids": sorted(set(ids))}
                out["servers_json"] = json.dumps(
                    norm, ensure_ascii=False, sort_keys=True,
                )
        # Дефолты для operation_check при создании: если поля не пришли —
        # подставляем разумные (300 сек, все серверы), чтобы планировщик
        # подхватил правило на ближайшем тике без дополнительных условий.
        if not partial and out.get("condition_kind") == "operation_check":
            if "interval_sec" not in out:
                out["interval_sec"] = 300
            if "servers_json" not in out:
                out["servers_json"] = json.dumps(
                    {"all": True}, ensure_ascii=False, sort_keys=True,
                )
        return out

    async def alert_rule_create(self, body: dict) -> dict:
        fields = self._validate_alert_rule_body(body, partial=False)
        ts = now_z()

        def fn(conn):
            is_opcheck = fields["condition_kind"] == "operation_check"
            interval = fields.get("interval_sec") if is_opcheck else None
            servers_json = fields.get("servers_json") if is_opcheck else None
            # next_run_at = ts: планировщик подхватит на ближайшем тике
            # (poll_loop раз в 30 сек). Совпадает с поведением старого
            # ChecksView, где новая проверка тоже запускалась сразу.
            next_run_at = ts if is_opcheck else None
            cur = conn.execute(
                """INSERT INTO alert_rules
                   (name, enabled, condition_json, severity, server_id,
                    cooldown_sec, builtin, auto_resolve_json, muted_until, created_at,
                    condition_kind, interval_sec, next_run_at, servers_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    fields["name"], fields["enabled"],
                    fields["condition_json"], fields["severity"],
                    fields["server_id"], fields["cooldown_sec"],
                    0,  # пользовательское
                    fields["auto_resolve_json"], None, ts,
                    fields["condition_kind"],
                    interval, next_run_at, servers_json,
                ),
            )
            rid = cur.lastrowid
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.create",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"id": rid, "condition_kind": fields["condition_kind"]},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )
            return rid

        rid = await self.db.mutate(fn)
        return self.alerts.rule_public(self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone())

    async def alert_rule_update(self, rid: int, body: dict) -> dict:
        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        # Тип условия менять нельзя — от него зависит структура condition_json
        # и то, какой механизм будет дёргать правило. Клиент может прислать
        # legacy source (старый UI) или condition_kind — оба смапятся на
        # канонический kind и сравнятся с текущим.
        requested_kind: str | None = None
        if "condition_kind" in body and body["condition_kind"] is not None:
            raw_k = body["condition_kind"]
            if not isinstance(raw_k, str):
                raise AppError("E_PARAM", "condition_kind: строка", status=400)
            requested_kind = raw_k.strip()
        elif "source" in body and body["source"] is not None:
            raw_s = body["source"]
            if not isinstance(raw_s, str):
                raise AppError("E_PARAM", "source: строка", status=400)
            requested_kind = self._SOURCE_TO_KIND_LEGACY.get(raw_s.strip())
            if requested_kind is None:
                raise AppError(
                    "E_PARAM",
                    f"source: {'|'.join(sorted(self._SOURCE_TO_KIND_LEGACY))}",
                    status=400,
                )
        if requested_kind is not None and requested_kind != row["condition_kind"]:
            raise AppError(
                "E_PARAM",
                "тип условия менять нельзя — создайте новое правило",
                status=400,
            )
        fields = self._validate_alert_rule_body(body, partial=True)
        if not fields:
            return dict(row)

        ts = now_z()
        sets = [f"{k}=?" for k in fields]
        args = list(fields.values()) + [rid]

        def fn(conn):
            conn.execute(
                "UPDATE alert_rules SET " + ", ".join(sets) + " WHERE id=?", args,
            )
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"id": rid, "fields": sorted(fields)},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return self.alerts.rule_public(self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone())

    async def alert_rule_delete(self, rid: int) -> dict:
        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        if row["builtin"]:
            raise AppError(
                "E_PARAM",
                "builtin-правило нельзя удалить — только отключить",
                status=400,
            )
        ts = now_z()

        def fn(conn):
            conn.execute("DELETE FROM alert_rules WHERE id=?", (rid,))
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.delete",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"id": rid},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return {"ok": True, "id": rid}

    async def alert_rule_reset(self, rid: int) -> dict:
        """Сброс builtin-правила к дефолту из BUILTIN_RULES.

        Для пользовательских правил — E_PARAM (нечего сбрасывать).
        """
        from melecho.alerts import BUILTIN_RULES
        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        if not row["builtin"]:
            raise AppError(
                "E_PARAM", "сброс работает только для builtin-правил", status=400,
            )
        spec = next((r for r in BUILTIN_RULES if r["name"] == row["name"]), None)
        if spec is None:
            raise AppError(
                "E_STATE",
                f"builtin-правило «{row['name']}» не найдено в BUILTIN_RULES",
                status=500,
            )
        ts = now_z()

        def fn(conn):
            conn.execute(
                """UPDATE alert_rules SET
                     enabled=?, condition_json=?, severity=?, server_id=NULL,
                     cooldown_sec=?, auto_resolve_json=?, muted_until=NULL
                   WHERE id=?""",
                (
                    int(spec.get("enabled_default", 1)),
                    spec["condition_json"],
                    spec["severity"],
                    spec["cooldown_sec"],
                    spec.get("auto_resolve_json"),
                    rid,
                ),
            )
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.reset",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"id": rid, "name": row["name"]},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return self.alerts.rule_public(self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone())

    async def alert_rules_reset_defaults(self) -> dict:
        """Сброс ВСЕХ builtin-правил к дефолтам из BUILTIN_RULES.

        Восстанавливает enabled, condition_json, severity, cooldown,
        auto_resolve. server_id становится NULL (глобальное).
        Пользовательские правила не трогаются.
        """
        from melecho.alerts import BUILTIN_RULES
        specs = {r["name"]: r for r in BUILTIN_RULES}
        ts = now_z()
        counter = {"n": 0}

        def fn(conn):
            rows = conn.execute(
                "SELECT id, name FROM alert_rules WHERE builtin=1"
            ).fetchall()
            for row in rows:
                spec = specs.get(row["name"])
                if spec is None:
                    continue
                conn.execute(
                    """UPDATE alert_rules SET
                         enabled=?, condition_json=?, severity=?, server_id=NULL,
                         cooldown_sec=?, auto_resolve_json=?, muted_until=NULL
                       WHERE id=?""",
                    (
                        int(spec.get("enabled_default", 1)),
                        spec["condition_json"],
                        spec["severity"],
                        spec["cooldown_sec"],
                        spec.get("auto_resolve_json"),
                        row["id"],
                    ),
                )
                counter["n"] += 1
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.reset_defaults",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"updated": counter["n"]},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )
            return counter["n"]

        n = await self.db.mutate(fn)
        return {"ok": True, "updated": n}

    async def alert_rules_disable_all(self) -> dict:
        """Отключить ВСЕ правила — для демонстрации «тихого» старта.

        Builtin и пользовательские. Не удаляет. Пользователь потом
        включит нужное через UI или LLM.
        """
        ts = now_z()
        counter = {"n": 0}

        def fn(conn):
            n = conn.execute(
                "SELECT COUNT(*) AS c FROM alert_rules WHERE enabled=1"
            ).fetchone()["c"]
            counter["n"] = n
            conn.execute("UPDATE alert_rules SET enabled=0 WHERE enabled=1")
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "alert_rule.disable_all",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"disabled": n},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )
            return n

        n = await self.db.mutate(fn)
        return {"ok": True, "disabled": n}

    def check_duplicate(self, body: dict) -> dict:
        """Проверка правила на дубли/конфликты перед сохранением.

        Возвращает {exact_duplicate, conflicts, overrides}:
          - exact_duplicate — правило с тем же condition_kind + condition_json
            + server_id. UI показывает модалку «Я знаю, что делаю»;
          - conflicts — правила, конфликтующие по метрике/операции (та же
            цель, другой порог). UI тоже предупреждает;
          - overrides — новое per-server правило перекрывает существующее
            глобальное по той же метрике. UI показывает бейдж, не блокирует.

        Тело не сохраняется. Валидация — как при create (partial=False),
        чтобы вызывающий сразу видел ошибки формы.

        Сравнение condition_json — через каноническую форму
        (json.dumps sort_keys), чтобы порядок ключей не влиял.
        """
        fields = self._validate_alert_rule_body(body, partial=False)
        kind = fields["condition_kind"]
        sid = fields["server_id"]
        cond_str = fields["condition_json"]
        try:
            cond_obj = json.loads(cond_str)
        except json.JSONDecodeError:
            cond_obj = {}
        metric = cond_obj.get("metric") if isinstance(cond_obj, dict) else None
        op_id = cond_obj.get("operation_id") if isinstance(cond_obj, dict) else None

        rows = self.db.conn.execute("SELECT * FROM alert_rules").fetchall()
        exact: dict | None = None
        conflicts: list[dict] = []
        overrides: list[dict] = []

        for r in rows:
            r_kind = r["condition_kind"]
            r_sid = r["server_id"]
            try:
                r_cond_obj = json.loads(r["condition_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                r_cond_obj = {}
            if not isinstance(r_cond_obj, dict):
                r_cond_obj = {}
            r_cond_str = json.dumps(r_cond_obj, ensure_ascii=False, sort_keys=True)

            # 1. Точный дубликат: kind + condition + server_id.
            if r_kind == kind and r_cond_str == cond_str and r_sid == sid:
                if exact is None:
                    exact = {"id": r["id"], "name": r["name"]}
                continue

            # 2. Метрики: тот же metric.
            if (
                kind in ("metric_threshold", "metric_zscore")
                and r_kind in ("metric_threshold", "metric_zscore")
                and metric
                and r_cond_obj.get("metric") == metric
            ):
                if r_sid == sid:
                    conflicts.append({
                        "id": r["id"], "name": r["name"],
                        "reason": "same_metric",
                    })
                elif sid is not None and r_sid is None:
                    overrides.append({
                        "id": r["id"], "name": r["name"],
                        "reason": "per_server",
                    })

            # 3. operation_check: тот же operation_id.
            if (
                kind == "operation_check"
                and r_kind == "operation_check"
                and op_id
                and r_cond_obj.get("operation_id") == op_id
            ):
                if r_sid == sid:
                    conflicts.append({
                        "id": r["id"], "name": r["name"],
                        "reason": "same_operation",
                    })
                elif sid is not None and r_sid is None:
                    overrides.append({
                        "id": r["id"], "name": r["name"],
                        "reason": "per_server",
                    })

        return {
            "exact_duplicate": exact,
            "conflicts": conflicts,
            "overrides": overrides,
        }

    async def run_rule_now(self, rid: int) -> dict:
        """Ручной запуск operation_check-правила.

        Прогоняет операцию на всех серверах из servers_json, обновляет
        last_run_at/last_result/next_run_at и возвращает сводку.
        """
        rule = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if rule is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        if rule["condition_kind"] != "operation_check":
            raise AppError(
                "E_PARAM",
                "run-now доступен только для правил типа operation_check",
                status=400,
            )
        servers = self._resolve_rule_servers(rule)
        results = []
        for sid, srow in servers:
            try:
                r = await self._run_rule_on_server(rid, sid, srow)
                results.append({"server_id": sid, **r})
            except Exception as e:
                log.exception("run-now: rule %s on server %s failed", rid, sid)
                results.append({"server_id": sid, "status": "error", "message": str(e)})
        ts = now_z()
        iv = rule["interval_sec"] or 300
        next_at = (
            datetime.now(timezone.utc) + timedelta(seconds=iv)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        overall = "ok" if results and all(r["status"] == "ok" for r in results) else "fail"

        def fn(conn):
            conn.execute(
                "UPDATE alert_rules SET last_run_at=?, last_result=?, next_run_at=? WHERE id=?",
                (ts, overall, next_at, rid),
            )

        await self.db.mutate(fn)
        return {"ok": True, "results": results, "overall": overall}

    def list_rule_runs(self, rid: int, limit: int = 100) -> dict:
        """История прогонов operation_check-правила."""
        rule = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if rule is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        if rule["condition_kind"] != "operation_check":
            raise AppError(
                "E_PARAM",
                "история прогонов есть только у правил типа operation_check",
                status=400,
            )
        rows = self.db.conn.execute(
            """SELECT * FROM alert_rule_runs
               WHERE rule_id=? ORDER BY id DESC LIMIT ?""",
            (rid, min(limit, 500)),
        ).fetchall()
        return {"items": [dict(r) for r in rows]}

    def alert_rule_get(self, rid: int) -> dict:
        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)
        return self.alerts.rule_public(row)

    # ---------- retention (Should, iter post-9) ----------
    #
    # Управление сроками хранения данных. Правила — в app/retention.py.
    # Все значения хранятся в settings (retention.<key>_days), дефолты
    # выставляются _init_settings_defaults. Планировщик — poll_loop
    # (раз в cfg.retention_interval_sec, дефолт 3600с).
    #
    # Ручной запуск через API: POST /retention/run?dry_run=true|false.
    # dry_run=true (дефолт) — только превью, без удаления.

    def retention_status(self) -> dict:
        """Текущее состояние: правила, что настроено, что будет удалено.

        Делает COUNT(*) по каждой таблице — операция не бесплатная,
        но UI вызывает нечасто (при открытии секции и по кнопке).
        """
        from melecho.retention import plan_retention
        rules_plan = plan_retention(self.db.conn, self.db.get_setting)
        # short_key — то, что удобно клиенту: без префикса retention.
        for r in rules_plan:
            r["short_key"] = r["key"].replace("retention.", "")
        last_run_at = self.db.get_setting("retention.last_run_at")
        interval = self.cfg.retention_interval_sec
        next_run_at = None
        if last_run_at:
            try:
                next_dt = parse_z(last_run_at) + timedelta(seconds=interval)
                next_run_at = next_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except (ValueError, TypeError):
                pass
        return {
            "rules": rules_plan,
            "last_run_at": last_run_at,
            "next_run_at": next_run_at,
            "run_interval_sec": interval,
        }

    async def retention_update(self, body: dict) -> dict:
        """Обновляет сроки хранения. body: {"metrics_raw_days": 3, ...}.

        Ключ в body — short_key без префикса retention. Валидация min/max
        по RULES. Неизвестный ключ → E_PARAM.
        """
        from melecho.retention import RULES
        by_full = {r.key: r for r in RULES}
        normalized: dict[str, int] = {}
        for k, v in body.items():
            full = "retention." + k
            rule = by_full.get(full)
            if rule is None:
                raise AppError(
                    "E_PARAM",
                    f"неизвестный ключ {k!r} (ожидается один из: "
                    + ", ".join(sorted(x.key.replace("retention.", "") for x in RULES))
                    + ")",
                    status=400,
                )
            if isinstance(v, bool):
                raise AppError("E_PARAM", f"{k}: должно быть целым числом", status=400)
            try:
                iv = int(v)
            except (TypeError, ValueError):
                raise AppError("E_PARAM", f"{k}: должно быть целым числом", status=400)
            if iv < rule.min_days or iv > rule.max_days:
                raise AppError(
                    "E_PARAM",
                    f"{k}: {iv} вне диапазона {rule.min_days}..{rule.max_days}",
                    status=400,
                )
            normalized[full] = iv
        if not normalized:
            return self.retention_status()

        def fn(conn):
            for full, iv in normalized.items():
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (full, str(iv)),
                )

        await self.db.mutate(fn)
        return self.retention_status()

    async def retention_run(self, dry_run: bool = True) -> dict:
        """Прогон retention. dry_run=True (дефолт) — только план.

        При реальном прогоне пишет retention.last_run_at в settings
        (для UI: «последняя очистка», «следующая примерно через N»).
        Аудит не пишет — фоновая операция обслуживания.
        """
        from melecho.retention import plan_retention, run_all_retention
        t0 = time.monotonic()
        if dry_run:
            plan = plan_retention(self.db.conn, self.db.get_setting)
            for r in plan:
                r["short_key"] = r["key"].replace("retention.", "")
            return {
                "dry_run": True,
                "plan": plan,
                "duration_ms": int((time.monotonic() - t0) * 1000),
            }

        def fn(conn):
            res = run_all_retention(conn, self.db.get_setting)
            ts = now_z()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('retention.last_run_at', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (ts,),
            )
            return res, ts

        result, ts = await self.db.mutate(fn)
        items = []
        for k, v in result.items():
            items.append({
                "key": k,
                "short_key": k.replace("retention.", ""),
                "deleted": v,
            })
        return {
            "dry_run": False,
            "deleted": items,
            "ran_at": ts,
            "duration_ms": int((time.monotonic() - t0) * 1000),
        }

    async def _check_threshold_alerts(self) -> None:
        """Проверка правил source=threshold раз в 30 секунд.

        Логика:
          - читаем enabled правила source=threshold;
          - для каждого: список серверов (per-server override или все);
          - берём последнюю raw-точку metrics_history по серверу;
          - извлекаем значение нужной метрики;
          - condition_met → emit; !condition_met → auto-resolve активных
            с этим fingerprint.

        Работает независимо от detector: даже если z-score-правила
        отключены, абсолютные пороги продолжат работать.
        """
        rules = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE enabled=1 AND condition_kind='metric_threshold'"
        ).fetchall()
        if not rules:
            return
        all_servers = [r["id"] for r in self.db.conn.execute(
            "SELECT id FROM servers"
        ).fetchall()]
        for rule in rules:
            try:
                cond = json.loads(rule["condition_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                continue
            metric = cond.get("metric")
            if not metric:
                continue
            sids = [rule["server_id"]] if rule["server_id"] is not None else all_servers
            threshold_repr = cond.get("value_gte")
            if threshold_repr is None:
                threshold_repr = cond.get("value_gt")
            for sid in sids:
                # Offline-сервер: последняя точка metrics_history старая,
                # условие threshold может быть met на устаревших данных —
                # это ложный алерт. Пропускаем полностью; когда сервер
                # вернётся, следующий тик threshold сработает по свежим.
                #
                # check_internet=False: для локальных серверов при глобальном
                # offline данные продолжают поступать — threshold должен
                # работать. Для внешних collect_server уже заблокирован,
                # они уйдут в _server_offline через несколько тиков.
                if self._is_sid_blocked(sid, check_internet=False):
                    continue
                row = self.db.conn.execute(
                    """SELECT * FROM metrics_history
                       WHERE server_id=? AND resolution='30s'
                       ORDER BY timestamp_utc DESC LIMIT 1""",
                    (sid,),
                ).fetchone()
                if row is None:
                    continue
                value = self._metric_value_for_threshold(row, metric)
                if value is None:
                    continue
                # load_1m: нормировка на nproc — порог из правила умножается
                # на число ядер сервера (та же логика, что в detector
                # для z-score ветки, см. Detector._load_threshold).
                # Для остальных метрик multiplier=1.0.
                mult = 1.0
                if metric == "load_1m":
                    mult = float(self.detector.nproc.get(sid, 1))
                fired = self._threshold_condition_met(value, cond, multiplier=mult)
                fp = fingerprint(rule["id"], sid, metric, metric)
                active = self.alerts.find_active_by_fingerprint(fp)
                if fired:
                    label = self._metric_label(metric)
                    # Для процентов: «Диск 97%», «RAM 93%». Для load —
                    # «Load 1m = 8.5»; в description показываем эффективный
                    # порог (nproc × per-cpu).
                    if metric in ("cpu", "ram", "disk"):
                        title = f"{label} {value:.0f}%"
                        value_repr = f"{value:.1f}%"
                        thr_repr = str(threshold_repr)
                        eff_threshold = (
                            float(threshold_repr) if threshold_repr is not None else None
                        )
                    else:
                        title = f"{label} = {value:.2f}"
                        value_repr = f"{value:.2f}"
                        if metric == "load_1m" and threshold_repr is not None:
                            eff = float(threshold_repr) * mult
                            thr_repr = f"{eff:.2f} (nproc×{threshold_repr})"
                            eff_threshold = eff
                        else:
                            thr_repr = str(threshold_repr)
                            eff_threshold = (
                                float(threshold_repr) if threshold_repr is not None else None
                            )
                    desc = (
                        f"текущее {value_repr} · порог {thr_repr} · "
                        f"правило «{rule['name']}»"
                    )
                    await self.alerts.emit(
                        rule,
                        server_id=sid,
                        metric=metric,
                        value=value,
                        threshold=eff_threshold,
                        title=title,
                        description=desc,
                        meta={"rule": rule["name"], "condition": cond},
                        dimension=metric,
                    )
                else:
                    if active:
                        await self.alerts.resolve(
                            active["id"],
                            by="auto",
                            reason=f"{metric} вернулся в норму ({value:.1f})",
                        )

    async def _check_stale_servers(self) -> None:
        """Проверяет last_seen_at каждого сервера и создаёт/закрывает
        stale-алерты.

        Логика:
          age > 1800 c (30 мин) → critical ("Metrics stale (critical)")
          300 c < age ≤ 1800 c  → warning  ("Metrics stale (warn)")
          иначе                 → auto-resolve оба алерта, если они активны.
        """
        warn_rule = self.alerts.find_builtin("Metrics stale (warn)")
        crit_rule = self.alerts.find_builtin("Metrics stale (critical)")
        if warn_rule is None or crit_rule is None:
            return
        servers = self.db.conn.execute("SELECT id, llm_alias, last_seen_at FROM servers").fetchall()
        now_dt = datetime.now(timezone.utc)
        for s in servers:
            sid = s["id"]
            # Не судим о свежести сервера, пока сами не попытались собрать.
            if sid not in self._collected_servers:
                continue
            # Offline-сервер — это «сервер не отвечает», а не «метрики
            # пропали». Отдельная семантика. Stale для него не эмитим,
            # чтобы не плодить «нет метрик 5 мин» на каждый офлайн.
            #
            # check_internet=False: глобальный offline интернета сам по
            # себе не делает метрики stale — они приходят от локальных
            # серверов штатно. Для внешних collect_server уже заблокирован,
            # и они либо в _server_offline, либо просто не попали в
            # _collected_servers. Дубль проверки не нужен.
            if self._is_sid_blocked(sid, check_internet=False):
                continue
            last_seen = s["last_seen_at"]
            if not last_seen:
                continue
            try:
                age = (now_dt - parse_z(last_seen)).total_seconds()
            except (ValueError, TypeError):
                continue

            # ВАЖНО: dimension="stale" должен совпадать с тем, что передаётся
            # в emit() ниже. Иначе find_active_by_fingerprint вернёт None, и
            # система будет плодить дубликаты вместо дедупликации и resolve.
            fp_warn = fingerprint(warn_rule["id"], sid, None, "stale")
            fp_crit = fingerprint(crit_rule["id"], sid, None, "stale")
            active_warn = self.alerts.find_active_by_fingerprint(fp_warn)
            active_crit = self.alerts.find_active_by_fingerprint(fp_crit)

            if age > 1800:
                # Critical. Если warn активен — закрываем его (переросли в crit).
                if active_warn:
                    await self.alerts.resolve(
                        active_warn["id"], by="auto", reason="эскалация в critical"
                    )
                if not active_crit:
                    await self.alerts.emit(
                        crit_rule,
                        server_id=sid,
                        metric=None,
                        value=age,
                        threshold=1800,
                        title=f"Нет метрик {int(age // 60)} мин",
                        description=f"последнее обновление {last_seen}",
                        meta={"age_sec": int(age), "last_seen_at": last_seen},
                        dimension="stale",
                    )
            elif age > 300:
                # Warning. Если crit активен — не трогаем его (всё ещё stale).
                if not active_warn and not active_crit:
                    await self.alerts.emit(
                        warn_rule,
                        server_id=sid,
                        metric=None,
                        value=age,
                        threshold=300,
                        title=f"Нет метрик {int(age // 60)} мин",
                        description=f"последнее обновление {last_seen}",
                        meta={"age_sec": int(age), "last_seen_at": last_seen},
                        dimension="stale",
                    )
            else:
                # Свежие данные — закрываем оба, если были.
                for row in (active_warn, active_crit):
                    if row:
                        await self.alerts.resolve(
                            row["id"], by="auto", reason="метрики снова свежие"
                        )

    # ---------- metrics collection ----------

    async def collect_server(self, sid: int) -> dict | None:
        # Приоритет проверок — от глобального к локальному. Порядок
        # важен: если интернета нет, нет смысла даже читать сервер из БД
        # и делать active_host_key SELECT. Мгновенный raise — poll_loop
        # получит понятный код, не будет разбирать SSH-ошибки.
        # ВАЖНО: check_offline=False. collect_server — это и есть
        # попытка подключения; флаг _server_offline ставится и снимается
        # в poll_loop по результату вызова. Если проверять его здесь,
        # poll_loop никогда не сможет «разбудить» сервер — он сам себя
        # заблокирует (замкнутый круг).
        #
        # check_internet=True: если интернета нет и сервер внешний —
        # не пробуем SSH (20 серверов × таймаут 15 сек = 5 минут впустую).
        # Для локальных серверов flag игнорируется — они работают.
        row = self.get_server(sid)
        block_code = self._is_sid_blocked(sid, row=row, check_offline=False)
        if block_code:
            msg = (
                "нет подключения к интернету — сбор метрик приостановлен"
                if block_code == "E_NO_INTERNET"
                else "сервер не отвечает — сбор метрик приостановлен"
            )
            raise AppError(block_code, msg, status=502)
        self._collected_servers.add(sid)
        # S7+: mismatch — SSH не открываем. Дублирует проверку в
        # _ensure_shell, но эта — раньше (не делаем лишний active_host_key
        # SELECT и не заходим в _ensure_shell вообще).
        if "host_key_mismatch_at" in row.keys() and row["host_key_mismatch_at"]:
            raise AppError(
                "E_HOSTKEY_MISMATCH",
                "host key сервера не совпадает с сохранённым",
                status=403,
            )
        kh = self.active_host_key(row["host"], row["port"])
        if kh is None:
            raise AppError("E_HOSTKEY", "host key не подтверждён", status=409)
        shell = await self._ensure_shell(sid)
        # nproc: читаем один раз при первом успешном сборе, сохраняем в БД.
        # Нужен для нормировки порога load_1m. Отсутствие coreutils / NULL в
        # БД — не ошибка, detector деградирует до nproc=1.
        existing_nproc = row["nproc"] if "nproc" in row.keys() else None
        if existing_nproc:
            self.detector.set_nproc(sid, int(existing_nproc))
        else:
            n = await self._read_nproc(shell)
            if n:
                def _save_nproc(conn, _sid=sid, _n=n):
                    conn.execute("UPDATE servers SET nproc=? WHERE id=?", (_n, _sid))
                await self.db.mutate(_save_nproc)
                self.detector.set_nproc(sid, n)
        # Один SSH-exec вместо шести. Разделение — по метке в stdout.
        raw = await self._collect_metrics_raw(shell)
        cpu_pair = parse_proc_stat(raw["stat"])
        ram = parse_free_b(raw["free"])
        try:
            disk, target = parse_findmnt_json(raw["findmnt"])
        except ValueError:
            disk, target = None, None
        net = parse_proc_net_dev(raw["net"])
        load = parse_loadavg(raw["loadavg"])
        uptime = parse_uptime(raw["uptime"])
        cpu_val = None
        prev = self.prev_cpu.get(sid)
        if cpu_pair:
            if prev:
                cpu_val = cpu_percent(prev, cpu_pair)
                self.prev_cpu[sid] = cpu_pair
            else:
                # Первый сбор после старта/добавления сервера: /proc/stat
                # содержит только cumulative-счётчики, для CPU нужны два
                # замера. Без прогрева первая точка пишется с cpu=NULL —
                # в UI это выглядит, будто CPU «оживает позже» остальных
                # метрик (RAM/Disk/Load/uptime пишутся сразу, потому что
                # они не требуют предыдущего замера).
                # Делаем один короткий второй запрос /proc/stat — этого
                # достаточно, чтобы тики счётчика изменились. Дальше prev
                # уже есть, паузы и второго запроса не будет.
                await asyncio.sleep(0.3)
                try:
                    r2 = await shell.run_argv(["/bin/cat", "/proc/stat"])
                    cpu_pair_2 = parse_proc_stat(r2.stdout or "")
                except Exception:
                    cpu_pair_2 = None
                    log.exception("collect_server: прогрев CPU не удался sid=%s", sid)
                if cpu_pair_2:
                    cpu_val = cpu_percent(cpu_pair, cpu_pair_2)
                    self.prev_cpu[sid] = cpu_pair_2
                else:
                    # Не удалось получить второй замер — пишем точку как
                    # есть (cpu=NULL), но prev сохраняем, чтобы следующий
                    # сбор был нормальным.
                    self.prev_cpu[sid] = cpu_pair
        if sid not in self.prev_net:
            self.prev_net[sid] = net
        else:
            self.prev_net[sid] = net
        ts = now_z()
        point = {
            "server_id": sid,
            "timestamp_utc": ts,
            "cpu": cpu_val,
            "ram": ram,
            "disk": disk,
            "net_rx": net[0],
            "net_tx": net[1],
            "load_avg": json.dumps(load),
            "uptime_sec": uptime,
            "resolution": "30s",
            "disk_role": disk_role(target, self.cfg.disk_roles),
        }

        def fn(conn):
            conn.execute(
                """INSERT INTO metrics_history(server_id, timestamp_utc, cpu, ram, disk, net_rx, net_tx, load_avg, uptime_sec, resolution)
                   VALUES (?,?,?,?,?,?,?,?,?, '30s')""",
                (sid, ts, cpu_val, ram, disk, net[0], net[1], json.dumps(load), uptime),
            )
            conn.execute("UPDATE servers SET last_seen_at=? WHERE id=?", (ts, sid))

        await self.db.mutate(fn)
        prev_pt = self.db.conn.execute(
            """SELECT * FROM metrics_history WHERE server_id=? AND resolution='30s' AND timestamp_utc < ?
               ORDER BY timestamp_utc DESC LIMIT 1""",
            (sid, ts),
        ).fetchone()
        self.detector.ingest_raw_point(sid, point, dict(prev_pt) if prev_pt else None)
        await self._flush_detector_alerts(sid)
        # SSE: новая точка метрик. Клиенты (Dashboard, ServerView)
        # подписаны и делают лёгкий refetch с дебаунсом. При 20 серверах
        # 40 событий/мин — немного. Фильтрацию на бэкенде не делаем:
        # если понадобится, добавим ?topics= в subscribe, не ломая API.
        self.events.publish("metric.point", {
            "server_id": sid,
            "point": point,
        })
        return point

    def _replay_detector_from_db(self) -> None:
        rows = self.db.conn.execute("SELECT id, nproc FROM servers").fetchall()
        for r in rows:
            sid = r["id"]
            if r["nproc"]:
                self.detector.set_nproc(sid, int(r["nproc"]))
            pts = self.db.conn.execute(
                """SELECT * FROM metrics_history WHERE server_id=? AND resolution='30s'
                   ORDER BY timestamp_utc""",
                (sid,),
            ).fetchall()
            if pts:
                self.detector.replay(sid, [dict(p) for p in pts])

    # ---------- operations ----------

    async def plan_op(self, oid: str, sid: int, params: dict, use_sudo: bool | None) -> dict:
        op = self.catalog.get(oid)
        row = self.get_server(sid)
        # Привязка user-операции к серверу (Should, iter 2). Системные —
        # неявно глобальные, is_operation_applicable всегда True. User-op,
        # не привязанная к этому серверу (unbound или явно не в списке),
        # отвергается здесь — до любого SSH.
        if not self.is_operation_applicable(oid, sid):
            raise AppError(
                "E_OP_NOT_APPLICABLE",
                f"операция {oid} не привязана к серверу {row['llm_alias']}",
                status=400,
            )
        units = json.loads(row["allowed_units"] or "[]")
        bound = bind_params(op, params, units)
        if op["flags"].get("escalatable"):
            if use_sudo is None:
                raise AppError("E_PARAM", "для escalatable нужно явно use_sudo true|false", status=400)
        else:
            use_sudo = False
        shell = await self._ensure_shell(sid)
        names = command_names_for(op)
        try:
            paths = await resolve_needed(
                shell, sid, names, self.paths, self.cfg.resolver_path, self.cfg.env_path, allow_sudo=False
            )
        except AppError as e:
            if e.code == "E_SUDO_REQUIRED":
                raise AppError("E_STATE", "plan не должен запрашивать sudo", status=500) from e
            raise
        env_abs = paths.get("env") or self.cfg.env_path
        sudo_abs = paths.get("sudo")
        steps_out = []
        warnings = []
        if op["flags"].get("dangerous"):
            warnings.append("dangerous")
        if not op["flags"].get("reversible", True):
            warnings.append("reversible: false")
        if op["flags"].get("escalatable") and not use_sudo:
            warnings.append("Вывод без sudo может быть неполным")

        def build(st, force_sudo: bool):
            raw = substitute_argv(st["command"], bound)
            wants = step_wants_sudo(raw) or force_sudo
            inner = drop_sudo_prefix(raw) if step_wants_sudo(raw) else raw
            if inner:
                head = inner[0]
                inner = [paths.get(head, head), *inner[1:]]
            mode = None
            if wants:
                mode = "n"
            argv = wrap_locale(inner, env_abs, sudo_abs, mode)
            show = redacted_argv(argv, op.get("params") or [], bound)
            return {
                "command": st["command"],
                "argv": show,
                "sudo": wants,
                "note": st.get("note") or st.get("on_success_note"),
            }

        for st in op.get("preconditions") or []:
            steps_out.append({**build(st, False), "phase": "pre"})
        for st in op["steps"]:
            force = bool(op["flags"].get("escalatable") and use_sudo)
            steps_out.append({**build(st, force), "phase": "run"})
        for st in op.get("postconditions") or []:
            steps_out.append({**build(st, False), "phase": "post"})
        return {
            "operation_id": oid,
            "server_id": sid,
            "read_only": not op["flags"].get("state_changing"),
            "state_changing": op["flags"].get("state_changing"),
            "requires_confirmation": op["flags"].get("requires_confirmation"),
            "use_sudo": bool(use_sudo),
            "warnings": warnings,
            "params": bound,
            "steps": steps_out,
        }

    async def execute_op(self, oid: str, sid: int, params: dict, use_sudo: bool | None, confirm: bool) -> dict:
        op = self.catalog.get(oid)
        if op["flags"].get("requires_confirmation") and not confirm:
            raise AppError("E_CONFIRM", "нужно подтверждение плана", status=400)
        plan = await self.plan_op(oid, sid, params, use_sudo)
        row = self.get_server(sid)
        shell = await self._ensure_shell(sid)
        env_abs = self.cfg.env_path
        sudo_abs = self.paths.get(sid, "sudo") or "/usr/bin/sudo"
        t0 = time.monotonic()
        results = []
        sudo_used = False
        interrupted = False
        full_out = []

        async def exec_phase(st, phase: str):
            nonlocal sudo_used
            raw = substitute_argv(st["command"], plan["params"])
            wants = step_wants_sudo(raw) or (phase == "run" and plan["use_sudo"] and op["flags"].get("escalatable"))
            inner = drop_sudo_prefix(raw) if step_wants_sudo(raw) else raw
            if inner:
                cached = self.paths.get(sid, inner[0]) or inner[0]
                inner = [cached if not inner[0].startswith("/") else inner[0], *inner[1:]]
                if not inner[0].startswith("/"):
                    p = self.paths.get(sid, inner[0])
                    if p:
                        inner[0] = p
            mode = "n" if wants else None
            argv = wrap_locale(inner, env_abs, sudo_abs, mode)
            inp = None
            r = await run_step(shell, argv, self.cfg.step_timeout_sec, inp, self.cfg.step_output_bytes)
            if r.sudo_code == "E_SUDO_REQUIRED":
                pw = self.sudo_pw(sid)
                if not pw:
                    raise AppError("E_SUDO_REQUIRED", f"нужен пароль sudo для {row['llm_alias']}", status=401)
                argv_s = wrap_locale(inner, env_abs, sudo_abs, "S")
                inp = pw.encode("utf-8") + b"\n"
                r = await run_step(shell, argv_s, self.cfg.step_timeout_sec, inp, self.cfg.step_output_bytes)
                sudo_used = True
                argv = argv_s
            if r.sudo_code and r.sudo_code != "E_SUDO_REQUIRED":
                raise AppError(r.sudo_code, r.stderr.strip()[:200] or r.sudo_code, status=400)
            expect = st.get("expect_exit", 0)
            ignore_err = st.get("ignore_stderr")
            if expect is not None and r.exit_code != expect and not (ignore_err and phase):
                if r.exit_code != expect:
                    raise AppError(
                        "E_STEP",
                        f"шаг завершился с кодом {r.exit_code}",
                        status=400,
                        details={"stderr": r.stderr[:500], "exit": r.exit_code},
                    )
            if st.get("expect_stdout") is not None:
                if st["expect_stdout"].strip() not in r.stdout:
                    raise AppError("E_POST", "postcondition stdout не совпал", status=400)
            full_out.append(r.stdout)
            full_out.append(r.stderr)
            # stdout отдаём целиком: на большие выводы уже стоит truncate() в
            # executor.run_step (лимит step_output_bytes = 1 MiB, маркер «[truncated]»
            # в конце). Резать [-4000:] нельзя — мы теряем начало и ломаем
            # парсинг JSON-выводов findmnt, а также делаем бессмысленным
            # спойлер «сырой JSON» в UI.
            # stderr — наоборот, оставляем с началом и лимитом: при ошибках
            # интересен контекст в начале, а не хвост.
            stderr_out = "" if ignore_err else (r.stderr[:2000] if len(r.stderr) > 2000 else r.stderr)
            return {
                "phase": phase,
                "argv": redacted_argv(argv, op.get("params") or [], plan["params"]),
                "exit": r.exit_code,
                "stdout": r.stdout,
                "stderr": stderr_out,
            }

        try:
            async with self.ops_sem:
                for st in op.get("preconditions") or []:
                    results.append(await exec_phase(st, "pre"))
                for st in op["steps"]:
                    results.append(await exec_phase(st, "run"))
                for st in op.get("postconditions") or []:
                    results.append(await exec_phase(st, "post"))
        except AppError as e:
            if e.code == "E_SUDO_REQUIRED":
                raise
            interrupted = e.code == "E_TIMEOUT"
            duration = int((time.monotonic() - t0) * 1000)
            rh = sha256_text(*full_out)
            await self.audit(
                {
                    "action": "execute",
                    "actor": "admin",
                    "command": "<redacted>" if any(p.get("sensitive") for p in op.get("params") or []) else oid,
                    "duration_ms": duration,
                    "interrupted": interrupted,
                    "operation_id": oid,
                    "result_hash": rh,
                    "result_meta": {"exit": 1, "code": e.code},
                    "server_id": sid,
                    "sudo_used": sudo_used,
                    "timestamp_utc": now_z(),
                }
            )
            raise
        duration = int((time.monotonic() - t0) * 1000)
        rh = sha256_text(*full_out)
        sensitive = any(p.get("sensitive") for p in op.get("params") or [])
        cmd_audit = "<redacted:unit>" if "unit" in plan["params"] else shlex_preview(plan)
        await self.audit(
            {
                "action": "execute",
                "actor": "admin",
                "command": cmd_audit if not sensitive else "<redacted:secret>",
                "duration_ms": duration,
                "interrupted": False,
                "operation_id": oid,
                "result_hash": rh,
                "result_meta": {"exit": 0, "sudo": sudo_used} if sudo_used else {"exit": 0},
                "server_id": sid,
                "sudo_used": sudo_used,
                "timestamp_utc": now_z(),
            }
        )
        return {"ok": True, "duration_ms": duration, "sudo_used": sudo_used, "steps": results, "result_hash": rh}

    # ---------- user operations (Should, iter 2) ----------
    #
    # Каталог пользовательских операций — YAML-файлы в catalog_user_dir.
    # Ключ в self.catalog.ops = "user:<id>". Валидация — ТА ЖЕ, что для
    # системных (Catalog._parse): whitelist команд, запрет интерпретаторов,
    # метасимволов, абсолютных путей, `id` matches ID_RE.
    #
    # Семантика:
    #   create — файла нет → создать, файл есть → E_CONFLICT;
    #   update — файла нет → 404, файл есть → перезаписать;
    #   delete — файла нет → 404, иначе unlink;
    #   get_yaml — файла нет → 404, иначе возвращаем как есть (без
    #              валидации — чтобы UI мог показать сломанный YAML для правки).
    #
    # Системные id (disk_check, systemd_restart, ...) защищены: user-op не
    # может их перезаписать (см. Catalog._load_dir → invalid).

    def _user_op_dir(self) -> Path:
        d = self.cfg.catalog_user_dir
        if d is None:
            raise AppError("E_STATE", "user-каталог отключён", status=500)
        return d

    def _user_op_path(self, oid: str) -> Path:
        return self._user_op_dir() / f"{oid}.yaml"

    def _validate_user_op_yaml(self, oid: str, yaml_text: str) -> dict:
        """Парсит YAML и прогоняет через штатный валидатор каталога.

        Возвращает parsed op-dict (как _parse). При ошибке бросает AppError.
        Побочных эффектов нет — файл не пишется.
        """
        if not isinstance(yaml_text, str) or not yaml_text.strip():
            raise AppError("E_PARAM", "yaml: непустая строка", status=400)
        try:
            raw = yaml.safe_load(yaml_text)
        except yaml.YAMLError as e:
            raise AppError("E_PARAM", f"YAML не разбирается: {e}", status=400) from e
        if not isinstance(raw, dict):
            raise AppError("E_PARAM", "YAML должен быть mapping (dict на верхнем уровне)", status=400)
        file_id = raw.get("id")
        if file_id != oid:
            raise AppError(
                "E_PARAM",
                f"id в YAML ({file_id!r}) не совпадает с id в запросе ({oid!r})",
                status=400,
            )
        try:
            op = self.catalog._parse(raw, Path(f"<inline:{oid}.yaml>"))
        except Exception as e:
            raise AppError("E_OP_INVALID", str(e) or "операция не прошла валидацию", status=400) from e
        return op

    async def _audit_user_op(self, action: str, oid: str, file_name: str | None) -> None:
        await self.audit({
            "action": action,
            "actor": "admin",
            "command": None,
            "duration_ms": 0,
            "interrupted": False,
            "operation_id": None,
            "result_hash": None,
            "result_meta": {"id": oid, "file": file_name} if file_name else {"id": oid},
            "server_id": None,
            "sudo_used": False,
            "timestamp_utc": now_z(),
        })

    async def user_op_create(self, oid: str, yaml_text: str) -> dict:
        self._user_op_dir()  # выбрасывает E_STATE, если фича отключена
        if not ID_RE.match(oid):
            raise AppError(
                "E_PARAM",
                f"id {oid!r}: ожидается ^[a-z][a-z0-9_]{{0,63}}$",
                status=400,
            )
        # Защита системных id: даже если файла нет, системная операция с
        # этим именем уже в каталоге — перезаписать её user-ом нельзя.
        existing = self.catalog.ops.get(oid)
        if existing is not None and existing.get("source") == "system":
            raise AppError("E_PARAM", f"id {oid!r} занят системной операцией", status=400)
        path = self._user_op_path(oid)
        if path.exists():
            raise AppError("E_CONFLICT", f"user-операция {oid!r} уже существует", status=409)
        self._validate_user_op_yaml(oid, yaml_text)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml_text, encoding="utf-8")
        self.catalog.load()
        op = self.catalog.ops.get(f"user:{oid}")
        if op is None or not op.get("valid"):
            # Файл на диске есть, но каталог его не принял (гонка?):
            # откат, чтобы не оставлять «отравленный» YAML.
            path.unlink(missing_ok=True)
            self.catalog.load()
            err = (op or {}).get("error") or "операция не принята каталогом"
            raise AppError("E_OP_INVALID", err, status=400)
        await self._audit_user_op("operation.user.create", oid, path.name)
        return self.catalog.public(op)

    async def user_op_update(self, oid: str, yaml_text: str) -> dict:
        self._user_op_dir()
        if not ID_RE.match(oid):
            raise AppError(
                "E_PARAM",
                f"id {oid!r}: ожидается ^[a-z][a-z0-9_]{{0,63}}$",
                status=400,
            )
        path = self._user_op_path(oid)
        if not path.exists():
            raise AppError("E_NOT_FOUND", f"user-операция {oid!r} не найдена", status=404)
        self._validate_user_op_yaml(oid, yaml_text)
        path.write_text(yaml_text, encoding="utf-8")
        self.catalog.load()
        op = self.catalog.ops.get(f"user:{oid}")
        if op is None or not op.get("valid"):
            # Восстановить нечего (перезаписали); сообщаем ошибку как есть.
            err = (op or {}).get("error") or "операция не принята каталогом"
            raise AppError("E_OP_INVALID", err, status=400)
        await self._audit_user_op("operation.user.update", oid, path.name)
        return self.catalog.public(op)

    async def user_op_delete(self, oid: str) -> dict:
        self._user_op_dir()
        if not ID_RE.match(oid):
            raise AppError("E_PARAM", f"id {oid!r}: недопустимый формат", status=400)
        path = self._user_op_path(oid)
        if not path.exists():
            raise AppError("E_NOT_FOUND", f"user-операция {oid!r} не найдена", status=404)
        path.unlink()
        self.catalog.load()
        # Каскад по operation_server_links: FK на servers(id) сам чистит
        # при удалении сервера, но при удалении ОПЕРАЦИИ нужно удалить
        # её строки вручную — иначе останутся «висячие» привязки.
        full_id = f"user:{oid}"

        def fn(conn):
            conn.execute(
                "DELETE FROM operation_server_links WHERE operation_id=?", (full_id,)
            )

        await self.db.mutate(fn)
        await self._audit_user_op("operation.user.delete", oid, path.name)
        return {"ok": True, "id": oid}

    def validate_user_op_yaml(self, oid: str, yaml_text: str) -> dict:
        """Проверка YAML без записи на диск. Для live-валидации в UI.

        ВСЕ «пользовательские» ошибки (плохой id, системный id, невалидный
        YAML) возвращаются как {valid: false, error}. 400 — только если
        клиент прислал мусор (id не строка). Это важно для UI: пока
        пользователь правит YAML, в консоли не должно быть красного 400
        на каждый символ.
        """
        if not isinstance(oid, str):
            raise AppError("E_PARAM", "id: строка", status=400)
        if not ID_RE.match(oid):
            return {
                "valid": False,
                "error": f"id {oid!r}: ожидается ^[a-z][a-z0-9_]{{0,63}}$",
                "parsed": None,
            }
        existing = self.catalog.ops.get(oid)
        if existing is not None and existing.get("source") == "system":
            return {
                "valid": False,
                "error": f"id {oid!r} занят системной операцией",
                "parsed": None,
            }
        try:
            op = self._validate_user_op_yaml(oid, yaml_text)
        except AppError as e:
            return {"valid": False, "error": e.message, "parsed": None}
        op_full = {**op, "id": f"user:{oid}", "source": "user"}
        return {
            "valid": True,
            "error": None,
            "parsed": self.catalog.public(op_full),
        }


    def user_op_get_yaml(self, oid: str) -> dict:
        """Возвращает сырой YAML user-операции.

        Без валидации: UI должен иметь возможность показать и
        отредактировать даже сломанный YAML.
        """
        if not ID_RE.match(oid):
            raise AppError("E_PARAM", f"id {oid!r}: недопустимый формат", status=400)
        path = self._user_op_path(oid)
        if not path.exists():
            raise AppError("E_NOT_FOUND", f"user-операция {oid!r} не найдена", status=404)
        return {
            "id": oid,
            "source": "user",
            "file": path.name,
            "yaml": path.read_text(encoding="utf-8"),
        }

    # ---------- operation links (Should, iter 2) ----------
    #
    # Привязка операции к серверам. Семантика:
    #   - системные операции (без "user:") — неявно глобальные,
    #     строк в таблице нет (backward compat: до этой итерации
    #     привязок не было вообще);
    #   - user-операции:
    #       нет строк            → is_unbound=true (не привязана);
    #       строка с NULL sid    → is_global=true (для всех);
    #       строки с sid=1,2,... → server_ids=[1,2,...].
    # FK operation_server_links(server_id) REFERENCES servers(id)
    # ON DELETE CASCADE — при удалении сервера строки чистятся сами.
    # При удалении user-операции — чистим вручную (2.2a).

    def _links_public(self, oid: str, rows: list) -> dict:
        if not rows:
            return {"operation_id": oid, "is_global": False,
                    "server_ids": [], "is_unbound": True}
        has_global = any(r["server_id"] is None for r in rows)
        if has_global:
            return {"operation_id": oid, "is_global": True,
                    "server_ids": [], "is_unbound": False}
        sids = sorted(int(r["server_id"]) for r in rows if r["server_id"] is not None)
        return {"operation_id": oid, "is_global": False,
                "server_ids": sids, "is_unbound": False}

    def links_get(self, oid: str) -> dict:
        """Читает привязки операции к серверам.

        oid должен существовать в каталоге (системный или "user:...").
        Иначе — E_NOT_FOUND (через self.catalog.get).
        """
        self.catalog.get(oid)
        if not oid.startswith("user:"):
            return {"operation_id": oid, "is_global": True,
                    "server_ids": [], "is_unbound": False, "source": "system"}
        rows = self.db.conn.execute(
            "SELECT server_id FROM operation_server_links WHERE operation_id=?",
            (oid,),
        ).fetchall()
        d = self._links_public(oid, rows)
        d["source"] = "user"
        return d

    async def links_set(self, oid: str, *, is_global: bool, server_ids: list[int]) -> dict:
        """Перезаписывает привязки.

        is_global=True  → одна строка (oid, NULL).
        is_global=False → строки по server_ids (пустой список = unbound).
        Системные операции — E_PARAM.
        Несуществующие server_id — E_NOT_FOUND.
        """
        self.catalog.get(oid)
        if not oid.startswith("user:"):
            raise AppError(
                "E_PARAM",
                "привязки системных операций менять нельзя — они глобальны",
                status=400,
            )
        if is_global:
            sids_clean: list[int] = []
        else:
            # Привести к int (UI может прислать строки), отсортировать,
            # убрать дубли. Проверка существования — до транзакции.
            try:
                sids_clean = sorted({int(x) for x in (server_ids or [])})
            except (TypeError, ValueError) as e:
                raise AppError("E_PARAM", "server_ids: целые числа", status=400) from e
            for sid in sids_clean:
                self.get_server(sid)
        ts = now_z()

        def fn(conn):
            conn.execute(
                "DELETE FROM operation_server_links WHERE operation_id=?", (oid,)
            )
            if is_global:
                conn.execute(
                    "INSERT INTO operation_server_links(operation_id, server_id, created_at) "
                    "VALUES (?, NULL, ?)",
                    (oid, ts),
                )
            else:
                for sid in sids_clean:
                    conn.execute(
                        "INSERT INTO operation_server_links(operation_id, server_id, created_at) "
                        "VALUES (?, ?, ?)",
                        (oid, sid, ts),
                    )
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "operation.links.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {
                        "operation_id": oid,
                        "is_global": is_global,
                        "server_ids": sids_clean,
                    },
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return self.links_get(oid)

    def is_operation_applicable(self, oid: str, server_id: int) -> bool:
        """Применима ли операция к серверу.

        Системные → всегда True.
        User → глобальная ИЛИ есть строка для server_id. Unbound → False.
        """
        if not oid.startswith("user:"):
            return True
        row = self.db.conn.execute(
            "SELECT 1 FROM operation_server_links "
            "WHERE operation_id=? AND (server_id IS NULL OR server_id=?) LIMIT 1",
            (oid, server_id),
        ).fetchone()
        return row is not None

    # ---------- catalog whitelist (Should, iter 2) ----------
    #
    # UI-редактор catalog.d/_whitelist.txt. При ручном добавлении команда
    # валидируется строго (400 при ошибке), в отличие от Catalog._load_whitelist,
    # который при чтении с диска плохие строки пропускает с warning.
    # После каждого изменения — self.catalog.load(), потому что whitelist
    # влияет на валидность уже загруженных YAML.

    def _whitelist_path(self) -> Path:
        d = self._user_op_dir()
        return d / "_whitelist.txt"

    def whitelist_get(self) -> dict:
        path = self._whitelist_path()
        commands: list[str] = []
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if s and not s.startswith("#"):
                    commands.append(s)
        return {
            "path": str(path),
            "commands": sorted(commands),
            "effective": sorted(self.catalog.allowed_commands),
            "base": sorted(self.catalog._base_allowed_commands),
        }

    async def whitelist_add(self, cmd: str) -> dict:
        cmd = (cmd or "").strip()
        if not cmd:
            raise AppError("E_PARAM", "пустая команда", status=400)
        if not CMD_NAME.match(cmd):
            raise AppError(
                "E_PARAM", f"команда {cmd!r}: имя не соответствует ^[A-Za-z0-9._+-]{{1,64}}$",
                status=400,
            )
        if cmd in INTERPRETER_CMDS:
            raise AppError(
                "E_PARAM", f"команда {cmd!r} — интерпретатор/лаунчер, запрещена",
                status=400,
            )
        if cmd in self.catalog._base_allowed_commands:
            raise AppError(
                "E_PARAM",
                f"команда {cmd!r} уже в базовом whitelist (config.toml) — дублировать не нужно",
                status=400,
            )
        path = self._whitelist_path()
        existing = self.whitelist_get()["commands"]
        if cmd in existing:
            raise AppError("E_CONFLICT", f"команда {cmd!r} уже в whitelist", status=409)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(
                "# Команды, разрешённые к использованию в пользовательских операциях.\n"
                "# Одна команда на строку. # — комментарий.\n",
                encoding="utf-8",
            )
        with path.open("a", encoding="utf-8") as f:
            f.write(cmd + "\n")
        self.catalog.load()
        ts = now_z()

        def fn(conn):
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "catalog.whitelist.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"added": [cmd]},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return self.whitelist_get()

    async def whitelist_remove(self, cmd: str) -> dict:
        cmd = (cmd or "").strip()
        if not cmd:
            raise AppError("E_PARAM", "пустая команда", status=400)
        path = self._whitelist_path()
        if not path.exists():
            raise AppError("E_NOT_FOUND", "whitelist пуст", status=404)
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        kept: list[str] = []
        removed = 0
        for ln in lines:
            s = ln.strip()
            if s and not s.startswith("#") and s == cmd:
                removed += 1
                continue
            kept.append(ln)
        if removed == 0:
            raise AppError("E_NOT_FOUND", f"команда {cmd!r} не в whitelist", status=404)
        path.write_text("".join(kept), encoding="utf-8")
        self.catalog.load()
        ts = now_z()

        def fn(conn):
            append_audit(
                conn, self.audit_key, self.cfg.no_audit,
                {
                    "action": "catalog.whitelist.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"removed": [cmd]},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": ts,
                },
            )

        await self.db.mutate(fn)
        return self.whitelist_get()

    # ---------- LLM ----------

    def llm_enabled(self) -> bool:
        v = self.db.get_setting("llm_master_enabled")
        if v is None:
            return bool(self.cfg.llm_master_enabled)
        return v == "1"

    def _llm_api_key(self) -> str | None:
        env = os.environ.get("DEEPSEEK_API_KEY")
        nonce = self.db.get_setting("llm_api_key_nonce")
        ct = self.db.get_setting("llm_api_key_ct")
        if nonce and ct and self.dek:
            try:
                return decrypt_secret(self.dek, nonce, ct, AAD_LLM).decode("utf-8")
            except Exception:
                log.warning("не удалось расшифровать LLM API-ключ")
        return env or None

    # ---------- emergency stop (глобальный kill switch) ----------

    def emergency_state(self) -> dict:
        raw = self.db.get_setting("automation_stopped_json")
        if not raw:
            return {"stopped": False, "stopped_at": None, "disabled_rule_ids": []}
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            return {"stopped": False, "stopped_at": None, "disabled_rule_ids": []}
        return {
            "stopped": bool(d.get("stopped")),
            "stopped_at": d.get("stopped_at"),
            "disabled_rule_ids": d.get("disabled_rule_ids") or [],
        }

    async def emergency_stop(self) -> dict:
        """Выключает все enabled reaction_rules и запоминает их id.

        Идемпотентно: повторный вызов не меняет snapshot.
        Уже запущенные running реакции НЕ прерываются (Milestone 2.2b:
        добавим cancel_requested). Сейчас только блокируем новые.
        """
        existing = self.emergency_state()
        if existing["stopped"]:
            return existing
        now = now_z()

        def fn(conn):
            rows = conn.execute(
                "SELECT id FROM reaction_rules WHERE enabled=1"
            ).fetchall()
            ids = [r["id"] for r in rows]
            conn.execute("UPDATE reaction_rules SET enabled=0, updated_at=? WHERE enabled=1", (now,))
            snapshot = {
                "stopped": True,
                "stopped_at": now,
                "disabled_rule_ids": ids,
            }
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('automation_stopped_json', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps(snapshot, ensure_ascii=False, sort_keys=True),),
            )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "automation.emergency_stop",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"disabled": len(ids)},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now,
                },
            )
            return snapshot

        return await self.db.mutate(fn)

    async def emergency_resume(self) -> dict:
        """Обратная операция: восстанавливает enabled=1 у правил из snapshot."""
        state = self.emergency_state()
        if not state["stopped"]:
            return state
        ids = state["disabled_rule_ids"]
        now = now_z()

        def fn(conn):
            if ids:
                ph = ",".join("?" * len(ids))
                conn.execute(
                    f"UPDATE reaction_rules SET enabled=1, updated_at=? WHERE id IN ({ph})",
                    [now, *ids],
                )
            conn.execute("DELETE FROM settings WHERE key='automation_stopped_json'")
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "automation.emergency_resume",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"enabled": len(ids)},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now,
                },
            )
            return {"stopped": False, "stopped_at": None, "disabled_rule_ids": []}

        return await self.db.mutate(fn)

    # ---------- LLM profiles ----------

    def _active_profile_id(self) -> int | None:
        v = self.db.get_setting("llm_active_profile_id")
        if not v:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    def _profile_row(self, pid: int):
        row = self.db.conn.execute("SELECT * FROM llm_profiles WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"профиль {pid} не найден", status=404)
        return row

    def _profile_api_key(self, row) -> str | None:
        if not row["api_key_ct"] or not row["api_key_nonce"]:
            return None
        dek = self.require_dek()
        try:
            pt = decrypt_secret(
                dek,
                row["api_key_nonce"],
                row["api_key_ct"],
                aad_llm_profile(row["id"], row["api_key_version"] or 1),
            )
            return pt.decode("utf-8")
        except Exception as e:
            raise AppError(
                "E_STATE", f"не удалось расшифровать ключ профиля {row['id']}", status=500
            ) from e

    # Ключи, которые пользователь НЕ может перезаписать через extra_params
    # — иначе случайно сломает логику клиента (например, stream=False
    # превратит SSE-эндпоинт в мусор).
    _RESERVED_BODY_KEYS = frozenset({"model", "messages", "stream", "max_tokens"})

    # Максимумы для истории suggest-стримов. Числа выбраны так, чтобы
    # prompt оставался в разумных рамках: 6 сообщений × 2000 символов =
    # 12000 символов — обычно в разы меньше, потому что реальные описания
    # 100-500 символов, а ответы ассистента короткие.
    _HISTORY_MAX_MESSAGES = 6
    _HISTORY_MAX_CHARS_PER_MSG = 2000
    _HISTORY_ROLES = ("user", "assistant")

    def _validate_history(self, raw) -> list[dict] | None:
        """Валидирует history из body suggest-эндпоинтов.

        Ожидаем: list[{role, content}]. Роли — user|assistant (system
        отбрасываем: в suggest-промпте system-сообщений быть не должно,
        там всё в тексте). Пустые/некорректные элементы отбрасываем
        молча — это UX-подсказка, а не security-вход. Если после чистки
        ничего не осталось — None.

        Возвращаем копию в исходном порядке; берём ПОСЛЕДНИЕ N сообщений
        (то есть если пришло больше 6 — оставляем самые свежие)."""
        if not isinstance(raw, list):
            return None
        cleaned: list[dict] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role not in self._HISTORY_ROLES:
                continue
            if not isinstance(content, str):
                continue
            text = content.strip()
            if not text:
                continue
            if len(text) > self._HISTORY_MAX_CHARS_PER_MSG:
                text = text[: self._HISTORY_MAX_CHARS_PER_MSG] + "…"
            cleaned.append({"role": role, "content": text})
        if not cleaned:
            return None
        if len(cleaned) > self._HISTORY_MAX_MESSAGES:
            cleaned = cleaned[-self._HISTORY_MAX_MESSAGES:]
        return cleaned

    def _validate_extra_params(self, raw) -> dict | None:
        """Валидирует extra_params из UI.

        None или пустой dict → None (параметров нет, в тело запроса ничего
        не подмешивается). Иначе — dict, не содержащий reserved-ключей,
        сериализуемый в JSON и не больше 4 KB.
        """
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise AppError("E_PARAM", "extra_params: ожидается JSON-объект", status=400)
        if not raw:
            return None
        for k in raw:
            if not isinstance(k, str) or not k:
                raise AppError("E_PARAM", "extra_params: ключи — непустые строки", status=400)
            if k in self._RESERVED_BODY_KEYS:
                raise AppError(
                    "E_PARAM",
                    f"extra_params: ключ {k!r} зарезервирован приложением",
                    status=400,
                )
        try:
            serialized = json.dumps(raw, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError) as e:
            raise AppError(
                "E_PARAM",
                f"extra_params: не сериализуется в JSON: {e}",
                status=400,
            ) from e
        if len(serialized.encode("utf-8")) > 4096:
            raise AppError("E_PARAM", "extra_params: слишком большой (>4 KB)", status=400)
        return dict(raw)

    def _profile_public(self, row) -> dict:
        active = self._active_profile_id()
        extra = None
        if row["extra_params_json"]:
            try:
                extra = json.loads(row["extra_params_json"])
            except json.JSONDecodeError:
                extra = None
        return {
            "id": row["id"],
            "name": row["name"],
            "provider": row["provider"],
            "base_url": row["base_url"],
            "model": row["model"],
            "has_api_key": bool(row["api_key_ct"]),
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "is_active": row["id"] == active,
            "extra_params": extra,
        }

    def list_llm_profiles(self) -> dict:
        rows = self.db.conn.execute("SELECT * FROM llm_profiles ORDER BY id").fetchall()
        active = self._active_profile_id()
        return {
            "items": [self._profile_public(r) for r in rows],
            "active_id": active,
        }

    async def create_llm_profile(self, body: dict) -> dict:
        dek = self.require_dek()
        name = (body.get("name") or "").strip()
        if not name or len(name) > 100:
            raise AppError("E_PARAM", "name: 1..100 символов", status=400)
        provider = (body.get("provider") or "custom").strip()
        if provider not in LLM_PRESETS:
            raise AppError("E_PARAM", f"provider {provider!r} неизвестен", status=400)
        base_url = validate_base_url(body.get("base_url") or "")
        model = (body.get("model") or "").strip()
        if not model or len(model) > 100:
            raise AppError("E_PARAM", "model: 1..100 символов", status=400)
        api_key = (body.get("api_key") or "").strip()
        needs_key = bool(LLM_PRESETS[provider].get("needs_key", True))
        if needs_key and not api_key:
            raise AppError("E_PARAM", "для этого провайдера нужен API-ключ", status=400)
        extra_params = self._validate_extra_params(body.get("extra_params"))
        extra_json = (
            json.dumps(extra_params, ensure_ascii=False, sort_keys=True)
            if extra_params else None
        )

        def fn(conn):
            cur = conn.execute(
                """INSERT INTO llm_profiles
                   (name, provider, base_url, model, created_at, api_key_version, extra_params_json)
                   VALUES (?,?,?,?,?,1,?)""",
                (name, provider, base_url, model, now_z(), extra_json),
            )
            pid = cur.lastrowid
            if api_key:
                nonce, ct = encrypt_secret(dek, api_key.encode("utf-8"), aad_llm_profile(pid, 1))
                conn.execute(
                    "UPDATE llm_profiles SET api_key_nonce=?, api_key_ct=? WHERE id=?",
                    (nonce, ct, pid),
                )
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "llm.profile.create",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"provider": provider},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )
            return pid

        pid = await self.db.mutate(fn)
        if self._active_profile_id() is None:
            await self.activate_llm_profile(pid)
        return self._profile_public(self._profile_row(pid))

    async def update_llm_profile(self, pid: int, body: dict) -> dict:
        dek = self.require_dek()
        row = self._profile_row(pid)
        new_name = (body.get("name") or "").strip() if "name" in body else None
        new_provider = (body.get("provider") or "").strip() if "provider" in body else None
        new_base = (body.get("base_url") or "").strip() if "base_url" in body else None
        new_model = (body.get("model") or "").strip() if "model" in body else None
        new_key_provided = "api_key" in body
        new_key = (body.get("api_key") or "").strip() if new_key_provided else None

        if new_name is not None and (not new_name or len(new_name) > 100):
            raise AppError("E_PARAM", "name: 1..100 символов", status=400)
        if new_provider is not None and new_provider not in LLM_PRESETS:
            raise AppError("E_PARAM", "provider неизвестен", status=400)
        if new_base is not None:
            new_base = validate_base_url(new_base)
        if new_model is not None and (not new_model or len(new_model) > 100):
            raise AppError("E_PARAM", "model: 1..100 символов", status=400)

        provider = new_provider or row["provider"]
        needs_key = bool(LLM_PRESETS[provider].get("needs_key", True))
        clear_key = new_key_provided and new_key == ""
        if needs_key and new_key_provided and new_key == "" and not row["api_key_ct"]:
            raise AppError("E_PARAM", "для этого провайдера нужен API-ключ", status=400)
        extra_params_provided = "extra_params" in body
        extra_params = (
            self._validate_extra_params(body.get("extra_params"))
            if extra_params_provided else None
        )

        def fn(conn):
            sets = []
            args = []
            if extra_params_provided:
                sets.append("extra_params_json=?")
                args.append(
                    json.dumps(extra_params, ensure_ascii=False, sort_keys=True)
                    if extra_params else None
                )
            if new_name is not None:
                sets.append("name=?")
                args.append(new_name)
            if new_provider is not None:
                sets.append("provider=?")
                args.append(new_provider)
            if new_base is not None:
                sets.append("base_url=?")
                args.append(new_base)
            if new_model is not None:
                sets.append("model=?")
                args.append(new_model)
            if clear_key:
                sets.append("api_key_ct=NULL")
                sets.append("api_key_nonce=NULL")
            elif new_key:
                ver = (row["api_key_version"] or 1) + 1
                nonce, ct = encrypt_secret(dek, new_key.encode("utf-8"), aad_llm_profile(pid, ver))
                sets.append("api_key_nonce=?")
                args.append(nonce)
                sets.append("api_key_ct=?")
                args.append(ct)
                sets.append("api_key_version=?")
                args.append(ver)
            if sets:
                args.append(pid)
                conn.execute("UPDATE llm_profiles SET " + ", ".join(sets) + " WHERE id=?", args)
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "llm.profile.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"provider": provider},
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        if self._active_profile_id() == pid:
            self._apply_llm()
        return self._profile_public(self._profile_row(pid))

    async def delete_llm_profile(self, pid: int) -> dict:
        self._profile_row(pid)
        was_active = self._active_profile_id() == pid

        def fn(conn):
            conn.execute("DELETE FROM llm_profiles WHERE id=?", (pid,))
            if was_active:
                conn.execute("DELETE FROM settings WHERE key='llm_active_profile_id'")
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "llm.profile.delete",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": None,
                    "server_id": None,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        if was_active:
            self._apply_llm()
        return {"ok": True}

    async def activate_llm_profile(self, pid: int) -> dict:
        self._profile_row(pid)
        self.db.set_setting("llm_active_profile_id", str(pid))
        self.db.conn.commit()
        self._apply_llm()
        return {"ok": True, "active_id": pid}

    # Максимум сообщений и символов на один чат-запрос. Ставим разумные
    # границы, чтобы пользователь (или баг фронта) не залил в LLM мегабайты.
    CHAT_MAX_MESSAGES = 32
    CHAT_MAX_CHARS = 16000
    CHAT_ROLES = {"system", "user", "assistant"}

    def validate_chat_request(self, body: dict) -> tuple[list[dict], int]:
        """Полная параметрическая валидация тела POST /llm/chat.

        Вызывается из HTTP-эндпоинта ДО старта StreamingResponse — чтобы
        неправильный формат возвращался как обычный JSON 400, а не как
        SSE-событие error уже после отправки 200.

        Возвращает (нормализованные messages, max_tokens).

        Отклоняет:
        - не-dict тело;
        - messages не список / пустой / больше CHAT_MAX_MESSAGES;
        - элемент messages не dict, роль вне {system, user, assistant};
        - content не непустая строка, длиннее CHAT_MAX_CHARS;
        - суммарный размер больше CHAT_MAX_CHARS;
        - max_tokens не число.
        """
        if not isinstance(body, dict):
            raise AppError("E_PARAM", "тело должно быть объектом", status=400)
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AppError("E_PARAM", "messages: ожидается список", status=400)
        if not messages:
            raise AppError("E_PARAM", "messages: пустой список", status=400)
        if len(messages) > self.CHAT_MAX_MESSAGES:
            raise AppError(
                "E_PARAM", f"messages: максимум {self.CHAT_MAX_MESSAGES} сообщений", status=400
            )
        out: list[dict] = []
        total = 0
        for i, m in enumerate(messages):
            if not isinstance(m, dict):
                raise AppError("E_PARAM", f"messages[{i}]: ожидается объект", status=400)
            role = m.get("role")
            if role not in self.CHAT_ROLES:
                raise AppError(
                    "E_PARAM", f"messages[{i}].role: должен быть system|user|assistant", status=400
                )
            content = m.get("content")
            if not isinstance(content, str) or not content.strip():
                raise AppError("E_PARAM", f"messages[{i}].content: непустая строка", status=400)
            if len(content) > self.CHAT_MAX_CHARS:
                raise AppError(
                    "E_PARAM",
                    f"messages[{i}].content: > {self.CHAT_MAX_CHARS} символов",
                    status=400,
                )
            total += len(content)
            out.append({"role": role, "content": content})
        if total > self.CHAT_MAX_CHARS:
            raise AppError(
                "E_PARAM", f"суммарный размер сообщений > {self.CHAT_MAX_CHARS} символов", status=400
            )
        raw_mt = body.get("max_tokens", 400)
        if isinstance(raw_mt, bool):
            raise AppError("E_PARAM", "max_tokens: должно быть целым", status=400)
        try:
            max_tokens = int(raw_mt)
        except (TypeError, ValueError) as e:
            raise AppError("E_PARAM", "max_tokens: должно быть целым", status=400) from e
                # 8000 — верхний предел не потому что модель столько выдаст, а
        # чтобы дать запас reasoning-моделям (Gemma тратит до 12K токенов
        # на <thought> прежде чем сформировать ответ). Клиент сейчас
        # просит 4000, но если поднимет — не упрёмся в наш лимит.
        max_tokens = max(8, min(max_tokens, 8000))
        return out, max_tokens

    def _parse_user_op_yaml_safe(self, yaml_text: str) -> tuple[str | None, dict | None, str | None]:
        """Парсит и валидирует YAML user-операции, не зная заранее id.

        Отличие от _validate_user_op_yaml: там id обязателен и сверяется с
        запросом (сценарий "сохранить по имени X"). Здесь id приходит от
        модели — может быть невалидный, и это нормально (LLM могла ошибиться).

        Возвращает (raw_id или None, parsed_op или None, error_str или None).
        Побочных эффектов нет.
        """
        if not isinstance(yaml_text, str) or not yaml_text.strip():
            return None, None, "пустой YAML"
        try:
            raw = yaml.safe_load(yaml_text)
        except yaml.YAMLError as e:
            return None, None, f"YAML не разбирается: {e}"
        if not isinstance(raw, dict):
            return None, None, "YAML должен быть mapping (dict на верхнем уровне)"
        raw_id = raw.get("id") if isinstance(raw.get("id"), str) else None
        try:
            op = self.catalog._parse(raw, Path(f"<llm:{raw_id or 'unnamed'}.yaml>"))
        except Exception as e:
            return raw_id, None, str(e) or "операция не прошла валидацию"
        return raw_id, op, None

    async def explain_alert(self, alert_id: int, question: str = "") -> dict:
        """LLM объясняет конкретный алерт.

        Одноразовый вызов (не sticky). Возвращает текст — не JSON, не YAML.
        Данные алерта передаются в промпт через allowlist полей: никаких
        hostname/IP/username — только llm_alias.

        Принимает alert_id и опциональный вопрос пользователя. Если alert_id
        не существует — E_NOT_FOUND.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )

        row = self.db.conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)

        # Разворачиваем meta_json (в нём хранится z-score, ewma и т.п.).
        meta = None
        if row["meta_json"]:
            try:
                meta = json.loads(row["meta_json"])
            except json.JSONDecodeError:
                meta = None

        # llm_alias: сервер мог быть удалён — защищаемся.
        llm_alias = None
        if row["server_id"] is not None:
            srv = self.db.conn.execute(
                "SELECT llm_alias FROM servers WHERE id=?", (row["server_id"],)
            ).fetchone()
            if srv:
                llm_alias = srv["llm_alias"]

        alert_data = {
            "id": row["id"],
            "llm_alias": llm_alias or (f"server-{row['server_id']}" if row["server_id"] else None),
            "severity": row["severity"],
            "source": row["source"],
            "status": row["status"],
            "metric": row["metric"],
            "value": row["value"],
            "threshold": row["threshold"],
            "title": row["title"],
            "description": row["description"],
            "meta": meta,
            "first_seen_at": row["first_seen_at"],
            "last_seen_at": row["last_seen_at"],
            "repeat_count": row["repeat_count"],
        }
        # Убираем None, чтобы промпт был чище.
        alert_data = {k: v for k, v in alert_data.items() if v is not None}

        prompt = build_explain_alert_prompt(alert_data, question or "")
        log.info("explain_alert: промпт (%d символов):\n%s", len(prompt), prompt)

        saved_timeout = self.llm.timeout
        self.llm.timeout = max(saved_timeout, 300)
        try:
            text, tin, tout, raw_text = await self.llm.complete(prompt, max_tokens=2000)
        finally:
            self.llm.timeout = saved_timeout

        log.info("explain_alert: после strip %d символов", len(text))

        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(), "explain_alert", self.llm.provider, self.llm.model,
                    ph, "alert_explain", tin, tout, 0, "ok",
                    row["server_id"],
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": text,
            "alert_id": alert_id,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            "raw_response": raw_text[:2000],
        }

    async def explain_rule(self, rid: int, question: str = "") -> dict:
        """LLM объясняет правило алерта. Не сохраняет ничего."""
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)

        # Готовим safe-dict: убираем description, source (его нет), builtin
        # оставляем (полезно), но контент без host/user/IP.
        cj = {}
        try:
            cj = json.loads(row["condition_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            cj = {}
        ar = None
        if row["auto_resolve_json"]:
            try:
                ar = json.loads(row["auto_resolve_json"])
            except (json.JSONDecodeError, TypeError):
                ar = None
        sj = None
        if "servers_json" in row.keys() and row["servers_json"]:
            try:
                sj = json.loads(row["servers_json"])
            except (json.JSONDecodeError, TypeError):
                sj = None

        rule_data = {
            "id": row["id"],
            "name": row["name"],
            "condition_kind": row["condition_kind"],
            "severity": row["severity"],
            "enabled": bool(row["enabled"]),
            "cooldown_sec": row["cooldown_sec"],
            "server_id": row["server_id"],
            "condition_json": cj,
            "auto_resolve_json": ar,
            "last_fired_at": row["last_fired_at"],
        }
        if row["condition_kind"] == "operation_check":
            rule_data["interval_sec"] = row["interval_sec"]
            rule_data["servers_json"] = sj

        prompt = build_explain_rule_prompt(rule_data, question or "")
        log.info("explain_rule: промпт (%d символов)", len(prompt))

        saved_timeout = self.llm.timeout
        self.llm.timeout = max(saved_timeout, 300)
        try:
            text, tin, tout, raw_text = await self.llm.complete(prompt, max_tokens=2000)
        finally:
            self.llm.timeout = saved_timeout

        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(), "explain_rule", self.llm.provider, self.llm.model,
                    ph, "rule_explain", tin, tout, 0, "ok",
                    row["server_id"],
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": text,
            "rule_id": rid,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            "raw_response": raw_text[:2000],
        }

    async def suggest_rule_edit(self, rid: int, description: str) -> dict:
        """LLM предлагает правку правила. Возвращает {patch, ...}.

        Ничего не сохраняет: patch — черновик, пользователь увидит форму
        и сохранит отдельно через PATCH /alert-rules/{id}.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)

        cj = {}
        try:
            cj = json.loads(row["condition_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            cj = {}
        ar = None
        if row["auto_resolve_json"]:
            try:
                ar = json.loads(row["auto_resolve_json"])
            except (json.JSONDecodeError, TypeError):
                ar = None
        sj = None
        if "servers_json" in row.keys() and row["servers_json"]:
            try:
                sj = json.loads(row["servers_json"])
            except (json.JSONDecodeError, TypeError):
                sj = None

        rule_data = {
            "id": row["id"],
            "name": row["name"],
            "condition_kind": row["condition_kind"],
            "severity": row["severity"],
            "enabled": bool(row["enabled"]),
            "cooldown_sec": row["cooldown_sec"],
            "server_id": row["server_id"],
            "condition_json": cj,
            "auto_resolve_json": ar,
        }
        if row["condition_kind"] == "operation_check":
            rule_data["interval_sec"] = row["interval_sec"]
            rule_data["servers_json"] = sj

        prompt = build_edit_rule_prompt(rule_data, desc)
        log.info("suggest_rule_edit: промпт (%d символов)", len(prompt))

        saved_timeout = self.llm.timeout
        self.llm.timeout = max(saved_timeout, 600)
        try:
            text, tin, tout, raw_text = await self.llm.complete(prompt, max_tokens=8000)
        finally:
            self.llm.timeout = saved_timeout

        json_text, explanation = extract_yaml_block(text)
        patch_raw: dict | None = None
        patch_validated: dict | None = None
        error: str | None = None

        if not json_text:
            if not explanation:
                error = "модель не вернула ни объяснения, ни JSON-блок"
            else:
                lower = explanation.lower()
                if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                    error = "модель не вернула JSON-блок"
        else:
            try:
                parsed = json.loads(json_text)
            except json.JSONDecodeError as e:
                error = f"JSON не разбирается: {e}"
            else:
                if not isinstance(parsed, dict) or not isinstance(parsed.get("patch"), dict):
                    error = "JSON должен содержать ключ 'patch' с объектом"
                else:
                    patch_raw = parsed["patch"]
                    try:
                        patch_validated = self._validate_rule_patch(row, patch_raw)
                    except AppError as e:
                        error = e.message

        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(), "suggest_rule_edit", self.llm.provider, self.llm.model,
                    ph, "rule_edit_draft", tin, tout, 0,
                    "ok" if not error else "invalid",
                    row["server_id"],
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": explanation,
            "patch_raw": patch_raw,
            "patch": patch_validated,
            "error": error,
            "rule_id": rid,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            "raw_response": raw_text[:2000],
        }

    # Поля, разрешённые к правке через LLM-suggest.
    _RULE_PATCH_FIELDS = frozenset({
        "name", "severity", "condition_json", "auto_resolve_json",
        "server_id", "cooldown_sec", "enabled",
        "interval_sec", "servers_json",
    })

    def _validate_rule_patch(self, rule_row, patch: dict) -> dict:
        """Валидирует и нормализует patch от LLM.

        Только whitelisted поля; типы проверяются. condition_kind менять
        нельзя — если LLM пытается, игнорируем с ошибкой.
        Для полей с ограничениями (interval_sec 60..86400, severity enum
        и т.п.) — те же границы, что в _validate_alert_rule_body.
        """
        out: dict = {}
        extra = set(patch.keys()) - self._RULE_PATCH_FIELDS
        if extra:
            # Не ошибка — игнорируем, но логируем.
            log.warning("suggest_rule_edit: игнорирую лишние поля: %s", sorted(extra))

        if "name" in patch:
            n = patch["name"]
            if not isinstance(n, str) or not n.strip() or len(n) > 200:
                raise AppError("E_PARAM", "patch.name: 1..200 символов", status=400)
            out["name"] = n.strip()
        if "severity" in patch:
            sev = patch["severity"]
            if sev not in ("info", "warning", "critical"):
                raise AppError("E_PARAM", "patch.severity: info|warning|critical", status=400)
            out["severity"] = sev
        if "condition_json" in patch:
            cj = patch["condition_json"]
            if not isinstance(cj, dict):
                raise AppError("E_PARAM", "patch.condition_json: объект", status=400)
            out["condition_json"] = cj
        if "auto_resolve_json" in patch:
            ar = patch["auto_resolve_json"]
            if ar is not None and not isinstance(ar, dict):
                raise AppError("E_PARAM", "patch.auto_resolve_json: объект или null", status=400)
            out["auto_resolve_json"] = ar
        if "server_id" in patch:
            sid = patch["server_id"]
            if sid is not None:
                try:
                    sid = int(sid)
                except (TypeError, ValueError):
                    raise AppError("E_PARAM", "patch.server_id: целое или null", status=400)
                try:
                    self.get_server(sid)
                except AppError as e:
                    raise AppError(
                        "E_PARAM",
                        f"patch.server_id={sid} не существует",
                        status=400,
                    ) from e
            out["server_id"] = sid
        if "cooldown_sec" in patch:
            try:
                cd = int(patch["cooldown_sec"])
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "patch.cooldown_sec: целое", status=400)
            if cd < 0 or cd > 86400:
                raise AppError("E_PARAM", "patch.cooldown_sec: 0..86400", status=400)
            out["cooldown_sec"] = cd
        if "enabled" in patch:
            out["enabled"] = bool(patch["enabled"])
        if "interval_sec" in patch:
            if rule_row["condition_kind"] != "operation_check":
                raise AppError(
                    "E_PARAM",
                    "patch.interval_sec применим только к operation_check",
                    status=400,
                )
            try:
                iv = int(patch["interval_sec"])
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "patch.interval_sec: целое", status=400)
            if iv < 60 or iv > 86400:
                raise AppError("E_PARAM", "patch.interval_sec: 60..86400", status=400)
            out["interval_sec"] = iv
        if "servers_json" in patch:
            if rule_row["condition_kind"] != "operation_check":
                raise AppError(
                    "E_PARAM",
                    "patch.servers_json применим только к operation_check",
                    status=400,
                )
            sj = patch["servers_json"]
            if not isinstance(sj, dict):
                raise AppError("E_PARAM", "patch.servers_json: объект", status=400)
            if sj.get("all") is True:
                out["servers_json"] = {"all": True}
            else:
                ids = sj.get("ids") or []
                if not isinstance(ids, list) or not all(isinstance(x, int) for x in ids):
                    raise AppError("E_PARAM", "patch.servers_json.ids: список целых", status=400)
                for sid in ids:
                    try:
                        self.get_server(sid)
                    except AppError as e:
                        raise AppError(
                            "E_PARAM",
                            f"patch.servers_json.ids: сервер #{sid} не существует",
                            status=400,
                        ) from e
                out["servers_json"] = {"ids": sorted(set(ids))}
        return out

    async def suggest_alert_rule(self, description: str) -> dict:
        """LLM предлагает правила алертов по описанию. Ничего не сохраняет.

        Возвращает:
          explanation — текст без JSON-блока
          rules       — сырой список из JSON модели (для дебага/UI)
          valid_rules — нормализованные, готовы к POST /alert-rules
          invalid_rules — [{index, error}] для невалидных
          error       — верхнеуровневая ошибка (нет блока, JSON не разобран)
          provider, model, tokens_in, tokens_out, prompt_hash, raw_response
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        # Контекст: существующие правила (не дублировать) + серверы +
        # операции (для operation_check — LLM выбирает operation_id из
        # каталога, сама YAML не придумывает).
        existing = [
            dict(r) for r in self.db.conn.execute(
                "SELECT id, name, condition_kind, severity, enabled "
                "FROM alert_rules ORDER BY id"
            ).fetchall()
        ]
        servers_list = [
            {"id": r["id"], "llm_alias": r["llm_alias"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, llm_alias, name FROM servers ORDER BY id"
            ).fetchall()
        ]
        operations_ctx = [
            {"id": op["id"], "name": op.get("name"), "flags": op.get("flags") or {}}
            for op in self.catalog.list() if op.get("valid")
        ]

        prompt = build_suggest_alert_prompt(
            desc, existing, servers_list, operations_ctx,
        )
        log.info("suggest_alert_rule: промпт (%d символов):\n%s", len(prompt), prompt)

        saved_timeout = self.llm.timeout
        self.llm.timeout = max(saved_timeout, 600)
        try:
            text, tin, tout, raw_text = await self.llm.complete(prompt, max_tokens=16000)
        finally:
            self.llm.timeout = saved_timeout

        log.info(
            "suggest_alert_rule: после strip %d символов, начало: %r",
            len(text), text[:400],
        )
        json_text, explanation = extract_yaml_block(text)

        rules_raw: list = []
        valid_rules: list[dict] = []
        invalid_rules: list[dict] = []
        error: str | None = None

        if not json_text:
            if not explanation:
                error = "модель не вернула ни объяснения, ни JSON-блок"
            else:
                lower = explanation.lower()
                if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                    error = "модель не вернула JSON-блок"
        else:
            try:
                parsed = json.loads(json_text)
            except json.JSONDecodeError as e:
                error = f"JSON не разбирается: {e}"
            else:
                if not isinstance(parsed, dict) or not isinstance(parsed.get("rules"), list):
                    error = "JSON должен содержать ключ \'rules\' со списком"
                else:
                    rules_raw = parsed["rules"]
                    if not rules_raw:
                        error = "модель вернула пустой список правил"
                    for i, r in enumerate(rules_raw):
                        if not isinstance(r, dict):
                            invalid_rules.append({"index": i, "error": "не объект"})
                            continue
                        try:
                            fields = self._validate_alert_rule_body(r, partial=False)
                            # operation_check: проверяем, что operation_id
                            # есть в каталоге. Иначе LLM выдумала операцию —
                            # правило нефункционально, помечаем invalid.
                            if fields["condition_kind"] == "operation_check":
                                try:
                                    cj = json.loads(fields["condition_json"])
                                except (json.JSONDecodeError, TypeError):
                                    cj = {}
                                op_id = cj.get("operation_id") if isinstance(cj, dict) else None
                                if not op_id:
                                    invalid_rules.append({
                                        "index": i,
                                        "error": "operation_check без operation_id",
                                    })
                                    continue
                                try:
                                    self.catalog.get(op_id)
                                except AppError:
                                    invalid_rules.append({
                                        "index": i,
                                        "error": f"операция {op_id!r} не найдена в каталоге",
                                    })
                                    continue
                            valid_rules.append({
                                "name": fields["name"],
                                "condition_kind": fields["condition_kind"],
                                "severity": fields["severity"],
                                "condition_json": json.loads(fields["condition_json"]),
                                "auto_resolve_json": (
                                    json.loads(fields["auto_resolve_json"])
                                    if fields["auto_resolve_json"] else None
                                ),
                                "server_id": fields["server_id"],
                                "cooldown_sec": fields["cooldown_sec"],
                                "enabled": bool(fields["enabled"]),
                                # operation_check-специфичные поля — только
                                # когда применимо, иначе не мусорим ответ.
                                **(
                                    {
                                        "interval_sec": fields["interval_sec"],
                                        "servers_json": json.loads(fields["servers_json"]),
                                    }
                                    if fields["condition_kind"] == "operation_check"
                                    and "interval_sec" in fields
                                    and "servers_json" in fields
                                    else {}
                                ),
                            })
                        except AppError as e:
                            invalid_rules.append({"index": i, "error": e.message})

        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(), "suggest_alert_rule", self.llm.provider, self.llm.model,
                    ph, "alert_rule_draft", tin, tout, 0,
                    "ok" if not error else "invalid",
                    None,
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": explanation,
            "rules": rules_raw,
            "valid_rules": valid_rules,
            "invalid_rules": invalid_rules,
            "error": error,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            "raw_response": raw_text[:2000],
        }

    async def suggest_reaction_rule(self, description: str) -> dict:
        """LLM предлагает правило реакции по описанию. Ничего не сохраняет.

        Возвращает:
          explanation — текст без JSON-блока
          rule        — сырой объект rule из JSON (для дебага/UI)
          valid_rule  — нормализованный, готов к POST /reaction-rules
          error       — верхнеуровневая ошибка
          provider, model, tokens_in, tokens_out, prompt_hash, raw_response
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        # Контекст: alert_rules, operations (с flags для hardcode-подсказки),
        # servers, existing reactions. После v13 в alert_rules нет source —
        # только condition_kind.
        alert_rules_ctx = [
            {"id": r["id"], "name": r["name"],
             "condition_kind": r["condition_kind"],
             "severity": r["severity"]}
            for r in self.db.conn.execute(
                "SELECT id, name, condition_kind, severity FROM alert_rules ORDER BY id"
            ).fetchall()
        ]
        operations_ctx = [
            {"id": op["id"], "name": op.get("name"),
             "flags": op.get("flags") or {}}
            for op in self.catalog.list() if op.get("valid")
        ]
        servers_ctx = [
            {"id": r["id"], "llm_alias": r["llm_alias"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, llm_alias, name FROM servers ORDER BY id"
            ).fetchall()
        ]
        existing_reactions = [
            {"id": r["id"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, name FROM reaction_rules ORDER BY id"
            ).fetchall()
        ]

        prompt = build_suggest_reaction_prompt(
            desc, alert_rules_ctx, operations_ctx, servers_ctx, existing_reactions,
        )
        log.info("suggest_reaction_rule: промпт (%d символов):\n%s", len(prompt), prompt)

        saved_timeout = self.llm.timeout
        self.llm.timeout = max(saved_timeout, 600)
        try:
            text, tin, tout, raw_text = await self.llm.complete(prompt, max_tokens=16000)
        finally:
            self.llm.timeout = saved_timeout

        log.info(
            "suggest_reaction_rule: после strip %d символов, начало: %r",
            len(text), text[:400],
        )
        json_text, explanation = extract_yaml_block(text)

        rule_raw: dict | None = None
        valid_rule: dict | None = None
        error: str | None = None

        if not json_text:
            if not explanation:
                error = "модель не вернула ни объяснения, ни JSON-блок"
            else:
                lower = explanation.lower()
                if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                    error = "модель не вернула JSON-блок"
        else:
            try:
                parsed = json.loads(json_text)
            except json.JSONDecodeError as e:
                error = f"JSON не разбирается: {e}"
            else:
                if not isinstance(parsed, dict) or not isinstance(parsed.get("rule"), dict):
                    error = "JSON должен содержать ключ \'rule\' с объектом"
                else:
                    rule_raw = parsed["rule"]
                    try:
                        fields = self.reactions.validate_rule_body(rule_raw)
                        # Нормализуем обратно в UI-friendly dict
                        valid_rule = {
                            "name": fields["name"],
                            "match": json.loads(fields["match_json"]),
                            "operation_id": fields["operation_id"],
                            "params": json.loads(fields["params_json"]),
                            "run_on_server": fields["run_on_server"],
                            "sudo_mode": fields["sudo_mode"],
                            "action_policy": fields["action_policy"],
                            "cooldown_sec": fields["cooldown_sec"],
                            "max_attempts_per_alert": fields["max_attempts_per_alert"],
                            "max_depth": fields["max_depth"],
                            "enabled": bool(fields["enabled"]),
                        }
                    except AppError as e:
                        error = e.message

        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(), "suggest_reaction_rule", self.llm.provider, self.llm.model,
                    ph, "reaction_rule_draft", tin, tout, 0,
                    "ok" if not error else "invalid",
                    None,
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": explanation,
            "rule": rule_raw,
            "valid_rule": valid_rule,
            "error": error,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            "raw_response": raw_text[:2000],
        }

    async def suggest_user_operation(self, description: str) -> dict:
        """LLM предлагает YAML user-операции по описанию.

        Ничего не сохраняет: возвращает черновик для предзаполнения редактора.
        Финальный выбор — за пользователем: LLM не создаёт артефакты
        без подтверждения.

        Ответ:
          explanation   - текст модели без YAML-блока
          yaml          - содержимое fenced-блока или None
          id            - id из YAML, если он там был
          valid         - прошёл ли YAML штатный валидатор каталога
          error         - причина невалидности, если valid=False
          provider/model/tokens_in/tokens_out/prompt_hash - для UI/аудита
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        # Разрешённые команды отдаём LLM в АКТУАЛЬНОМ виде: base + whitelist
        # из catalog.d/_whitelist.txt. Если пользователь уже добавил wg —
        # LLM имеет право её использовать.
        allowed = sorted(self.catalog.allowed_commands)
        prompt = build_suggest_operation_prompt(desc, allowed)
        # Логируем промпт целиком — видно, что реально уходит провайдеру.
        # Помогает при отладке «почему модель уходит в reasoning».
        log.info("suggest_user_operation: промпт (%d символов):\n%s",
                 len(prompt), prompt)
        # S4-канарейки: complete() внутри OpenAICompatLLM вызывает
        # assert_no_secrets(prompt). Никакого отдельного вызова не нужно.

        # 2000 токенов — с запасом на reasoning-блок (Gemini 2.x кладёт
        # «размышления» в content) + YAML. 1000 не хватало: модель
        # упиралась в лимит до того, как выдавала ответ.
        #
        # Таймаут: генерация YAML с reasoning — самая долгая операция в
        # панели. Обычного llm_timeout_sec (30) не хватает. Временно
        # поднимаем до 120 с, затем возвращаем исходное значение.
        saved_timeout = self.llm.timeout
        # 10 минут: reasoning-модели (Gemini 2.x, DeepSeek-R1, o-серия)
        # могут обдумывать несколько минут, особенно при холодном старте.
        self.llm.timeout = max(saved_timeout, 600)
        try:
            # 16000 токенов: reasoning-модели (Gemini 2.x, DeepSeek-R1,
            # o-серия) у Gemini 2.0 Flash легко тратят 4000-8000 токенов
            # на <thought>...</thought> до появления реального ответа.
            # При 4000 модель упиралась в лимит ДО того, как закрывала
            # тег reasoning. 16000 — безопасный запас.
            text, tin, tout, raw_text = await self.llm.complete(
                prompt, max_tokens=16000,
            )
        finally:
            self.llm.timeout = saved_timeout
        # Диагностика: пишем в лог длину и начало ответа. Помогает
        # понять, что модель реально прислала, если extract_yaml_block
        # не находит блок.
        # Диагностика пост-strip: важно понимать, потеряли ли мы всё
        # содержимое из-за незакрытого <thought> (типичный симптом, когда
        # модель упёрлась в max_tokens на reasoning).
        log.info(
            "suggest_user_operation: после strip %d символов, начало: %r",
            len(text), text[:400],
        )
        yaml_text, explanation = extract_yaml_block(text)
        raw_id, parsed_op, error = self._parse_user_op_yaml_safe(yaml_text) if yaml_text else (
            None, None, "модель не вернула YAML-блок"
        )
        valid = parsed_op is not None and error is None
        ph = prompt_hash(prompt)

        def fn(conn):
            conn.execute(
                """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                       prompt_hash, data_categories, tokens_in, tokens_out, cost,
                       status, server_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    now_z(),
                    "suggest_user_operation",
                    self.llm.provider,
                    self.llm.model,
                    ph,
                    "operation_draft",
                    tin,
                    tout,
                    0,
                    "ok" if valid else "invalid_yaml",
                    None,
                ),
            )

        await self.db.mutate(fn)
        return {
            "explanation": explanation,
            "yaml": yaml_text,
            "id": raw_id,
            "valid": valid,
            "error": error,
            "provider": self.llm.provider,
            "model": self.llm.model,
            "tokens_in": tin,
            "tokens_out": tout,
            "prompt_hash": ph,
            # Сырой ответ провайдера ДО strip — чтобы UI показал, что
            # реально прислала модель, когда text пуст (весь ушёл в
            # reasoning). Не идёт в LLM, не пишется в аудит.
            "raw_response": raw_text[:2000],
        }

    # ---------- suggest-*: SSE-стримы ----------
    #
    # Все 4 suggest-режима (operation / alert-rule / reaction-rule / rule-edit)
    # переведены на SSE. Общая машинерия:
    #   - стрим от LLM через self.llm.stream_messages — reasoning (<thought>
    #     и т.п.) вырезается на лету той же логикой, что и в /llm/chat;
    #   - построчный fence-парсер отделяет fenced-блок от explanation;
    #   - в конце — parse_fn(full_text) даёт структурный результат,
    #     байт-в-байт совпадающий с бывшим JSON-ответом.
    #
    # События SSE:
    #   {"type":"chunk","text":"..."}                       — кусок explanation
    #   {"type":"block","content":"...","lang":"yaml|json"} — fenced-блок целиком
    #   {"type":"final", <полный dict>}                     — структурный результат
    #   {"type":"error","code":"...","message":"..."}       — при ошибке
    #
    # Публичные методы НЕ async: они возвращают async-генератор синхронно.
    # Это позволяет выбросить AppError (LLM выключен, пустой desc) ДО старта
    # StreamingResponse — FastAPI отдаст обычный JSON 400, а не SSE после 200.
    # Точно так же работает /llm/chat: там validate_chat_request вызывается
    # до StreamingResponse.

    def _suggest_stream_common(
        self,
        *,
        prompt: str,
        role_label: str,
        data_category: str,
        max_tokens: int,
        parse_fn,
        history: list[dict] | None = None,
    ):
        """Возвращает async-генератор SSE-событий для suggest-* режимов.

        parse_fn(full_text) -> (fields, audit_status).
          fields       — dict; уходит в final как есть (плюс provider/model/
                         prompt_hash, которые добавляет common);
          audit_status — "ok" | "invalid" | "invalid_yaml" — статус для llm_audit.
        """
        # Если пришла история — вставляем её ПЕРЕД задачей. Маркер
        # "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:" есть во всех 4 промптах ровно один раз
        # (проверено в app/llm.py: build_suggest_operation_prompt,
        # build_suggest_alert_prompt, build_suggest_reaction_prompt,
        # build_edit_rule_prompt). Используем rfind на случай, если
        # пользователь напишет ту же фразу в описании — берём последнее.
        if history:
            lines = [
                "ПРЕДЫДУЩИЙ ДИАЛОГ (контекст задачи; НЕ отвечай отдельно на",
                "эти сообщения, используй их только чтобы понять текущую",
                "задачу):",
            ]
            for m in history:
                who = "Пользователь" if m["role"] == "user" else "Ассистент"
                lines.append(f"{who}: {m['content']}")
            dialog_block = "\n".join(lines) + "\n\n"
            marker = "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:"
            idx = prompt.rfind(marker)
            if idx >= 0:
                prompt = prompt[:idx] + dialog_block + prompt[idx:]
            else:
                # На всякий случай: если маркер пропал (кто-то отредактирует
                # промпты), историю всё равно не теряем — добавляем в конец.
                prompt = prompt + "\n\n" + dialog_block.rstrip()

        ph = prompt_hash(prompt)
        provider = self.llm.provider
        model = self.llm.model

        async def _gen():
            full_parts: list[str] = []
            line_buf = ""
            in_line_emitted = False
            in_block = False
            block_lang = ""
            block_body: list[str] = []
            block_raw: list[str] = []
            block_emitted = False

            def _process_line(line: str, in_line: bool = False) -> list[bytes]:
                """Обрабатывает одну полную строку. Возвращает 0 или более
                SSE-событий. Обновляет состояние парсера (in_block,
                block_body, block_raw, block_emitted, block_lang).

                in_line=True — начало этой строки уже эмитилось как chunk
                раньше, значит fence-проверку делать нельзя: fence возможен
                только в начале строки. Используется, когда мы отдали
                часть длинной строки без \n через _safe_prefix_len, а затем
                пришёл \n (или следующий чанк).
                """
                nonlocal in_block, block_lang, block_body, block_raw, block_emitted
                events: list[bytes] = []
                lang = None if in_line else _fence_lang(line)
                if not in_block:
                    if lang is not None:
                        in_block = True
                        block_lang = lang
                        block_body = []
                        block_raw = [line]
                    else:
                        events.append(_sse_event({"type": "chunk", "text": line + "\n"}))
                else:
                    if lang is not None:
                        in_block = False
                        block_raw.append(line)
                        if not block_emitted:
                            block_emitted = True
                            events.append(_sse_event({
                                "type": "block",
                                "content": "\n".join(block_body),
                                "lang": block_lang,
                            }))
                        block_body = []
                        block_raw = []
                    else:
                        block_body.append(line)
                        block_raw.append(line)
                return events

            saved_timeout = self.llm.timeout
            self.llm.timeout = max(saved_timeout, 600)
            try:
                async for chunk in self.llm.stream_messages(
                    [{"role": "user", "content": prompt}],
                    max_tokens=max_tokens,
                ):
                    if not chunk:
                        continue
                    full_parts.append(chunk)
                    line_buf += chunk
                    while "\n" in line_buf:
                        line, line_buf = line_buf.split("\n", 1)
                        for ev in _process_line(line, in_line=in_line_emitted):
                            yield ev
                        in_line_emitted = False
                    # Хвост без \n.
                    #
                    # in_block=True: ждём \n. Внутри блока нельзя отличить
                    # частичный ``` от частичного содержимого, а block_body
                    # должен собираться целиком — иначе первая строка
                    # YAML-блока («id: ...») утекает как обычный chunk
                    # и теряется из содержимого блока.
                    #
                    # in_block=False:
                    #   - in_line_emitted: строка уже начала эмититься как
                    #     chunk (мы отдали её безопасный префикс) — фенс
                    #     в середине невозможен, продолжаем сразу;
                    #   - иначе: если начало строки не может быть фенсом,
                    #     эмитим сразу (снимает «одним куском» для случая,
                    #     когда провайдер шлёт абзац без \n).
                    if line_buf and not in_block:
                        if in_line_emitted:
                            yield _sse_event({"type": "chunk", "text": line_buf})
                            line_buf = ""
                        else:
                            safe = _safe_prefix_len(line_buf)
                            if safe > 0:
                                piece = line_buf[:safe]
                                line_buf = line_buf[safe:]
                                in_line_emitted = True
                                yield _sse_event({"type": "chunk", "text": piece})
            except AppError as e:
                yield _sse_event({"type": "error", "code": e.code, "message": e.message})
                return
            except Exception:
                log.exception("suggest stream error")
                yield _sse_event({
                    "type": "error", "code": "E_INTERNAL",
                    "message": "внутренняя ошибка стрима",
                })
                return
            finally:
                self.llm.timeout = saved_timeout

            # Хвост — последняя строка без завершающего \n. Может быть
            # как обычным текстом, так и закрывающим ``` (типичный случай:
            # LLM присылает ` ``` ` отдельным чанком без \n в конце).
            # Обрабатываем тем же _process_line с учётом in_line: если
            # строка уже начала эмититься раньше, fence-проверка не нужна.
            if line_buf:
                for ev in _process_line(line_buf, in_line=in_line_emitted):
                    yield ev

            # Блок не закрылся к концу стрима — отдаём его как обычный текст,
            # а не как block-событие. Совпадает с extract_yaml_block: незакрытый
            # fence не считается блоком (regex требует закрывающий ```).
            if in_block:
                for raw_line in block_raw:
                    yield _sse_event({"type": "chunk", "text": raw_line + "\n"})

            full_text = "".join(full_parts)

            try:
                fields, audit_status = parse_fn(full_text)
            except Exception:
                log.exception("suggest stream: parse_fn упал")
                yield _sse_event({
                    "type": "error", "code": "E_INTERNAL",
                    "message": "не удалось разобрать ответ LLM",
                })
                return

            # llm_audit. tokens_in/tokens_out = 0: стрим их не отдаёт
            # (провайдеры кладут usage в последний чанк, но не все; в /llm/chat
            # по той же причине audit не пишется вообще). Запись нужна как
            # факт обращения к LLM, точные токены для suggest-* не критичны.
            def _write_audit(conn):
                conn.execute(
                    """INSERT INTO llm_audit(timestamp_utc, role, provider, model,
                           prompt_hash, data_categories, tokens_in, tokens_out, cost,
                           status, server_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        now_z(), role_label, provider, model,
                        ph, data_category, 0, 0, 0, audit_status, None,
                    ),
                )

            try:
                await self.db.mutate(_write_audit)
            except Exception:
                log.exception("suggest stream: не удалось записать llm_audit")

            payload = {
                "type": "final",
                "provider": provider,
                "model": model,
                "prompt_hash": ph,
            }
            payload.update(fields)
            yield _sse_event(payload)

        return _gen()

    def suggest_operation_stream(self, description: str, history=None):
        """SSE-поток: LLM предлагает YAML user-операции.

        Body запроса: {"description": "<задача>", "history": [...]|null}
        history — опциональный контекст (последние сообщения в этом же
        режиме); используется, когда модель до этого задавала УТОЧНИТЕ.
        События: chunk (explanation), block (yaml), final (поля как в
        бывшем JSON: explanation, yaml, id, valid, error, raw_response,
        provider, model, prompt_hash).
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        allowed = sorted(self.catalog.allowed_commands)
        prompt = build_suggest_operation_prompt(desc, allowed)
        log.info("suggest_operation_stream: промпт (%d символов):\n%s", len(prompt), prompt)

        def _parse(text: str):
            yaml_text, explanation = extract_yaml_block(text)
            if not yaml_text:
                raw_id, parsed_op, error = None, None, "модель не вернула YAML-блок"
                valid = False
            else:
                raw_id, parsed_op, error = self._parse_user_op_yaml_safe(yaml_text)
                valid = parsed_op is not None and error is None
            return {
                "explanation": explanation,
                "yaml": yaml_text,
                "id": raw_id,
                "valid": valid,
                "error": error,
                "raw_response": text[:2000],
            }, ("ok" if valid else "invalid_yaml")

        return self._suggest_stream_common(
            prompt=prompt,
            role_label="suggest_user_operation",
            data_category="operation_draft",
            max_tokens=16000,
            parse_fn=_parse,
            history=self._validate_history(history),
        )

    def suggest_alert_rule_stream(self, description: str, history=None):
        """SSE-поток: LLM предлагает правила алертов (JSON-массив).

        history — опциональный контекст предыдущих обменов в этом режиме.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        existing = [
            dict(r) for r in self.db.conn.execute(
                "SELECT id, name, condition_kind, severity, enabled "
                "FROM alert_rules ORDER BY id"
            ).fetchall()
        ]
        servers_list = [
            {"id": r["id"], "llm_alias": r["llm_alias"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, llm_alias, name FROM servers ORDER BY id"
            ).fetchall()
        ]
        operations_ctx = [
            {"id": op["id"], "name": op.get("name"), "flags": op.get("flags") or {}}
            for op in self.catalog.list() if op.get("valid")
        ]

        prompt = build_suggest_alert_prompt(desc, existing, servers_list, operations_ctx)
        log.info("suggest_alert_rule_stream: промпт (%d символов):\n%s", len(prompt), prompt)

        def _parse(text: str):
            json_text, explanation = extract_yaml_block(text)
            rules_raw: list = []
            valid_rules: list[dict] = []
            invalid_rules: list[dict] = []
            error: str | None = None

            if not json_text:
                if not explanation:
                    error = "модель не вернула ни объяснения, ни JSON-блок"
                else:
                    lower = explanation.lower()
                    if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                        error = "модель не вернула JSON-блок"
            else:
                try:
                    parsed = json.loads(json_text)
                except json.JSONDecodeError as e:
                    error = f"JSON не разбирается: {e}"
                else:
                    if not isinstance(parsed, dict) or not isinstance(parsed.get("rules"), list):
                        error = "JSON должен содержать ключ 'rules' со списком"
                    else:
                        rules_raw = parsed["rules"]
                        if not rules_raw:
                            error = "модель вернула пустой список правил"
                        for i, r in enumerate(rules_raw):
                            if not isinstance(r, dict):
                                invalid_rules.append({"index": i, "error": "не объект"})
                                continue
                            try:
                                fields = self._validate_alert_rule_body(r, partial=False)
                                if fields["condition_kind"] == "operation_check":
                                    try:
                                        cj = json.loads(fields["condition_json"])
                                    except (json.JSONDecodeError, TypeError):
                                        cj = {}
                                    op_id = cj.get("operation_id") if isinstance(cj, dict) else None
                                    if not op_id:
                                        invalid_rules.append({
                                            "index": i,
                                            "error": "operation_check без operation_id",
                                        })
                                        continue
                                    try:
                                        self.catalog.get(op_id)
                                    except AppError:
                                        invalid_rules.append({
                                            "index": i,
                                            "error": f"операция {op_id!r} не найдена в каталоге",
                                        })
                                        continue
                                valid_rules.append({
                                    "name": fields["name"],
                                    "condition_kind": fields["condition_kind"],
                                    "severity": fields["severity"],
                                    "condition_json": json.loads(fields["condition_json"]),
                                    "auto_resolve_json": (
                                        json.loads(fields["auto_resolve_json"])
                                        if fields["auto_resolve_json"] else None
                                    ),
                                    "server_id": fields["server_id"],
                                    "cooldown_sec": fields["cooldown_sec"],
                                    "enabled": bool(fields["enabled"]),
                                    **(
                                        {
                                            "interval_sec": fields["interval_sec"],
                                            "servers_json": json.loads(fields["servers_json"]),
                                        }
                                        if fields["condition_kind"] == "operation_check"
                                        and "interval_sec" in fields
                                        and "servers_json" in fields
                                        else {}
                                    ),
                                })
                            except AppError as e:
                                invalid_rules.append({"index": i, "error": e.message})

            return {
                "explanation": explanation,
                "rules": rules_raw,
                "valid_rules": valid_rules,
                "invalid_rules": invalid_rules,
                "error": error,
                "raw_response": text[:2000],
            }, ("ok" if not error else "invalid")

        return self._suggest_stream_common(
            prompt=prompt,
            role_label="suggest_alert_rule",
            data_category="alert_rule_draft",
            max_tokens=16000,
            parse_fn=_parse,
            history=self._validate_history(history),
        )

    def suggest_reaction_rule_stream(self, description: str, history=None):
        """SSE-поток: LLM предлагает правило реакции.

        history — опциональный контекст предыдущих обменов в этом режиме.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        alert_rules_ctx = [
            {"id": r["id"], "name": r["name"],
             "condition_kind": r["condition_kind"],
             "severity": r["severity"]}
            for r in self.db.conn.execute(
                "SELECT id, name, condition_kind, severity FROM alert_rules ORDER BY id"
            ).fetchall()
        ]
        operations_ctx = [
            {"id": op["id"], "name": op.get("name"),
             "flags": op.get("flags") or {}}
            for op in self.catalog.list() if op.get("valid")
        ]
        servers_ctx = [
            {"id": r["id"], "llm_alias": r["llm_alias"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, llm_alias, name FROM servers ORDER BY id"
            ).fetchall()
        ]
        existing_reactions = [
            {"id": r["id"], "name": r["name"]}
            for r in self.db.conn.execute(
                "SELECT id, name FROM reaction_rules ORDER BY id"
            ).fetchall()
        ]

        prompt = build_suggest_reaction_prompt(
            desc, alert_rules_ctx, operations_ctx, servers_ctx, existing_reactions,
        )
        log.info("suggest_reaction_rule_stream: промпт (%d символов):\n%s", len(prompt), prompt)

        def _parse(text: str):
            json_text, explanation = extract_yaml_block(text)
            rule_raw: dict | None = None
            valid_rule: dict | None = None
            error: str | None = None

            if not json_text:
                if not explanation:
                    error = "модель не вернула ни объяснения, ни JSON-блок"
                else:
                    lower = explanation.lower()
                    if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                        error = "модель не вернула JSON-блок"
            else:
                try:
                    parsed = json.loads(json_text)
                except json.JSONDecodeError as e:
                    error = f"JSON не разбирается: {e}"
                else:
                    if not isinstance(parsed, dict) or not isinstance(parsed.get("rule"), dict):
                        error = "JSON должен содержать ключ 'rule' с объектом"
                    else:
                        rule_raw = parsed["rule"]
                        try:
                            fields = self.reactions.validate_rule_body(rule_raw)
                            valid_rule = {
                                "name": fields["name"],
                                "match": json.loads(fields["match_json"]),
                                "operation_id": fields["operation_id"],
                                "params": json.loads(fields["params_json"]),
                                "run_on_server": fields["run_on_server"],
                                "sudo_mode": fields["sudo_mode"],
                                "action_policy": fields["action_policy"],
                                "cooldown_sec": fields["cooldown_sec"],
                                "max_attempts_per_alert": fields["max_attempts_per_alert"],
                                "max_depth": fields["max_depth"],
                                "enabled": bool(fields["enabled"]),
                            }
                        except AppError as e:
                            error = e.message

            return {
                "explanation": explanation,
                "rule": rule_raw,
                "valid_rule": valid_rule,
                "error": error,
                "raw_response": text[:2000],
            }, ("ok" if not error else "invalid")

        return self._suggest_stream_common(
            prompt=prompt,
            role_label="suggest_reaction_rule",
            data_category="reaction_rule_draft",
            max_tokens=16000,
            parse_fn=_parse,
            history=self._validate_history(history),
        )

    def suggest_rule_edit_stream(self, rid: int, description: str, history=None):
        """SSE-поток: LLM предлагает patch для правила алерта.

        history — опциональный контекст предыдущих обменов в этом режиме.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError(
                "E_LLM_KEY",
                "нет активного профиля или ключа — настройте в «Профили LLM»",
                status=400,
            )
        desc = (description or "").strip()
        if not desc:
            raise AppError("E_PARAM", "description: непустая строка", status=400)
        if len(desc) > 4000:
            raise AppError("E_PARAM", "description: максимум 4000 символов", status=400)

        row = self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE id=?", (rid,)
        ).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило {rid} не найдено", status=404)

        cj = {}
        try:
            cj = json.loads(row["condition_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            cj = {}
        ar = None
        if row["auto_resolve_json"]:
            try:
                ar = json.loads(row["auto_resolve_json"])
            except (json.JSONDecodeError, TypeError):
                ar = None
        sj = None
        if "servers_json" in row.keys() and row["servers_json"]:
            try:
                sj = json.loads(row["servers_json"])
            except (json.JSONDecodeError, TypeError):
                sj = None

        rule_data = {
            "id": row["id"],
            "name": row["name"],
            "condition_kind": row["condition_kind"],
            "severity": row["severity"],
            "enabled": bool(row["enabled"]),
            "cooldown_sec": row["cooldown_sec"],
            "server_id": row["server_id"],
            "condition_json": cj,
            "auto_resolve_json": ar,
        }
        if row["condition_kind"] == "operation_check":
            rule_data["interval_sec"] = row["interval_sec"]
            rule_data["servers_json"] = sj

        prompt = build_edit_rule_prompt(rule_data, desc)
        log.info("suggest_rule_edit_stream: промпт (%d символов)", len(prompt))

        def _parse(text: str):
            json_text, explanation = extract_yaml_block(text)
            patch_raw: dict | None = None
            patch_validated: dict | None = None
            error: str | None = None

            if not json_text:
                if not explanation:
                    error = "модель не вернула ни объяснения, ни JSON-блок"
                else:
                    lower = explanation.lower()
                    if not (lower.startswith("уточните:") or lower.startswith("невозможно:")):
                        error = "модель не вернула JSON-блок"
            else:
                try:
                    parsed = json.loads(json_text)
                except json.JSONDecodeError as e:
                    error = f"JSON не разбирается: {e}"
                else:
                    if not isinstance(parsed, dict) or not isinstance(parsed.get("patch"), dict):
                        error = "JSON должен содержать ключ 'patch' с объектом"
                    else:
                        patch_raw = parsed["patch"]
                        try:
                            patch_validated = self._validate_rule_patch(row, patch_raw)
                        except AppError as e:
                            error = e.message

            return {
                "explanation": explanation,
                "patch_raw": patch_raw,
                "patch": patch_validated,
                "error": error,
                "rule_id": rid,
                "raw_response": text[:2000],
            }, ("ok" if not error else "invalid")

        return self._suggest_stream_common(
            prompt=prompt,
            role_label="suggest_rule_edit",
            data_category="rule_edit_draft",
            max_tokens=8000,
            parse_fn=_parse,
            history=self._validate_history(history),
        )


    async def chat_stream(self, messages: list[dict], max_tokens: int = 400):
        """Async-generator: отдаёт чанки ответа LLM по мере поступления.

        Ожидает УЖЕ валидированные (messages, max_tokens) — см.
        validate_chat_request.

        ПЕРЕПИСАНО 2026-10-10: system-сообщение от фронта ИГНОРИРУЕТСЯ
        и подменяется свежим build_chat_system_prompt с АКТУАЛЬНЫМ
        whitelist команд. Раньше фронт слал статичный промпт (жил в
        app.js), из-за чего LLM не знала о добавленных командах и
        отвечала «у меня нет доступа к списку». Плюс подмена защищает
        от prompt-injection через system-role с фронта.
        """
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен в настройках", status=409)
            raise AppError(
                "E_LLM_KEY", "нет активного профиля или ключа — настройте в «Профили LLM»", status=400
            )
        from melecho.llm import assert_no_secrets

        # Свежий system prompt на момент запроса: список команд актуален
        # (пользователь мог только что добавить whitelist-команду).
        dynamic_system = build_chat_system_prompt(sorted(self.catalog.allowed_commands))
        # Выкидываем все system от фронта — там был устаревший статичный
        # промпт, плюс это защита от инъекции через system-role.
        clean_messages = [m for m in messages if m.get("role") != "system"]
        full_messages = [{"role": "system", "content": dynamic_system}, *clean_messages]

        # S4: последний рубеж — проверка канареек и шаблонов секретов.
        # Проверяем именно ИТОГОВЫЙ набор, включая наш динамический system.
        assert_no_secrets(json.dumps(full_messages, ensure_ascii=False))
        # Обновляем last_used_at активного профиля.
        # `mutate` принимает ТОЛЬКО синхронную функцию (см. Database.mutate
        # и защиту F12). Пишем функцию без `async`.
        pid = self._active_profile_id()
        if pid is not None:
            ts = now_z()

            def _mark(conn):
                conn.execute("UPDATE llm_profiles SET last_used_at=? WHERE id=?", (ts, pid))

            await self.db.mutate(_mark)
        async for chunk in self.llm.stream_messages(full_messages, max_tokens=max_tokens):
            yield chunk

    async def list_llm_models(self, body: dict) -> dict:
        """Запрашивает у провайдера список моделей.

        base_url — из тела (режим создания/правки), иначе из активного профиля.
        api_key — из тела, если пользователь его передал; иначе подтягиваем
        сохранённый из профиля (по id в body) или из активного. Логика
        симметрична test_llm_profile: иначе в режиме «правка» юзер видит
        пустое поле ключа, фронт шлёт пустой api_key, и провайдер отвечает
        404 — как было у Gemini при загрузке моделей.
        """
        base_url_raw = (body.get("base_url") or "").strip()
        api_key_provided = "api_key" in body
        api_key = (body.get("api_key") or "").strip() if api_key_provided else ""

        # id профиля из body — пригодится, чтобы подтянуть сохранённый ключ
        # и, при отсутствии base_url, взять его из профиля.
        profile_id_for_key: int | None = None
        if "id" in body and body["id"] is not None:
            try:
                profile_id_for_key = int(body["id"])
            except (TypeError, ValueError):
                profile_id_for_key = None
        if not api_key and profile_id_for_key is not None:
            try:
                row_for_key = self._profile_row(profile_id_for_key)
                api_key = self._profile_api_key(row_for_key) or ""
            except AppError:
                pass

        if base_url_raw:
            base_url = validate_base_url(base_url_raw)
        else:
            pid = profile_id_for_key if profile_id_for_key is not None else self._active_profile_id()
            if pid is None:
                raise AppError(
                    "E_PARAM", "нужен base_url (или активный профиль)", status=400
                )
            row = self._profile_row(pid)
            base_url = row["base_url"]
            api_key = api_key or (self._profile_api_key(row) or "")

        from melecho.llm import OpenAICompatLLM

        client = OpenAICompatLLM(base_url, "_", api_key, self.cfg.llm_timeout_sec)
        models = await client.list_models()
        return {"items": models}

    async def test_llm_profile(self, body: dict) -> dict:
        """Тест соединения. Если base_url+model не переданы — берём активный профиль."""
        provider = (body.get("provider") or "").strip()
        base_url_raw = (body.get("base_url") or "").strip()
        model = (body.get("model") or "").strip()
        api_key_provided = "api_key" in body
        api_key = (body.get("api_key") or "").strip() if api_key_provided else ""

        # Ключ: сначала смотрим body. Если его там нет, но есть id
        # профиля — подтягиваем ключ ИЗ ЭТОГО профиля. Так «Проверить
        # связь» из формы правки работает без повторного ввода ключа
        # (в UI он не показывается).
        #
        # Семантика:
        #   api_key есть в body        → используем как есть (может быть "");
        #   api_key нет, но id профиля → берём из профиля;
        #   api_key нет, id нет        → берём из активного профиля;
        #   вообще ничего              → клиент не пройдёт валидацию ниже.
        profile_id_for_key: int | None = None
        if "id" in body and body["id"] is not None:
            try:
                profile_id_for_key = int(body["id"])
            except (TypeError, ValueError):
                profile_id_for_key = None
        if not api_key_provided and profile_id_for_key is not None:
            try:
                row_for_key = self._profile_row(profile_id_for_key)
                api_key = self._profile_api_key(row_for_key) or ""
            except AppError:
                pass

        if not base_url_raw or not model:
            pid = profile_id_for_key if profile_id_for_key is not None else self._active_profile_id()
            if pid is None:
                raise AppError("E_PARAM", "нужны base_url и model (или активный профиль)", status=400)
            row = self._profile_row(pid)
            base_url = row["base_url"]
            model = row["model"]
            api_key = api_key or (self._profile_api_key(row) or "")
            provider = provider or row["provider"]
        else:
            base_url = validate_base_url(base_url_raw)

        # extra_params из body — пользователь проверяет, работают ли его
        # параметры с этим провайдером. Не сохраняем — только для теста.
        extra_params = self._validate_extra_params(body.get("extra_params"))
        from melecho.llm import OpenAICompatLLM

        client = OpenAICompatLLM(
            base_url, model, api_key, self.cfg.llm_timeout_sec,
            extra_params=extra_params,
        )
        t0 = time.monotonic()
        try:
            # Gemini 2.x тратит токены на thinking-блок — при 8 токенах ответ
            # не успевает выйти. 64 даёт запас на reasoning + короткий ответ.
            text, _, _, _ = await client.complete("Reply with the single word: OK", max_tokens=64)
        except AppError as e:
            return {
                "ok": False,
                "code": e.code,
                "message": e.message,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
            }
        return {
            "ok": True,
            "text": (text or "").strip()[:120],
            "provider": provider,
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
        }

    async def _migrate_legacy_llm_settings(self) -> None:
        """Одноразовая миграция: если профилей нет, но есть legacy-ключ — создать
        профиль DeepSeek. Не пишет аудит (тихая миграция настроек)."""
        try:
            n = self.db.conn.execute("SELECT COUNT(*) AS c FROM llm_profiles").fetchone()["c"]
        except Exception:
            return
        if n:
            return
        legacy_key = self._llm_api_key()
        if not legacy_key or self.dek is None:
            return
        dek = self.dek
        model = self.cfg.llm_model or "deepseek-chat"

        def fn(conn):
            cur = conn.execute(
                """INSERT INTO llm_profiles(name, provider, base_url, model, created_at, api_key_version)
                   VALUES (?,?,?,?,?,1)""",
                ("DeepSeek (миграция)", "deepseek", "https://api.deepseek.com/v1", model, now_z()),
            )
            pid = cur.lastrowid
            nonce, ct = encrypt_secret(dek, legacy_key.encode("utf-8"), aad_llm_profile(pid, 1))
            conn.execute(
                "UPDATE llm_profiles SET api_key_nonce=?, api_key_ct=? WHERE id=?",
                (nonce, ct, pid),
            )
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('llm_active_profile_id', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(pid),),
            )
            return pid

        pid = await self.db.mutate(fn)
        log.info("LLM: legacy-ключ мигрирован в профиль id=%s", pid)

    def _apply_llm(self) -> None:
        self.llm = None
        if not self.llm_enabled():
            return
        # 1. Приоритет — активный профиль.
        pid = self._active_profile_id()
        if pid is not None:
            row = self.db.conn.execute("SELECT * FROM llm_profiles WHERE id=?", (pid,)).fetchone()
            if row is not None:
                try:
                    key = self._profile_api_key(row) or ""
                    extra = None
                    if row["extra_params_json"]:
                        try:
                            extra = json.loads(row["extra_params_json"])
                        except json.JSONDecodeError:
                            log.warning(
                                "профиль %s: extra_params_json не парсится, игнор", pid
                            )
                    from melecho.llm import OpenAICompatLLM

                    self.llm = OpenAICompatLLM(
                        row["base_url"], row["model"], key, self.cfg.llm_timeout_sec,
                        extra_params=extra,
                    )
                    return
                except AppError as e:
                    log.warning("не удалось применить LLM-профиль %s: %s", pid, e.code)
        # 2. Legacy fallback: старый ключ в settings (пока UI не переехал на профили).
        key = self._llm_api_key()
        if not key:
            return
        from melecho.llm import OpenAICompatLLM

        self.llm = OpenAICompatLLM(
            self.cfg.llm_base_url, self.cfg.llm_model, key, self.cfg.llm_timeout_sec
        )

    async def explain_anomaly(self, server_id: int, metric: str, include_logs: bool | None = None) -> dict:
        if self.llm is None:
            if not self.llm_enabled():
                raise AppError("E_LLM_DISABLED", "LLM выключен. Включите в настройках.", status=409)
            raise AppError("E_LLM_KEY", "нет API-ключа LLM — укажите его в настройках", status=400)
        row = self.get_server(server_id)
        alias = row["llm_alias"]
        # Состояние детектора читаем из state (не из alert_candidates:
        # они сливаются в БД через _flush_detector_alerts и там очищаются).
        st = (self.detector.state.get(server_id) or {}).get(metric)
        if not st or not st.anomaly:
            raise AppError("E_NOT_FOUND", "нет аномалии по этой метрике", status=404)
        payload = {
            "baseline_ewma": st.s,
            "current": st.last_x,
            "z_score": st.last_z,
            "threshold": self.cfg.z_threshold,
            "window": "15m",
        }
        if include_logs is None:
            include_logs = bool(int(self.db.get_setting("llm_opt_in_logs") or "0"))
        ids = self.catalog.catalog_ids()
        metric_name = {
            "cpu": "cpu_usage_percent",
            "ram": "ram_usage_percent",
            "disk": "disk_usage_percent",
            "load_1m": "load_1m",
            "net_rx_bps": "net_rx_bps",
            "net_tx_bps": "net_tx_bps",
        }.get(metric, metric)
        prompt = build_anomaly_prompt(alias, metric_name, payload, ids)
        if include_logs:
            excerpt = await self._redacted_log_excerpt(row)
            if excerpt:
                prompt += "\n\nlog_excerpt_redacted:\n" + excerpt
        from melecho.llm import assert_no_secrets

        assert_no_secrets(prompt)
        if row["host"] in prompt or row["name"] in prompt or row["user"] in prompt:
            raise AppError("E_LLM_LEAK", "внутренний отказ: в промпт попали идентификаторы", status=500)
        ph = prompt_hash(prompt)
        if not include_logs:
            cached = self.db.conn.execute(
                "SELECT * FROM llm_cache WHERE prompt_hash=? AND llm_alias=? AND response IS NOT NULL",
                (ph, alias),
            ).fetchone()
        else:
            cached = None
        if cached:
            text = cached["response"]
            tin, tout = 0, 0
            status = "cache"
        else:
            text, tin, tout, _raw = await self.llm.complete(prompt)
            until = ttl_until(self.cfg.llm_cache_ttl_days)

            def fn(conn):
                conn.execute(
                    """INSERT INTO llm_cache(prompt_hash, model, params_hash, llm_alias, response, provider, tokens_used, cost, created_at, ttl_until)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        ph,
                        self.llm.model,
                        "default",
                        alias,
                        None if include_logs else text,
                        self.llm.provider,
                        tin + tout,
                        0,
                        now_z(),
                        until,
                    ),
                )
                conn.execute(
                    """INSERT INTO llm_audit(timestamp_utc, role, provider, model, prompt_hash, data_categories, tokens_in, tokens_out, cost, status, server_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        now_z(),
                        "anomaly_interpreter",
                        self.llm.provider,
                        self.llm.model,
                        ph,
                        "metrics_aggregates",
                        tin,
                        tout,
                        0,
                        "ok",
                        server_id,
                    ),
                )

            await self.db.mutate(fn)
            status = "ok"
        recs = parse_catalog_ids(text, ids)
        return {
            "llm_alias": alias,
            "metric": metric_name,
            "window": "15m",
            "explanation": text,
            "recommendations": recs,
            "prompt_hash": ph,
            "status": status,
            "provider": self.llm.provider,
            "opt_in_logs": include_logs,
        }

    async def _redacted_log_excerpt(self, row) -> str:
        """Забирает журнал через SSH (journalctl) и режет идентификаторы.
        Возвращает пустую строку, если не удалось."""
        try:
            shell = await self._ensure_shell(row["id"])
            r = await shell.run_argv(
                ["/usr/bin/journalctl", "--no-pager", "-n", "20", "-o", "short-iso"]
            )
            if r.exit_code != 0:
                return ""
            raw = r.stdout or ""
        except Exception:
            return ""
        return redact_log_excerpt(raw, [row["host"], row["name"], row["user"]])

    # ---------- audit export / settings ----------

    def csv_audit(self) -> bytes:
        rows = self.db.conn.execute("SELECT * FROM audit_log ORDER BY id").fetchall()
        buf = io.StringIO()
        fields = [
            "id",
            "timestamp_utc",
            "server_id",
            "actor",
            "operation_id",
            "action",
            "command",
            "result_meta",
            "result_hash",
            "duration_ms",
            "sudo_used",
            "interrupted",
            "prev_hmac",
            "entry_hmac",
        ]
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(fields)

        def cell(v):
            if v is None:
                return ""
            s = str(v)
            if s[:1] in {"=", "+", "-", "@", "\t", "\r"}:
                return "'" + s
            return s

        for r in rows:
            w.writerow([cell(r[f]) for f in fields])
        return buf.getvalue().encode("utf-8-sig")

    def list_servers(self) -> list[dict]:
        rows = self.db.conn.execute("SELECT * FROM servers ORDER BY id").fetchall()
        return [self.public_server(r) for r in rows]

    def dashboard(self) -> dict:
        servers = []
        for r in self.db.conn.execute("SELECT * FROM servers ORDER BY id").fetchall():
            sid = r["id"]
            last = self.db.conn.execute(
                """SELECT * FROM metrics_history WHERE server_id=? AND resolution='30s'
                   ORDER BY timestamp_utc DESC LIMIT 1""",
                (sid,),
            ).fetchone()
            spark = self.db.conn.execute(
                """SELECT timestamp_utc, cpu, ram FROM metrics_history
                   WHERE server_id=? AND resolution='30s' ORDER BY timestamp_utc DESC LIMIT 30""",
                (sid,),
            ).fetchall()
            spark = list(reversed(spark))
            st = self.detector.state.get(sid) or {}
            anomaly = any(v.anomaly for v in st.values())
            item = self.public_server(r)
            item["cpu"] = None if last is None else last["cpu"]
            item["ram"] = None if last is None else last["ram"]
            item["disk"] = None if last is None else last["disk"]
            item["load_avg"] = None if last is None else json.loads(last["load_avg"] or "null")
            item["sparkline_cpu"] = [x["cpu"] for x in spark]
            item["sparkline_ram"] = [x["ram"] for x in spark]
            item["sparkline_ts"] = [x["timestamp_utc"] for x in spark]
            item["anomaly"] = anomaly
            item["collect_error"] = self.collect_errors.get(sid)
            item["hostkey"] = bool(self.active_host_key(r["host"], r["port"]))
            servers.append(item)
        integ = self.integrity()
        return {
            "servers": servers,
            "audit": integ,
            "no_audit": self.cfg.no_audit,
            "locked": self.locked(),
            "first_run": self.first_run(),
            # Глобальное состояние интернета. Клиент показывает баннер
            # и через SSE net.status получает апдейты.
            "internet_offline": self._internet_offline,
            "internet_checking": self._internet_checking,
            "internet_last_check_at": self._internet_last_check_at,
            "internet_next_check_in_sec": self._internet_next_check_in_sec(),
            # Публикуется для UI: если false — баннер и настройки
            # проверки интернета не показываются (нечего проверять).
            "has_external_servers": self._has_external_servers(),
        }

    def metrics_query(self, sid: int, resolution: str, ts_from: str | None, ts_to: str | None) -> dict:
        self.get_server(sid)
        if resolution not in {"30s", "5m"}:
            raise AppError("E_PARAM", "resolution: 30s|5m", status=400)
        sql = "SELECT * FROM metrics_history WHERE server_id=? AND resolution=?"
        args: list = [sid, resolution]
        if ts_from:
            sql += " AND timestamp_utc >= ?"
            args.append(ts_from)
        if ts_to:
            sql += " AND timestamp_utc <= ?"
            args.append(ts_to)
        sql += " ORDER BY timestamp_utc"
        rows = [dict(r) for r in self.db.conn.execute(sql, args).fetchall()]
        for r in rows:
            if r.get("load_avg"):
                try:
                    r["load_avg"] = json.loads(r["load_avg"])
                except json.JSONDecodeError:
                    pass
        return {
            "points": rows,
            "net_unit": "bytes_cumulative" if resolution == "30s" else "bytes_delta_5m",
            "resolution": resolution,
        }

    def metrics_batch(self, sid: int, windows: list) -> dict:
        """Метрики за несколько окон одним запросом.

        Каждое окно — отдельный запрос к metrics_history с нужным
        resolution (30s для 15m/1h, 5m для 24h/7d). Это позволяет
        фронту показывать метрики с индивидуальными окнами без
        «оглядки» на глобальное: у CPU может быть 7d при 5m-resolution,
        у RAM — 15m при 30s-resolution, оба приходят одним ответом.

        Body: {"windows": ["15m", "7d", ...]} — максимум 4 (все
        поддерживаемые в UI). Окна уникализируются.
        Ответ: {"byWindow": {"<w>": {points, net_unit, resolution}}}
        — формат каждой записи идентичен GET /metrics.
        """
        self.get_server(sid)
        if not isinstance(windows, list) or not windows:
            windows = ["15m"]
        if len(windows) > len(_WINDOW_MS):
            raise AppError(
                "E_PARAM",
                f"windows: максимум {len(_WINDOW_MS)}",
                status=400,
            )
        unique: list[str] = []
        seen: set[str] = set()
        for w in windows:
            if not isinstance(w, str) or w not in _WINDOW_MS:
                raise AppError(
                    "E_PARAM",
                    f"windows: {w!r} не поддерживается (допустимо: "
                    + ", ".join(sorted(_WINDOW_MS)) + ")",
                    status=400,
                )
            if w in seen:
                continue
            unique.append(w)
            seen.add(w)
        by_window: dict = {}
        now = datetime.now(timezone.utc)
        for w in unique:
            ms = _WINDOW_MS[w]
            res = _WINDOW_RES[w]
            from_s = (now - timedelta(milliseconds=ms)).strftime("%Y-%m-%dT%H:%M:%SZ")
            by_window[w] = self.metrics_query(sid, res, from_s, None)
        return {"byWindow": by_window}

    def audit_list(self, server_id: int | None, action: str | None, limit: int, offset: int) -> dict:
        sql = "SELECT * FROM audit_log WHERE 1=1"
        args: list = []
        if server_id is not None:
            sql += " AND server_id=?"
            args.append(server_id)
        if action:
            sql += " AND action=?"
            args.append(action)
        total = self.db.conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args.extend([limit, offset])
        rows = []
        for r in self.db.conn.execute(sql, args).fetchall():
            d = dict(r)
            if d.get("result_meta"):
                try:
                    d["result_meta"] = json.loads(d["result_meta"])
                except json.JSONDecodeError:
                    pass
            rows.append(d)
        return {"items": rows, "total": total}

    def settings_get(self) -> dict:
        return {
            "sudo_ttl_sec": int(self.db.get_setting("sudo_ttl_sec") or self.cfg.sudo_ttl_sec),
            "metrics_interval_sec": self.cfg.metrics_interval_sec,
            "llm_master_enabled": self.llm_enabled(),
            "llm_provider": self.db.get_setting("llm_provider") or self.cfg.llm_provider,
            "llm_model": self.db.get_setting("llm_model") or self.cfg.llm_model,
            "llm_api_key_set": bool(self.db.get_setting("llm_api_key_ct") or os.environ.get("DEEPSEEK_API_KEY")),
            "llm_ready": self.llm is not None,
            "llm_active_profile_id": self._active_profile_id(),
            "llm_active_profile_name": None
            if self._active_profile_id() is None
            else (
                self.db.conn.execute(
                    "SELECT name FROM llm_profiles WHERE id=?", (self._active_profile_id(),)
                ).fetchone()
                or {"name": None}
            )["name"],
            "no_audit": self.cfg.no_audit,
            "kdf_params_version": int(self.db.get_setting("kdf_params_version") or "1"),
            "max_servers": self.cfg.max_servers,
            "llm_opt_in_logs": bool(int(self.db.get_setting("llm_opt_in_logs") or "0")),
            # Хост/порт для проверки доступа в интернет. Override из
            # settings, fallback на cfg [network]. Пользователь меняет
            # из UI (Настройки → Сеть), если 1.1.1.1:53 недоступен
            # (провайдер блокирует исходящий DNS) или нужен свой резолвер.
            "internet_check_host": self._effective_internet_check_host(),
            "internet_check_port": self._effective_internet_check_port(),
            # Авто-проверка обновлений. Override из settings (UI toggle),
            # fallback на cfg [updates].
            "updates_check_on_start": self._effective_updates_check_on_start(),
        }

    async def settings_patch(self, body: dict) -> dict:
        dek = self.require_dek()

        def fn(conn):
            if "sudo_ttl_sec" in body:
                v = int(body["sudo_ttl_sec"])
                if v < 0:
                    raise AppError("E_PARAM", "sudo_ttl_sec >= 0", status=400)
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('sudo_ttl_sec', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(v),),
                )
            if "llm_master_enabled" in body:
                flag = "1" if body["llm_master_enabled"] else "0"
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_master_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (flag,),
                )
            if "llm_opt_in_logs" in body:
                flag = "1" if body["llm_opt_in_logs"] else "0"
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_opt_in_logs', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (flag,),
                )
            if body.get("llm_provider"):
                prov = str(body["llm_provider"]).strip()
                if prov not in {"deepseek", "mock", "off"}:
                    raise AppError("E_PARAM", "llm_provider: deepseek|mock|off", status=400)
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_provider', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (prov,),
                )
            if body.get("llm_model"):
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_model', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(body["llm_model"]).strip(),),
                )
            if body.get("llm_api_key"):
                nonce, ct = encrypt_secret(dek, str(body["llm_api_key"]).encode("utf-8"), AAD_LLM)
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_api_key_nonce', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (nonce,),
                )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('llm_api_key_ct', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (ct,),
                )
            if body.get("llm_api_key") == "":
                # пустая строка = сброс ключа
                conn.execute("DELETE FROM settings WHERE key IN ('llm_api_key_nonce','llm_api_key_ct')")
            # Авто-проверка обновлений. Строго bool. При отключении
            # фоновая задача _update_poll_loop сама перестаёт делать HTTP.
            if "updates_check_on_start" in body:
                v = body["updates_check_on_start"]
                if not isinstance(v, bool):
                    raise AppError(
                        "E_PARAM", "updates_check_on_start: true|false", status=400
                    )
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('updates_check_on_start', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("1" if v else "0",),
                )
            # Хост/порт для проверки интернета. Пустой host = reset на
            # cfg [network]. Порт валидируется 1..65535; при выходе за
            # диапазон — E_PARAM (лучше явная ошибка, чем молчаливое
            # игнорирование неправильного ввода).
            if "internet_check_host" in body:
                raw = body["internet_check_host"]
                if raw is None:
                    conn.execute("DELETE FROM settings WHERE key='internet_check_host'")
                elif isinstance(raw, str):
                    h = raw.strip()
                    if not h:
                        conn.execute("DELETE FROM settings WHERE key='internet_check_host'")
                    elif not HOST_RE.match(h):
                        raise AppError(
                            "E_PARAM",
                            "internet_check_host: недопустимые символы или слишком длинный",
                            status=400,
                        )
                    else:
                        conn.execute(
                            "INSERT INTO settings(key, value) VALUES ('internet_check_host', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (h,),
                        )
                else:
                    raise AppError("E_PARAM", "internet_check_host: строка или null", status=400)
            if "internet_check_port" in body:
                raw_p = body["internet_check_port"]
                if raw_p is None:
                    conn.execute("DELETE FROM settings WHERE key='internet_check_port'")
                elif isinstance(raw_p, bool):
                    raise AppError("E_PARAM", "internet_check_port: целое число", status=400)
                else:
                    try:
                        pv = int(raw_p)
                    except (TypeError, ValueError):
                        raise AppError("E_PARAM", "internet_check_port: целое число", status=400)
                    if pv < 1 or pv > 65535:
                        raise AppError(
                            "E_PARAM", "internet_check_port: 1..65535", status=400
                        )
                    conn.execute(
                        "INSERT INTO settings(key, value) VALUES ('internet_check_port', ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (str(pv),),
                    )

        await self.db.mutate(fn)
        self._apply_llm()
        return self.settings_get()

    # ---------- services / allowed units ----------

    async def list_services(self, sid: int, q: str, page: int, per_page: int) -> dict:
        row = self.get_server(sid)
        shell = await self._ensure_shell(sid)
        r = await shell.run_argv(
            ["/usr/bin/systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"]
        )
        lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
        units = []
        for ln in lines[:5000]:
            name = ln.split()[0]
            if not UNIT_RE.match(name):
                continue
            if q and q.lower() not in name.lower():
                continue
            rest = ln.split()
            units.append(
                {
                    "unit": name,
                    "load": rest[1] if len(rest) > 1 else "",
                    "active": rest[2] if len(rest) > 2 else "",
                    "sub": rest[3] if len(rest) > 3 else "",
                }
            )
        per_page = min(max(per_page, 1), 50)
        page = max(page, 1)
        start = (page - 1) * per_page
        allowed = json.loads(row["allowed_units"] or "[]")
        for u in units:
            u["allowed"] = u["unit"] in allowed
        return {"items": units[start : start + per_page], "total": len(units), "page": page, "per_page": per_page}

    def allowed_units_get(self, sid: int) -> dict:
        row = self.get_server(sid)
        return {"allowed_units": json.loads(row["allowed_units"] or "[]")}

    async def allowed_units_put(self, sid: int, units: list[str]) -> dict:
        from melecho.catalog import _validate_unit

        row = self.get_server(sid)
        clean = []
        for u in units:
            _validate_unit(u)
            clean.append(u)
        if len(clean) > 5000:
            raise AppError("E_LIMIT", "слишком много unit", status=400)
        shell = await self._ensure_shell(sid)
        for u in clean:
            # Инъекция невозможна уже на этапе _validate_unit, но конкатенация
            # в строку — плохой паттерн. Явный argv + /bin/sh -c делает вызов
            # детерминированным (F10).
            r = await shell.run_argv(["/usr/bin/systemctl", "cat", u])
            if r.exit_code != 0:
                raise AppError("E_PARAM", f"systemctl cat {u} завершился с ошибкой", status=400)
        old = json.loads(row["allowed_units"] or "[]")
        added = sorted(set(clean) - set(old))
        removed = sorted(set(old) - set(clean))

        def fn(conn):
            conn.execute("UPDATE servers SET allowed_units=? WHERE id=?", (json.dumps(clean), sid))
            append_audit(
                conn,
                self.audit_key,
                self.cfg.no_audit,
                {
                    "action": "allowed_units.update",
                    "actor": "admin",
                    "command": None,
                    "duration_ms": 0,
                    "interrupted": False,
                    "operation_id": None,
                    "result_hash": None,
                    "result_meta": {"added": added, "removed": removed},
                    "server_id": sid,
                    "sudo_used": False,
                    "timestamp_utc": now_z(),
                },
            )

        await self.db.mutate(fn)
        return {"allowed_units": clean, "added": added, "removed": removed}

    # ---------- anomalies / llm audit ----------

    def anomalies(self, server_id: int | None) -> dict:
        """Активные алерты для UI. Формат совместим с прежним (deque-based):
        добавлены severity/status/repeat_count, но старые поля (z_score,
        window, llm_alias, metric, server_id) сохранены для текущего UI."""
        res = self.alerts.list_alerts(
            server_id=server_id,
            statuses=("open", "reacting", "pending_confirmation", "acknowledged"),
            limit=200,
        )
        items = []
        for a in res["items"]:
            meta = a.get("meta") or {}
            alias = None
            if a["server_id"] is not None:
                try:
                    alias = self.get_server(a["server_id"])["llm_alias"]
                except AppError:
                    alias = f"server-{a['server_id']}"
            items.append({
                "id": a["id"],
                "server_id": a["server_id"],
                "metric": a["metric"],
                "z_score": meta.get("z") or 0.0,
                "ewma": meta.get("ewma"),
                "window": meta.get("window") or "15m",
                "severity": a["severity"],
                "title": a["title"],
                "description": a.get("description"),
                "source": a["source"],
                "status": a["status"],
                "first_seen_at": a["first_seen_at"],
                "last_seen_at": a["last_seen_at"],
                "repeat_count": a["repeat_count"],
                "llm_alias": alias,
            })
        # Старые записи показываем сверху — UI использует slice(-8).
        items.sort(key=lambda x: x["last_seen_at"])
        return {"items": items[-50:]}

    def llm_audit_list(self, limit: int = 50) -> dict:
        rows = self.db.conn.execute("SELECT * FROM llm_audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return {"items": [dict(r) for r in rows]}

    # ---------- poll loop / backlog ----------

    async def _internet_poll_loop(self) -> None:
        """Отдельный task: активный polling интернета при offline.

        Вынесен из poll_loop, потому что тот делает много вещей подряд
        и любое исключение в collect'ах валит всю итерацию — до polling'а
        дело не доходит. Отдельный task изолирован: свой while, свой
        try/except, свой sleep.

        Логика: при _internet_offline проверяем handshake с force=True
        каждые N секунд (backoff 5 → 10 → 20 → 30). При успехе — снимаем
        глобальный флаг, чистим per-server offline.
        """
        log.info("internet-poll: task started")
        while True:
            try:
                await asyncio.sleep(1.0)
                # Работаем только после unlock — до этого cfg.дек ещё
                # не расшифрован, и вообще панелью пользоваться нельзя.
                if self.dek is None:
                    continue
                # Если все серверы локальные — проверка интернета не
                # нужна. Сбрасываем возможный старый флаг (мог остаться,
                # если удалили последний внешний сервер, пока шёл offline)
                # и спим.
                if not self._has_external_servers():
                    if self._internet_offline:
                        self._set_internet_state(offline=False)
                        self._server_offline.clear()
                        log.info("internet-poll: все серверы локальные — флаг сброшен")
                    self._internet_poll_backoff = 0.0
                    continue
                if not self._internet_offline:
                    # Сбрасываем backoff, чтобы в следующий раз начать
                    # с минимума (5 сек). Иначе после долгого offline
                    # следующая пауза сразу начнётся с 30 сек.
                    self._internet_poll_backoff = 0.0
                    continue
                now = time.monotonic()
                if now < self._internet_poll_next_at:
                    continue
                log.info(
                    "internet-poll: пробую handshake (%s:%s) backoff=%.0fs",
                    self._effective_internet_check_host(),
                    self._effective_internet_check_port(),
                    self._internet_poll_backoff,
                )
                # checking=True — SSE net.status уходит в UI, баннер
                # показывает спиннер в кнопке (как при ручной проверке).
                self._set_internet_state(checking=True)
                ok = await self._internet_reachable(force=True)
                # Одно финальное событие: checking:false + итоговый
                # offline. Промежуточное (checking:false, offline:true)
                # НЕ публикуем — на быстрых handshake'ах оно гоняло UI.
                self._finish_internet_check(ok)
                if ok:
                    self._server_offline.clear()
                    log.info("internet: соединение восстановлено")
                else:
                    # Нарастающий backoff. Стартуем с min, дальше *2
                    # до max.
                    nxt = self._internet_poll_backoff * 2
                    if nxt < self.cfg.internet_check_poll_sec_min:
                        nxt = self.cfg.internet_check_poll_sec_min
                    if nxt > self.cfg.internet_check_poll_sec_max:
                        nxt = self.cfg.internet_check_poll_sec_max
                    self._internet_poll_backoff = nxt
                    self._internet_poll_next_at = now + nxt
                    log.info(
                        "internet-poll: всё ещё offline, следующий через %.0fs",
                        nxt,
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("internet-poll loop")

    async def poll_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(1)
                if self.dek is None:
                    continue
                now = time.monotonic()
                if not self._backlog_done:
                    try:
                        await self._seed_builtin_alerts()
                    except Exception:
                        log.exception("seed builtin alerts")
                    try:
                        n = await self.db.mutate(lambda c: run_downsample(c))
                        await self.db.mutate(
                            lambda c: run_all_retention(c, self.db.get_setting)
                        )
                        log.info("startup backlog downsample windows=%s then retention", n)
                    except Exception:
                        log.exception("startup backlog downsample/retention")
                    self._backlog_done = True
                    self._down_at = now
                    self._retain_at = now
                # S7+: один раз после unlock — сверка host key до коннектов.
                # Запускаем как фоновую задачу: probe может ждать таймаут
                # connect_timeout_sec на каждом недоступном сервере. Inline-await
                # заблокировал бы весь poll_loop (метрики, реакции, checks)
                # до окончания последнего probe — на 20 недоступных серверах
                # это до 5 минут.
                if not self._hostkey_preflight_done:
                    self._hostkey_preflight_done = True

                    async def _preflight_bg():
                        try:
                            await self._preflight_host_keys()
                        except Exception:
                            log.exception("hostkey pre-flight failed")

                    asyncio.create_task(_preflight_bg())
                ids = [r["id"] for r in self.db.conn.execute("SELECT id FROM servers").fetchall()]
                for sid in ids:
                    due = self._next_collect.get(sid, 0.0)
                    if now < due:
                        continue
                    try:
                        was_offline = sid in self._server_offline
                        await self.collect_server(sid)
                        self.collect_errors.pop(sid, None)
                        self._retry_delay.pop(sid, None)
                        self._next_collect[sid] = now + self.cfg.metrics_interval_sec
                        if was_offline:
                            # Сервер вернулся. Снимаем флаг, сбрасываем
                            # warmup EWMA — за время offline пропущено
                            # несколько точек, старая статистика невалидна
                            # (baseline устарел, z-score дал бы ложные
                            # аномалии на первом же сборе после возврата).
                            self._server_offline.pop(sid, None)
                            try:
                                self.detector.reset_server(sid)
                            except Exception:
                                log.exception("reset_server after offline sid=%s", sid)
                            log.info("collect server=%s: снова online (было offline)", sid)
                    except AppError as e:
                        self.collect_errors[sid] = f"{e.code}: {e.message}"
                        if e.code == "E_NO_INTERNET":
                            # Глобальный флаг — не долбим серверы. Это НЕ
                            # ошибка конкретного сервера: UI показывает
                            # глобальный баннер + «заморозку» карточки через
                            # status.internet_offline. Сбрасываем возможные
                            # старые записи (в т.ч. _server_offline —
                            # при недоступном интернете нельзя судить
                            # о доступности конкретного сервера).
                            self.collect_errors.pop(sid, None)
                            self._server_offline.pop(sid, None)
                            self._next_collect[sid] = now + self.cfg.metrics_interval_sec
                        elif e.code == "E_HOSTKEY":
                            # не транзиентная ошибка — host key подтверждается руками
                            # в карточке сервера. Проверяем раз в 5 минут, не спамим.
                            self._next_collect[sid] = now + 300.0
                            log.debug("collect server=%s: hostkey не подтверждён", sid)
                        elif e.code == "E_HOSTKEY_MISMATCH":
                            # S7+: host key не совпал. Не долбим сервер —
                            # ждём, пока пользователь сверит и ротирует.
                            self._next_collect[sid] = now + 300.0
                            log.warning(
                                "collect server=%s: host key mismatch — подключение заблокировано",
                                sid,
                            )
                        elif e.code in ("E_SSH", "E_SSH_TIMEOUT", "E_SSH_REFUSED",
                                        "E_SSH_UNREACHABLE", "E_SSH_DISCONNECTED",
                                        "E_TIMEOUT"):
                            # Сервер не отвечает. Прежде чем объявлять его
                            # offline, проверяем, жив ли интернет вообще.
                            # Кэш 60 сек в _internet_reachable: при 20
                            # серверах, упавших разом, сделаем один handshake,
                            # не 20.
                            net_ok = await self._internet_reachable()
                            if not net_ok:
                                # Глобальный случай: интернета нет, все
                                # серверы «мертвы» одновременно. НЕ пишем
                                # в collect_errors[sid] — это была бы ложная
                                # ошибка сервера. UI покажет «заморозку»
                                # через status.internet_offline.
                                self._set_internet_state(offline=True)
                                # Per-server offline тоже сбрасываем:
                                # мы не знаем, был ли сервер реально
                                # недоступен до глобального сбоя.
                                self.collect_errors.pop(sid, None)
                                self._server_offline.clear()
                                # Таймер первой авто-проверки.
                                self._internet_poll_backoff = 0.0
                                self._internet_poll_next_at = (
                                    time.monotonic()
                                    + self.cfg.internet_check_poll_sec_min
                                )
                                # Публикуем net.status сразу, чтобы UI
                                # получил countdown вместе с флагом (иначе
                                # плашка «следующая проверка» появится
                                # только через 5 сек, после первого тика
                                # _internet_poll_loop).
                                self.events.publish("net.status", {
                                    "internet_offline": self._internet_offline,
                                    "internet_checking": self._internet_checking,
                                    "next_check_in_sec": self._internet_next_check_in_sec(),
                                })
                                self._next_collect[sid] = now + self.cfg.metrics_interval_sec
                                log.warning(
                                    "collect server=%s: %s, интернет недоступен — "
                                    "глобальная пауза",
                                    sid, e.code,
                                )
                            else:
                                # Интернет есть — значит конкретный сервер
                                # лёг. Per-server offline.
                                # collect_errors — единый текст E_SERVER_OFFLINE:
                                # UI показывает статус «недоступен» бейджем,
                                # а не сырой E_SSH/E_TIMEOUT с диагностикой
                                # вроде «[Errno 101] Network is unreachable».
                                if sid not in self._server_offline:
                                    self._server_offline[sid] = now_z()
                                    log.warning(
                                        "collect server=%s: %s — переведён в offline",
                                        sid, e.code,
                                    )
                                self.collect_errors[sid] = (
                                    "E_SERVER_OFFLINE: сервер не отвечает — "
                                    "сбор метрик приостановлен"
                                )
                                self._next_collect[sid] = now + 30.0
                        else:
                            # Не связано с доступностью (креды, парсинг, и т.п.).
                            # Обычный экспоненциальный backoff.
                            delay = self._retry_delay.get(sid, 5.0)
                            self._retry_delay[sid] = min(60.0, delay * 2)
                            self._next_collect[sid] = now + delay
                            log.info("collect server=%s: %s (retry in %ss)", sid, e.code, delay)
                    except Exception as e:  # noqa: BLE001
                        self.collect_errors[sid] = str(e)
                        # Неизвестная ошибка — не offline-сигнал, обычный backoff.
                        delay = self._retry_delay.get(sid, 5.0)
                        self._retry_delay[sid] = min(60.0, delay * 2)
                        self._next_collect[sid] = now + delay
                        log.warning("collect server=%s: %s (retry in %ss)", sid, e, delay)
                # Реакции — раз в 15 секунд.
                if now - getattr(self, "_reactions_tick_at", 0.0) >= 15.0:
                    try:
                        await self.reactions.process_new_alerts()
                        await self.reactions.run_pending()
                    except Exception:
                        log.exception("reactions tick")
                    self._reactions_tick_at = now

                # Проверки (scheduled_checks) — раз в 30 секунд.
                if now - getattr(self, "_checks_tick_at", 0.0) >= 30.0:
                    try:
                        await self._run_due_checks()
                    except Exception:
                        log.exception("checks tick")
                    self._checks_tick_at = now

                # Stale-check серверов — раз в минуту.
                if now - getattr(self, "_stale_check_at", 0.0) >= 60.0:
                    try:
                        await self._check_stale_servers()
                    except Exception:
                        log.exception("stale check")
                    self._stale_check_at = now

                # Threshold-правила (source=threshold) — раз в 30 секунд.
                # Не привязаны к detector: даже при выключенных z-score
                # правилах абсолютные пороги продолжают работать.
                if now - getattr(self, "_threshold_check_at", 0.0) >= 30.0:
                    try:
                        await self._check_threshold_alerts()
                    except Exception:
                        log.exception("threshold check")
                    self._threshold_check_at = now

                # Чистка просроченных сессий — не чаще раза в минуту.
                if now - getattr(self, "_sess_prune_at", 0.0) >= 60.0:
                    n = self.prune_sessions()
                    if n:
                        log.info("pruned %s expired sessions", n)
                    self._sess_prune_at = now
                if now - self._down_at >= self.cfg.downsample_sec:
                    def down(conn):
                        return run_downsample(conn)

                    n = await self.db.mutate(down)
                    log.info("downsample windows=%s", n)
                    self._down_at = now
                if now - self._retain_at >= self.cfg.retention_interval_sec:
                    def ret(conn):
                        res = run_all_retention(conn, self.db.get_setting)
                        ts = now_z()
                        conn.execute(
                            "INSERT INTO settings(key, value) VALUES ('retention.last_run_at', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (ts,),
                        )
                        return res

                    res = await self.db.mutate(ret)
                    log.info("retention: %s", res)
                    self._retain_at = now
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("poll_loop")

    async def refresh_paths(self, sid: int) -> dict:
        self.get_server(sid)
        self.paths.invalidate(sid)
        return {"ok": True}

    async def refresh_nproc(self, sid: int) -> dict:
        """Принудительно перечитать nproc через SSH.

        Полезно, если добавили ядра на живом сервере: порог load_1m
        (nproc × abs_load_1m_per_cpu) адаптируется к новому железу.
        Ошибка SSH/отсутствие coreutils — не критичны, возвращаем ok=False
        с понятным сообщением.
        """
        self.get_server(sid)
        try:
            shell = await self._ensure_shell(sid)
        except AppError as e:
            return {"ok": False, "error_code": e.code, "message": e.message}
        n = await self._read_nproc(shell)
        if not n:
            return {
                "ok": False,
                "error_code": "E_NPROC",
                "message": "не удалось прочитать /usr/bin/nproc (нет coreutils или команда упала)",
            }

        def fn(conn):
            conn.execute("UPDATE servers SET nproc=? WHERE id=?", (n, sid))

        await self.db.mutate(fn)
        self.detector.set_nproc(sid, n)
        log.info("nproc обновлён: server=%s nproc=%s", sid, n)
        return {"ok": True, "nproc": n}

    def status(self) -> dict:
        integ = self.integrity()
        try:
            pending_reactions = self.reactions.pending_count()
        except Exception:
            pending_reactions = 0
        return {
            "first_run": self.first_run(),
            "pending_reactions": pending_reactions,
            "locked": self.locked(),
            "lockout": self.is_lockout(),
            "lock_until": self.lock_until(),
            "no_audit": self.cfg.no_audit,
            "audit": integ,
            "version": "0.1.0",
            "started": self.started,
            "llm_provider": getattr(self.llm, "provider", None),
            "llm_enabled": self.llm is not None,
            # Состояние интернета — AppShell показывает баннер глобально
            # (над всеми вкладками), не только на дашборде.
            "internet_offline": self._internet_offline,
            "internet_checking": self._internet_checking,
            "internet_last_check_at": self._internet_last_check_at,
            "internet_next_check_in_sec": self._internet_next_check_in_sec(),
            # Публикуется для UI: если false — баннер и настройки
            # проверки интернета не показываются (нечего проверять).
            "has_external_servers": self._has_external_servers(),
            # Состояние проверки обновлений — badge в шапке + секция
            # «Обновления» в Настройках.
            "update": self.update_status(),
        }


def shlex_preview(plan: dict) -> str:
    for st in plan.get("steps") or []:
        if st.get("phase") == "run":
            return " ".join(st.get("argv") or [])
    return plan.get("operation_id") or ""
