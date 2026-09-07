# coturn — TURN relay for qvc

Peers behind symmetric NAT can't establish a direct path from STUN alone; this
relays their (already end-to-end-encrypted) media. The relay only ever forwards
DTLS-SRTP ciphertext — it cannot read the media, and the browser's per-frame
E2EE sits above that.

## Credentials — ephemeral, never long-lived on the client

coturn runs with `use-auth-secret` (the TURN REST API). The **signaling server**
mints short-lived credentials with the *same* secret (`signaling/turn.py`,
`GET /ice-servers`); coturn recomputes the HMAC to validate them. No long-lived
secret ever reaches the browser.

## Deploy (Railway or any Docker host)

1. Deploy this directory as its own service (build the `Dockerfile`).
2. Set on the **coturn** service:
   - `TURN_SECRET` — a long random string (e.g. `openssl rand -hex 32`).
   - `TURN_REALM` — e.g. `qvc.turn` (optional; defaults to `qvc.turn`).
   - `TURN_EXTERNAL_IP` — the relay's public IP (required behind NAT so coturn
     advertises the right address).
3. Expose UDP/TCP **3478**, TLS **5349**, and the relay range **49160-49200**.
4. Set on the **signaling** service (so `/ice-servers` mints TURN entries):
   - `QVC_TURN_SECRET` — the **same** value as `TURN_SECRET`.
   - `QVC_TURN_URLS` — comma-separated, e.g.
     `turn:relay.example.com:3478?transport=udp,turns:relay.example.com:5349?transport=tcp`.
   - `QVC_TURN_TTL` — credential lifetime in seconds (optional; default 3600).

With `QVC_TURN_SECRET`/`QVC_TURN_URLS` unset, `/ice-servers` returns STUN-only —
the app still runs, relay-requiring calls just won't connect (prior behaviour).

## Verify

```
curl -s https://<signaling-host>/ice-servers | jq
```

Expect a `turn:`/`turns:` entry whose `username` is `<future-unix-ts>:<nonce>`.
In the browser, `chrome://webrtc-internals` shows a `relay` candidate once TURN
is reachable.
