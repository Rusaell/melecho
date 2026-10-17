from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from melecho.errors import AppError

log = logging.getLogger("melecho")

CANARY_HOST = "CANARYHOST.invalid"
CANARY_USER = "canary_user_xyz"
CANARY_PASSWORD = "CanaryPassw0rd!"
CANARY_SUDO = "CanarySudoPass!"
CANARY_IP = "203.0.113.77"

SECRET_PATTERNS = [
    re.compile(r"(?i)password\s*[:=]\s*\S+"),
    re.compile(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)sudo:.+password"),
]
_IP_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
# Fenced-блок ```yaml...``` (или ``` без языка). Lazy - берём ровно
# до первого закрывающего, чтобы не съесть соседний блок.
_YAML_BLOCK_RE = re.compile(r"```(?:yaml|yml|json)?[ \t]*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+\d{2}:\d{2}|Z)?")

# Never send exact timestamps, hostnames, IPs, usernames, paths.
BLOCK_KEYS = {
    "host",
    "hostname",
    "ip",
    "username",
    "user",
    "name",
    "server_name",
    "path",
    "mount",
    "mountpoint",
    "target",
    "interface",
    "device",
    "detected_at",
    "timestamp",
    "timestamp_utc",
    "_ts",
}


def prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_anomaly_prompt(alias: str, metric: str, payload: dict, catalog_ids: list[str]) -> str:
    body = {
        "llm_alias": alias,
        "metric": metric,
        "window": payload.get("window") or "15m",
        "baseline_ewma": payload.get("baseline_ewma"),
        "current_ewma": payload.get("ewma") or payload.get("current"),
        "z_score": payload.get("z_score") or payload.get("z"),
        "threshold": payload.get("threshold"),
        "catalog_ids": catalog_ids,
    }
    lines = [
        "Ты — ассистент системного администратора.",
        "На сервере обнаружено статистическое отклонение.",
        "Данные (allowlist, без сырых логов):",
        "",
    ]
    for k, v in body.items():
        lines.append(f"{k}: {v if not isinstance(v, list) else json.dumps(v)}")
    lines += [
        "",
        "Объясни возможные причины и укажи, какие id из catalog_ids имеет смысл рассмотреть.",
        "Команды не предлагай и не выполняй.",
    ]
    return "\n".join(lines)


def build_chat_system_prompt(allowed_commands: list[str]) -> str:
    """System prompt для общего чата LLM.

    В отличие от прежнего статичного текста (он жил в app.js и ничего не
    знал о панели), этот промпт собирается на каждый запрос и включает
    АКТУАЛЬНЫЙ whitelist команд. Поэтому когда пользователь добавил
    команду в whitelist и спрашивает «а доступна ли теперь wg?» — модель
    видит её в списке и отвечает по существу, а не «у меня нет доступа».

    Тон — помощник админа, отвечает по-русски, не выполняет команды
    (это делает каталог операций), не генерирует скрипты.
    """
    cmds = ", ".join(sorted(allowed_commands)) if allowed_commands else "(список пуст)"
    return (
        "Ты — ассистент системного администратора в локальной панели Melecho.\n"
        "Отвечай по-русски, кратко и по делу.\n"
        "\n"
        "Ты работаешь в контексте локальной панели управления Linux-серверами\n"
        "через SSH. В панели есть:\n"
        "  - серверы (метрики, логи, systemd-сервисы);\n"
        "  - операции из YAML-каталога (параметризованные argv);\n"
        "  - алерты и проверки;\n"
        "  - реакции на алерты.\n"
        "\n"
        "Разрешённые команды для пользовательских операций (argv[0]):\n"
        f"{cmds}\n"
        "\n"
        "Если пользователь спрашивает про команду, которой нет в списке —\n"
        "скажи прямо, что её нужно сначала добавить в белый список (вкладка\n"
        "Автоматизация → Операции → Белый список команд).\n"
        "\n"
        "Не предлагай выполнять команды и не генерируй shell-скрипты.\n"
        "Если тебе не хватает данных — скажи об этом одной фразой.\n"
        "Для создания новой операции пользователь пишет команду\n"
        "/operation <описание> — это отдельный режим, там ты получишь\n"
        "расширенную инструкцию. В обычном чате ты просто консультируешь."
    )


def build_explain_alert_prompt(alert_data: dict, question: str = "") -> str:
    """System-промпт для объяснения конкретного алерта.

    alert_data: уже подготовленный safe-dict (без host/IP/username), содержит:
      id, llm_alias, severity, source, status, metric, value, threshold,
      title, description, meta, first_seen_at, last_seen_at, repeat_count.
    question:    опциональный вопрос пользователя, например «что делать».
    """
    lines = []
    for k in (
        "id", "llm_alias", "severity", "source", "status",
        "metric", "value", "threshold",
        "first_seen_at", "last_seen_at", "repeat_count",
    ):
        v = alert_data.get(k)
        if v is not None:
            lines.append(f"{k}: {v}")
    if alert_data.get("title"):
        lines.append("title: " + str(alert_data["title"]))
    if alert_data.get("description"):
        lines.append("description: " + str(alert_data["description"]))
    meta = alert_data.get("meta")
    if isinstance(meta, dict) and meta:
        import json as _json
        lines.append("meta: " + _json.dumps(meta, ensure_ascii=False, sort_keys=True))

    data_str = "\n".join(lines) if lines else "(нет данных)"

    q = (question or "").strip()
    parts = [
        "Ты — ассистент системного администратора в панели Melecho.",
        "Пользователь показывает алерт из системы мониторинга и просит объяснить.",
        "Ответь на русском, кратко, по делу.",
        "",
        "Что нужно:",
        "  1) Что произошло — интерпретируй метрику/порог/источник.",
        "  2) Почему это может происходить (2-3 вероятные причины).",
        "  3) Что стоит проверить или сделать (конкретные шаги).",
        "",
        "Не предлагай выполнять shell-команды от своего имени и не генерируй",
        "скрипты. Можешь упомянуть, какие операции имеет смысл рассмотреть",
        "(например, systemd_restart для сервисов).",
        "",
        "ДАННЫЕ АЛЕРТА (без hostname/IP/username):",
        data_str,
    ]
    if q:
        parts += ["", "ВОПРОС ПОЛЬЗОВАТЕЛЯ:", q]
    return "\n".join(parts)



