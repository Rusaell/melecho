"""In-memory pub/sub для SSE-канала.

Один процесс, много подписчиков. Каждый подписчик — asyncio.Queue
с ограниченным размером. Если очередь заполнена (медленный клиент),
событие дропается — клиент просто пропустит его, но не заблокирует
publish. Клиент сам перезагрузит состояние при переподключении.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("melecho")

# Максимум событий в очереди на одного подписчика. Небольшое число:
# если клиент не вычитывает — не хотим растить память.
_QUEUE_MAX = 200


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class EventBroker:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._subscribers.add(q)
        log.debug("event broker: +subscriber (total=%d)", len(self._subscribers))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)
        log.debug("event broker: -subscriber (total=%d)", len(self._subscribers))

    def publish(self, topic: str, payload: dict | None = None) -> None:
        """Синхронный publish. Вызывается из async-контекста, но
        внутри — только `Queue.put_nowait`, это не блокирует event loop."""
        if not self._subscribers:
            return
        event: dict[str, Any] = {
            "topic": topic,
            "ts": _now(),
            "payload": payload or {},
        }
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Медленный клиент — событие дропаем. Он получит следующие,
                # а при переподключении сам перечитает состояние.
                log.debug("event broker: queue full, drop %s", topic)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
