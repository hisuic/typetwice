import { expect, expectGate, expectNoGate, gate, test, unlock } from './fixtures';

test('x.com and twitter.com share one unlock; Instagram has its own', async ({ context, ext }) => {
  await ext.enableSite('X');
  await ext.enableSite('Instagram');
  await ext.setTiming(5);

  const x = await context.newPage();
  await x.goto('https://x.com/home');
  await unlock(x);

  const twitter = await context.newPage();
  await twitter.goto('https://mobile.twitter.com/explore');
  await twitter.waitForTimeout(500);
  await expectNoGate(twitter);

  const instagram = await context.newPage();
  await instagram.goto('https://www.instagram.com/');
  await expectGate(instagram);
  await expect(gate(instagram).locator('.site')).toHaveText('Instagram');
});

test('an unlock in one tab removes the gate in other tabs of the same site once', async ({ context, ext }) => {
  await ext.enableSite('X');
  await ext.setTiming(5);
  const first = await context.newPage();
  await first.goto('https://x.com/a');
  const second = await context.newPage();
  await second.goto('https://twitter.com/b');
  await expectGate(first);
  await expectGate(second);

  await first.bringToFront();
  await unlock(first);
  await expectNoGate(second);
  await expect.poll(() => ext.stats()).toMatchObject({ opened: 1 });
});

test('tabs that were open before a site was enabled get the gate', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/already-open');
  await page.locator('#compose').fill('typed before enabling');
  await expectNoGate(page);

  await ext.enableSite('X');
  await expectGate(page);
  expect(await page.locator('#compose').inputValue()).toBe('typed before enabling');
});

test('custom sites can be added from a URL, rejected when overlapping, and removed', async ({ context, ext }) => {
  await ext.setTiming(5);
  const options = await ext.openOptions();
  const input = options.locator('#site-input');

  await input.fill('https://mobile.twitter.com/home');
  await expect(options.locator('#site-preview')).toHaveText('mobile.twitter.com is already covered by X (twitter.com).');
  await input.fill('*.example.org');
  await expect(options.locator('#site-preview')).toContainText('Wildcards are not supported');
  await input.fill('co.uk');
  await expect(options.locator('#site-preview')).toContainText('public suffix');

  await input.fill('https://www.example.org/some/path?q=1');
  await expect(options.locator('#site-preview')).toHaveText(
    'Will cover example.org and all of its subdomains (http and https). Only the domain is used: www.example.org. "www." was removed so example.org and all of its subdomains are covered.',
  );
  await options.getByRole('button', { name: 'Add and allow access' }).click();
  const row = options.locator('.site', { has: options.locator('.site-name', { hasText: 'example.org' }) });
  await expect(row.locator('.chip')).toHaveText('Protected');

  const page = await context.newPage();
  await page.goto('https://blog.example.org/post');
  await expectGate(page);
  await expect(gate(page).locator('.site')).toHaveText('example.org');

  await options.bringToFront();
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  await expectNoGate(page);
  const later = await context.newPage();
  await later.goto('https://example.org/');
  await later.waitForTimeout(500);
  await expectNoGate(later);
});

test('turning the extension off removes open gates; turning it on asks again', async ({ context, ext, extensionId }) => {
  await ext.enableSite('X');
  await ext.setTiming(5);
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('switch').uncheck();
  await expect(popup.locator('#paused')).toBeVisible();

  const another = await context.newPage();
  await another.goto('https://x.com/other');
  await another.waitForTimeout(500);
  await expectNoGate(another);

  await popup.getByRole('switch').check();
  // Re-enabling does not keep the old unlock: open tabs are gated with a new challenge.
  await expectGate(another);
  await expectGate(page);
});

test('a declined permission request leaves the site off and says why', async ({ context, ext }) => {
  const options = await ext.openOptions();
  await options.evaluate(() => {
    chrome.permissions.request = (async () => false) as typeof chrome.permissions.request;
  });
  const row = options.locator('.site', { has: options.locator('.site-name', { hasText: 'Instagram' }) });
  await row.getByRole('switch').click();
  await expect(row.locator('.chip')).toHaveText('Permission required');
  await expect(row.getByRole('switch')).not.toBeChecked();
  await expect(options.locator('#notice')).toHaveText('Instagram was not turned on because access was not allowed.');

  const page = await context.newPage();
  await page.goto('https://www.instagram.com/');
  await page.waitForTimeout(500);
  await expectNoGate(page);
});

test('withdrawing site access in the browser removes the gate and shows Permission required', async ({ context, ext, extensionId }) => {
  await ext.enableSite('X');
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);

  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions');
  await extensionsPage.evaluate(
    (id) => (chrome as any).developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: 'ON_CLICK' }),
    extensionId,
  );

  await expectNoGate(page);
  const options = await ext.openOptions();
  await options.reload();
  const row = options.locator('.site', { has: options.locator('.site-name', { hasText: 'X' }) });
  await expect(row.locator('.chip')).toHaveText('Permission required');
  await expect(row.getByRole('button', { name: 'Allow access' })).toBeVisible();

  // Giving access back protects the site again, including the open tab.
  await extensionsPage.evaluate(
    (id) => (chrome as any).developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: 'ON_ALL_SITES' }),
    extensionId,
  );
  await expect(row.locator('.chip')).toHaveText('Protected');
  await expectGate(page);
});