def build_explain_rule_prompt(rule_data: dict, question: str = "") -> str:
    """Промпт для объяснения правила алерта.

    rule_data: safe-dict правила, подготовленный в runtime.explain_rule —
      id, name, condition_kind, condition_json (dict), severity, enabled,
      cooldown_sec, auto_resolve_json, server_id, last_fired_at,
      interval_sec, servers_json (только для operation_check).
    question:  опциональный вопрос пользователя.
    """
    lines = []
    for k in ("id", "name", "condition_kind", "severity", "enabled",
              "cooldown_sec", "server_id", "last_fired_at",
              "interval_sec"):
        v = rule_data.get(k)
        if v is not None:
            lines.append(f"{k}: {v}")
    cj = rule_data.get("condition_json")
    if cj is not None:
        lines.append("condition_json: " + json.dumps(cj, ensure_ascii=False, sort_keys=True))
    ar = rule_data.get("auto_resolve_json")
    if ar:
        lines.append("auto_resolve_json: " + json.dumps(ar, ensure_ascii=False, sort_keys=True))
    sj = rule_data.get("servers_json")
    if sj:
        lines.append("servers_json: " + json.dumps(sj, ensure_ascii=False, sort_keys=True))

    data_str = "\n".join(lines) if lines else "(нет данных)"
    q = (question or "").strip()

    parts = [
        "Ты — ассистент системного администратора в панели Melecho.",
        "Пользователь показывает правило алерта и просит объяснить.",
        "Ответь на русском, кратко, по делу.",
        "",
        "Что нужно:",
        "  1) Что отслеживает правило — простыми словами.",
        "  2) Когда оно сработает (и когда закроется, если есть auto_resolve).",
        "  3) Не дублирует ли оно другие правила (если видно из контекста).",
        "  4) Если есть вопрос пользователя — ответь конкретно на него.",
        "",
        "Не предлагай выполнять shell-команды и не генерируй скрипты.",
        "",
        "ДАННЫЕ ПРАВИЛА (без hostname/IP/username):",
        data_str,
    ]
    if q:
        parts += ["", "ВОПРОС ПОЛЬЗОВАТЕЛЯ:", q]
    return "\n".join(parts)


def build_edit_rule_prompt(rule_data: dict, description: str) -> str:
    """Промпт для предложения правки правила.

    Модель возвращает ТОЛЬКО поля, которые нужно изменить (patch), в
    формате {"patch": {...}}. Backend валидирует patch и применяет поверх
    текущего правила перед показом формы — пользователь видит «что станет»
    и решает, сохранять ли.

    Менять condition_kind нельзя (тип условия фиксирован после создания).
    """
    rule_json = json.dumps(rule_data, ensure_ascii=False, sort_keys=True, indent=2)

    return "\n".join([
        "Ты — редактор правил алертов панели Melecho.",
        "Пользователь даёт существующее правило и описание изменения.",
        "Ты возвращаешь ТОЛЬКО изменяемые поля в виде patch-объекта.",
        "Отвечай СТРОГО в формате ниже. Думать вслух запрещено.",
        "Теги <thought>, <reasoning>, <thinking>, <analysis> запрещены.",
        "",
        "ДОПУСТИМЫЕ ПОЛЯ PATCH (только они; остальные — игнорируются):",
        "  name               — строка 1..200",
        "  severity           — info | warning | critical",
        "  condition_json     — объект (структура зависит от condition_kind,",
        "                        см. текущее правило выше)",
        "  auto_resolve_json  — объект или null",
        "  server_id          — целое или null",
        "  cooldown_sec       — целое 0..86400",
        "  enabled            — true | false",
        "  interval_sec       — целое 60..86400 (только operation_check)",
        "  servers_json       — {all:true} или {ids:[...]} (только operation_check)",
        "",
        "ЗАПРЕЩЕНО МЕНЯТЬ:",
        "  condition_kind — тип условия фиксирован после создания.",
        "  id — тоже, разумеется.",
        "",
        "ФОРМАТ ОТВЕТА (ровно так, ничего лишнего):",
        "",
        "<1-2 строки, что меняешь и почему>",
        "",
        "```json",
        "{",
        '  "patch": {',
        '    "<поле>": <новое значение>',
        "  }",
        "}",
        "```",
        "",
        "ПРИМЕР (задача: порог поднять с 90 до 95):",
        "",
        "Меняю порог с 90 на 95.",
        "",
        "```json",
        "{",
        '  "patch": {',
        '    "condition_json": {"metric": "disk", "value_gte": 95},',
        '    "auto_resolve_json": {"below": 95}',
        "  }",
        "}",
        "```",
        "",
        "ОСОБЫЕ СЛУЧАИ (без JSON-блока):",
        "  НЕВОЗМОЖНО: <причина>",
        "  УТОЧНИТЕ: <вопрос>",
        "",
        "ТЕКУЩЕЕ ПРАВИЛО (JSON):",
        rule_json,
        "",
        "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:",
        description.strip(),
    ])


