/** Shared helpers for driving the QKD app in e2e specs. */
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a daemon's pairing token written by launch.mjs. */
export function readToken(which) {
  return readFileSync(join(here, '.artifacts', `${which}.token`), 'utf-8').trim();
}

/** Inject the fast-timing globals every page needs before app.js loads. */
export async function fastTimers(page) {
  await page.addInitScript(() => {
    globalThis.QVC_FRAME_PERIOD_MS = 8;
    globalThis.QVC_ROTATION_FLOOR_MS = 1500;
  });
}

/** Pre-arm optical mode (persisted settings) before the app loads. */
export async function armOptical(context, { url, token }) {
  await context.addInitScript(
    ([u, t]) => {
      try {
        localStorage.setItem('qvc.optical', JSON.stringify({ enabled: true, url: u, token: t }));
      } catch {
        /* storage unavailable */
      }
    },
    [url, token],
  );
}

/** Create a room and return its invite token. */
export async function createRoom(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Session' }).click();
  const link = page.locator('#invite-link');
  await expect(link).toBeVisible({ timeout: 20_000 });
  const invite = await link.inputValue();
  const m = invite.match(/#room=(.+)$/);
  if (!m) throw new Error(`no room token in invite link: ${invite}`);
  return decodeURIComponent(m[1]);
}

/** Join an existing room by token. */
export async function joinRoom(page, token) {
  await page.goto('/');
  await page.fill('#room-input', token);
  await page.locator('.join-form button[type="submit"]').click();
}

/** Wait until a page's cipher pill reports encrypted (a key rotated in). */
export async function expectEncrypted(page) {
  await expect(page.locator('.cipher-pill')).toContainText('Encrypted', { timeout: 45_000 });
}

/** Read the SAS digits currently shown (or null). */
export async function sasDigits(page) {
  const el = page.locator('#sas-digits');
  return (await el.count()) ? (await el.textContent())?.trim() : null;
}
