from __future__ import annotations

import json
import logging
from typing import Any

from melecho.canonical import ZERO_HMAC_HEX, ZERO_PREV, entry_hmac, head_hmac
from melecho.errors import AppError

log = logging.getLogger("melecho")

PAYLOAD_FIELDS = (
    "action",
    "actor",
    "command",
    "duration_ms",
    "id",
    "interrupted",
    "operation_id",
    "result_hash",
    "result_meta",
    "server_id",
    "sudo_used",
    "timestamp_utc",
)

# Only these keys in result_meta for MVP.
META_ALLOW = {"exit", "sudo", "added", "removed", "code", "stderr_trunc", "hostkey_mode"}


def _normalize_meta(meta: Any) -> Any:
    if meta is None:
        return None
    if not isinstance(meta, dict):
        return meta
    out = {k: v for k, v in meta.items() if k in META_ALLOW}
    for k in ("added", "removed"):
        if k in out and isinstance(out[k], list):
            out[k] = sorted(str(x) for x in out[k])
    return out or None


def empty_head() -> dict:
    return {
        "count": 0,
        "last_id": 0,
        "last_entry_hmac": ZERO_HMAC_HEX,
    }


def sign_head(key: bytes, body: dict) -> dict:
    digest = head_hmac(key, body["count"], body["last_id"], body["last_entry_hmac"])
    return {**body, "head_hmac": digest.hex()}


def load_head(raw: str | None) -> dict:
    if not raw:
        return empty_head()
    return json.loads(raw)


def verify_head_mac(key: bytes, head: dict) -> bool:
    expected = head_hmac(
        key, int(head.get("count", 0)), int(head.get("last_id", 0)), str(head.get("last_entry_hmac") or ZERO_HMAC_HEX)
    ).hex()
    got = str(head.get("head_hmac") or "")
    import hmac as hmaclib

    return hmaclib.compare_digest(expected, got)


def append_audit(conn, key: bytes | None, no_audit: bool, row: dict) -> dict | None:
    """Insert one audit row + update signed head. Must run inside BEGIN IMMEDIATE.

    `id` is assigned before HMAC. Returns the stored payload or None if no_audit.
    """
    if no_audit or key is None:
        log.info("audit_disabled action=%s", row.get("action"))
        return None

    next_id = conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM audit_log").fetchone()["n"]
    prev_row = conn.execute(
        "SELECT entry_hmac FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log)"
    ).fetchone()
    prev_hex = prev_row["entry_hmac"] if prev_row else ZERO_HMAC_HEX
    prev_bytes = bytes.fromhex(prev_hex)

    meta = _normalize_meta(row.get("result_meta"))
    payload = {
        "action": row["action"],
        "actor": row.get("actor") or "admin",
        "command": row.get("command"),
        "duration_ms": row.get("duration_ms"),
        "id": next_id,
        "interrupted": bool(row.get("interrupted", False)),
        "operation_id": row.get("operation_id"),
        "result_hash": row.get("result_hash"),
        "result_meta": meta,
        "server_id": row.get("server_id"),
        "sudo_used": bool(row.get("sudo_used", False)),
        "timestamp_utc": row["timestamp_utc"],
    }
    digest = entry_hmac(key, prev_bytes, payload)
    hmac_hex = digest.hex()
    conn.execute(
        """INSERT INTO audit_log(
            id, timestamp_utc, server_id, actor, operation_id, action, command,
            result_meta, result_hash, duration_ms, sudo_used, interrupted, prev_hmac, entry_hmac
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            next_id,
            payload["timestamp_utc"],
            payload["server_id"],
            payload["actor"],
            payload["operation_id"],
            payload["action"],
            payload["command"],
            None if meta is None else json.dumps(meta, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            payload["result_hash"],
            payload["duration_ms"],
            1 if payload["sudo_used"] else 0,
            1 if payload["interrupted"] else 0,
            prev_hex,
            hmac_hex,
        ),
    )
    count = conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]
    head = sign_head(
        key,
        {"count": count, "last_id": next_id, "last_entry_hmac": hmac_hex},
    )
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('audit_head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(head, ensure_ascii=False, sort_keys=True, separators=(",", ":")),),
    )
    return payload


def verify_integrity(conn, key: bytes | None) -> dict:
    if key is None:
        return {"ok": False, "code": "E_AUDIT_DISABLED", "message": "аудит выключен (--no-audit), ключ не загружен"}
    raw = conn.execute("SELECT value FROM settings WHERE key = 'audit_head'").fetchone()
    head = load_head(None if raw is None else raw["value"])
    if not verify_head_mac(key, head):
        return {"ok": False, "code": "FAIL_HEAD_MAC", "message": "цепочка нарушена: подпись головы не сходится"}
    count = conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]
    max_id_row = conn.execute("SELECT MAX(id) AS m FROM audit_log").fetchone()
    max_id = max_id_row["m"] or 0
    if count != int(head.get("count", -1)):
        return {"ok": False, "code": "FAIL_COUNT", "message": "цепочка нарушена: COUNT(*) не совпадает с головой"}
    if max_id != int(head.get("last_id", -1)):
        return {"ok": False, "code": "FAIL_LAST_ID", "message": "цепочка нарушена: MAX(id) не совпадает с головой (обрез хвоста?)"}
    prev = ZERO_PREV
    last_hex = ZERO_HMAC_HEX
    rows = conn.execute("SELECT * FROM audit_log ORDER BY id").fetchall()
    for r in rows:
        meta = None
        if r["result_meta"]:
            meta = json.loads(r["result_meta"])
        payload = {
            "action": r["action"],
            "actor": r["actor"],
            "command": r["command"],
            "duration_ms": r["duration_ms"],
            "id": r["id"],
            "interrupted": bool(r["interrupted"]),
            "operation_id": r["operation_id"],
            "result_hash": r["result_hash"],
            "result_meta": meta,
            "server_id": r["server_id"],
            "sudo_used": bool(r["sudo_used"]),
            "timestamp_utc": r["timestamp_utc"],
        }
        expected_prev = prev.hex()
        if r["prev_hmac"] != expected_prev:
            return {"ok": False, "code": "FAIL_PREV", "message": f"цепочка нарушена: prev_hmac записи {r['id']}"}
        expected = entry_hmac(key, prev, payload).hex()
        if r["entry_hmac"] != expected:
            return {"ok": False, "code": "FAIL_ENTRY", "message": f"цепочка нарушена: HMAC записи {r['id']}"}
        prev = bytes.fromhex(r["entry_hmac"])
        last_hex = r["entry_hmac"]
    if last_hex != head.get("last_entry_hmac"):
        return {"ok": False, "code": "FAIL_LAST_HMAC", "message": "цепочка нарушена: HMAC последней записи ≠ голова"}
    return {"ok": True, "code": "OK", "message": "целостность подтверждена", "count": count, "last_id": max_id}


def require_ok(result: dict) -> None:
    if not result.get("ok"):
        raise AppError("E_AUDIT_BROKEN", result.get("message") or "цепочка нарушена", status=409)