def build_suggest_alert_prompt(
    description: str,
    existing_rules: list[dict],
    servers: list[dict],
    operations: list[dict] | None = None,
) -> str:
    """Промпт для генерации правил алертов.

    existing_rules: [{id, name, condition_kind, severity, enabled}]
    servers:        [{id, llm_alias}]
    operations:     [{id, name, flags}] — только для operation_check
                    (LLM выбирает operation_id из каталога; сама YAML
                    не придумывает).
    """
    rules_lines = []
    for r in existing_rules[:50]:
        rules_lines.append(
            "  #{} {!r} kind={} severity={} enabled={}".format(
                r["id"], r["name"],
                r.get("condition_kind") or "?",
                r["severity"], r["enabled"],
            )
        )
    rules_str = "\n".join(rules_lines) if rules_lines else "  (нет правил)"

    # alias = "server-{id}" (синхронизировано миграцией v16). Формат
    # "server-N (name)" — один идентификатор. Число в server-N и есть
    # server_id.
    servers_lines = [
        "  {!r} ({})".format(s["llm_alias"], s.get("name") or "?")
        for s in servers[:50]
    ]
    servers_str = "\n".join(servers_lines) if servers_lines else "  (нет серверов)"

    ops = operations or []
    op_lines = []
    for o in ops[:50]:
        flags = o.get("flags") or {}
        tags = []
        if flags.get("state_changing"):
            tags.append("state-changing")
        if flags.get("dangerous"):
            tags.append("dangerous")
        tag_str = (" [{}]".format(", ".join(tags))) if tags else ""
        op_lines.append("  {} — {}{}".format(o["id"], o.get("name") or "", tag_str))
    op_str = "\n".join(op_lines) if op_lines else "  (нет операций)"

    return "\n".join([
        "Ты — генератор правил алертов панели Melecho.",
        "Отвечай СТРОГО в формате ниже. Думать вслух запрещено.",
        "Теги <thought>, <reasoning>, <thinking>, <analysis> запрещены —",
        "если модель их использует, ответ считается невалидным.",
        "",
        "ПРАВИЛО ВЫБОРА ТИПА (condition_kind):",
        "  metric_threshold  — порог метрики: «cpu > 90», «диск больше 95%»,",
        "                      «load выше 2.5». Самый частый случай.",
        "  metric_zscore     — статистическая аномалия («z-score», «отклонение",
        "                      от нормы», «аномалия»).",
        "  metric_stale      — нет метрик N секунд («сервер молчит», «данные",
        "                      не приходят»).",
        "  operation_check   — периодически запускать операцию и смотреть результат",
        "                      («каждую минуту проверяй», «следи, что nginx жив»).",
        "                      Требует operation_id из списка OPERATIONS ниже.",
        "                      НЕ предлагай operation_check, если подходящей",
        "                      операции нет в списке — ответь УТОЧНИТЕ.",
        "  manual_op_failed  — провал операции из UI («если операция упала»).",
        "  reaction_failed   — реакция не смогла восстановить.",
        "",
        "ФОРМАТ condition_json по типам:",
        '  metric_threshold: {"metric": "cpu|ram|disk|load_1m", "value_gte": N}',
        "                    также value_gt / value_lte / value_lt (ровно один).",
        "                    Для load_1m — per-cpu: реальный порог = nproc × N.",
        '  metric_zscore:    {"z_min": N} или {"z_min": N, "z_max": M}',
        '  metric_stale:     {"no_data_sec": N}  (300 = 5 мин, 1800 = 30 мин)',
        '  operation_check:  {"operation_id": "...", "params": {},',
        '                     "expected": {"exit": 0}}',
        '                    Плюс поля верхнего уровня:',
        '                      "interval_sec": N  (60..86400)',
        '                      "servers_json": {"all": true}',
        '                            или "servers_json": {"ids": [1, 2]}',
        '  manual_op_failed: {"exit_ne": 0}',
        '  reaction_failed:  {"status_in": ["failed", "timeout"]}',
        "",
        "SEVERITY: info | warning | critical",
        "cooldown_sec: 300 (дефолт).",
        "",
        "СЕРВЕРЫ И server_id:",
        "  Метка сервера — \"server-N\", где N = server_id. Например,",
        "  для server-2 в поле server_id пиши 2. Пользователь называет",
        "  сервер по имени (test) или метке (server-2).",
        "  Если пользователь назвал сервер, которого нет в списке —",
        "  ответь РОВНО: УТОЧНИТЕ: сервер <имя> не найден.",
        "  НЕ подставляй server_id по догадке.",
        "",
        "server_id: null = глобальное, иначе число из server-N.",
        "auto_resolve_json: только для метрических типов; например",
        '  {"below": 90}. Для остальных — null.',
        "enabled: true.",
        "",
        "СУЩЕСТВУЮЩИЕ ПРАВИЛА (НЕ дублируй по name и condition_kind):",
        rules_str,
        "",
        "СЕРВЕРЫ (для server_id):",
        servers_str,
        "",
        "OPERATIONS (для operation_check.condition_json.operation_id):",
        op_str,
        "",
        "ФОРМАТ ОТВЕТА (ровно так, ничего лишнего):",
        "",
        "<1-2 строки объяснения>",
        "",
        "```json",
        "{",
        '  "rules": [',
        "    {",
        '      "name": "<имя>",',
        '      "condition_kind": "metric_threshold",',
        '      "severity": "warning",',
        '      "condition_json": {"metric": "cpu", "value_gte": 1.0},',
        '      "server_id": null,',
        '      "cooldown_sec": 300,',
        '      "auto_resolve_json": {"below": 1.0},',
        '      "enabled": true',
        "    }",
        "  ]",
        "}",
        "```",
        "",
        "ПРИМЕР 1 (задача: cpu выше 3 — warning, выше 5 — critical):",
        "",
        "Создаёт два правила для CPU.",
        "",
        "```json",
        "{",
        '  "rules": [',
        '    {"name": "CPU warning", "condition_kind": "metric_threshold",',
        '     "severity": "warning",',
        '     "condition_json": {"metric": "cpu", "value_gte": 3},',
        '     "server_id": null, "cooldown_sec": 300,',
        '     "auto_resolve_json": {"below": 3}, "enabled": true},',
        '    {"name": "CPU critical", "condition_kind": "metric_threshold",',
        '     "severity": "critical",',
        '     "condition_json": {"metric": "cpu", "value_gte": 5},',
        '     "server_id": null, "cooldown_sec": 300,',
        '     "auto_resolve_json": {"below": 5}, "enabled": true}',
        "  ]",
        "}",
        "```",
        "",
        "ПРИМЕР 2 (задача: каждую минуту проверяй, что systemd-сервис nginx жив):",
        "",
        "Создаёт правило типа operation_check с системной операцией.",
        "",
        "```json",
        "{",
        '  "rules": [',
        '    {"name": "nginx alive", "condition_kind": "operation_check",',
        '     "severity": "warning",',
        '     "condition_json": {"operation_id": "systemctl_is_active",',
        '                        "params": {"unit": "nginx.service"},',
        '                        "expected": {"exit": 0, "stdout_regex": "active"}},',
        '     "interval_sec": 60, "servers_json": {"all": true},',
        '     "server_id": null, "cooldown_sec": 300,',
        '     "auto_resolve_json": null, "enabled": true}',
        "  ]",
        "}",
        "```",
        "",
        "ОСОБЫЕ СЛУЧАИ (когда JSON НЕ нужен):",
        "  Если задача требует того, чего нет в схеме — ответь РОВНО:",
        "    НЕВОЗМОЖНО: <причина>",
        "  Если непонятно, мало данных или нужна операция, которой нет в",
        "  списке OPERATIONS — ответь РОВНО:",
        "    УТОЧНИТЕ: <один конкретный вопрос>",
        "",
        "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:",
        description.strip(),
    ])


