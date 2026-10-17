from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from melecho.netutil import net_delta

log = logging.getLogger("melecho")


def parse_proc_stat(text: str) -> tuple[int, int] | None:
    """Return (total, idle+iowait) from the cpu line."""
    for line in text.splitlines():
        if line.startswith("cpu "):
            parts = line.split()
            nums = [int(x) for x in parts[1:]]
            if len(nums) < 5:
                return None
            idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
            return sum(nums), idle
    return None


def cpu_percent(prev: tuple[int, int], curr: tuple[int, int]) -> float | None:
    dtotal = curr[0] - prev[0]
    if dtotal <= 0:
        return None
    didle = curr[1] - prev[1]
    return 100.0 * (1 - didle / dtotal)


def parse_free_b(text: str) -> float | None:
    for line in text.splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            total = int(parts[1])
            used = int(parts[2])
            if total <= 0:
                return None
            return used / total * 100.0
    return None


def parse_loadavg(text: str) -> list[float]:
    parts = text.split()
    return [float(parts[0]), float(parts[1]), float(parts[2])]


def parse_uptime(text: str) -> int:
    return int(float(text.split()[0]))


def parse_proc_net_dev(text: str) -> tuple[int, int]:
    rx = tx = 0
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        iface = name.strip()
        if iface == "lo":
            continue
        cols = rest.split()
        rx += int(cols[0])
        tx += int(cols[8])
    return rx, tx


def parse_findmnt_json(stdout: str) -> tuple[float | None, str | None]:
    """Return (max used percent, worst target) or raise ValueError on JSON issues."""
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise ValueError("findmnt JSON") from e
    rows = data.get("filesystems", [])
    if not isinstance(rows, list):
        raise ValueError("findmnt filesystems")
    worst = None
    worst_target = None
    for row in rows:
        try:
            target = row["target"]
            fstype = row["fstype"]
            size = int(row["size"])
            used = int(row["used"])
            int(row["avail"])
        except (KeyError, TypeError, ValueError):
            continue
        if fstype not in {"ext4", "xfs", "btrfs"}:
            continue
        if size == 0:
            # Для служебных ФС (tmpfs/sysfs/proc) size=0 — норма, они уже
            # отфильтрованы выше. Если реальный ext4/xfs/btrfs пришёл с
            # size=0 — это неожиданно: либо ошибка разметки, либо findmnt
            # не смог прочитать параметры. Логируем на WARNING, чтобы
            # администратор заметил, а не «диск молча исчез».
            log.warning("findmnt: ФС %s (%s) с size=0 — пропущена", target, fstype)
            continue
        pct = used / size * 100.0
        if worst is None or pct > worst:
            worst = pct
            worst_target = target
    return worst, worst_target


def disk_role(target: str | None, roles: dict[str, str]) -> str:
    if not target:
        return "unknown"
    return roles.get(target, "unknown")


def downsample_window(points: list[dict]) -> dict:
    """Aggregate raw 30s points in a 5m window. net_* become delta bytes."""
    n = len(points)
    cpu = [p["cpu"] for p in points if p.get("cpu") is not None]
    ram = [p["ram"] for p in points if p.get("ram") is not None]
    disk = [p["disk"] for p in points if p.get("disk") is not None]
    loads = []
    for p in points:
        if p.get("load_avg"):
            la = p["load_avg"]
            if isinstance(la, str):
                la = json.loads(la)
            loads.append(la)
    net_rx = 0
    net_tx = 0
    for i in range(1, n):
        a, b = points[i - 1], points[i]
        if a.get("net_rx") is None or b.get("net_rx") is None:
            continue
        d, _ = net_delta(int(a["net_rx"]), int(b["net_rx"]))
        net_rx += d
        d, _ = net_delta(int(a["net_tx"]), int(b["net_tx"]))
        net_tx += d
    load_agg = None
    if loads:
        load_agg = [
            sum(x[0] for x in loads) / len(loads),
            sum(x[1] for x in loads) / len(loads),
            sum(x[2] for x in loads) / len(loads),
        ]
    last = points[-1]
    return {
        "timestamp_utc": last["timestamp_utc"],
        "cpu": (sum(cpu) / len(cpu)) if cpu else None,
        "ram": (sum(ram) / len(ram)) if ram else None,
        "disk": max(disk) if disk else None,
        "net_rx": net_rx,
        "net_tx": net_tx,
        "load_avg": json.dumps(load_agg) if load_agg else None,
        "uptime_sec": last.get("uptime_sec"),
        "resolution": "5m",
        "server_id": last["server_id"],
    }


