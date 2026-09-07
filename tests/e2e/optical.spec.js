/**
 * Optical-mode e2e: two browser contexts, each paired with its own bench
 * daemon (source + detector) wired by the emulated fiber, complete a real
 * call and mint a shared key over the optical backend. Then the eavesdropper
 * latches the channel red, and toggling it off recovers.
 */
import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  expectEncrypted,
  fastTimers,
  armOptical,
  readToken,
  sasDigits,
} from './driver.js';

test('two benches negotiate optical mode and mint a shared key', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  // The room creator is the SOURCE (pairs with the source daemon); the joiner
  // is the DETECTOR.
  await armOptical(alice, { url: 'ws://127.0.0.1:8782', token: readToken('source') });
  await armOptical(bob, { url: 'ws://127.0.0.1:8781', token: readToken('detector') });

  const pageA = await alice.newPage();
  const pageB = await bob.newPage();
  await fastTimers(pageA);
  await fastTimers(pageB);

  try {
    const token = await createRoom(pageA);
    await joinRoom(pageB, token);

    // Both sides negotiate the optical backend.
    await expect(pageA.locator('.qd-mode')).toHaveText('OPTICAL', { timeout: 30_000 });
    await expect(pageB.locator('.qd-mode')).toHaveText('OPTICAL', { timeout: 30_000 });

    await expectEncrypted(pageA);
    await expectEncrypted(pageB);
    const sasA = await sasDigits(pageA);
    expect(sasA).toBe(await sasDigits(pageB));

    // Eve on the source bench drives QBER over threshold; the channel latches
    // red and recovers when Eve is removed. The SAS strip stays visible in red
    // so the reject control remains available.
    await pageA.evaluate(() => window.toggleEavesdropper());
    await expect(pageA.locator('.cipher-pill')).toContainText('integrity lost', {
      timeout: 45_000,
    });
    await expect(pageA.locator('.sas-mismatch')).toBeVisible();

    await pageA.evaluate(() => window.toggleEavesdropper());
    await expectEncrypted(pageA);
  } finally {
    await alice.close();
    await bob.close();
  }
});