def build_suggest_reaction_prompt(
    description: str,
    alert_rules: list[dict],
    operations: list[dict],
    servers: list[dict],
    existing_reactions: list[dict],
) -> str:
    """System-промпт для генерации правила реакции.

    alert_rules:        [{id, name, source, severity}]
    operations:         [{id, name, flags}]
    servers:            [{id, llm_alias}]
    existing_reactions: [{id, name}]
    """
    ar_lines = [
        "  #{} {!r} {}/{}".format(
            r["id"], r["name"],
            r.get("condition_kind") or "?",
            r["severity"],
        )
        for r in alert_rules[:50]
    ]
    ar_str = "\n".join(ar_lines) if ar_lines else "  (нет правил)"

    op_lines = []
    for o in operations[:50]:
        flags = o.get("flags") or {}
        tags = []
        if flags.get("state_changing"):
            tags.append("state-changing")
        if flags.get("dangerous"):
            tags.append("dangerous")
        tag_str = (" [{}]".format(", ".join(tags))) if tags else ""
        op_lines.append("  {} — {}{}".format(o["id"], o["name"], tag_str))
    op_str = "\n".join(op_lines) if op_lines else "  (нет операций)"

    # alias = "server-{id}" (v16). Формат "server-N (name)".
    sv_lines = [
        "  {!r} ({})".format(s["llm_alias"], s.get("name") or "?")
        for s in servers[:50]
    ]
    sv_str = "\n".join(sv_lines) if sv_lines else "  (нет серверов)"

    er_lines = ["  #{} {!r}".format(r["id"], r["name"]) for r in existing_reactions[:50]]
    er_str = "\n".join(er_lines) if er_lines else "  (нет правил)"

    return "\n".join([
        "Ты — генератор правил реакций панели Melecho.",
        "Реакция = «если алерт X, запусти операцию Y».",
        "Отвечай СТРОГО в формате ниже. Думать вслух запрещено.",
        "Теги <thought>, <reasoning>, <thinking>, <analysis> запрещены.",
        "",
        "ФОРМАТ ОТВЕТА (ровно так, ничего лишнего):",
        "",
        "<1-2 строки объяснения>",
        "",
        "```json",
        "{",
        '  "rule": {',
        '    "name": "...",',
        '    "match": {',
        '      "rule_ids": [],',
        '      "severities": ["critical"],',
        '      "condition_kinds": [],',
        '      "server_ids": null',
        "    },",
        '    "operation_id": "...",',
        '    "params": {},',
        '    "run_on_server": "same_as_alert",',
        '    "sudo_mode": "never",',
        '    "action_policy": "confirm",',
        '    "cooldown_sec": 300,',
        '    "max_attempts_per_alert": 3,',
        '    "max_depth": 3,',
        '    "enabled": true',
        "  }",
        "}",
        "```",
        "",
        "ПРАВИЛА СХЕМЫ:",
        "- match.rule_ids — id из ALERT_RULES. Пусто = любое правило.",
        "- match.severities — critical | warning | info. Пусто = любая.",
        "- match.condition_kinds — типы условий алерта. Пусто = любой тип.",
        "  Допустимые значения:",
        "    metric_threshold, metric_zscore, metric_stale,",
        "    operation_check, manual_op_failed, reaction_failed",
        "- match.server_ids — null = все, [N, ...] = только эти.",
        "  Метка сервера — server-N, где N = число для match.server_ids.",
        "  Например, для server-2 в массиве указывай 2.",
        "- Хотя бы одно условие в match обязательно.",
        "- operation_id — из OPERATIONS.",
        '- run_on_server — "same_as_alert" или "<id>".',
        "- sudo_mode — never | auto | confirm.",
        "- action_policy — auto | confirm. Сервер сам форсит confirm",
        "  для state-changing и dangerous операций, но лучше сразу ставить confirm.",
        "",
        "ALERT_RULES (для rule_ids):",
        ar_str,
        "",
        "OPERATIONS (для operation_id):",
        op_str,
        "",
        "SERVERS (для match.server_ids и run_on_server):",
        sv_str,
        "",
        "EXISTING REACTIONS (не дублируй):",
        er_str,
        "",
        "ПРИМЕР (задача: при critical алерте на любом сервере перезапустить systemd-сервис):",
        "",
        "Реакция запускает systemd_restart при critical алертах.",
        "",
        "```json",
        "{",
        '  "rule": {',
        '    "name": "Restart on critical",',
        '    "match": {"rule_ids": [], "severities": ["critical"],',
        '              "condition_kinds": [], "server_ids": null},',
        '    "operation_id": "systemd_restart",',
        '    "params": {"unit": "nginx.service"},',
        '    "run_on_server": "same_as_alert",',
        '    "sudo_mode": "auto",',
        '    "action_policy": "confirm",',
        '    "cooldown_sec": 300,',
        '    "max_attempts_per_alert": 3,',
        '    "max_depth": 3,',
        '    "enabled": true',
        "  }",
        "}",
        "```",
        "",
        "ОСОБЫЕ СЛУЧАИ (без JSON-блока):",
        "  НЕВОЗМОЖНО: <причина>",
        "  УТОЧНИТЕ: <вопрос>",
        "",
        "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:",
        description.strip(),
    ])


