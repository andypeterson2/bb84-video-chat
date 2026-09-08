/**
 * Analytics screen — the second-window demo dashboard. Subscribes to the
 * same-origin telemetry bus the call window publishes on, accumulates its own
 * time-series (the call window ships live scalars; sparkline history is built
 * here), and renders real readings only — an honest empty state before a call,
 * never fabricated numbers.
 *
 * Structured for testability: the buffers, formatters, and `renderPanels` are
 * pure and exported; `createAnalytics` wires them to a BroadcastChannel and the
 * DOM; the auto-mount at the bottom runs only on the real page (a root element
 * present), so importing the module under test has no side effects.
 */

import { TELEMETRY_CHANNEL, EVENT_KINDS } from './telemetry.js';

/* ── Formatters ──────────────────────────────────────────────────── */

export const fmt = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
export const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '—');
export const mmss = (s) => {
  const n = s || 0;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};
export const modeLabel = (mode) => (mode === 'optical' ? 'OPTICAL' : mode ? 'SIMULATED' : '—');

/** A short, readable QBER verdict from the thresholds the call window ships. */
export function qberVerdict(qber, threshold, warning) {
  if (typeof qber !== 'number') return { label: 'Measuring…', tone: 'muted' };
  if (threshold != null && qber > threshold) return { label: 'Very noisy', tone: 'error' };
  if (warning != null && qber > warning) return { label: 'Noisy', tone: 'warning' };
  return { label: 'Clean', tone: 'success' };
}

/** Truncate a DTLS fingerprint to its first and last group for display. */
export function shortFp(fp) {
  if (!fp || typeof fp !== 'string') return '—';
  const groups = fp.split(':');
  return groups.length <= 4 ? fp : `${groups.slice(0, 2).join(':')}…${groups.slice(-2).join(':')}`;
}

const EVENT_LABEL = {
  [EVENT_KINDS.callStart]: 'Call started',
  [EVENT_KINDS.callEnd]: 'Call ended',
  [EVENT_KINDS.minted]: 'Key minted',
  [EVENT_KINDS.rotated]: 'Key rotated',
  [EVENT_KINDS.sasVerified]: 'Identity verified',
  [EVENT_KINDS.eve]: 'Eavesdropper toggled',
  [EVENT_KINDS.peerEve]: 'Peer eavesdropper',
  [EVENT_KINDS.reconnect]: 'Reconnecting',
  [EVENT_KINDS.recovered]: 'Recovered',
  [EVENT_KINDS.qberAbort]: 'QBER abort',
  [EVENT_KINDS.compromised]: 'Integrity lost',
  [EVENT_KINDS.mode]: 'Backend negotiated',
};
export const eventLabel = (kind) => EVENT_LABEL[kind] || kind;

/* ── Time-series buffers (built window-side from live scalars) ───── */

/**
 * Bounded ring buffers for the media sparklines. The call window ships current
 * scalars; the analytics window is what retains them over time, so opening the
 * screen mid-call simply starts the series from that point.
 */
export class SeriesBuffers {
  constructor(cap = 120) {
    this._cap = Math.max(1, cap | 0);
    this.bandwidth = [];
    this.rtt = [];
    this.enc = [];
    this.dec = [];
  }
  _push(name, v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return;
    const arr = this[name];
    arr.push(v);
    if (arr.length > this._cap) arr.shift();
  }
  /** Append one snapshot's media scalars (skips absent ones). */
  push(snap) {
    if (snap.quality) {
      this._push('bandwidth', snap.quality.bandwidthKbps);
      this._push('rtt', snap.quality.rttMs);
    }
    if (snap.crypto) {
      this._push('enc', snap.crypto.encryptLatencyUs);
      this._push('dec', snap.crypto.decryptLatencyUs);
    }
  }
  clear() {
    this.bandwidth = [];
    this.rtt = [];
    this.enc = [];
    this.dec = [];
  }
}

/* ── Canvas drawing (theme-token colored, DPR-aware) ─────────────── */

