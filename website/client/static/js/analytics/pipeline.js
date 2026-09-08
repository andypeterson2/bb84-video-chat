/**
 * The end-to-end key-process pipeline — the demo hero. A physics-flavored
 * animation of BB84: polarized photons stream from the source, mismatched bases
 * are sifted away, the QBER gate rejects a tampered channel, surviving bits are
 * distilled into a key, keys pool and rotate into the cipher, and encrypted
 * frames flow out. It is HONEST about its backend: the source stage is labeled
 * SIMULATED or OPTICAL and never implies real photons when simulated.
 *
 * `pipelineModel(snapshot)` is the pure, testable projection of a telemetry
 * snapshot into per-stage state; `createPipeline` is the canvas animation that
 * reads a live model each frame. All numbers shown come from the model (real
 * call data) — the particles are illustrative motion, not fabricated metrics.
 */

/** Ordered stages of the pipeline, left → right. */
export const STAGES = [
  { key: 'source', label: 'Source' },
  { key: 'sift', label: 'Sift' },
  { key: 'qber', label: 'QBER gate' },
  { key: 'distill', label: 'Distill' },
  { key: 'pool', label: 'Key pool' },
  { key: 'rotate', label: 'Rotate' },
  { key: 'encrypt', label: 'Encrypt' },
];

const RECENT_MS = 1600; // an event "lights up" its stage for this long

/** Latest timestamp of an event of `kind` in the snapshot's event tail, or 0. */
function latestEvent(events, kind) {
  let t = 0;
  if (Array.isArray(events)) for (const e of events) if (e.kind === kind && e.t > t) t = e.t;
  return t;
}

function sourceLabel(mode) {
  return mode ? (mode === 'optical' ? 'OPTICAL' : 'SIMULATED') : 'Source';
}

/** Per-stage status strings from the gating conditions. Extracted to keep the
 * model builder flat. */
function stageStatuses(active, overThreshold, overWarning, cipherState) {
  const base = active ? 'ok' : 'idle';
  let encrypt;
  if (cipherState === 'encrypted') encrypt = 'ok';
  else if (cipherState === 'compromised' || cipherState === 'unencrypted') encrypt = 'reject';
  else encrypt = active ? 'establishing' : 'idle';
  let qber;
  if (!active) qber = 'idle';
  else if (overThreshold) qber = 'reject';
  else if (overWarning) qber = 'warn';
  else qber = 'ok';
  return { source: base, sift: base, qber, distill: base, pool: base, rotate: base, encrypt };
}

/**
 * Project a telemetry snapshot into the pipeline's per-stage state. Pure.
 * `now` is injectable for tests. `compromised` gates the whole flow: the QBER
 * gate closes when the error rate crosses the abort threshold, which is exactly
 * the eavesdropper-detection moment.
 */
export function pipelineModel(snapshot, now = Date.now()) {
  const s = snapshot || {};
  const active = !!s.inCall && !!s.bb84Active;
  const qber = typeof s.qber === 'number' ? s.qber : null;
  const threshold = s.qberThreshold ?? 0.11;
  const warning = s.qberWarning ?? 0.08;
  const overThreshold = qber != null && qber > threshold;
  const overWarning = qber != null && qber > warning;
  const compromised = s.cipherState === 'compromised' || overThreshold;
  const gateOpen = active && !compromised;

  const status = stageStatuses(active, overThreshold, overWarning, s.cipherState);
  const glowFor = {
    distill: latestEvent(s.events, 'minted'),
    rotate: latestEvent(s.events, 'rotated'),
    qber: latestEvent(s.events, 'qber-abort'),
  };
  const glowing = (t) => t > 0 && now - t < RECENT_MS;

  return {
    active,
    mode: s.mode || null,
    modeLabel: s.mode ? sourceLabel(s.mode) : '—',
    qber,
    gateOpen,
    compromised,
    eavesdropping: !!s.eavesdropping || !!s.peerEavesdropping,
    distillFraction: s.distillFraction || 0,
    keysMinted: s.keysMinted || 0,
    rotations: s.rotations || 0,
    poolDepth: s.poolDepth || 0,
    keyIndex: s.keyIndex ?? null,
    cipherState: s.cipherState || null,
    stages: STAGES.map((st) => ({
      key: st.key,
      label: st.key === 'source' ? sourceLabel(s.mode) : st.label,
      status: status[st.key],
      glow: st.key in glowFor && glowing(glowFor[st.key]),
    })),
  };
}

/* ── Canvas animation ────────────────────────────────────────────── */

function token(styles, name, fallback) {
  const v = styles.getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

function readColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    muted: token(s, '--text-muted', '#5c6675'),
    accent: token(s, '--accent', '#00629b'),
    gold: token(s, '--highlight', '#ffcd00'),
    ok: token(s, '--success', '#5e8233'),
    warn: token(s, '--warning', '#b96b06'),
    bad: token(s, '--error', '#c0362c'),
    surface: token(s, '--bg-surface', '#f7f4ec'),
    border: token(s, '--border-subtle', '#e5e0d4'),
  };
}

function statusColor(status, C) {
  if (status === 'reject') return C.bad;
  if (status === 'warn' || status === 'establishing') return C.warn;
  if (status === 'ok') return C.ok;
  return C.muted;
}