def build_suggest_operation_prompt(description: str, allowed_commands: list[str]) -> str:
    """Промпт для генерации user-операции.

    ПЕРЕПИСАН 2026-10-10 под reasoning-модели (Gemma, Gemini 2.x). Раньше
    был длинный список правил, модель уходила в обдумывание на 40-50K
    токенов и не возвращалась к ответу. Сейчас:

      - короткий, директивный;
      - явный запрет reasoning-тегов;
      - ГОТОВЫЙ ПРИМЕР ответа — модель копирует структуру;
      - маршруты для «не знаю» (УТОЧНИТЕ / НЕВОЗМОЖНО) — вместо
        попыток угадать, что тоже генерит reasoning.

    Спросить пользователя — лучше, чем выдумать команду. Модель честно
    пишет «УТОЧНИТЕ: нужна команда для X, пример вывода: Y», UI покажет
    как обычное сообщение ассистента, пользователь переспросит.
    """
    cmds = ", ".join(sorted(allowed_commands)) if allowed_commands else "(нет)"
    return (
        "Ты — генератор YAML-файлов операций для панели Melecho.\n"
        "Отвечай СТРОГО в формате ниже. Думать вслух запрещено. Теги\n"
        "<thought>, <reasoning>, <thinking>, <analysis> запрещены —\n"
        "если модель их использует, ответ считается невалидным.\n"
        "\n"
        "РАЗРЕШЁННЫЕ КОМАНДЫ (argv[0], только из этого списка):\n"
        f"{cmds}, sudo\n"
        "\n"
        "ЖЁСТКИЕ ПРАВИЛА:\n"
        "- Запрещены shell-обёртки (sh, bash, zsh), интерпретаторы\n"
        "  (awk, sed, perl, python, ruby, node, env, xargs, find,\n"
        "  timeout, nice, nohup, watch, screen, tmux)\n"
        "- Запрещены метасимволы в шаблоне: ; | & $ ` < > ( ) \\ и \\n\n"
        "- Запрещены абсолютные пути (/usr/bin/systemctl — нельзя)\n"
        "- Параметр ставится ОТДЕЛЬНЫМ argv: journalctl -n {lines},\n"
        "  НЕ -n{lines} и НЕ --since={since}\n"
        "- id: только [a-z][a-z0-9_]*, начинается с буквы\n"
        "\n"
        "ФОРМАТ ОТВЕТА (ровно так, ничего лишнего):\n"
        "\n"
        "<1-2 строки, что делает операция>\n"
        "\n"
        "```yaml\n"
        "id: <snake_case>\n"
        "name: <человекочитаемое>\n"
        "category: <network|storage|services|logs|packages|other>\n"
        "version: 1\n"
        "params: []\n"
        "flags:\n"
        "  dangerous: false\n"
        "  state_changing: false\n"
        "  idempotent: true\n"
        "  reversible: true\n"
        "steps:\n"
        "  - command: \"<команда из списка>\"\n"
        "    expect_exit: 0\n"
        "```\n"
        "\n"
        "ПРИМЕР ПРАВИЛЬНОГО ОТВЕТА:\n"
        "\n"
        "Показывает состояние WireGuard-интерфейсов.\n"
        "\n"
        "```yaml\n"
        "id: wg_status\n"
        "name: Статус WireGuard\n"
        "category: network\n"
        "version: 1\n"
        "params: []\n"
        "flags:\n"
        "  dangerous: false\n"
        "  state_changing: false\n"
        "  idempotent: true\n"
        "  reversible: true\n"
        "steps:\n"
        "  - command: \"wg show\"\n"
        "    expect_exit: 0\n"
        "```\n"
        "\n"
        "ОСОБЫЕ СЛУЧАИ (когда YAML НЕ нужен):\n"
        "\n"
        "Если задача требует команду НЕ из разрешённого списка —\n"
        "ответь РОВНО ОДНОЙ строкой, без YAML-блока:\n"
        "  НЕВОЗМОЖНО: <какая команда нужна и зачем>\n"
        "\n"
        "Если задача непонятна или данных не хватает —\n"
        "ответь РОВНО ОДНОЙ строкой, без YAML-блока:\n"
        "  УТОЧНИТЕ: <один конкретный вопрос>\n"
        "\n"
        "НАПОМИНАЮ СПИСОК РАЗРЕШЁННЫХ КОМАНД (ещё раз, перед задачей):\n"
        "  " + cmds + ", sudo\n"
        "Если команда из твоего ответа не в этом списке — это ошибка.\n"
        "Перечитай список ДО того, как писать YAML.\n"
        "\n"
        "ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:\n"
        + description.strip() + "\n"
    )