function colorFor(styles, name, fallback) {
  const v = styles.getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

function prepCanvas(canvas) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 48;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

/** Per-frame QBER strip chart with the abort threshold drawn in (ported from
 * the in-call chart so both read identically). */
export function drawQberChart(canvas, history, threshold, warning) {
  if (!canvas) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const bad = colorFor(styles, '--error', '#c0362c');
  const ok = colorFor(styles, '--success', '#5e8233');
  const warn = colorFor(styles, '--warning', '#b96b06');
  const scale = Math.max(threshold ? threshold * 1.4 : 0.3, ...history, 0.05);
  const x = (i) => (history.length <= 1 ? w : (i / (history.length - 1)) * w);
  const y = (v) => h - (v / scale) * h;

  if (threshold != null) {
    ctx.strokeStyle = bad;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(threshold));
    ctx.lineTo(w, y(threshold));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (history.length > 1) {
    ctx.strokeStyle = ok;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  }
  history.forEach((v, i) => {
    ctx.fillStyle =
      threshold != null && v > threshold ? bad : warning != null && v > warning ? warn : ok;
    ctx.beginPath();
    ctx.arc(x(i), y(v), 1.6, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** A minimal sparkline of a numeric series, normalized to its own min/max. */
export function drawSparkline(canvas, series, colorToken = '--accent') {
  if (!canvas) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) return;
  const styles = getComputedStyle(document.documentElement);
  const stroke = colorFor(styles, colorToken, '#00629b');
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const x = (i) => (i / (series.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
}

/* ── Panel rendering ─────────────────────────────────────────────── */

const tile = (k, v, cls = '') =>
  `<div class="an-tile ${cls}"><div class="an-k">${k}</div><div class="an-v">${v}</div></div>`;

function reservoirPanel(s) {
  const distillPct = Math.round((s.distillFraction || 0) * 100);
  const budget = s.mintBudget
    ? `${(s.reservoirBits || 0).toLocaleString()} / ${s.mintBudget.toLocaleString()} bits`
    : `${(s.reservoirBits || 0).toLocaleString()} bits`;
  return `
    <section class="an-panel">
      <h2>Key reservoir <span class="an-badge">${modeLabel(s.mode)}</span></h2>
      <div class="an-tiles">
        ${tile('Keys minted', fmt(s.keysMinted))}
        ${tile('Rotations', fmt(s.rotations))}
        ${tile('Pool', fmt(s.poolDepth))}
        ${tile('Key index', s.keyIndex === null || s.keyIndex === undefined ? '—' : `#${s.keyIndex}`)}
      </div>
      <div class="an-distill">
        <div class="an-bar"><span style="width:${distillPct}%"></span></div>
        <div class="an-sub">Distilling next key — ${budget}</div>
      </div>
    </section>`;
}

function qberPanel(s) {
  const v = qberVerdict(s.qber, s.qberThreshold, s.qberWarning);
  return `
    <section class="an-panel">
      <h2>Channel quality (QBER)</h2>
      <div class="an-qber">
        <div class="an-qber-now an-tone-${v.tone}">${pct(s.qber)}</div>
        <div class="an-qber-verdict an-tone-${v.tone}">${v.label}</div>
      </div>
      <canvas class="an-chart" data-chart="qber"></canvas>
      <div class="an-sub">Abort threshold ${s.qberThreshold != null ? (s.qberThreshold * 100).toFixed(0) + '%' : '—'} · intercept-resend lands near 25%</div>
    </section>`;
}

function securityPanel(s) {
  const emoji = s.sas && Array.isArray(s.sas.emoji) ? s.sas.emoji.join(' ') : '—';
  const digits = s.sas && s.sas.digits ? s.sas.digits : '—';
  const verified = s.sasVerified
    ? `<span class="an-badge an-tone-success">✓ Verified</span>`
    : `<span class="an-badge">Unverified</span>`;
  return `
    <section class="an-panel">
      <h2>Security &amp; authentication</h2>
      <div class="an-tiles">
        ${tile('Cipher', fmt(s.cipherState))}
        ${tile('Backend', modeLabel(s.mode))}
      </div>
      <div class="an-sas">
        <div class="an-sas-emoji">${emoji}</div>
        <div class="an-sas-digits">${digits}</div>
        ${verified}
      </div>
      <div class="an-fp">
        <div><span class="an-k">DTLS (you)</span> <code>${shortFp(s.fingerprints && s.fingerprints.local)}</code></div>
        <div><span class="an-k">DTLS (peer)</span> <code>${shortFp(s.fingerprints && s.fingerprints.remote)}</code></div>
      </div>
    </section>`;
}

function mediaPanel(s) {
  const q = s.quality || {};
  const c = s.crypto || {};
  const spark = (label, cur, chart, token) => `
    <div class="an-spark">
      <div class="an-spark-head"><span class="an-k">${label}</span><span class="an-v-sm">${cur}</span></div>
      <canvas class="an-sparkline" data-chart="${chart}" data-token="${token}"></canvas>
    </div>`;
  return `
    <section class="an-panel">
      <h2>Media &amp; network</h2>
      <div class="an-tiles">
        ${tile('Tier', fmt(q.tier))}
        ${tile('Out', fmt(q.actualRes))}
        ${tile('In', fmt(q.inRes))}
        ${tile('Limited by', fmt(q.limitedBy && q.limitedBy !== 'none' ? q.limitedBy : 'nothing'))}
      </div>
      ${spark('Bandwidth', q.bandwidthKbps != null ? q.bandwidthKbps.toLocaleString() + ' kbps' : '—', 'bandwidth', '--accent')}
      ${spark('Round-trip', q.rttMs != null ? q.rttMs + ' ms' : '—', 'rtt', '--accent-teal')}
      ${spark('Encrypt', c.encryptLatencyUs != null ? Math.round(c.encryptLatencyUs) + ' µs' : '—', 'enc', '--accent-olive')}
      ${spark('Decrypt', c.decryptLatencyUs != null ? Math.round(c.decryptLatencyUs) + ' µs' : '—', 'dec', '--accent-brown')}
    </section>`;
}

function timelinePanel(s, nowT) {
  const events = Array.isArray(s.events) ? s.events.slice().reverse() : [];
  const rel = (t) => {
    const secs = Math.max(0, Math.round((nowT - t) / 1000));
    return secs < 1 ? 'now' : secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  };
  const rows = events.length
    ? events
        .map(
          (e) =>
            `<li><span class="an-ev-t">${rel(e.t)}</span><span class="an-ev-k">${eventLabel(e.kind)}</span></li>`,
        )
        .join('')
    : '<li class="an-ev-empty">No events yet</li>';
  return `
    <section class="an-panel an-panel-wide">
      <h2>Event timeline</h2>
      <ul class="an-timeline">${rows}</ul>
    </section>`;
}

function summaryCard(s) {
  const peak =
    Array.isArray(s.qberHistory) && s.qberHistory.length ? Math.max(...s.qberHistory) : null;
  return `
    <section class="an-summary">
      <h2>Call summary</h2>
      <div class="an-tiles">
        ${tile('Duration', mmss(s.elapsed))}
        ${tile('Keys minted', fmt(s.keysMinted))}
        ${tile('Rotations', fmt(s.rotations))}
        ${tile('Peak QBER', peak != null ? pct(peak) : '—')}
        ${tile('Backend', modeLabel(s.mode))}
        ${tile('Verified', s.sasVerified ? 'Yes' : 'No')}
      </div>
    </section>`;
}

/**
 * Render the whole page into `root` from a snapshot + accumulated series, then
 * draw the canvases. Idempotent: safe to call on every snapshot.
 */
export function renderPanels(root, snap, buffers, nowT = Date.now()) {
  const s = snap || { inCall: false };
  const eve = s.eavesdropping || s.peerEavesdropping;
  const header = `
    <header class="an-header">
      <h1>QKD Analytics</h1>
      <div class="an-status">${
        s.inCall
          ? `${modeLabel(s.mode)} · ${mmss(s.elapsed)} · cipher: ${fmt(s.cipherState)}${eve ? ' · <span class="an-flag">eavesdropper active</span>' : ''}`
          : s.summary
            ? 'Call ended'
            : 'Waiting for a call…'
      }</div>
      <div class="an-controls" ${s.inCall ? '' : 'hidden'}>
        <button data-cmd="toggle-eve" ${s.isInitiator ? '' : 'disabled'} title="Eavesdropper demo (initiator only)">Eavesdropper</button>
        <button data-cmd="force-rotate" title="Rotate the key now">Force rotate</button>
        <button data-cmd="reset" title="Restart the session">Reset</button>
        <button data-action="density" title="Toggle compact / presentation density">Density</button>
      </div>
    </header>`;

  if (!s.inCall && !s.summary) {
    root.innerHTML = `${header}<div class="an-empty">No live call. Open a call in the main window — this screen fills in automatically once a session starts.</div>`;
    return;
  }
  if (s.summary) {
    root.innerHTML = `${header}${summaryCard(s)}${timelinePanel(s, nowT)}`;
    return;
  }

  root.innerHTML = `
    ${header}
    <div class="an-grid">
      ${reservoirPanel(s)}
      ${qberPanel(s)}
      ${securityPanel(s)}
      ${mediaPanel(s)}
      ${timelinePanel(s, nowT)}
    </div>`;

  // Draw canvases now that they exist in the DOM.
  drawQberChart(
    root.querySelector('[data-chart="qber"]'),
    s.qberHistory || [],
    s.qberThreshold,
    s.qberWarning,
  );
  for (const cv of root.querySelectorAll('.an-sparkline')) {
    drawSparkline(cv, buffers[cv.dataset.chart], cv.dataset.token);
  }
}

/* ── Bus + DOM wiring ────────────────────────────────────────────── */

const DENSITY_KEY = 'qvc.analytics.density';

/**
 * Wire a live analytics screen: subscribe to `channel`, keep sparkline buffers,
 * render on each snapshot, and post allowlisted demo commands on control clicks.
 * Returns a `destroy()` for teardown/tests.
 */
export function createAnalytics({ root, channel, storage }) {
  const buffers = new SeriesBuffers(120);
  let wasInCall = false;
  let density = 'compact';
  try {
    density = storage?.getItem(DENSITY_KEY) || 'compact';
  } catch {
    /* storage blocked — default density */
  }
  root.dataset.density = density;

  let last = { inCall: false };
  const draw = () => renderPanels(root, last, buffers);

  channel.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'telemetry') return;
    // A fresh call (transition into inCall) starts the sparkline history clean.
    if (msg.inCall && !wasInCall) buffers.clear();
    wasInCall = msg.inCall;
    if (msg.inCall) buffers.push(msg);
    last = msg;
    draw();
  };

  const onClick = (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd && !cmd.disabled) {
      channel.postMessage({ type: 'command', cmd: cmd.dataset.cmd });
      return;
    }
    const action = e.target.closest('[data-action="density"]');
    if (action) {
      density = density === 'presentation' ? 'compact' : 'presentation';
      root.dataset.density = density;
      try {
        storage?.setItem(DENSITY_KEY, density);
      } catch {
        /* storage blocked — density is session-only */
      }
    }
  };
  root.addEventListener('click', onClick);

  draw(); // initial empty state
  return {
    destroy() {
      root.removeEventListener('click', onClick);
      channel.onmessage = null;
    },
  };
}

/* ── Auto-mount (real page only; no-op under test import) ─────────── */

if (typeof document !== 'undefined') {
  const root = document.getElementById('analytics-root');
  if (root && typeof BroadcastChannel !== 'undefined') {
    try {
      root.dataset.theme = localStorage.getItem('qvc-theme') || 'light';
      document.documentElement.dataset.theme = root.dataset.theme;
    } catch {
      document.documentElement.dataset.theme = 'light';
    }
    createAnalytics({
      root,
      channel: new BroadcastChannel(TELEMETRY_CHANNEL),
      storage: window.localStorage,
    });
  }
}
