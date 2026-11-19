"""Clocks for action timers (P3.3).

A table reads the time from its clock, and its runner waits for a turn's
deadline through the same clock. ``SystemClock`` uses wall-clock time, so a
deadline saved before a restart (P3.5) still means the same moment after it.
``ManualClock`` only moves when a test calls ``advance``, so timer tests
never sleep.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
import time
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float:
        """Seconds since the epoch."""
        ...

    async def wait(self, event: asyncio.Event, deadline: float | None) -> bool:
        """Wait until ``event`` is set or the clock reaches ``deadline``.

        Returns ``True`` if the event was set and ``False`` on reaching the
        deadline. With no deadline, waits for the event only.
        """
        ...


class SystemClock:
    def now(self) -> float:
        return time.time()

    async def wait(self, event: asyncio.Event, deadline: float | None) -> bool:
        if deadline is None:
            await event.wait()
            return True
        try:
            await asyncio.wait_for(event.wait(), max(0.0, deadline - time.time()))
        except TimeoutError:
            return event.is_set()
        return True


class ManualClock:
    """A clock that moves only when told to."""

    def __init__(self, start: float = 1_000_000.0) -> None:
        self._now = start
        self._waiters: list[tuple[float, int, asyncio.Future[None]]] = []
        self._ids = itertools.count()

    def now(self) -> float:
        return self._now

    async def wait(self, event: asyncio.Event, deadline: float | None) -> bool:
        if event.is_set():
            return True
        if deadline is not None and deadline <= self._now:
            return False
        loop = asyncio.get_running_loop()
        reached: asyncio.Future[None] = loop.create_future()
        if deadline is not None:
            heapq.heappush(self._waiters, (deadline, next(self._ids), reached))
        event_task = loop.create_task(event.wait())
        try:
            await asyncio.wait({event_task, reached}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            event_task.cancel()
            if not reached.done():
                reached.cancel()
        return event.is_set()

    def advance(self, seconds: float) -> None:
        """Move time forward, releasing every wait whose deadline has passed."""
        self._now += seconds
        while self._waiters and self._waiters[0][0] <= self._now:
            _, _, future = heapq.heappop(self._waiters)
            if not future.done():
                future.set_result(None)