def floor_5m(ts: str) -> str:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)
    dt = dt.replace(minute=(dt.minute // 5) * 5, second=0, microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def run_downsample(conn, now: datetime | None = None) -> int:
    """Backlog raw 30s → 5m. Returns number of windows written."""
    now = now or datetime.now(timezone.utc)
    written = 0
    servers = [r["id"] for r in conn.execute("SELECT id FROM servers").fetchall()]
    for sid in servers:
        existing = {
            r["timestamp_utc"]
            for r in conn.execute(
                "SELECT timestamp_utc FROM metrics_history WHERE server_id=? AND resolution='5m'",
                (sid,),
            )
        }
        rows = conn.execute(
            """SELECT * FROM metrics_history
               WHERE server_id=? AND resolution='30s'
               ORDER BY timestamp_utc""",
            (sid,),
        ).fetchall()
        buckets: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            key = floor_5m(r["timestamp_utc"])
            if key in existing:
                continue
            # only close windows strictly before current 5m slot
            current_slot = floor_5m(now.strftime("%Y-%m-%dT%H:%M:%SZ"))
            if key >= current_slot:
                continue
            buckets[key].append(dict(r))
        for key, pts in buckets.items():
            if len(pts) < 1:
                continue
            agg = downsample_window(pts)
            agg["timestamp_utc"] = key
            conn.execute(
                """INSERT INTO metrics_history(
                    server_id, timestamp_utc, cpu, ram, disk, net_rx, net_tx, load_avg, uptime_sec, resolution
                ) VALUES (?,?,?,?,?,?,?,?,?, '5m')""",
                (
                    sid,
                    key,
                    agg["cpu"],
                    agg["ram"],
                    agg["disk"],
                    agg["net_rx"],
                    agg["net_tx"],
                    agg["load_avg"],
                    agg["uptime_sec"],
                ),
            )
            written += 1
    return written


# Whitelist таблиц, к которым _delete_where_in_batches имеет право обращаться.
# Имена таблиц нельзя передавать параметром SQL — поэтому фиксируем их
# как константу и отвергаем всё остальное. F11.
_BATCHABLE_TABLES = frozenset({
    "metrics_history", "llm_cache",
    "alerts", "alert_events", "reactions",
    "alert_rule_runs", "llm_audit", "known_hosts_history",
})


def _delete_where_in_batches(
    conn, table: str, where_sql: str, params: tuple, batch: int = 500
) -> int:
    """DELETE ... LIMIT не включён во всех сборках SQLite (Python 3.14 wheels),
    поэтому делаем двухшаговый вариант: SELECT id ... LIMIT → DELETE ... IN (...).

    `table` сверяется с белым списком (f-string в шаблоне, но по константе).
    `where_sql` — фиксированная строка, задаваемая только вызывающей стороной
    в этом же модуле; не приходит извне.
    """
    if table not in _BATCHABLE_TABLES:
        raise ValueError(f"таблица {table!r} не разрешена для batch-delete")
    try:
        batch_n = int(batch)
    except (TypeError, ValueError) as e:
        raise ValueError("batch должен быть целым") from e
    if batch_n < 1 or batch_n > 10000:
        raise ValueError("batch должен быть в диапазоне 1..10000")
    total = 0
    while True:
        ids = [
            r[0]
            for r in conn.execute(
                f"SELECT id FROM {table} WHERE {where_sql} LIMIT {batch_n}",
                params,
            ).fetchall()
        ]
        if not ids:
            break
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(f"DELETE FROM {table} WHERE id IN ({placeholders})", ids)
        total += cur.rowcount if cur.rowcount and cur.rowcount > 0 else len(ids)
        if len(ids) < batch_n:
            break
    return total


def run_retention(conn, raw_days: int, agg_days: int, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    raw_cut = (now - timedelta(days=raw_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    agg_cut = (now - timedelta(days=agg_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    n_raw = _delete_where_in_batches(
        conn, "metrics_history", "resolution='30s' AND timestamp_utc < ?", (raw_cut,)
    )
    n_agg = _delete_where_in_batches(
        conn, "metrics_history", "resolution='5m' AND timestamp_utc < ?", (agg_cut,)
    )
    now_s = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    n_llm = _delete_where_in_batches(conn, "llm_cache", "ttl_until < ?", (now_s,))
    log.info("retention raw=%s agg=%s llm_cache=%s cut_raw=%s", n_raw, n_agg, n_llm, raw_cut)
    return {"raw": n_raw, "agg": n_agg, "llm_cache": n_llm}