function roundRect(ctx, rect, r) {
  const { x, y, w, h } = rect;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const GLYPH = { source: '☀', sift: '⋔', distill: '⚗', pool: '▤', rotate: '↻', encrypt: '🔒' };

/** A tiny per-stage glyph inside the node. */
function drawGlyph(ctx, st, cx, cy, C) {
  ctx.save();
  ctx.fillStyle = st.status === 'reject' ? C.bad : st.status === 'ok' ? C.ok : C.muted;
  ctx.textAlign = 'center';
  ctx.font = '600 12px system-ui, sans-serif';
  const glyph = st.key === 'qber' ? (st.status === 'reject' ? '⨯' : '✓') : GLYPH[st.key];
  if (glyph) ctx.fillText(glyph, cx, cy + 4);
  ctx.restore();
}

function drawStages(env, model) {
  const { ctx, d, C } = env;
  model.stages.forEach((st, i) => {
    const cx = d.cellW * (i + 0.5);
    ctx.save();
    if (st.glow) {
      ctx.shadowColor = C.gold;
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = C.surface;
    ctx.strokeStyle = st.status === 'idle' ? C.border : statusColor(st.status, C);
    ctx.lineWidth = st.glow ? 2 : 1.25;
    roundRect(ctx, { x: cx - d.cellW * 0.34, y: d.trackY - 16, w: d.cellW * 0.68, h: 32 }, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.muted;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(st.label.toUpperCase(), cx, d.trackY - 26);
    drawGlyph(ctx, st, cx, d.trackY, C);
  });
}

function particleColor(p, d, C) {
  if (p.blocked) return C.bad;
  if (!p.kept) return C.muted;
  if (p.x > d.cellW * 3.5) return C.gold; // past distill: now key material
  return C.accent;
}

function drawParticle(env, p, py) {
  const { ctx, d, C } = env;
  const color = particleColor(p, d, C);
  ctx.globalAlpha = Math.max(0, p.alpha);
  ctx.fillStyle = color;
  if (p.kept && p.x > d.cellW * 6) {
    ctx.fillRect(p.x - 3, py - 3, 6, 6); // encrypted frame
  } else {
    ctx.beginPath();
    ctx.arc(p.x, py, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (p.basis === 'rect') {
      ctx.moveTo(p.x, py - 5);
      ctx.lineTo(p.x, py + 5);
    } else {
      ctx.moveTo(p.x - 4, py - 4);
      ctx.lineTo(p.x + 4, py + 4);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawGate(env, model) {
  const { ctx, d, C } = env;
  ctx.strokeStyle = model.gateOpen ? C.ok : C.bad;
  ctx.lineWidth = model.gateOpen ? 1.5 : 3;
  ctx.setLineDash(model.gateOpen ? [3, 4] : []);
  ctx.beginPath();
  ctx.moveTo(d.gateX, d.trackY - 15);
  ctx.lineTo(d.gateX, d.trackY + 15);
  ctx.stroke();
  ctx.setLineDash([]);
}

function dimsFor(canvas) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth || 720;
  const h = canvas.clientHeight || 150;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const cellW = w / STAGES.length;
  return { dpr, w, h, cellW, trackY: h * 0.52, gateX: cellW * 2.5 };
}

/**
 * Start the pipeline animation. `canvasGetter()` returns the current canvas (or
 * null when the hero isn't mounted — e.g. before a call); `modelGetter()`
 * returns the latest {@link pipelineModel}. One persistent rAF loop drives it;
 * returns `{ stop }`. Where requestAnimationFrame is absent (test import) it
 * draws a single frame and never loops.
 */
export function createPipeline(canvasGetter, modelGetter) {
  const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : null;
  const particles = [];
  let last = 0;
  let spawnAcc = 0;
  let running = true;

  const spawn = (kept) =>
    particles.push({
      x: 0,
      y: (Math.random() - 0.5) * 0.5,
      basis: Math.random() < 0.5 ? 'rect' : 'diag',
      kept,
      blocked: false,
      alpha: 1,
    });

  function advanceParticle(env, p, model) {
    const { d, dt, ts } = env;
    if (!p.blocked) p.x += 0.16 * dt * (d.w / 720);
    const py = d.trackY + p.y * 22 + Math.sin((p.x + ts * 0.02) * 0.04) * 3;
    if (!p.kept && p.x > d.cellW * 1.5) p.alpha -= 0.05; // mismatched bases fade away
    const barrier = d.gateX - d.cellW * 0.3;
    if (p.kept && !model.gateOpen && p.x >= barrier) {
      p.x = barrier; // tamper: gate closed, photon halts
      p.blocked = true;
    }
    if (p.alpha > 0) drawParticle(env, p, py);
  }

  function reap(d) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.alpha <= 0 || p.x > d.w + 8 || (p.blocked && Math.random() < 0.02)) {
        particles.splice(i, 1);
      }
    }
  }

  function stepParticles(env, model) {
    spawnAcc += env.dt;
    while (spawnAcc >= 90) {
      spawnAcc -= 90;
      spawn(Math.random() < 0.55); // ~half survive basis reconciliation
    }
    for (const p of particles) advanceParticle(env, p, model);
    reap(env.d);
  }

  function draw(canvas, model, ts) {
    const d = dimsFor(canvas);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
    ctx.clearRect(0, 0, d.w, d.h);
    const C = readColors();
    const dt = last ? Math.min(64, ts - last) : 16;
    last = ts;
    const env = { ctx, d, C, dt, ts };

    drawStages(env, model);
    if (!model.active) {
      particles.length = 0;
      ctx.fillStyle = C.muted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for the quantum channel…', d.w / 2, d.h - 10);
      return;
    }
    stepParticles(env, model);
    drawGate(env, model);
  }

  function frame(ts) {
    if (!running) return;
    const canvas = canvasGetter && canvasGetter();
    const model = (modelGetter && modelGetter()) || { active: false, stages: [] };
    if (canvas) draw(canvas, model, ts);
    if (raf) raf(frame);
  }

  if (raf) raf(frame);
  else if (canvasGetter && canvasGetter()) {
    draw(canvasGetter(), modelGetter ? modelGetter() : { active: false, stages: [] }, 0);
  }

  return {
    stop() {
      running = false;
    },
  };
}
