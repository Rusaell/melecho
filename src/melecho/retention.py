"""Retention — единый прогон по всем правилам хранения данных.

Все правила (таблицы, SQL, дефолты) — фиксированные константы в этом
модуле. Имена таблиц и WHERE-выражения НЕ приходят извне: защита F11
(f-string SQL только по константе).

Пользователь настраивает только число дней хранения через settings
(retention.<table>_days). Планировщик (poll_loop) вызывает
run_all_retention раз в час (retention_interval_sec).

Что чистится:
  * metrics_history (raw 30s и agg 5m) — отдельными правилами;
  * закрытые alerts (open/reacting/pending/acknowledged не трогаем);
  * завершённые reactions (running/pending_confirmation не трогаем);
  * scheduled_check_runs — вся история старше N дней;
  * llm_audit — для RQ3 на защите, разумное окно;
  * known_hosts_history — по умолчанию никогда (0 = не удалять);
  * llm_cache — TTL-driven, всегда (не настройка).

Что не чистится никогда: audit_log. HMAC-chain — S2-инвариант, удаление
любой строки ломает verify.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from melecho.metrics import _delete_where_in_batches


@dataclass(frozen=True)
class RetentionRule:
    key: str                # "retention.metrics_raw_days" — ключ в settings
    table: str              # "metrics_history" — из _BATCHABLE_TABLES
    ts_column: str          # "timestamp_utc" — для MIN()/UI
    where_sql: str          # "resolution='30s' AND timestamp_utc < ?" — только константа
    default_days: int
    min_days: int
    max_days: int
    description: str
    # 0 = «никогда». Для known_hosts_history: крошечная таблица, ценна
    # при аудите смены ключа, удаление — только осознанно.
    zero_means_never: bool = False
    # Необязательный «пред-удаляющий» шаг: сначала чистим зависимые
    # строки (alert_events для alerts), потом основную таблицу.
    pre_delete: tuple[str, str] | None = None
    # WHERE для COUNT(*)/MIN(ts) в plan_retention. Нужен, когда одно
    # правило — подмножество таблицы (metrics_history: 30s vs 5m).
    # По умолчанию «вся таблица». where_sql для DELETE остаётся
    # отдельным — он добавляет к этому ещё и срез по timestamp.
    stats_sql: str = "1=1"


RULES: list[RetentionRule] = [
    RetentionRule(
        key="retention.metrics_raw_days",
        table="metrics_history",
        ts_column="timestamp_utc",
        where_sql="resolution='30s' AND timestamp_utc < ?",
        default_days=3,
        min_days=1,
        max_days=30,
        description="Метрики: сырые (30s)",
        stats_sql="resolution='30s'",
    ),
    RetentionRule(
        key="retention.metrics_agg_days",
        table="metrics_history",
        ts_column="timestamp_utc",
        where_sql="resolution='5m' AND timestamp_utc < ?",
        default_days=30,
        min_days=1,
        max_days=365,
        description="Метрики: агрегат (5m)",
        stats_sql="resolution='5m'",
    ),
    RetentionRule(
        key="retention.alerts_days",
        table="alerts",
        ts_column="last_seen_at",
        where_sql=(
            "status NOT IN ('open','reacting','pending_confirmation','acknowledged') "
            "AND last_seen_at < ?"
        ),
        default_days=90,
        min_days=7,
        max_days=730,
        description="Закрытые алерты",
        pre_delete=(
            "alert_events",
            "alert_id IN (SELECT id FROM alerts WHERE "
            "status NOT IN ('open','reacting','pending_confirmation','acknowledged') "
            "AND last_seen_at < ?)",
        ),
    ),
    RetentionRule(
        key="retention.reactions_days",
        table="reactions",
        ts_column="timestamp_utc",
        where_sql="status IN ('ok','failed','timeout','cancelled') AND timestamp_utc < ?",
        default_days=30,
        min_days=1,
        max_days=365,
        description="История реакций",
    ),
    RetentionRule(
        key="retention.check_runs_days",
        table="alert_rule_runs",
        ts_column="timestamp_utc",
        where_sql="timestamp_utc < ?",
        default_days=14,
        min_days=1,
        max_days=180,
        description="История запусков проверок",
    ),
    RetentionRule(
        key="retention.llm_audit_days",
        table="llm_audit",
        ts_column="timestamp_utc",
        where_sql="timestamp_utc < ?",
        default_days=180,
        min_days=30,
        max_days=730,
        description="Журнал LLM-запросов",
    ),
    RetentionRule(
        key="retention.known_hosts_history_days",
        table="known_hosts_history",
        ts_column="removed_at",
        where_sql="removed_at < ?",
        default_days=0,
        min_days=0,
        max_days=3650,
        description="История host-ключей (0 — не удалять)",
        zero_means_never=True,
    ),
]

# Ключ для llm_cache в результате прогона (не настройка — TTL).
LLM_CACHE_KEY = "retention.llm_cache_ttl"


def _now_z(now: datetime) -> str:
    return now.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _cutoff_z(keep_days: int, now: datetime) -> str:
    return (now - timedelta(days=keep_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(value, hi))


def _read_keep_days(rule: RetentionRule, get_setting) -> int:
    raw = get_setting(rule.key)
    try:
        v = int(raw) if raw is not None else rule.default_days
    except (TypeError, ValueError):
        v = rule.default_days
    return _clamp(v, rule.min_days, rule.max_days)


def _table_stats(conn, rule: RetentionRule) -> dict:
    try:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM {rule.table} WHERE {rule.stats_sql}"
        ).fetchone()["c"]
    except Exception:
        total = 0
    try:
        row = conn.execute(
            f"SELECT MIN({rule.ts_column}) AS m FROM {rule.table} WHERE {rule.stats_sql}"
        ).fetchone()
        oldest = row["m"] if row else None
    except Exception:
        oldest = None
    return {"rows_total": int(total or 0), "oldest": oldest}


def plan_retention(conn, get_setting, now: datetime | None = None) -> list[dict]:
    """Dry-run без удаления. Возвращает список правил с текущими
    значениями и количеством строк, которые БЫЛИ БЫ удалены."""
    now = now or datetime.now(timezone.utc)
    out: list[dict] = []
    for rule in RULES:
        keep_days = _read_keep_days(rule, get_setting)
        stats = _table_stats(conn, rule)
        would = 0
        if not (rule.zero_means_never and keep_days == 0):
            cutoff = _cutoff_z(keep_days, now)
            try:
                row = conn.execute(
                    f"SELECT COUNT(*) AS c FROM {rule.table} WHERE {rule.where_sql}",
                    (cutoff,),
                ).fetchone()
                would = int(row["c"]) if row else 0
            except Exception:
                would = 0
        out.append({
            "key": rule.key,
            "table": rule.table,
            "description": rule.description,
            "keep_days": keep_days,
            "min_days": rule.min_days,
            "max_days": rule.max_days,
            "zero_means_never": rule.zero_means_never,
            "rows_total": stats["rows_total"],
            "oldest": stats["oldest"],
            "would_delete": would,
        })
    return out


def run_all_retention(conn, get_setting, now: datetime | None = None) -> dict:
    """Реальное удаление по всем правилам. Возвращает {rule.key: deleted}.
    Для правил с pre_delete сначала чистит зависимые строки.

    llm_cache чистится всегда (TTL-driven, не настройка) — отдельный
    ключ LLM_CACHE_KEY в результате.
    """
    now = now or datetime.now(timezone.utc)
    out: dict[str, int] = {}
    for rule in RULES:
        keep_days = _read_keep_days(rule, get_setting)
        if rule.zero_means_never and keep_days == 0:
            out[rule.key] = 0
            continue
        cutoff = _cutoff_z(keep_days, now)
        try:
            if rule.pre_delete is not None:
                pre_table, pre_where = rule.pre_delete
                _delete_where_in_batches(conn, pre_table, pre_where, (cutoff,))
            out[rule.key] = _delete_where_in_batches(
                conn, rule.table, rule.where_sql, (cutoff,)
            )
        except Exception:
            # Одна упавшая таблица не должна валить весь retention.
            # Логирование — на уровне вызывающего (poll_loop).
            out[rule.key] = -1
    try:
        now_s = _now_z(now)
        out[LLM_CACHE_KEY] = _delete_where_in_batches(
            conn, "llm_cache", "ttl_until < ?", (now_s,)
        )
    except Exception:
        out[LLM_CACHE_KEY] = -1
    return out
