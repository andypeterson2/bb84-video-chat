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

## Current Status

This is a research demonstration, not a production QKD system.

### Working

- **Signaling server**: room creation, SDP/ICE relay, connection lifecycle management
- **WebRTC video**: peer-to-peer video and audio between browsers
- **BB84 key exchange**: full protocol over DataChannel — basis sifting, QBER estimation, block-parity error correction, and privacy amplification by a per-round seeded Toeplitz hash (leftover hashing): Alice draws the seed from the crypto RNG, transmits it, and both sides distill the same 128-bit key with the same matrix. Parity bits disclosed during error correction are subtracted from the key budget; a round that cannot cover the 128-bit target aborts rather than shrinking the key.
- **Eavesdropper detection**: intercept-resend attacks raise QBER above the 11% threshold, triggering automatic key rejection and re-exchange
- **BB84 keys drive the frame encryption**: on round completion the derived key is posted to the crypto worker (`setEncryptionKey` → `set-key`), and the AES-128-GCM Insertable Streams transforms (installed on every sender/receiver at connection setup) begin encrypting. The worker is **fail-closed**: until a key is installed it drops frames rather than passing them in the clear, and the in-call pill reports the worker's own state (amber establishing / green encrypted / red not-encrypted). Requires `RTCRtpScriptTransform` support in the browser.
- **Hardened signaling**: capability-token rooms, fail-closed admin auth (`QVC_ADMIN_SECRET`), per-IP rate limiting (`QVC_RATE_LIMIT`, default 30/min), anchored CORS origins, and redacted dashboards/logs. See `docs/THREAT_MODEL.md` for the full attack-surface table.

### Simulated

- **Quantum channel**: there are no real photons. The `SimulatedQuantumChannel` models a Poisson photon source, fiber attenuation, and avalanche photodiode (APD) detectors to produce realistic error rates and key generation statistics. This is a computational model of the quantum optical layer, suitable for demonstrating and testing the classical post-processing stages of BB84.

## Tests

### Python (signaling server)

```bash
pip install pytest
python -m pytest tests/signaling/ -v
```

88 tests: room management unit tests, signaling flow integration tests (including connection loss and clean teardown scenarios), and security tests (admin auth and its framework-identical 404, CORS anchoring + legacy-wildcard migration, rate limiting incl. X-Forwarded-For trust rules, and log redaction). Run from the repo root (`pytest.ini` lives there).

### JavaScript (crypto, BB84, metrics)

```bash
npm install
npm test
```

90 tests (Vitest, from the repo root): AES-GCM frame crypto, the BB84 protocol and orchestrator over ideal, simulated, and DataChannel transports (including Toeplitz seed agreement, seed-dependence, key-budget aborts, typed-message enforcement, adversarial-peer aborts, round deadlines/teardown liveness, and stale-queue recovery), DataChannel mux hardening, the WebRTC renegotiation guard, app rendering (cipher pill states, invite flow, room-token parsing), metrics collector, and signaling client.

## Project Structure

```
signaling/
  server.py          # Flask + Socket.IO signaling server
  rooms.py           # Room management (create, join, leave)
  main.py            # Entry point

website/client/
  index.html         # Frontend entry point
  static/
    app.js           # Main application (state, render, actions)
    style.css        # Styles
    js/
      webrtc.js      # RTCPeerConnection lifecycle + DataChannel
      crypto.js      # AES-128-GCM frame encrypt/decrypt
      crypto-worker.js  # Insertable Streams Web Worker
      metrics.js     # MetricsCollector (rolling windows, thresholds)
      bb84/
        protocol.js  # BB84: sifting, QBER, error correction, privacy amp
        channel.js   # QuantumChannel + ClassicalChannel interfaces
        simulated.js # SimulatedQuantumChannel (photon source, fiber, APD)
        metrics.js   # BB84Metrics data class

shared/              # Legacy shared code (BB84 reference, encryption)
tests/
  signaling/         # Python signaling tests
  js/                # JavaScript tests (vitest)
    bb84/            # BB84 protocol + simulation tests
```
