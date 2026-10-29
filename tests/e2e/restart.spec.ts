import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, expectGate, launch, prepareExtension, sentenceOf, test, unlock } from './fixtures';

async function extensionPage(context: BrowserContext, path: string): Promise<Page> {
  let worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  worker ??= await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/${path}`);
  return page;
}

test('settings, imported sentences and protected sites survive a browser restart; unlocks do not', async () => {
  const extensionDir = prepareExtension();
  const userDataDir = mkdtempSync(join(tmpdir(), 'typetwice-profile-'));
  try {
    let context = await launch(userDataDir, extensionDir);
    let options = await extensionPage(context, 'options.html');
    const xRow = options.locator('.site', { has: options.locator('.site-name', { hasText: 'X' }) });
    await xRow.getByRole('switch').check();
    await expect(xRow.locator('.chip')).toHaveText('Protected');
    await options.locator('#min-duration').fill('5');
    await options.locator('#min-duration').press('Tab');
    await options.locator('#file-input').setInputFiles({
      name: 'mine.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('After a restart this is still here.\n'),
    });
    await options.getByRole('button', { name: 'Replace sentences' }).click();
    await expect(options.locator('#corpus-status')).toContainText('Using 1 imported sentence from mine.txt');

    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await unlock(page);
    await context.close();

    // Same profile, browser started again.
    context = await launch(userDataDir, extensionDir);
    options = await extensionPage(context, 'options.html');
    await expect(options.locator('#corpus-status')).toContainText('Using 1 imported sentence from mine.txt');
    await expect(options.locator('#min-duration')).toHaveValue('5');
    await expect(options.locator('.site', { has: options.locator('.site-name', { hasText: 'X' }) }).locator('.chip')).toHaveText(
      'Protected',
    );

    // The content script registration persisted, the unlock did not.
    const again = await context.newPage();
    await again.goto('https://x.com/home');
    await expectGate(again);
    expect(await sentenceOf(again)).toBe('After a restart this is still here.');
    await context.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extensionDir, { recursive: true, force: true });
  }
});
