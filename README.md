# Quantum Video Chat

Browser-native, peer-to-peer video chat with **BB84 quantum key distribution**. Video and audio flow directly between browsers via WebRTC. The BB84 protocol runs over a WebRTC DataChannel, producing shared symmetric keys through a simulated quantum optical channel.

The quantum channel models real hardware parameters: Poissonian photon statistics, fiber attenuation, single-photon APD detectors, and intercept-resend eavesdropping. When the quantum bit error rate (QBER) exceeds the 11% security threshold, keys are rejected and re-exchanged automatically.

## Architecture

```
Browser A ◄══ WebRTC (P2P encrypted media) ══► Browser B
    │                                              │
    └──── Socket.IO signaling ────► Server ◄───────┘
                                  (SDP + ICE relay only)
```

- **Signaling server** (Python/Flask): room management, SDP/ICE relay. No media touches the server.
- **WebRTC**: peer-to-peer video/audio via `RTCPeerConnection`
- **Insertable Streams**: AES-128-GCM frame encryption in a Web Worker (`RTCRtpScriptTransform`)
- **DataChannel**: BB84 key exchange messages flow peer-to-peer
- **BB84 Protocol** (JavaScript): sifting, QBER estimation, block-parity error correction (simplified; full Cascade is future work), seeded Toeplitz privacy amplification

## Quick Start

### Prerequisites

- Python 3.9+
- Node.js 20+ (for JS tests only; not needed at runtime)
- pip packages: `flask flask-cors python-socketio eventlet`

### Run the signaling server

```bash
pip install flask flask-cors python-socketio eventlet
python signaling/main.py
```

The server starts on a dynamically assigned port (or set `QVC_SERVER_REST_PORT=5050`).

### Run with Docker

```bash
# From the website root
docker compose up -d
```

Port assignments are in `.env`. Set `DEV=1` in `.env` to also serve the Astro frontend.

### Open the client

Navigate to the page that serves `website/client/index.html`. In Docker, this is served by the Astro dev server at `localhost:4322/projects/quantum-video-chat/client/`.

1. Two browser tabs → both connect to the signaling server
2. Tab A clicks **Start Session** → gets an invite link (the room id is an unguessable capability token — the link is the credential)
3. Tab B pastes the invite link → clicks **Join** (opening the link directly prefills it)
4. WebRTC peer connection establishes → video flows P2P
5. BB84 key exchange runs over DataChannel → shared key derived; the cipher pill turns green when the crypto worker confirms it is encrypting

### Run the bench daemon (optical mode)

Optical mode runs one daemon per bench. On one machine, start the detector
first (it listens on the fiber) then the source (it dials it):

```bash
pip install -r bench/requirements.txt          # asyncio + websockets
python -m bench --config bench-detector.toml   # role = "detector"
python -m bench --config bench-source.toml     # role = "source"
```

Each daemon prints a one-time **pairing token** to stdout. In the lobby, tick
**Use optical bench**, paste the daemon's `ws://` URL and its token — the room
creator uses the source daemon, the joiner uses the detector daemon. Optical
mode engages only when both peers present complementary benches; otherwise the
call falls back to the simulator. See `bench/bench.toml.example` for every
knob (APD and SNSPD presets included) and `docs/HARDWARE.md` for the contract
that swaps the emulated instruments for real optics.

The daemon is asyncio + `websockets`, deliberately **process-isolated** from
the eventlet-based signaling server (they share no code or process); an
instrument-control process must not carry eventlet's monkey-patching.

## Current Status

This is a research demonstration, not a production QKD system.

### Working

- **Signaling server**: room creation, SDP/ICE relay, connection lifecycle management
- **WebRTC video**: peer-to-peer video and audio between browsers
- **BB84 key exchange**: full protocol over DataChannel — basis sifting, QBER estimation, block-parity error correction, and privacy amplification by a per-round seeded Toeplitz hash (leftover hashing): Alice draws the seed from the crypto RNG, transmits it, and both sides distill the same 128-bit key with the same matrix. Parity bits disclosed during error correction are subtracted from the key budget; a round that cannot cover the 128-bit target aborts rather than shrinking the key.
- **Eavesdropper detection**: intercept-resend attacks raise QBER above the 11% threshold, triggering automatic key rejection and re-exchange
- **BB84 keys drive the frame encryption**: on round completion the derived key is posted to the crypto worker (`setEncryptionKey` → `set-key`), and the AES-128-GCM Insertable Streams transforms (installed on every sender/receiver at connection setup) begin encrypting. The worker is **fail-closed**: until a key is installed it drops frames rather than passing them in the clear, and the in-call pill reports the worker's own state (amber establishing / green encrypted / red not-encrypted). Requires `RTCRtpScriptTransform` support in the browser.
- **Hardened signaling**: capability-token rooms, fail-closed admin auth (`QVC_ADMIN_SECRET`), per-IP rate limiting (`QVC_RATE_LIMIT`, default 30/min), anchored CORS origins, and redacted dashboards/logs. See `docs/THREAT_MODEL.md` for the full attack-surface table.
- **Authenticated classical channel**: per-direction HMAC keys derived (HKDF-SHA-256) from the invite link's capability token authenticate every BB84 classical message ({seq, payload, tag}; tamper/replay/inject → latched `auth-failure`), the DTLS fingerprints are cross-checked over the authenticated channel, and a short authentication string (4 emoji + 6 digits) is displayed under the video for on-camera verification. Two-tier guarantee: authenticated if your invite channel was; verified if you compared the SAS.

