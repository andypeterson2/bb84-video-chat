/**
 * Simulated-mode e2e: two browser contexts complete a real call over the
 * signaling server and mint a shared key, with no bench daemons involved.
 * This is the reliable headless coverage of the whole browser stack.
 */
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, expectEncrypted, fastTimers, sasDigits } from './driver.js';

test('two peers establish an encrypted call and agree on the SAS', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const pageA = await alice.newPage();
  const pageB = await bob.newPage();
  await fastTimers(pageA);
  await fastTimers(pageB);

  try {
    const token = await createRoom(pageA);
    await joinRoom(pageB, token);

    await expectEncrypted(pageA);
    await expectEncrypted(pageB);

    // Both sides show the SIMULATED badge and an identical SAS.
    await expect(pageA.locator('.qd-mode')).toHaveText('SIMULATED');
    await expect(pageB.locator('.qd-mode')).toHaveText('SIMULATED');
    const sasA = await sasDigits(pageA);
    const sasB = await sasDigits(pageB);
    expect(sasA).toMatch(/^\d{6}$/);
    expect(sasA).toBe(sasB);
  } finally {
    await alice.close();
    await bob.close();
  }
});
