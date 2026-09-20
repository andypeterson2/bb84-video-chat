# Quantum Video Chat

Peer-to-peer video chat where the frame-encryption key comes from a BB84 exchange run over the WebRTC data channel. Video and audio flow directly between browsers; the signaling server only relays SDP and ICE. This is a research demonstration, not a production QKD system — there are no real photons in the default mode, and the optical mode emulates the instruments rather than driving them.

The quantum channel models Poissonian photon statistics, fiber attenuation, single-photon APD detectors and intercept-resend eavesdropping. When the quantum bit error rate passes the 11% security threshold the key is rejected and re-exchanged.

```
Browser A ◄══ WebRTC (P2P encrypted media) ══► Browser B
    │                                              │
    └──── Socket.IO signaling ────► Server ◄───────┘
                                  (SDP + ICE relay only)
```

The signaling server is Flask and never sees media. BB84 messages travel on a DataChannel. Frames are encrypted with AES-128-GCM in a Web Worker through Insertable Streams (`RTCRtpScriptTransform`).

## Protocol

Sifting compares bases, QBER is estimated on a disclosed sample, Cascade (Brassard & Salvail, six passes) corrects the rest, a verification hash checks that both sides agree, and a seeded Toeplitz hash does privacy amplification. Alice draws the seed from the crypto RNG and sends it, so both sides distill the same 128-bit key.

Keys are not minted one round at a time. A reservoir engine streams frames from a pluggable frame source, sifts and QBER-gates each frame on its own, pools the accepted bits, and distills a key whenever the pool covers a key plus its disclosure leakage. Parity bits leaked by Cascade and the verification hash come out of the key budget; a mint that cannot cover 128 bits aborts rather than shrinking the key.

Until a key is installed the crypto worker drops frames rather than passing them in the clear, and the in-call pill shows the worker's own state: amber establishing, green encrypted, red not encrypted.

The classical channel is authenticated with per-direction HMAC keys derived (HKDF-SHA-256) from the invite link's capability token; tampering, replay or injection latches an `auth-failure`. DTLS fingerprints are cross-checked over that channel, and a short authentication string (4 emoji and 6 digits) sits under the video for on-camera comparison. The channel is authenticated if your invite channel was, and verified once you compare the SAS.

The signaling server has capability-token rooms, fail-closed admin auth (`QVC_ADMIN_SECRET`), per-IP rate limiting (`QVC_RATE_LIMIT`, default 30/min), anchored CORS origins and redacted dashboards and logs.

## Backends

`SimulatedQuantumChannel` is the default and the badge reads `SIMULATED`.

Optical mode runs an optional Python daemon per peer (`bench/`) driving an emulated BB84 bench: Poisson emission, per-photon loss, jitter, dead time, dark counts, an unknown clock offset with drift, and Qubit4Sync-style clock recovery, over an emulated fiber between the two daemons. Nothing above the driver classes in `bench/drivers.py` knows the photons are simulated, so those classes are where real optics would be swapped in. The badge reads `OPTICAL (emulated)` and never claims physical security.

## Running it

Needs Python 3.9+, and Node 20+ for the JavaScript tests.

```bash
pip install flask flask-cors python-socketio eventlet
python signaling/main.py
```

The server picks a port unless `QVC_SERVER_REST_PORT` is set. `docker-compose.yml` here builds that one service and nothing else; it reads `QVC_SERVER_PORT` from a `.env` beside it, which has no default, so set it before `docker compose up -d`. The Astro frontend and its `DEV=1` profile live in the website repository's own compose file, not this one.

Then open the page serving `website/client/index.html` — under Docker, the Astro dev server at `localhost:4322/projects/quantum-video-chat/client/`. Open two tabs, start a session in one, and paste the invite link into the other. The room id is an unguessable capability token, so the link is the credential. Video flows once the peer connection establishes, and the cipher pill turns green when the worker confirms it is encrypting.

## Running the optical bench

One daemon per bench. Start the detector first, since it listens on the fiber, then the source, which dials it:

```bash
pip install -r bench/requirements.txt          # asyncio + websockets
python -m bench --config bench-detector.toml   # role = "detector"
python -m bench --config bench-source.toml     # role = "source"
```

Each daemon prints a one-time pairing token. In the lobby, tick **Use optical bench** and paste the daemon's `ws://` URL and token — the room creator uses the source daemon, the joiner the detector. Optical mode engages only when both peers present complementary benches; otherwise the call falls back to the simulator. `bench/bench.toml.example` lists every setting, with APD and SNSPD presets.

The daemon is asyncio and `websockets`, in its own process. Eventlet's monkey-patching must not reach instrument control, so it shares no code or process with the signaling server.

## Tests

```bash
pip install pytest
python -m pytest tests/signaling/ -v      # signaling server and bench daemon
npm install && npm test                   # vitest: crypto, BB84, reservoir, bench, UI
npx playwright install chromium
npm run test:e2e                          # two browser contexts through a real call
```

Run the Python tests from the repo root, where `pytest.ini` lives. Playwright drives a simulated two-peer call and an optical call against two live bench daemons wired by the emulated fiber, including an eavesdropper latching the channel red and the recovery after it; `tests/e2e/launch.mjs` starts the daemons and the combined signaling and static server in order.
