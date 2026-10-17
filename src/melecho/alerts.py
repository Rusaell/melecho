
"""Alert Engine — единая точка работы с алертами (Milestone 1).

Все алерты, независимо от источника (detector, threshold, stale,
operation, check), проходят через AlertEngine.emit — это даёт:
- дедупликацию через fingerprint,
- единый журнал событий alert_events,
- единую точку расширения для реакций (Milestone 2).
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone

log = logging.getLogger("melecho")

SEVERITIES = ("info", "warning", "critical")
SOURCES = ("detector", "threshold", "stale", "operation", "check", "manual")

# Канонический тип условия правила → legacy-имя source.
# Нужен, чтобы:
#   * заполнить alerts.source (эта колонка остаётся как денормализация
#     для фильтра /alerts?source=... и UI);
#   * отдавать клиенту виртуальное поле source в /alert-rules, пока UI
#     не переехал на condition_kind (Патч 5).
# reaction_failed не имеет legacy-эквивалента → 'check' (событие-провал,
# не метрика); смысл совпадает с operation_check, различение — по kind.
CONDITION_KIND_TO_SOURCE: dict[str, str] = {
    "metric_threshold":  "threshold",
    "metric_zscore":     "detector",
    "metric_stale":      "stale",
    "operation_check":   "check",
    "manual_op_failed":  "operation",
    "reaction_failed":   "check",
}
STATUSES = ("open", "reacting", "pending_confirmation", "resolved", "failed", "acknowledged", "dismissed")
ACTIVE_STATUSES = ("open", "reacting", "pending_confirmation", "acknowledged")

# Окно дедупликации: если новый алерт с тем же fingerprint появляется, пока
# предыдущий активен и last_seen_at моложе N секунд — обновляем, а не создаём.
DEDUP_WINDOW_SEC = 300


def now_z() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_z(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def fingerprint(rule_id: int | None, server_id: int | None, metric: str | None, dimension: str | None = None) -> str:
    """Считает fingerprint алерта. Одинаковые (rule, server, metric, dimension)
    дедуплицируются в один алерт с repeat_count++."""
    key = f"{rule_id or ''}|{server_id or ''}|{metric or ''}|{dimension or ''}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


# Built-in правила создаются один раз при первом запуске. Удалить нельзя,
# можно только отключить (enabled=0). Правила — глобальные (server_id=NULL).
# Built-in правила. Создаются один раз при первом запуске.
#
# enabled_default: 0 — правило появится в БД отключённым. Пользователь
# включает сам через UI или через LLM. Так дефолтное поведение
# «не спамить алертами» сочетается с возможностью быстро развернуть
# полный набор через /alert.
#
# Источники:
#   detector   — z-score аномалии (EWMA). Роутинг в _flush_detector_alerts.
#   operation  — провал execute_op.
#   check      — провал scheduled_check (создаётся lazy, не здесь).
#   stale      — нет метрик N секунд.
#   threshold  — абсолютный порог метрики. Проверяется раз в 30 сек
#                в _check_threshold_alerts. condition_json:
#                {"metric": "disk", "value_gte": 95}
#                Поддерживаемые ключи: metric (обязателен), value_gte/gt/lte/lt.
#                Доступные метрики: cpu, ram, disk (percent), load_1m.
BUILTIN_RULES: list[dict] = [
    {
        "name": "Z-score warning",
        "condition_kind": "metric_zscore",
        "severity": "warning",
        "condition_json": json.dumps({"z_min": 3.0, "z_max": 4.5}, sort_keys=True),
        "auto_resolve_json": json.dumps({"z_below": 1.5, "for_sec": 300}, sort_keys=True),
        "cooldown_sec": 300,
        "enabled_default": 0,
    },
    {
        "name": "Z-score critical",
        "condition_kind": "metric_zscore",
        "severity": "critical",
        "condition_json": json.dumps({"z_min": 4.5}, sort_keys=True),
        "auto_resolve_json": json.dumps({"z_below": 2.0, "for_sec": 300}, sort_keys=True),
        "cooldown_sec": 300,
        "enabled_default": 0,
    },
    {
        "name": "Operation failed",
        "condition_kind": "manual_op_failed",
        "severity": "warning",
        "condition_json": json.dumps({"exit_ne": 0}, sort_keys=True),
        "auto_resolve_json": None,
        "cooldown_sec": 300,
        "enabled_default": 0,
    },
    {
        "name": "Metrics stale (warn)",
        "condition_kind": "metric_stale",
        "severity": "warning",
        "condition_json": json.dumps({"no_data_sec": 300}, sort_keys=True),
        "auto_resolve_json": json.dumps({"fresh_data_sec": 60}, sort_keys=True),
        "cooldown_sec": 600,
        "enabled_default": 0,
    },
    {
        "name": "Metrics stale (critical)",
        "condition_kind": "metric_stale",
        "severity": "critical",
        "condition_json": json.dumps({"no_data_sec": 1800}, sort_keys=True),
        "auto_resolve_json": json.dumps({"fresh_data_sec": 60}, sort_keys=True),
        "cooldown_sec": 600,
        "enabled_default": 0,
    },
    {
        "name": "Disk usage high",
        "condition_kind": "metric_threshold",
        "severity": "critical",
        "condition_json": json.dumps({"metric": "disk", "value_gte": 95}, sort_keys=True),
        "auto_resolve_json": json.dumps({"below": 95}, sort_keys=True),
        "cooldown_sec": 600,
        "enabled_default": 1,
    },
    {
        "name": "RAM usage high",
        "condition_kind": "metric_threshold",
        "severity": "warning",
        "condition_json": json.dumps({"metric": "ram", "value_gte": 90}, sort_keys=True),
        "auto_resolve_json": json.dumps({"below": 90}, sort_keys=True),
        "cooldown_sec": 600,
        "enabled_default": 1,
    },
]


class AlertEngine:
    """Единая точка создания/обновления алертов.

    Работает поверх Database. Все мутации — через db.mutate (с write-lock
    и BEGIN IMMEDIATE), поэтому emit() атомарен: поиск + create/update +
    alert_event создаются в одной транзакции.
    """

    def __init__(self, db, on_event=None):
        self.db = db
        # on_event: callable(topic: str, payload: dict | None) — вызывается
        # ПОСЛЕ успешного commit. Никогда не должен бросать исключение —
        # это разорвёт путь записи алерта.
        self._on_event = on_event

    def _publish(self, topic: str, payload: dict | None = None) -> None:
        if not self._on_event:
            return
        try:
            self._on_event(topic, payload)
        except Exception:
            log.exception("alerts: on_event failed for %s", topic)

    # ---------- built-in ----------

    async def ensure_builtin_rules(self) -> int:
        """Создаёт built-in правила, если их нет. Возвращает число созданных."""
        created = 0
        now = now_z()

        def fn(conn):
            nonlocal created
            for rule in BUILTIN_RULES:
                exists = conn.execute(
                    "SELECT id FROM alert_rules WHERE builtin=1 AND name=?",
                    (rule["name"],),
                ).fetchone()
                if exists:
                    continue
                conn.execute(
                    """INSERT INTO alert_rules
                       (name, enabled, condition_json, severity, server_id,
                        cooldown_sec, builtin, auto_resolve_json, muted_until, created_at,
                        condition_kind)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        rule["name"],
                        int(rule.get("enabled_default", 1)),
                        rule["condition_json"],
                        rule["severity"],
                        None,
                        rule["cooldown_sec"],
                        1,
                        rule["auto_resolve_json"],
                        None,
                        now,
                        rule["condition_kind"],
                    ),
                )
                created += 1
            return created

        return await self.db.mutate(fn)

    def find_builtin(self, name: str):
        return self.db.conn.execute(
            "SELECT * FROM alert_rules WHERE builtin=1 AND name=?", (name,)
        ).fetchone()

    # ---------- emit ----------

    async def emit(
        self,
        rule_row,
        *,
        server_id: int | None,
        metric: str | None,
        value: float | None,
        threshold: float | None,
        title: str,
        description: str = "",
        meta: dict | None = None,
        dimension: str | None = None,
        related_audit_id: int | None = None,
        parent_alert_id: int | None = None,
        depth: int = 0,
    ) -> dict:
        """Создаёт алерт или обновляет существующий с тем же fingerprint.

        Возвращает {"id": ..., "created": bool, "repeat_count": int}.
        """
        rule_id = rule_row["id"]
        # Отключённое правило НЕ создаёт алертов. Это единая точка
        # защиты: раньше enabled проверялся только в некоторых
        # вызывающих местах (threshold — SQL-фильтр), а detector и
        # stale шли напрямую через emit и создавали алерты из
        # выключенных правил. Теперь невозможно забыть.
        enabled = rule_row["enabled"] if "enabled" in rule_row.keys() else 1
        if not enabled:
            return {"skipped": "disabled"}
        severity = rule_row["severity"]
        # alerts.source — денормализация для фильтра /alerts и UI.
        # В правиле хранится только condition_kind; legacy-имя выводим.
        kind = rule_row["condition_kind"] if "condition_kind" in rule_row.keys() else None
        source = CONDITION_KIND_TO_SOURCE.get(kind or "", "manual")
        # Mute-правило: полный пропуск.
        muted_until = rule_row["muted_until"] if "muted_until" in rule_row.keys() else None
        if muted_until:
            try:
                if parse_z(muted_until) > datetime.now(timezone.utc):
                    return {"skipped": "muted"}
            except (ValueError, TypeError):
                pass
        fp = fingerprint(rule_id, server_id, metric, dimension)
        now = now_z()
        meta_json = json.dumps(meta, sort_keys=True, ensure_ascii=False) if meta else None

        def fn(conn):
            # Правило 1: если создаётся WARNING, а по этой же метрике на этом же
            # сервере уже активен CRITICAL — warning не нужен, инкрементим critical.
            if severity == "warning" and metric is not None:
                crit = conn.execute(
                    """SELECT id, repeat_count FROM alerts
                       WHERE server_id IS ? AND metric=? AND severity='critical'
                         AND status IN ('open', 'reacting', 'pending_confirmation', 'acknowledged')
                       ORDER BY id DESC LIMIT 1""",
                    (server_id, metric),
                ).fetchone()
                if crit is not None:
                    conn.execute(
                        "UPDATE alerts SET last_seen_at=?, repeat_count=repeat_count+1, "
                        "value=?, threshold=?, meta_json=? WHERE id=?",
                        (now, value, threshold, meta_json, crit["id"]),
                    )
                    conn.execute(
                        "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                        "VALUES (?,?,?,?,?)",
                        (crit["id"], now, "repeated", "system", None),
                    )
                    return {
                        "id": crit["id"],
                        "created": False,
                        "repeat_count": crit["repeat_count"] + 1,
                        "skipped": "critical_active",
                    }

            # Правило 2: дедуп без ограничения по времени. Если есть активный
            # алерт с этим fingerprint — обновляем, а не создаём новый.
            # Раньше был 300-секундный cutoff: он давал ложные «новые алерты»
            # после минут молчания, хотя проблема та же.
            existing = conn.execute(
                """SELECT id, repeat_count FROM alerts
                   WHERE fingerprint=? AND status IN ('open', 'reacting', 'pending_confirmation', 'acknowledged')
                   ORDER BY id DESC LIMIT 1""",
                (fp,),
            ).fetchone()
            if existing:
                # condition_kind — денормализация для фильтра реакций.
                # COALESCE: не перетираем, если у existing уже стоит
                # (например, другой source того же rule_id не бывает,
                # но миграция могла не сработать на момент первой версии).
                conn.execute(
                    "UPDATE alerts SET last_seen_at=?, repeat_count=repeat_count+1, "
                    "value=?, threshold=?, meta_json=?, "
                    "condition_kind=COALESCE(condition_kind, ?) WHERE id=?",
                    (now, value, threshold, meta_json, kind, existing["id"]),
                )
                conn.execute(
                    "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                    "VALUES (?,?,?,?,?)",
                    (existing["id"], now, "repeated", "system", None),
                )
                # last_fired_at правила — «последний раз, когда оно эмитило».
                # Денормализация для UI карточки; источник истины —
                # MAX(alerts.last_seen_at) по rule_id, но так быстрее.
                conn.execute(
                    "UPDATE alert_rules SET last_fired_at=? WHERE id=?",
                    (now, rule_id),
                )
                return {
                    "id": existing["id"],
                    "created": False,
                    "repeat_count": existing["repeat_count"] + 1,
                }

            # Правило 3: если пришёл CRITICAL, закрываем активные WARNING по этой
            # же метрике на этом же сервере — иначе UI показывает две карточки
            # про одно и то же.
            if severity == "critical" and metric is not None:
                warn_rows = conn.execute(
                    """SELECT id FROM alerts
                       WHERE server_id IS ? AND metric=? AND severity='warning'
                         AND status IN ('open', 'reacting', 'pending_confirmation', 'acknowledged')""",
                    (server_id, metric),
                ).fetchall()
                for w in warn_rows:
                    conn.execute(
                        "UPDATE alerts SET status='resolved', resolved_at=?, resolved_by='auto' WHERE id=?",
                        (now, w["id"]),
                    )
                    conn.execute(
                        "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                        "VALUES (?,?,?,?,?)",
                        (w["id"], now, "auto_resolved", "system",
                         json.dumps({"reason": "escalated to critical"}, sort_keys=True)),
                    )

            cur = conn.execute(
                """INSERT INTO alerts
                   (fingerprint, first_seen_at, last_seen_at, repeat_count,
                    server_id, rule_id, source, severity, title, description,
                    metric, value, threshold, meta_json,
                    related_audit_id, parent_alert_id, depth, status,
                    condition_kind)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    fp, now, now, 1,
                    server_id, rule_id, source, severity, title, description,
                    metric, value, threshold, meta_json,
                    related_audit_id, parent_alert_id, depth, "open",
                    kind,
                ),
            )
            alert_id = cur.lastrowid
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                "VALUES (?,?,?,?,?)",
                (alert_id, now, "created", "system", None),
            )
            conn.execute(
                "UPDATE alert_rules SET last_fired_at=? WHERE id=?",
                (now, rule_id),
            )
            return {"id": alert_id, "created": True, "repeat_count": 1}

        res = await self.db.mutate(fn)
        # Публикуем событие. Если это обновление существующего — topic
        # alert.updated; если создание — alert.created.
        if isinstance(res, dict) and "id" in res:
            topic = "alert.created" if res.get("created") else "alert.updated"
            self._publish(topic, {
                "alert_id": res["id"],
                "severity": severity,
                "source": source,
                "server_id": server_id,
                "skipped": res.get("skipped"),
            })
        return res

    # ---------- resolve / state changes ----------

    def find_active_by_fingerprint(self, fp: str):
        """Возвращает активный алерт с данным fingerprint или None."""
        return self.db.conn.execute(
            """SELECT * FROM alerts
               WHERE fingerprint=? AND status IN (?,?,?,?)
               ORDER BY id DESC LIMIT 1""",
            (fp, *ACTIVE_STATUSES),
        ).fetchone()

    async def resolve(self, alert_id: int, *, by: str = "auto", reason: str = "") -> bool:
        """Помечает алерт resolved. by: 'auto' | 'manual'. Пишет событие."""
        now = now_z()

        def fn(conn):
            row = conn.execute("SELECT id, status FROM alerts WHERE id=?", (alert_id,)).fetchone()
            if row is None or row["status"] in ("resolved", "dismissed"):
                return False
            conn.execute(
                "UPDATE alerts SET status='resolved', resolved_at=?, resolved_by=? WHERE id=?",
                (now, by, alert_id),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                "VALUES (?,?,?,?,?)",
                (alert_id, now, "auto_resolved" if by == "auto" else "resolved",
                 "system" if by == "auto" else "admin",
                 json.dumps({"reason": reason}, sort_keys=True) if reason else None),
            )
            return True

        ok = await self.db.mutate(fn)
        if ok:
            self._publish("alert.updated", {"alert_id": alert_id, "kind": "resolved"})
        return ok

    async def acknowledge(self, alert_id: int, *, by: str = "admin") -> bool:
        now = now_z()

        def fn(conn):
            row = conn.execute(
                "SELECT id, status FROM alerts WHERE id=?", (alert_id,)
            ).fetchone()
            if row is None:
                from melecho.errors import AppError
                raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)
            if row["status"] in ("resolved", "dismissed"):
                return False
            conn.execute(
                "UPDATE alerts SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id=?",
                (now, by, alert_id),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                "VALUES (?,?,?,?,?)",
                (alert_id, now, "acknowledged", by, None),
            )
            return True

        ok = await self.db.mutate(fn)
        if ok:
            self._publish("alert.updated", {"alert_id": alert_id, "kind": "acknowledged"})
        return ok

    async def dismiss(self, alert_id: int, *, by: str = "admin") -> bool:
        now = now_z()

        def fn(conn):
            row = conn.execute(
                "SELECT id, status FROM alerts WHERE id=?", (alert_id,)
            ).fetchone()
            if row is None:
                from melecho.errors import AppError
                raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)
            if row["status"] == "dismissed":
                return False
            conn.execute(
                "UPDATE alerts SET status='dismissed', dismissed_at=?, dismissed_by=? WHERE id=?",
                (now, by, alert_id),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                "VALUES (?,?,?,?,?)",
                (alert_id, now, "dismissed", by, None),
            )
            return True

        ok = await self.db.mutate(fn)
        if ok:
            self._publish("alert.updated", {"alert_id": alert_id, "kind": "dismissed"})
        return ok

    async def mute(self, alert_id: int, *, until_z: str, by: str = "admin") -> bool:
        """Ставит muted_until на конкретный алерт. Не меняет статус — просто
        помечает, что алерт «замьючен» пользователем (не показываем в активных
        с бейджем)."""
        now = now_z()

        def fn(conn):
            row = conn.execute("SELECT id FROM alerts WHERE id=?", (alert_id,)).fetchone()
            if row is None:
                from melecho.errors import AppError
                raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)
            conn.execute("UPDATE alerts SET muted_until=? WHERE id=?", (until_z, alert_id))
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                "VALUES (?,?,?,?,?)",
                (alert_id, now, "muted", by,
                 json.dumps({"until": until_z}, sort_keys=True)),
            )
            return True

        return await self.db.mutate(fn)

    async def hard_delete(self, alert_id: int, *, by: str = "admin") -> bool:
        """Удаляет алерт и все его события. Разрешено только для
        resolved/dismissed — чтобы нельзя было случайно убрать активный алерт,
        за которым, возможно, следит реакция."""
        def fn(conn):
            row = conn.execute(
                "SELECT id, status FROM alerts WHERE id=?", (alert_id,)
            ).fetchone()
            if row is None:
                from melecho.errors import AppError
                raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)
            # Блокируем только те алерты, над которыми идёт активная работа
            # реакций (Milestone 2). Остальные — open/acknowledged/resolved/
            # dismissed — удалять разрешено.
            if row["status"] in ("reacting", "pending_confirmation"):
                from melecho.errors import AppError
                raise AppError(
                    "E_STATE",
                    f"нельзя удалить алерт в статусе {row['status']} (идёт реакция)",
                    status=409,
                )
            conn.execute("DELETE FROM alert_events WHERE alert_id=?", (alert_id,))
            conn.execute("DELETE FROM alerts WHERE id=?", (alert_id,))
            return True

        await self.db.mutate(fn)
        return True

    async def mute_rule(self, rule_id: int, *, until_z: str) -> bool:
        """Глобальный мьют правила. Все будущие emit этого правила — пропуск."""
        def fn(conn):
            row = conn.execute("SELECT id, builtin FROM alert_rules WHERE id=?", (rule_id,)).fetchone()
            if row is None:
                from melecho.errors import AppError
                raise AppError("E_NOT_FOUND", f"правило {rule_id} не найдено", status=404)
            conn.execute("UPDATE alert_rules SET muted_until=? WHERE id=?", (until_z, rule_id))
            return True

        return await self.db.mutate(fn)

    async def dismiss_for_server(self, server_id: int, *, by: str = "auto") -> int:
        """Закрывает все активные алерты сервера. Вызывается при удалении
        сервера — иначе они висят вечно с чужим server_id."""
        now = now_z()
        count = {"n": 0}

        def fn(conn):
            rows = conn.execute(
                """SELECT id FROM alerts
                   WHERE server_id=? AND status IN (?,?,?,?)""",
                (server_id, *ACTIVE_STATUSES),
            ).fetchall()
            for r in rows:
                conn.execute(
                    "UPDATE alerts SET status='dismissed', dismissed_at=?, dismissed_by=? WHERE id=?",
                    (now, by, r["id"]),
                )
                conn.execute(
                    "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json) "
                    "VALUES (?,?,?,?,?)",
                    (r["id"], now, "dismissed", by,
                     json.dumps({"reason": "server deleted"}, sort_keys=True)),
                )
            count["n"] = len(rows)
            return count["n"]

        n = await self.db.mutate(fn)
        return n

    # ---------- read ----------

    def get(self, alert_id: int):
        row = self.db.conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if row is None:
            from melecho.errors import AppError

            raise AppError("E_NOT_FOUND", f"алерт {alert_id} не найден", status=404)
        return row

    def get_events(self, alert_id: int, limit: int = 200) -> list[dict]:
        rows = self.db.conn.execute(
            """SELECT * FROM alert_events WHERE alert_id=?
               ORDER BY id ASC LIMIT ?""",
            (alert_id, limit),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            if d.get("meta_json"):
                try:
                    d["meta"] = json.loads(d["meta_json"])
                except json.JSONDecodeError:
                    d["meta"] = None
            out.append(d)
        return out

    def list_alerts(
        self,
        *,
        server_id: int | None = None,
        severity: str | None = None,
        source: str | None = None,
        statuses: tuple[str, ...] | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        sql = "SELECT * FROM alerts WHERE 1=1"
        args: list = []
        if server_id is not None:
            sql += " AND server_id=?"
            args.append(server_id)
        if severity:
            sql += " AND severity=?"
            args.append(severity)
        if source:
            sql += " AND source=?"
            args.append(source)
        if statuses:
            placeholders = ",".join("?" * len(statuses))
            sql += f" AND status IN ({placeholders})"
            args.extend(statuses)
        sql += " ORDER BY last_seen_at DESC LIMIT ? OFFSET ?"
        args.extend([limit, offset])
        rows = [dict(r) for r in self.db.conn.execute(sql, args).fetchall()]
        for r in rows:
            if r.get("meta_json"):
                try:
                    r["meta"] = json.loads(r["meta_json"])
                except json.JSONDecodeError:
                    r["meta"] = None
        return {"items": rows, "limit": limit, "offset": offset}

    def counts_by_severity(self) -> dict:
        """Счётчики алертов для шапки и тулбара.

        Возвращает:
          active:  {info, warning, critical, total} — что открыто/ждёт;
          other:   {resolved, dismissed, failed} — что закрыто/сломалось;
          total:   все алерты в БД.

        Активные — те, что требуют внимания (open, reacting,
        pending_confirmation, acknowledged). Остальные разбиты по статусам,
        чтобы UI мог показать сводку в одном месте.
        """
        base = {
            "info": 0, "warning": 0, "critical": 0,
            "active_total": 0,
            "resolved": 0, "dismissed": 0, "failed": 0,
            "total": 0,
        }
        # Активные по severity
        rows = self.db.conn.execute(
            """SELECT severity, COUNT(*) AS c FROM alerts
               WHERE status IN (?,?,?,?)
               GROUP BY severity""",
            ACTIVE_STATUSES,
        ).fetchall()
        for r in rows:
            base[r["severity"]] = r["c"]
            base["active_total"] += r["c"]
        # Прочие статусы
        rows2 = self.db.conn.execute(
            """SELECT status, COUNT(*) AS c FROM alerts
               WHERE status IN ('resolved', 'dismissed', 'failed')
               GROUP BY status"""
        ).fetchall()
        for r in rows2:
            base[r["status"]] = r["c"]
        # Всего
        base["total"] = self.db.conn.execute(
            "SELECT COUNT(*) AS c FROM alerts"
        ).fetchone()["c"]
        return base

    @staticmethod
    def rule_public(row) -> dict:
        """Сериализация правила для API.

        В БД больше нет alert_rules.source — есть condition_kind. Пока UI
        не переехал на condition_kind (Патч 5), добавляем виртуальное
        поле source, выведенное из kind. Обратной совместимостью
        закрываем /alert-rules (список/детали/create/update/reset).
        """
        d = dict(row)
        kind = d.get("condition_kind")
        d["source"] = CONDITION_KIND_TO_SOURCE.get(kind or "", "manual")
        return d

    def list_rules(
        self,
        *,
        kind: str | None = None,
        severity: str | None = None,
        server_id: int | None = None,
        enabled: bool | None = None,
    ) -> list[dict]:
        """Список правил с серверными фильтрами.

        Параметры — из query /alert-rules. None → не фильтруем.
        Фильтр по server_id: server_id=? ИЛИ server_id IS NULL
        (per-server + глобальные) — так UI видит оба типа. Если нужно
        строго «только для этого сервера» — передавайте server_id без
        NULL-ветки (пока не нужно, можно расширить `server_id_strict`).
        """
        sql = "SELECT * FROM alert_rules WHERE 1=1"
        args: list = []
        if kind:
            sql += " AND condition_kind=?"
            args.append(kind)
        if severity:
            sql += " AND severity=?"
            args.append(severity)
        if server_id is not None:
            sql += " AND (server_id=? OR server_id IS NULL)"
            args.append(server_id)
        if enabled is not None:
            sql += " AND enabled=?"
            args.append(1 if enabled else 0)
        sql += " ORDER BY builtin DESC, id ASC"
        rows = self.db.conn.execute(sql, args).fetchall()
        return [self.rule_public(r) for r in rows]
