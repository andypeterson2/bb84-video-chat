"""Emulated fiber transport (asyncio TCP, length-prefixed binary frames).

The source daemon dials the detector daemon; each fiber frame from
fiber_wire.encode() is sent with a 4-byte length prefix. In a real system the
photons take the fiber and nothing here exists; this is the emulation of that
physical link, confined to loopback/LAN.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

_LEN = struct.Struct("<I")
_MAX_FRAME = 8 << 20  # 8 MB ceiling against a garbled/hostile peer


class FiberLink:
    """A bidirectional frame link over an asyncio stream pair."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Wrap an asyncio reader/writer pair as a frame link."""
        self._reader = reader
        self._writer = writer

    async def send(self, frame: bytes) -> None:
        """Send one length-prefixed frame."""
        self._writer.write(_LEN.pack(len(frame)) + frame)
        await self._writer.drain()

    async def frames(self):
        """Async-iterate decoded-length frames until the peer closes."""
        while True:
            header = await self._reader.readexactly(_LEN.size)
            (length,) = _LEN.unpack(header)
            if length > _MAX_FRAME:
                msg = f"fiber frame length {length} exceeds cap"
                raise ValueError(msg)
            yield await self._reader.readexactly(length)

    async def close(self) -> None:
        """Close the underlying writer."""
        self._writer.close()
        with contextlib.suppress(ConnectionError, OSError):
            await self._writer.wait_closed()


async def dial(host: str, port: int) -> FiberLink:
    """Source side: connect to the detector daemon's fiber listener."""
    reader, writer = await asyncio.open_connection(host, port)
    return FiberLink(reader, writer)


async def serve(host: str, port: int, handler: Callable[[FiberLink], Awaitable[None]]):
    """Detector side: accept one fiber connection and run `handler` on it."""
    return await asyncio.start_server(
        lambda r, w: handler(FiberLink(r, w)),
        host,
        port,
    )