def extract_yaml_block(text: str) -> tuple[str | None, str]:
    """Ищет fenced-блок ```yaml\\n...\\n``` и вырезает его из текста.

    Возвращает (yaml_content или None, текст-без-yaml-блока).

    Берётся ПЕРВЫЙ блок - по промпту модель должна отдавать ровно один.
    Если блоков несколько, все вырезаются из explanation (иначе UI
    покажет пользователю половинчатый YAML вперемешку с текстом),
    но используется только первый.

    Если блоков нет - yaml=None, explanation = исходный текст (strip).
    """
    if not text:
        return None, ""
    matches = list(_YAML_BLOCK_RE.finditer(text))
    if not matches:
        return None, text.strip()
    first_yaml = matches[0].group(1).strip()
    cleaned = text
    for m in reversed(matches):
        cleaned = cleaned[: m.start()] + cleaned[m.end() :]
    return first_yaml, cleaned.strip()


def assert_no_secrets(prompt: str) -> None:
    """Защита S4: перед отправкой в LLM проверяем, что в промпт не попали
    известные секреты-канарейки или шаблоны, похожие на секреты.

    Нарушение — не «обычная» ошибка, а индикатор бага в сборке промпта.
    Возвращаем 500 E_LLM_CANARY, чтобы запрос ушёл в лог и был заметен.
    """
    for c in (CANARY_HOST, CANARY_USER, CANARY_PASSWORD, CANARY_SUDO, CANARY_IP):
        if c in prompt:
            log.error("LLM canary %r leaked into prompt; refusing to send", c[:8])
            raise AppError(
                "E_LLM_CANARY",
                "внутренняя защита: в промпт попали запрещённые данные",
                status=500,
            )
    for rx in SECRET_PATTERNS:
        if rx.search(prompt):
            log.error("LLM secret-pattern matched in prompt; refusing to send")
            raise AppError(
                "E_LLM_CANARY",
                "внутренняя защита: в промпте найден шаблон секрета",
                status=500,
            )


def redact_log_excerpt(text: str, block: list[str]) -> str:
    """Strip host/user/IP/exact timestamps before opt-in log snippets hit a prompt."""
    out = text or ""
    for b in sorted((x for x in block if x), key=len, reverse=True):
        out = out.replace(b, "<redacted>")
    out = _IP_RE.sub("<ip>", out)
    out = _TS_RE.sub("<ts>", out)
    return out[:2000]


def parse_catalog_ids(text: str, allowed: list[str]) -> list[str]:
    found = []
    for oid in allowed:
        if re.search(rf"\b{re.escape(oid)}\b", text):
            found.append(oid)
    return found


LLM_PRESETS = {
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "needs_key": True,
    },
    "openai": {
        "label": "OpenAI (ChatGPT)",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "needs_key": True,
    },
    "gemini": {
        "label": "Google Gemini (OpenAI-совместимый)",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        # ID — не человекочитаемое имя. Точный список доступен через
        # кнопку «Загрузить модели» (GET {base_url}/models).
        "model": "gemini-2.0-flash",
        "needs_key": True,
    },
    "ollama": {
        "label": "Ollama (локальная)",
        "base_url": "http://localhost:11434/v1",
        "model": "llama3.2",
        "needs_key": False,
    },
    "lmstudio": {
        "label": "LM Studio (локальная)",
        "base_url": "http://localhost:1234/v1",
        "model": "local-model",
        "needs_key": False,
    },
    "custom": {
        "label": "Другая (OpenAI-совместимая)",
        "base_url": "",
        "model": "",
        "needs_key": True,
    },
}


_REASONING_TAGS = ("thought", "reasoning", "thinking", "analysis")


def _strip_reasoning(text: str) -> str:
    """Вырезает reasoning-блоки из content. Возвращает маркер, если
    весь ответ ушёл в reasoning (в любом виде — закрытый или нет).

    Маркер — непустая строка. Это важно: downstream видит не пустоту,
    а понятное объяснение, и пользователь понимает, что происходит.
    """
    if not text:
        return text
    out = text
    had_reasoning = False
    for tag in _REASONING_TAGS:
        # 1) Закрытые блоки — удалить.
        new_out, n = re.subn(
            rf"<{tag}>.*?</{tag}>", "", out, flags=re.DOTALL | re.IGNORECASE,
        )
        if n > 0:
            had_reasoning = True
        out = new_out
        # 2) Незакрытый блок (обрезан max_tokens) — обрезать до тега.
        m = re.search(rf"<{tag}>", out, flags=re.IGNORECASE)
        if m:
            had_reasoning = True
            out = out[: m.start()]
    out = out.strip()
    if not out and had_reasoning:
        return (
            "[модель израсходовала весь лимит токенов на внутренние "
            "рассуждения и не успела сформировать ответ. Попробуйте: "
            "1) другую модель без reasoning, 2) повторить запрос, "
            "3) короче описать задачу.]"
        )
    return out


def _extract_provider_error(resp) -> str:
    """Достаёт `error.message` из JSON-ответа провайдера для диагностики.

    Обрезаем до 240 символов. Провайдеры обычно не эхо-выводят наш промпт,
    но это проверка — только для UI и логов, никогда для llm_audit.
    """
    try:
        d = resp.json()
    except Exception:
        return ""
    if not isinstance(d, dict):
        return ""
    err = d.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str) and msg:
            return msg[:240]
    if isinstance(err, str):
        return err[:240]
    return ""


