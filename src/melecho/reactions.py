"""Reaction Engine — Milestone 2.2.

Единая точка работы с реакциями:
- матчинг новых алертов против reaction_rules,
- создание reactions (running / pending_confirmation),
- выполнение операции через runtime.execute_op,
- запись результата и alert_events.

Hardcode: если операция — dangerous/state_changing, action_policy форсится
в 'confirm' независимо от настройки пользователя. Это защита: автозапуск
опасных операций запрещён.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone, timedelta

from melecho.errors import AppError

log = logging.getLogger("melecho")


def now_z() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_z(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


ACTIVE_REACTION_STATUSES = ("running", "pending_confirmation")

# Legacy source → condition_kind. Нужен для двух случаев:
#   1) старые match_json с ключом sources (до миграции v10);
#   2) alert_row без condition_kind (до v15, старые алерты).
# См. CONDITION_KIND_TO_SOURCE в alerts.py — это обратный маппинг.
_LEGACY_SOURCE_TO_KIND = {
    "threshold": "metric_threshold",
    "detector":  "metric_zscore",
    "stale":     "metric_stale",
    "operation": "manual_op_failed",
    "check":     "operation_check",
}


class ReactionEngine:
    """Реакции. Обратная ссылка на runtime для execute_op и др."""

    def __init__(self, runtime):
        self.rt = runtime
        self.db = runtime.db
        self.alerts = runtime.alerts
        self.catalog = runtime.catalog

    def _publish(self, topic: str, payload: dict | None = None) -> None:
        broker = getattr(self.rt, "events", None)
        if broker is None:
            return
        try:
            broker.publish(topic, payload)
        except Exception:
            log.exception("reactions: publish failed for %s", topic)

    # ---------- rules CRUD ----------

    def _public_rule(self, row) -> dict:
        d = dict(row)
        for k in ("match_json", "params_json"):
            if d.get(k):
                try:
                    d[k[:-5]] = json.loads(d[k])
                except json.JSONDecodeError:
                    d[k[:-5]] = None
        stat = self.db.conn.execute(
            """SELECT
                 SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
                 SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS fail,
                 SUM(CASE WHEN status='pending_confirmation' THEN 1 ELSE 0 END) AS pending
               FROM reactions WHERE rule_id=?""",
            (row["id"],),
        ).fetchone()
        d["stats"] = {
            "ok": stat["ok"] or 0,
            "fail": stat["fail"] or 0,
            "pending": stat["pending"] or 0,
        }
        # Если operation_id ссылается на удалённую операцию — помечаем.
        # UI покажет «операция удалена», даст удалить правило или
        # выбрать другую. Само правило из списка не выпадает:
        # иначе нельзя ни удалить, ни исправить.
        op_id = d.get("operation_id")
        if op_id:
            try:
                self.catalog.get(op_id)
                d["operation_missing"] = False
            except AppError:
                d["operation_missing"] = True
        return d

    def list_rules(self) -> dict:
        rows = self.db.conn.execute("SELECT * FROM reaction_rules ORDER BY id").fetchall()
        return {"items": [self._public_rule(r) for r in rows]}

    def get_rule(self, rid: int):
        row = self.db.conn.execute("SELECT * FROM reaction_rules WHERE id=?", (rid,)).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"правило реакции {rid} не найдено", status=404)
        return row

    def validate_rule_body(self, body: dict) -> dict:
        """Валидация и нормализация тела правила реакции. БЕЗ записи в БД.

        Используется:
          - create_rule перед INSERT
          - runtime._suggest_reaction_rule для dry-run валидации
            JSON-ответа LLM (не сохранять предложение модели)

        Возвращает нормализованный dict полей, готовый к INSERT:
          name, match_json, operation_id, params_json, run_on_server,
          sudo_mode, action_policy, cooldown_sec, max_attempts_per_alert,
          max_depth, enabled

        Хардкод: если операция dangerous или state_changing — action_policy
        форсится в confirm. Это защита, обойти нельзя.
        """
        name = (body.get("name") or "").strip()
        if not name or len(name) > 200:
            raise AppError("E_PARAM", "name: 1..200 символов", status=400)

        op_id = (body.get("operation_id") or "").strip()
        op = self.catalog.get(op_id)

        match = body.get("match") or {}
        if not isinstance(match, dict):
            raise AppError("E_PARAM", "match: объект", status=400)

        # Тип условия: канонически condition_kinds. Для совместимости
        # принимаем legacy sources и мапим через _LEGACY_SOURCE_TO_KIND.
        kinds_raw = match.get("condition_kinds")
        if kinds_raw is None:
            legacy = match.get("sources")
            if legacy is None:
                kinds_norm: list[str] = []
            else:
                if not isinstance(legacy, list):
                    raise AppError("E_PARAM", "match.sources: список", status=400)
                kinds_norm = []
                for s in legacy:
                    if not isinstance(s, str):
                        raise AppError(
                            "E_PARAM", "match.sources: строки", status=400,
                        )
                    k = _LEGACY_SOURCE_TO_KIND.get(s)
                    if k is None:
                        raise AppError(
                            "E_PARAM",
                            f"match.sources: неизвестный источник {s!r}",
                            status=400,
                        )
                    if k not in kinds_norm:
                        kinds_norm.append(k)
        else:
            if not isinstance(kinds_raw, list):
                raise AppError("E_PARAM", "match.condition_kinds: список", status=400)
            kinds_norm = []
            for k in kinds_raw:
                if not isinstance(k, str):
                    raise AppError(
                        "E_PARAM", "match.condition_kinds: строки", status=400,
                    )
                if k not in kinds_norm:
                    kinds_norm.append(k)

        match_norm = {
            "rule_ids": list(match.get("rule_ids") or []),
            "severities": list(match.get("severities") or []),
            "condition_kinds": kinds_norm,
            "server_ids": match.get("server_ids"),
        }
        if not any(
            match_norm.get(k)
            for k in ("rule_ids", "severities", "condition_kinds", "server_ids")
        ):
            raise AppError("E_PARAM", "match: укажите хотя бы одно условие", status=400)

        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise AppError("E_PARAM", "params: объект", status=400)

        run_on_server = str(body.get("run_on_server") or "same_as_alert").strip()
        if run_on_server != "same_as_alert":
            try:
                int(run_on_server)
            except (TypeError, ValueError):
                raise AppError(
                    "E_PARAM", "run_on_server: same_as_alert | <server_id>", status=400,
                )

        sudo_mode = (body.get("sudo_mode") or "never").strip()
        if sudo_mode not in ("never", "auto", "confirm"):
            raise AppError("E_PARAM", "sudo_mode: never|auto|confirm", status=400)

        policy = (body.get("action_policy") or "confirm").strip()
        if policy not in ("auto", "confirm"):
            raise AppError("E_PARAM", "action_policy: auto|confirm", status=400)

        # Hardcode: опасные/меняющие состояние операции — всегда confirm.
        flags = op.get("flags") or {}
        forced = bool(flags.get("dangerous") or flags.get("state_changing"))
        if forced:
            policy = "confirm"

        try:
            cooldown = int(
                body.get("cooldown_sec") if body.get("cooldown_sec") is not None else 300
            )
        except (TypeError, ValueError):
            raise AppError("E_PARAM", "cooldown_sec: целое", status=400)
        if cooldown < 0 or cooldown > 86400:
            raise AppError("E_PARAM", "cooldown_sec: 0..86400", status=400)

        try:
            max_attempts = int(body.get("max_attempts_per_alert") or 3)
            max_depth = int(body.get("max_depth") or 3)
        except (TypeError, ValueError):
            raise AppError(
                "E_PARAM", "max_attempts_per_alert/max_depth: целые", status=400,
            )
        if max_attempts < 1 or max_attempts > 20:
            raise AppError("E_PARAM", "max_attempts_per_alert: 1..20", status=400)
        if max_depth < 1 or max_depth > 10:
            raise AppError("E_PARAM", "max_depth: 1..10", status=400)

        return {
            "name": name,
            "match_json": json.dumps(match_norm, ensure_ascii=False, sort_keys=True),
            "operation_id": op_id,
            "params_json": json.dumps(params, ensure_ascii=False, sort_keys=True),
            "run_on_server": run_on_server,
            "sudo_mode": sudo_mode,
            "action_policy": policy,
            "cooldown_sec": cooldown,
            "max_attempts_per_alert": max_attempts,
            "max_depth": max_depth,
            "enabled": 1 if body.get("enabled", True) else 0,
        }

    async def create_rule(self, body: dict) -> dict:
        fields = self.validate_rule_body(body)
        ts = now_z()

        def fn(conn):
            cur = conn.execute(
                """INSERT INTO reaction_rules
                   (name, enabled, match_json, operation_id, params_json,
                    run_on_server, sudo_mode, action_policy, cooldown_sec,
                    max_attempts_per_alert, max_depth, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    fields["name"], fields["enabled"], fields["match_json"],
                    fields["operation_id"], fields["params_json"],
                    fields["run_on_server"], fields["sudo_mode"],
                    fields["action_policy"], fields["cooldown_sec"],
                    fields["max_attempts_per_alert"], fields["max_depth"],
                    ts, ts,
                ),
            )
            return cur.lastrowid

        rid = await self.db.mutate(fn)
        return self._public_rule(self.get_rule(rid))

    async def update_rule(self, rid: int, body: dict) -> dict:
        self.get_rule(rid)
        sets: list[str] = []
        args: list = []

        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name or len(name) > 200:
                raise AppError("E_PARAM", "name: 1..200 символов", status=400)
            sets.append("name=?")
            args.append(name)
        if "enabled" in body:
            sets.append("enabled=?")
            args.append(1 if body.get("enabled") else 0)
        if "sudo_mode" in body:
            sm = (body.get("sudo_mode") or "").strip()
            if sm not in ("never", "auto", "confirm"):
                raise AppError("E_PARAM", "sudo_mode: never|auto|confirm", status=400)
            sets.append("sudo_mode=?")
            args.append(sm)
        if "action_policy" in body:
            ap = (body.get("action_policy") or "").strip()
            if ap not in ("auto", "confirm"):
                raise AppError("E_PARAM", "action_policy: auto|confirm", status=400)
            sets.append("action_policy=?")
            args.append(ap)
        if "cooldown_sec" in body:
            try:
                v = int(body["cooldown_sec"])
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "cooldown_sec: целое", status=400)
            if v < 0 or v > 86400:
                raise AppError("E_PARAM", "cooldown_sec: 0..86400", status=400)
            sets.append("cooldown_sec=?")
            args.append(v)
        if "max_attempts_per_alert" in body:
            try:
                v = int(body["max_attempts_per_alert"])
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "max_attempts_per_alert: целое", status=400)
            if v < 1 or v > 20:
                raise AppError("E_PARAM", "max_attempts_per_alert: 1..20", status=400)
            sets.append("max_attempts_per_alert=?")
            args.append(v)
        if "max_depth" in body:
            try:
                v = int(body["max_depth"])
            except (TypeError, ValueError):
                raise AppError("E_PARAM", "max_depth: целое", status=400)
            if v < 1 or v > 10:
                raise AppError("E_PARAM", "max_depth: 1..10", status=400)
            sets.append("max_depth=?")
            args.append(v)

        if not sets:
            return self._public_rule(self.get_rule(rid))
        sets.append("updated_at=?")
        args.append(now_z())
        args.append(rid)

        def fn(conn):
            conn.execute("UPDATE reaction_rules SET " + ", ".join(sets) + " WHERE id=?", args)

        await self.db.mutate(fn)
        return self._public_rule(self.get_rule(rid))

    async def delete_rule(self, rid: int) -> dict:
        self.get_rule(rid)

        def fn(conn):
            conn.execute("DELETE FROM reaction_rules WHERE id=?", (rid,))
            # reactions оставляем для истории

        await self.db.mutate(fn)
        return {"ok": True}

    # ---------- matching ----------

    def _matches(self, rule_row, alert_row) -> bool:
        try:
            m = json.loads(rule_row["match_json"])
        except (json.JSONDecodeError, TypeError):
            return False
        rule_ids = m.get("rule_ids") or []
        if rule_ids and alert_row["rule_id"] not in rule_ids:
            return False
        sevs = m.get("severities") or []
        if sevs and alert_row["severity"] not in sevs:
            return False
        # Тип условия. Основной ключ — condition_kinds (v10+). Fallback
        # на sources — на случай, если правило не мигрировано (ручной
        # фикс БД, или пользователь восстановил старый match_json).
        kinds = m.get("condition_kinds")
        if not isinstance(kinds, list) or not kinds:
            legacy = m.get("sources") or []
            kinds = [
                _LEGACY_SOURCE_TO_KIND[s]
                for s in legacy
                if isinstance(s, str) and s in _LEGACY_SOURCE_TO_KIND
            ]
        if kinds:
            alert_kind = (
                alert_row["condition_kind"]
                if "condition_kind" in alert_row.keys() else None
            )
            if not alert_kind:
                # Старый алерт (до v15): выводим из source.
                alert_kind = _LEGACY_SOURCE_TO_KIND.get(alert_row["source"])
            if alert_kind not in kinds:
                return False
        srvs = m.get("server_ids")
        if srvs and alert_row["server_id"] not in srvs:
            return False
        return True

    def _target_server_id(self, rule_row, alert_row) -> int | None:
        ros = rule_row["run_on_server"] or "same_as_alert"
        if ros == "same_as_alert":
            return alert_row["server_id"]
        try:
            return int(ros)
        except (TypeError, ValueError):
            return None

    # ---------- process ----------

    async def process_new_alerts(self, window_sec: int = 600) -> int:
        """Находит свежие алерты и создаёт reactions для подходящих правил.

        Не запускает выполнение — только создаёт записи со статусом
        pending_confirmation или running. Выполнение — run_pending().
        """
        cutoff = (
            datetime.now(timezone.utc) - timedelta(seconds=window_sec)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        # Пауза теперь per-server: см. проверку через
        # self.rt._is_sid_blocked ниже. При internet_offline внешние
        # серверы пропускаются, локальные обрабатываются штатно.
        alerts = self.db.conn.execute(
            """SELECT * FROM alerts
               WHERE status IN ('open','acknowledged') AND last_seen_at >= ?""",
            (cutoff,),
        ).fetchall()
        if not alerts:
            return 0
        rules = self.db.conn.execute(
            "SELECT * FROM reaction_rules WHERE enabled=1 ORDER BY id"
        ).fetchall()
        if not rules:
            return 0
        created = 0
        now_dt = datetime.now(timezone.utc)
        for a in alerts:
            for r in rules:
                if not self._matches(r, a):
                    continue
                # max_depth: алерт слишком глубокий (это уже результат реакции)
                if a["depth"] >= r["max_depth"]:
                    continue
                # сервер для запуска
                target_sid = self._target_server_id(r, a)
                if target_sid is None:
                    continue
                # Сервер сейчас заблокирован (offline или internet
                # недоступен и сервер внешний) — не создаём новую
                # реакцию. При возврате сервера новые алерты придут
                # в обычном цикле.
                if self.rt._is_sid_blocked(target_sid):
                    continue
                # max_attempts_per_alert
                attempts = self.db.conn.execute(
                    "SELECT COUNT(*) AS c FROM reactions WHERE rule_id=? AND alert_id=?",
                    (r["id"], a["id"]),
                ).fetchone()["c"]
                if attempts >= r["max_attempts_per_alert"]:
                    continue
                # уже идёт реакция от этого правила на этот алерт
                in_flight = self.db.conn.execute(
                    """SELECT id FROM reactions
                       WHERE rule_id=? AND alert_id=?
                         AND status IN ('running','pending_confirmation')
                       LIMIT 1""",
                    (r["id"], a["id"]),
                ).fetchone()
                if in_flight:
                    continue
                # Глобальный cooldown этого правила на этом сервере
                last = self.db.conn.execute(
                    """SELECT timestamp_utc FROM reactions
                       WHERE rule_id=? AND server_id IS ?
                       ORDER BY id DESC LIMIT 1""",
                    (r["id"], target_sid),
                ).fetchone()
                if last:
                    try:
                        if (now_dt - parse_z(last["timestamp_utc"])).total_seconds() < r["cooldown_sec"]:
                            continue
                    except (ValueError, TypeError):
                        pass
                # Policy
                policy = r["action_policy"]
                try:
                    op = self.catalog.get(r["operation_id"])
                except AppError:
                    continue
                # Привязка операции к серверу (Should, iter 2).
                # Если операция — user-op, не привязанная к этому серверу
                # (или unbound), реакцию не создаём. Раньше это пропускалось
                # до _run_one → execute_op, и user-op могла отработать
                # на сервере, к которому не привязана.
                if not self.rt.is_operation_applicable(r["operation_id"], target_sid):
                    log.debug(
                        "reaction rule %s: op %s не применима к серверу %s — пропуск",
                        r["id"], r["operation_id"], target_sid,
                    )
                    continue
                flags = op.get("flags") or {}
                if flags.get("dangerous") or flags.get("state_changing"):
                    policy = "confirm"
                status = "running" if policy == "auto" else "pending_confirmation"
                rid = await self._create_reaction(a, r, target_sid, status)
                if rid is None:
                    continue
                created += 1
        return created

    async def _create_reaction(self, alert_row, rule_row, server_id: int, status: str) -> int | None:
        now = now_z()
        params = rule_row["params_json"] or "{}"

        def fn(conn):
            cur = conn.execute(
                """INSERT INTO reactions
                   (alert_id, rule_id, timestamp_utc, status, operation_id,
                    server_id, params_json, sudo_used)
                   VALUES (?,?,?,?,?,?,?,0)""",
                (
                    alert_row["id"], rule_row["id"], now, status,
                    rule_row["operation_id"], server_id, params,
                ),
            )
            rid = cur.lastrowid
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json, reaction_id) "
                "VALUES (?,?,?,?,?,?)",
                (alert_row["id"], now, "reaction_scheduled", "system",
                 json.dumps({"rule_id": rule_row["id"], "status": status}, sort_keys=True), rid),
            )
            return rid

        rid = await self.db.mutate(fn)
        if rid is not None:
            topic = ("reaction.pending" if status == "pending_confirmation"
                     else "reaction.running")
            self._publish(topic, {
                "reaction_id": rid,
                "alert_id": alert_row["id"],
                "rule_id": rule_row["id"],
                "operation_id": rule_row["operation_id"],
                "server_id": server_id,
            })
        return rid

    # ---------- execute ----------

    async def run_pending(self) -> int:
        """Берёт запланированные реакции со статусом 'running' и выполняет их.

        Ограничение: не более 2 параллельных реакций, чтобы не забить SSH-пул.
        """
        import asyncio
        rows = self.db.conn.execute(
            """SELECT * FROM reactions
               WHERE status='running' ORDER BY id ASC LIMIT 2"""
        ).fetchall()
        if not rows:
            return 0
        tasks = [asyncio.create_task(self._run_one(r["id"])) for r in rows]
        await asyncio.gather(*tasks, return_exceptions=True)
        return len(rows)

    async def _run_one(self, rid: int) -> None:
        row = self.db.conn.execute("SELECT * FROM reactions WHERE id=?", (rid,)).fetchone()
        if row is None or row["status"] != "running":
            return
        rule = self.db.conn.execute("SELECT * FROM reaction_rules WHERE id=?", (row["rule_id"],)).fetchone()

        # Все проверки — ДО mark_start. Если любая провалится, реакция
        # получит status='failed' + error_code. Раньше started_at
        # проставлялся раньше всех проверок, и при отсутствии sudo реакция
        # возвращалась в pending_confirmation с уже установленным
        # started_at — в UI это выглядело как «началась, потом снова pending»,
        # а в «Последние запуски» — как вечно висящая запись без деталей.
        params = json.loads(row["params_json"] or "{}")
        op_id = row["operation_id"]
        sid = row["server_id"]

        if sid is None:
            await self._finish(rid, "failed", error_code="E_NO_SERVER",
                               stderr="no target server")
            return
        try:
            op = self.catalog.get(op_id)
        except AppError as e:
            await self._finish(rid, "failed", error_code=e.code, stderr=e.message)
            return
        # Race: правило было applicable при создании reaction, но админ
        # успел поменять привязку до tick'а выполнения.
        if not self.rt.is_operation_applicable(op_id, sid):
            await self._finish(
                rid, "failed", error_code="E_OP_NOT_APPLICABLE",
                stderr=f"операция {op_id} не привязана к серверу {sid}",
            )
            return
        # Race: интернет/сервер ушли в offline между созданием running
        # и этим тиком. Проверяем ещё раз — это дешевле, чем ждать
        # 15-секундный SSH-таймаут. Локальные серверы работают при
        # internet_offline штатно (см. _is_sid_blocked).
        block_code = self.rt._is_sid_blocked(sid)
        if block_code:
            msg = (
                "нет подключения к интернету — реакция отложена"
                if block_code == "E_NO_INTERNET"
                else f"сервер {sid} не отвечает — реакция отложена"
            )
            await self._finish(rid, "failed", error_code=block_code, stderr=msg)
            return

        needs_sudo = any(
            (st.get("command") or "").strip().startswith("sudo")
            for st in (op.get("steps") or [])
        )
        sudo_pw: str | None = None
        if needs_sudo:
            sudo_mode = rule["sudo_mode"] if rule else "never"
            if sudo_mode == "never":
                await self._finish(
                    rid, "failed", error_code="E_SUDO_NOT_ALLOWED",
                    stderr="правило запрещает sudo, но операция требует",
                )
                return
            sudo_pw = self.rt.sudo_get_password()
            if not sudo_pw:
                # Раньше здесь было to_pending — и реакция бесконечно
                # возвращалась в pending_confirmation при каждом
                # подтверждении. Теперь fail с чёткой инструкцией.
                # Разблокировав автосудо один раз, пользователь получит
                # работающие реакции на следующие алерты.
                await self._finish(
                    rid, "failed", error_code="E_SUDO_NOT_UNLOCKED",
                    stderr=(
                        "операция требует sudo, но автосудо не разблокировано. "
                        "Настройки → Автосудо → Разблокировать, затем повторите "
                        "или дождитесь следующего алерта."
                    ),
                )
                return

        # Все проверки пройдены. Только теперь фиксируем начало выполнения.
        started_at = now_z()

        def mark_start(conn):
            conn.execute("UPDATE reactions SET started_at=? WHERE id=?", (started_at, rid))

        await self.db.mutate(mark_start)
        self._publish("reaction.started", {
            "reaction_id": rid,
            "alert_id": row["alert_id"],
            "operation_id": op_id,
            "server_id": sid,
        })

        # Если пароль есть — положим в кэш runtime для execute_op
        # (короткий TTL: одна операция).
        if sudo_pw:
            self.rt.sudo[sid] = (sudo_pw, time.monotonic() + 60)

        t0 = time.monotonic()
        status = "ok"
        exit_code = None
        stdout = ""
        stderr = ""
        error_code = None
        sudo_used = False
        try:
            res = await self.rt.execute_op(op_id, sid, params, use_sudo=None, confirm=True)
            steps = res.get("steps") or []
            run_step = next((s for s in steps if s.get("phase") == "run"), None)
            if run_step:
                exit_code = run_step.get("exit")
                stdout = (run_step.get("stdout") or "")[:8000]
                stderr = (run_step.get("stderr") or "")[:2000]
            sudo_used = bool(res.get("sudo_used"))
            if exit_code != 0:
                status = "failed"
        except AppError as e:
            status = "failed"
            error_code = e.code
            stderr = (e.message or "")[:500]
        except Exception as e:
            status = "failed"
            error_code = "E_INTERNAL"
            stderr = str(e)[:500]

        duration_ms = int((time.monotonic() - t0) * 1000)
        await self._finish(
            rid, status,
            exit_code=exit_code, duration_ms=duration_ms,
            stdout=stdout, stderr=stderr, error_code=error_code,
            sudo_used=sudo_used,
        )

    async def _finish(
        self, rid: int, status: str, *,
        exit_code: int | None = None,
        duration_ms: int | None = None,
        stdout: str = "",
        stderr: str = "",
        error_code: str | None = None,
        sudo_used: bool = False,
    ) -> None:
        finished_at = now_z()
        row = self.db.conn.execute("SELECT * FROM reactions WHERE id=?", (rid,)).fetchone()
        if row is None:
            return
        kind = "reaction_success" if status == "ok" else "reaction_failed"

        def fn(conn):
            conn.execute(
                """UPDATE reactions SET status=?, finished_at=?, exit_code=?,
                     duration_ms=?, stdout_trunc=?, stderr_trunc=?, error_code=?,
                     sudo_used=?
                   WHERE id=?""",
                (status, finished_at, exit_code, duration_ms, stdout, stderr,
                 error_code, 1 if sudo_used else 0, rid),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json, reaction_id) "
                "VALUES (?,?,?,?,?,?)",
                (row["alert_id"], finished_at, kind, "system",
                 json.dumps({"status": status, "exit": exit_code, "error": error_code}, sort_keys=True),
                 rid),
            )
            # Если реакция удалась — резолвим алерт. Если упала — оставляем
            # алерт открытым, но помечаем failed, чтобы UI показал "не помогло".
            if status == "ok":
                conn.execute(
                    "UPDATE alerts SET status='resolved', resolved_at=?, resolved_by='reaction' WHERE id=? AND status IN ('open','acknowledged','reacting')",
                    (finished_at, row["alert_id"]),
                )
                conn.execute(
                    "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json, reaction_id) "
                    "VALUES (?,?,?,?,?,?)",
                    (row["alert_id"], finished_at, "auto_resolved", "system",
                     json.dumps({"reason": "reaction succeeded"}, sort_keys=True), rid),
                )
            elif status in ("failed", "timeout"):
                conn.execute(
                    "UPDATE alerts SET status='failed' WHERE id=? AND status IN ('open','acknowledged','reacting')",
                    (row["alert_id"],),
                )

        await self.db.mutate(fn)
        self._publish("reaction.finished", {
            "reaction_id": rid,
            "alert_id": row["alert_id"],
            "status": status,
            "error_code": error_code,
            "exit_code": exit_code,
        })

    # ---------- read ----------

    def list_reactions(self, *, alert_id: int | None = None, status: str | None = None,
                       limit: int = 100, offset: int = 0) -> dict:
        sql = "SELECT * FROM reactions WHERE 1=1"
        args: list = []
        if alert_id is not None:
            sql += " AND alert_id=?"
            args.append(alert_id)
        if status:
            sql += " AND status=?"
            args.append(status)
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args.extend([min(limit, 500), offset])
        rows = [dict(r) for r in self.db.conn.execute(sql, args).fetchall()]
        return {"items": rows, "limit": limit, "offset": offset}

    def get_reaction(self, rid: int):
        row = self.db.conn.execute("SELECT * FROM reactions WHERE id=?", (rid,)).fetchone()
        if row is None:
            raise AppError("E_NOT_FOUND", f"реакция {rid} не найдена", status=404)
        return row

    def pending_count(self) -> int:
        return self.db.conn.execute(
            "SELECT COUNT(*) AS c FROM reactions WHERE status='pending_confirmation'"
        ).fetchone()["c"]

    async def confirm(self, rid: int, *, by: str = "admin") -> dict:
        """Подтверждение pending-реакции: переводим в running, чтобы poll_loop
        её подхватил."""
        row = self.get_reaction(rid)
        if row["status"] != "pending_confirmation":
            raise AppError("E_STATE", f"реакция в статусе {row['status']}, нельзя подтвердить", status=409)

        # Race: сервер мог уйти в offline между созданием pending и
        # подтверждением, либо для внешнего сервера мог пропасть
        # интернет. Не запускаем SSH в пустоту на 15 сек таймаута, а
        # сразу финализируем failed. Локальные серверы работают при
        # internet_offline штатно (см. _is_sid_blocked).
        sid_check = row["server_id"]
        block_code = (
            self.rt._is_sid_blocked(sid_check) if sid_check is not None else None
        )
        if block_code:
            msg = (
                "нет подключения к интернету — реакция не выполнена"
                if block_code == "E_NO_INTERNET"
                else f"сервер {sid_check} не отвечает — реакция не выполнена"
            )
            await self._finish(rid, "failed", error_code=block_code, stderr=msg)
            return {"ok": False, "error_code": block_code}

        now = now_z()

        def fn(conn):
            conn.execute(
                "UPDATE reactions SET status='running', confirmed_at=?, confirmed_by=? WHERE id=?",
                (now, by, rid),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json, reaction_id) "
                "VALUES (?,?,?,?,?,?)",
                (row["alert_id"], now, "reaction_confirmed", by, None, rid),
            )

        await self.db.mutate(fn)
        self._publish("reaction.running", {
            "reaction_id": rid,
            "alert_id": row["alert_id"],
            "operation_id": row["operation_id"],
            "server_id": row["server_id"],
        })
        return {"ok": True}

    async def cancel(self, rid: int, *, by: str = "admin", reason: str = "") -> dict:
        row = self.get_reaction(rid)
        if row["status"] not in ACTIVE_REACTION_STATUSES:
            raise AppError("E_STATE", f"реакция в статусе {row['status']}, нельзя отменить", status=409)
        now = now_z()

        def fn(conn):
            conn.execute(
                "UPDATE reactions SET status='cancelled', finished_at=? WHERE id=?",
                (now, rid),
            )
            conn.execute(
                "INSERT INTO alert_events(alert_id, timestamp_utc, kind, actor, meta_json, reaction_id) "
                "VALUES (?,?,?,?,?,?)",
                (row["alert_id"], now, "reaction_cancelled", by,
                 json.dumps({"reason": reason}, sort_keys=True) if reason else None, rid),
            )

        await self.db.mutate(fn)
        self._publish("reaction.cancelled", {
            "reaction_id": rid,
            "alert_id": row["alert_id"],
        })
        return {"ok": True}
