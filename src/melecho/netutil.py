"""Shared net_delta — UI, downsampling and detector must use this."""

from __future__ import annotations


def net_delta(prev: int, curr: int) -> tuple[int, bool]:
    if curr >= prev:
        return curr - prev, False
    return curr, True