def validate_base_url(url: str) -> str:
    """Проверяет base_url для OpenAI-совместимого провайдера.

    Правила:
    - только http/https;
    - hostname обязателен;
    - http разрешён только для loopback (localhost / 127.0.0.0/8 / ::1) —
      на удалённые хосты http = MITM, требуем https;
    - возвращает URL без хвостового '/' (единый стиль с rstrip в _apply_llm).
    """
    url = (url or "").strip()
    if not url:
        raise AppError("E_PARAM", "base_url не может быть пустым", status=400)
    p = urlparse(url)
    if p.scheme not in {"http", "https"}:
        raise AppError("E_PARAM", "base_url: схема должна быть http или https", status=400)
    if not p.hostname:
        raise AppError("E_PARAM", "base_url: не указан hostname", status=400)
    host = p.hostname.lower()
    is_local = False
    if host in {"localhost", "127.0.0.1", "::1"}:
        is_local = True
    else:
        try:
            if ipaddress.ip_address(host).is_loopback:
                is_local = True
        except ValueError:
            pass
    if p.scheme == "http" and not is_local:
        raise AppError(
            "E_PARAM",
            "http:// разрешён только для localhost — для удалённого хоста используйте https (иначе трафик в открытом виде)",
            status=400,
        )
    return url.rstrip("/")