### Continuous key reservoir

- **Streaming key production**: keys are not minted one round at a time. A reservoir engine streams frames from a pluggable *frame source*, sifts and QBER-gates each frame independently, pools the accepted bits, and distills a key (pooled block-parity correction, a verification-hash correctness check, then Toeplitz amplification) whenever the pool covers a key plus its disclosure leakage — rotating keys into the crypto worker on a floored cadence. This is the shape deployed QKD stacks use (see `docs/HARDWARE.md`).

### Backends: simulated and (emulated) optical

- **Simulated (default)**: there are no real photons. `SimulatedQuantumChannel` models a Poisson photon source, fiber attenuation, and APD detectors to produce realistic error rates. The mode badge reads `SIMULATED`.
- **Optical bench (emulated)**: an optional per-peer Python daemon (`bench/`) drives an *emulated* BB84 bench — Poisson emission, per-photon loss, jitter, dead time, dark counts, an unknown clock offset + drift, and Qubit4Sync-style clock recovery — over an emulated fiber between the two daemons. Everything above the driver ABCs is the code a **real** bench would run; `docs/HARDWARE.md` is the swap contract. The badge reads `OPTICAL (emulated)` and never claims physical security.

## Tests

### Python (signaling server)

```bash
pip install pytest
python -m pytest tests/signaling/ -v
```

121 tests: signaling (room management, flow integration incl. connection loss/teardown, and security — admin auth + framework-identical 404, CORS anchoring + legacy-wildcard migration, rate limiting incl. X-Forwarded-For trust rules, log redaction) plus the bench daemon (physics/alignment/slot-recovery fidelity, fiber wire, pairing, WebSocket packing, the transport-free daemon path, and a deterministic two-bench integration run that accumulates a distillable pool). Run from the repo root (`pytest.ini` lives there).

### JavaScript (crypto, BB84, reservoir, bench)

```bash
npm install
npm test
```

142 tests (Vitest, from the repo root): AES-GCM frame crypto, the reservoir engine over the loopback and daemon backends (streaming, minting, rotation floor, pool cap, per-frame QBER gate, session restart, liveness), sparse sifting + pooled distillation with the correctness verification hash, DataChannel mux hardening, the WebRTC renegotiation guard, app rendering (cipher pill states, SAS strip gating, reservoir dashboard, optical settings, invite flow, room-token parsing), channel authentication (MAC/replay/tamper aborts, the pure fingerprint-bound SAS + commit-then-reveal, retry-then-latch integrity semantics, per-call lifecycle resets), backend negotiation, the daemon WebSocket client, and the signaling client.

### End-to-end (Playwright)

```bash
npx playwright install chromium
npm run test:e2e
```

2 specs drive two browser contexts through a real call over the signaling server: a **simulated** two-peer call (matching SAS, keys minting) and an **optical** call against two live bench daemons wired by the emulated fiber (optical-mode negotiation, minting, the eavesdropper latching the channel red, and recovery). `tests/e2e/launch.mjs` brings up the detector daemon, the source daemon, and the combined signaling+static server in order.

## Project Structure

```
signaling/
  server.py          # Flask + Socket.IO signaling server
  rooms.py           # Room management (create, join, leave)
  main.py            # Entry point

bench/               # Hardware-bench daemon (optical mode)
  drivers.py         # The swap surface: Pulse/TimeTagger/Polarization ABCs
  physics.py clock.py sync.py alignment.py slot_recovery.py  # emulation + recovery
  emulated_awg.py emulated_timetagger.py fiber_link.py eve.py
  daemon.py ws_protocol.py pairing.py config.py session.py
  bench.toml.example

website/client/
  index.html         # Frontend entry point
  static/
    app.js           # Main application (state, render, actions)
    js/
      webrtc.js      # RTCPeerConnection lifecycle + DataChannel
      crypto-worker.js  # Insertable Streams Web Worker (AES-128-GCM)
      bb84/
        orchestrator.js       # Call lifecycle: auth, SAS, negotiation, engine
        channel-auth.js       # HKDF/HMAC envelopes + fingerprint-bound SAS
        datachannel-adapter.js# Mux + classical channel
        simulated.js          # SimulatedQuantumChannel
      bench/
        reservoir.js          # Continuous key reservoir engine
        frame-source.js loopback-source.js daemon-source.js
        sift.js distill.js packing.js negotiation.js

tests/
  signaling/         # Python signaling tests
  bench/             # Python bench-daemon tests
  js/                # JavaScript tests (vitest), incl. js/bench/
  e2e/               # Playwright two-context specs + daemon launcher

docs/
  THREAT_MODEL.md    # Attack-surface table + honesty ledger
  HARDWARE.md        # The real-optics swap contract
```
