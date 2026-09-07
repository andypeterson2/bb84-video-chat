/**
 * tuneOpus — merges high-quality Opus fmtp params into a local SDP without
 * disturbing the rest of it. Pure string transform, so it is tested directly.
 * The defaults lift Opus off its ~32 kbps mono baseline to stereo 128 kbps with
 * in-band FEC and DTX.
 */
import { tuneOpus, OPUS_PARAMS } from '../../website/client/static/js/webrtc.js';

const CRLF = '\r\n';

/** A minimal audio m-section with an Opus rtpmap + a browser-typical fmtp. */
function sdpWith(fmtpLine, { pt = '111', eol = CRLF } = {}) {
  return [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF ' + pt,
    `a=rtpmap:${pt} opus/48000/2`,
    ...(fmtpLine ? [fmtpLine] : []),
    'a=rtcp-fb:' + pt + ' transport-cc',
  ].join(eol);
}

test('merges the quality params into an existing Opus fmtp, preserving its others', () => {
  const sdp = sdpWith('a=fmtp:111 minptime=10;useinbandfec=1');
  const out = tuneOpus(sdp);
  const fmtp = out.split(CRLF).find((l) => l.startsWith('a=fmtp:111 '));
  const params = Object.fromEntries(
    fmtp
      .slice('a=fmtp:111 '.length)
      .split(';')
      .map((kv) => kv.split('=')),
  );
  // Pre-existing param survives...
  expect(params.minptime).toBe('10');
  // ...and every quality param is present.
  expect(params.maxaveragebitrate).toBe('64000');
  expect(params.useinbandfec).toBe('1');
  expect(params.usedtx).toBe('1');
  // Stereo is deliberately NOT forced — a talking-head call is mono.
  expect(params.stereo).toBeUndefined();
});

test('mints an fmtp line when the Opus rtpmap has none', () => {
  const sdp = sdpWith(null);
  const out = tuneOpus(sdp);
  const lines = out.split(CRLF);
  const rtpmapIdx = lines.findIndex((l) => l === 'a=rtpmap:111 opus/48000/2');
  // The minted fmtp lands immediately after the rtpmap it belongs to.
  expect(lines[rtpmapIdx + 1]).toContain('a=fmtp:111 ');
  expect(lines[rtpmapIdx + 1]).toContain('maxaveragebitrate=64000');
});

test('does not duplicate: exactly one fmtp line for the Opus PT', () => {
  const sdp = sdpWith('a=fmtp:111 minptime=10');
  const out = tuneOpus(sdp);
  const count = out.split(CRLF).filter((l) => l.startsWith('a=fmtp:111 ')).length;
  expect(count).toBe(1);
});

test('only touches the Opus payload type, not other codecs', () => {
  const sdp = [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 8',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10',
    'a=rtpmap:8 PCMA/8000',
  ].join(CRLF);
  const out = tuneOpus(sdp);
  // No fmtp injected for PCMA (pt 8).
  expect(out.split(CRLF).some((l) => l.startsWith('a=fmtp:8 '))).toBe(false);
});

test('is a no-op on an SDP with no Opus (e.g. video-only)', () => {
  const sdp = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000'].join(CRLF);
  expect(tuneOpus(sdp)).toBe(sdp);
});

test('preserves the line ending style (LF-only in, LF-only out)', () => {
  const sdp = sdpWith('a=fmtp:111 minptime=10', { eol: '\n' });
  const out = tuneOpus(sdp);
  expect(out.includes('\r\n')).toBe(false);
  expect(out).toContain('a=fmtp:111 ');
});

test('empty / falsy SDP is returned unchanged', () => {
  expect(tuneOpus('')).toBe('');
  expect(tuneOpus(undefined)).toBe(undefined);
});

test('OPUS_PARAMS documents the intent (64k mono, fec, dtx — no stereo)', () => {
  expect(OPUS_PARAMS).toMatchObject({
    maxaveragebitrate: 64000,
    useinbandfec: 1,
    usedtx: 1,
  });
  expect(OPUS_PARAMS.stereo).toBeUndefined();
});
