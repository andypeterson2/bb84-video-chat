"""Bench daemon — wires the bench session to the browser (WS) and peer (fiber).

The message logic lives in `BenchConnection`, which is transport-free: it takes
`send` callables and is driven directly in tests. `serve()` is the thin
`websockets` + asyncio.start_server shell around it for the real entry point.

Trust boundary: the browser WebSocket hands out raw detections and (source
side) the attack control, so the daemon binds loopback only, checks the Origin
header, requires the pairing token on the first message, and drops any
connection that has not paired within a short grace period.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from bench import ws_protocol as wp
from bench.pairing import Pairing
from bench.session import DetectorBench, SourceBench

if TYPE_CHECKING:
    from bench.config import BenchConfig

logger = logging.getLogger("bench.daemon")

Send = Callable[[dict], Awaitable[None]]


class BenchConnection:
    """One browser connection's message handling, transport-free.

    Owns the pairing gate for this connection and dispatches browser messages
    to the bench. Detector detections are pushed through `send` as they are
    recovered from the fiber (see `on_fiber_frame`).
    """

    def __init__(
        self,
        cfg: BenchConfig,
        pairing: Pairing,
        send: Send,
        *,
        source: SourceBench | None = None,
        detector: DetectorBench | None = None,
    ) -> None:
        """Bind a browser connection to the pairing gate and bench."""
        self._cfg = cfg
        self._pairing = pairing
        self._send = send
        self._source = source
        self._detector = detector
        self._started = False

    async def on_message(self, raw: str | bytes) -> None:
        """Handle one browser message (JSON text)."""
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            await self._send(wp.error("bad_json", "message was not valid JSON"))
            return
        if not isinstance(msg, dict) or "t" not in msg:
            await self._send(wp.error("bad_message", "missing message type"))
            return

        kind = msg["t"]
        if not self._pairing.is_paired:
            if kind != "pair":
                await self._send(wp.refused("must pair first"))
                return
            if not self._pairing.verify(msg.get("token", "")):
                await self._send(wp.refused("bad token"))
                return
            await self._send(wp.paired(self._cfg))
            return

        await self._dispatch(kind, msg)

    async def _dispatch(self, kind: str, msg: dict) -> None:
        if kind == "start":
            if self._detector:
                await self._detector.start()
            self._started = True
            await self._send({"t": "started"})
        elif kind == "stop":
            if self._detector:
                await self._detector.stop()
            self._started = False
            await self._send({"t": "stopped"})
        elif kind == "transmit":
            await self._on_transmit(msg)
        elif kind == "eve":
            if self._source is None:
                await self._send(wp.error("wrong_role", "eve is a source-side control"))
            else:
                self._source.set_eavesdropper(enabled=bool(msg.get("enabled")))
        else:
            await self._send(wp.error("unknown", f"unknown message type {kind!r}"))

    async def _on_transmit(self, msg: dict) -> None:
        if self._source is None:
            await self._send(wp.error("wrong_role", "transmit is a source-side control"))
            return
        try:
            slots = int(msg["slots"])
            bits = tuple(wp.unpack_bits(wp.unb64(msg["bits"]), slots))
            bases = tuple(wp.unpack_bits(wp.unb64(msg["bases"]), slots))
            frame_id = int(msg["frame_id"])
        except (KeyError, ValueError, TypeError) as exc:
            await self._send(wp.error("bad_transmit", str(exc)))
            return
        report = await self._source.transmit(frame_id, bits, bases)
        await self._send(wp.frame_sent(report.frame_id, report.tx_epoch_ps))

    async def on_fiber_frame(self, raw: bytes) -> None:
        """Detector side: recover a fiber frame and push detections upstream."""
        if self._detector is None or not self._started:
            return
        recovered = self._detector.process(raw)
        await self._send(wp.detections(recovered.frame_id, recovered.detections, recovered.stats))


def origin_allowed(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """Whether a browser Origin header is on the daemon's allowlist."""
    if origin is None:
        return False
    return any(origin == a or origin.startswith((a + ":", a)) for a in allowed)


async def serve(cfg: BenchConfig, *, pairing: Pairing | None = None) -> None:  # pragma: no cover - real entry point
    """Run the daemon: fiber link + browser WebSocket. Requires `websockets`.

    `websockets` is imported lazily so the test suite (which drives
    BenchConnection directly) needs no runtime WebSocket dependency.
    """
    import asyncio  # noqa: PLC0415 - entry-point-local

    import websockets  # noqa: PLC0415 - optional runtime dep, imported only when serving

    from bench import fiber_link  # noqa: PLC0415 - entry-point-local

    if cfg.net.ws_host not in ("127.0.0.1", "localhost", "::1") and not cfg.net.insecure_bind:
        msg = f"refusing to bind non-loopback ws_host {cfg.net.ws_host!r} without insecure_bind"
        raise RuntimeError(msg)

    pairing = pairing or Pairing()
    logger.warning("Bench pairing token (paste into the browser): %s", pairing.token)

    source: SourceBench | None = None
    detector: DetectorBench | None = None
    current: dict[str, BenchConnection | None] = {"conn": None}

    if cfg.role == "source":
        link = await fiber_link.dial(cfg.net.fiber_host, cfg.net.fiber_port)
        source = SourceBench(cfg, link.send)
    else:
        detector = DetectorBench(cfg)

        async def fiber_handler(link: fiber_link.FiberLink) -> None:
            async for raw in link.frames():
                conn = current["conn"]
                if conn is not None:
                    await conn.on_fiber_frame(raw)

        await fiber_link.serve(cfg.net.fiber_host, cfg.net.fiber_port, fiber_handler)

    async def ws_handler(ws) -> None:
        origin = ws.request.headers.get("Origin") if hasattr(ws, "request") else None
        if not origin_allowed(origin, cfg.net.ws_allowed_origins):
            await ws.close(code=1008, reason="origin not allowed")
            return
        pairing.reset()
        conn = BenchConnection(cfg, pairing, lambda m: ws.send(json.dumps(m)), source=source, detector=detector)
        current["conn"] = conn
        try:
            async for raw in ws:
                await conn.on_message(raw)
        finally:
            current["conn"] = None
            pairing.reset()

    async with websockets.serve(ws_handler, cfg.net.ws_host, cfg.net.ws_port):
        logger.warning("Bench daemon (%s) listening on ws://%s:%d", cfg.role, cfg.net.ws_host, cfg.net.ws_port)
        await asyncio.Future()  # run forever