class OpenAICompatLLM:
    """Клиент любого OpenAI-совместимого API.

    Покрывает DeepSeek, OpenAI, Gemini (openai-слой), Ollama, LM Studio,
    vLLM, llama.cpp-server и любые кастомные endpoints.
    """

    provider = "openai_compat"

    def __init__(
        self, base_url: str, model: str, api_key: str, timeout: int,
        extra_params: dict | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key or ""
        self.timeout = timeout
        # Дополнительные параметры тела запроса: reasoning_effort,
        # chat_template_kwargs и прочее, специфичное для провайдера.
        # None/пустой dict = ничего не подмешиваем — принципиально
        # важно, чтобы дефолт не менял поведение клиента.
        self.extra_params = dict(extra_params) if extra_params else None

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        # Локальные LLM часто без ключа — тогда заголовок не отправляем вовсе,
        # чтобы не путать прокси и не плодить логи «Bearer пусто».
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def complete(
        self, prompt: str, max_tokens: int = 400,
    ) -> tuple[str, int, int, str]:
        """Возвращает (text_after_strip, tokens_in, tokens_out, raw_text).

        raw_text — то, что реально прислал провайдер, ДО вырезания
        reasoning-блоков. Нужно для диагностики и для показа пользователю
        в тех случаях, когда весь ответ ушёл в reasoning и text пуст.
        """
        assert_no_secrets(prompt)
        import httpx

        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "stream": False,
        }
        # merge поверх базовых полей — только если задано. Пользователь
        # сам отвечает за то, что провайдер их принимает (кнопка
        # «Проверить связь» в UI покажет ошибку провайдера).
        if self.extra_params:
            body.update(self.extra_params)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                )
        except httpx.TimeoutException as e:
            raise AppError("E_LLM_TIMEOUT", "таймаут запроса к LLM-провайдеру", status=504) from e
        except httpx.RequestError as e:
            log.warning("LLM request failed: %s", type(e).__name__)
            raise AppError("E_LLM_NETWORK", "не удалось связаться с LLM-провайдером", status=502) from e

        if r.status_code >= 400:
            err_msg = _extract_provider_error(r)
            log.warning("LLM provider returned HTTP %s%s", r.status_code, (" — " + err_msg) if err_msg else "")
            raise AppError(
                "E_LLM_PROVIDER",
                f"LLM-провайдер ответил HTTP {r.status_code}" + (f": {err_msg}" if err_msg else ""),
                status=502,
            )

        try:
            data = r.json()
        except Exception as e:
            raise AppError("E_LLM_PROVIDER", "ответ LLM не является JSON", status=502) from e

        choices = data.get("choices") or []
        if not choices or not isinstance(choices, list) or not isinstance(choices[0], dict):
            log.warning("LLM provider returned no choices")
            raise AppError("E_LLM_PROVIDER", "в ответе LLM нет choices", status=502)
        message = choices[0].get("message") or {}
        text = message.get("content")
        if not isinstance(text, str) or not text.strip():
            raise AppError("E_LLM_PROVIDER", "пустой ответ LLM", status=502)
        # Диагностика: если после _strip_reasoning станет пусто, в логе
        # будет видно, что реально прислала модель (обычно это значит,
        # что весь ответ — один большой <thought>-блок, обрезанный по
        # max_tokens до появления «настоящего» content).
        log.info("LLM raw content (%d символов): %r", len(text), text[:1500])
        raw_text = text                       # до strip — для диагностики
        text = _strip_reasoning(text)
        usage = data.get("usage") or {}
        return (
            text,
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            raw_text,
        )

    async def stream_messages(self, messages: list[dict], max_tokens: int = 400):
        """Стримит ответ по списку сообщений [{role, content}].

        Фильтрует reasoning-блоки (<thought>...</thought> и аналоги) по мере
        стрима, чтобы они не долетали до UI. Открывающий/закрывающий тег
        может прийти в разных чанках — поэтому держим маленький буфер-хвост.
        """
        assert_no_secrets(json.dumps(messages, ensure_ascii=False))
        import httpx

        body = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": True,
        }
        if self.extra_params:
            body.update(self.extra_params)

        # State machine для вырезания reasoning-блоков.
        # Отслеживаем до 4 тегов; обычно используется один.
        open_tags = {f"<{t}>": f"</{t}>" for t in _REASONING_TAGS}
        max_open_len = max(len(k) for k in open_tags)
        buf = ""
        skip_until: str | None = None  # закрывающий тег, которого ждём

        def process(chunk: str) -> str:
            """Возвращает текст, который можно отдать наружу."""
            nonlocal buf, skip_until
            buf += chunk
            out: list[str] = []
            while buf:
                if skip_until is not None:
                    idx = buf.find(skip_until)
                    if idx == -1:
                        # Оставляем хвост длиной (len(skip_until) - 1), чтобы
                        # поймать тег, разрезанный чанком.
                        keep = len(skip_until) - 1
                        if keep > 0:
                            buf = buf[-keep:] if len(buf) > keep else buf
                            if len(buf) <= keep:
                                return "".join(out)
                        else:
                            buf = ""
                        return "".join(out)
                    buf = buf[idx + len(skip_until):]
                    skip_until = None
                else:
                    # Ищем ближайший открывающий тег в буфере.
                    best_idx = -1
                    best_tag = None
                    for tag in open_tags:
                        i = buf.find(tag)
                        if i != -1 and (best_idx == -1 or i < best_idx):
                            best_idx = i
                            best_tag = tag
                    if best_idx == -1:
                        # Тега нет. Возможно, часть тега в хвосте.
                        keep = max_open_len - 1
                        if keep > 0 and len(buf) > keep:
                            out.append(buf[: len(buf) - keep])
                            buf = buf[len(buf) - keep:]
                        return "".join(out)
                    if best_idx > 0:
                        out.append(buf[:best_idx])
                    buf = buf[best_idx + len(best_tag):]
                    skip_until = open_tags[best_tag]
            return "".join(out)

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                ) as r:
                    if r.status_code >= 400:
                        await r.aread()
                        err_msg = _extract_provider_error(r)
                        log.warning("LLM chat stream HTTP %s%s", r.status_code, (" — " + err_msg) if err_msg else "")
                        raise AppError(
                            "E_LLM_PROVIDER",
                            f"LLM-провайдер ответил HTTP {r.status_code}"
                            + (f": {err_msg}" if err_msg else ""),
                            status=502,
                        )
                    async for line in r.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            # flush остаток буфера, если он не внутри reasoning
                            if skip_until is None and buf:
                                yield buf
                            return
                        try:
                            data = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        chunk = delta.get("content")
                        if not chunk:
                            continue
                        visible = process(chunk)
                        if visible:
                            yield visible
        except httpx.TimeoutException as e:
            raise AppError("E_LLM_TIMEOUT", "таймаут LLM-стрима", status=504) from e
        except httpx.RequestError as e:
            log.warning("LLM chat stream failed: %s", type(e).__name__)
            raise AppError("E_LLM_NETWORK", "не удалось связаться с LLM-провайдером", status=502) from e

    async def stream(self, prompt: str, max_tokens: int = 400):
        """Отдаёт текстовые чанки по мере поступления (SSE format `data: {json}`).

        Используется эндпоинтом /api/v1/llm/chat для интерактивного окна.
        """
        assert_no_secrets(prompt)
        import httpx

        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "stream": True,
        }
        if self.extra_params:
            body.update(self.extra_params)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                ) as r:
                    if r.status_code >= 400:
                        await r.aread()
                        err_msg = _extract_provider_error(r)
                        log.warning("LLM stream HTTP %s%s", r.status_code, (" — " + err_msg) if err_msg else "")
                        raise AppError(
                            "E_LLM_PROVIDER",
                            f"LLM-провайдер ответил HTTP {r.status_code}"
                            + (f": {err_msg}" if err_msg else ""),
                            status=502,
                        )
                    async for line in r.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            return
                        try:
                            data = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        chunk = delta.get("content")
                        if chunk:
                            yield chunk
        except httpx.TimeoutException as e:
            raise AppError("E_LLM_TIMEOUT", "таймаут LLM-стрима", status=504) from e
        except httpx.RequestError as e:
            log.warning("LLM stream failed: %s", type(e).__name__)
            raise AppError("E_LLM_NETWORK", "не удалось связаться с LLM-провайдером", status=502) from e
    async def list_models(self) -> list[str]:
        """GET {base_url}/models — стандартный OpenAI-совместимый способ узнать
        доступные модели. Используется UI для автодополнения поля «модель».
        """
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.get(f"{self.base_url}/models", headers=self._headers())
        except httpx.TimeoutException as e:
            raise AppError("E_LLM_TIMEOUT", "таймаут запроса списка моделей", status=504) from e
        except httpx.RequestError as e:
            log.warning("LLM list models failed: %s", type(e).__name__)
            raise AppError("E_LLM_NETWORK", "не удалось связаться с LLM-провайдером", status=502) from e

        if r.status_code >= 400:
            err_msg = _extract_provider_error(r)
            raise AppError(
                "E_LLM_PROVIDER",
                f"провайдер ответил HTTP {r.status_code}" + (f": {err_msg}" if err_msg else ""),
                status=502,
            )
        try:
            data = r.json()
        except Exception as e:
            raise AppError("E_LLM_PROVIDER", "ответ на /models не JSON", status=502) from e

        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise AppError(
                "E_LLM_PROVIDER",
                "нестандартный формат ответа /models — этот провайдер не поддерживает OpenAI-совместимый listing",
                status=502,
            )
        out: list[str] = []
        seen: set[str] = set()
        for it in items[:500]:
            mid = None
            if isinstance(it, dict):
                mid = it.get("id")
            elif isinstance(it, str):
                mid = it
            if isinstance(mid, str) and mid and mid not in seen:
                seen.add(mid)
                out.append(mid)
        return out


def ttl_until(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
