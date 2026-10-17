"""HMAC canonical JSON — must match TZ appendix A byte-for-byte."""

from __future__ import annotations

import hashlib
import hmac
import json

ZERO_PREV = bytes(32)
ZERO_HMAC_HEX = "00" * 32


def canonical_json(obj) -> bytes:
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def entry_hmac(key: bytes, prev: bytes, payload: dict) -> bytes:
    return hmac.new(key, prev + canonical_json(payload), hashlib.sha256).digest()


def head_hmac(key: bytes, count: int, last_id: int, last_entry_hmac_hex: str) -> bytes:
    body = {
        "count": count,
        "last_entry_hmac": last_entry_hmac_hex,
        "last_id": last_id,
    }
    return hmac.new(key, canonical_json(body), hashlib.sha256).digest()


def utc_z(ts) -> str:
    """Format aware/naive UTC datetime as YYYY-MM-DDTHH:MM:SSZ (seconds)."""
    if isinstance(ts, str):
        return ts
    if ts.tzinfo is not None:
        ts = ts.replace(microsecond=0)
        return ts.strftime("%Y-%m-%dT%H:%M:%SZ") if ts.utcoffset() and ts.utcoffset().total_seconds() == 0 else ts.astimezone().strftime("%Y-%m-%dT%H:%M:%SZ")
    return ts.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
