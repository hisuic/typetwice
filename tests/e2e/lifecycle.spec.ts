import { expect, expectGate, expectNoGate, gate, sentenceOf, test, typeSentence, unlock } from './fixtures';

test.beforeEach(async ({ ext }) => {
  await ext.enableSite('X');
  await ext.setTiming(5);
});

test('an expired unlock waits for the next navigation and keeps drafts, focus and caret', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);

  await page.locator('#dm').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await page.locator('#compose').click();
  await page.keyboard.type('Half-written post');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  // The unlock ends while the user is still on the page: nothing happens yet.
  await ext.expireGrants();
  await page.waitForTimeout(800);
  await expectNoGate(page);

  // The next in-app navigation (pushState from the page's own script) brings the gate back.
  await page.evaluate(() => history.pushState({}, '', '/messages'));
  await expectGate(page);
  expect(await page.locator('#compose').inputValue()).toBe('Half-written post');
  expect(await page.locator('#dm').textContent()).toBe('Draft message and more');

  await unlock(page);
  // Focus and caret return to where they were.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('compose');
  expect(await page.locator('#compose').evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(15);
  await page.keyboard.type('!');
  expect(await page.locator('#compose').inputValue()).toBe('Half-written po!st');
});

test('re-checks an expired unlock on hash changes, returning to the tab and reloads', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);

  await ext.expireGrants();
  await page.evaluate(() => (location.hash = '#replies'));
  await expectGate(page);
  await unlock(page);

  // Coming back to the tab (window focus) re-checks too. Headless browsers keep every tab
  // visible, so the focus event stands in for switching tabs or apps here.
  await ext.expireGrants();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectGate(page);
  await unlock(page);

  await ext.expireGrants();
  await page.reload();
  await expectGate(page);
});

test('an unlock that is still valid is not extended by moving around', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);
  const grant = async () =>
    (await worker()).evaluate(async () => ((await chrome.storage.session.get('grants')).grants as Record<string, number>).x);
  const before = await grant();
  await page.evaluate(() => history.pushState({}, '', '/explore'));
  await page.goto('https://twitter.com/notifications');
  await expectNoGate(page);
  expect(await grant()).toBe(before);
});

test('pages restored from the back/forward cache are checked again', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);
  await ext.expireGrants();

  await page.goto('https://unrelated.example.net/');
  // A restore from the cache fires no load event.
  await page.goBack({ waitUntil: 'commit' });
  await expectGate(page);
  // The same document came back (pageshow with persisted = true), so pageshow handling is what re-gated it.
  expect(await page.evaluate(() => (window as unknown as { pageShows: boolean[] }).pageShows)).toEqual([false, true]);
});

test('Go back returns to the previous page and counts as going back', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://unrelated.example.net/start');
  await page.goto('https://x.com/home');
  await expectGate(page);
  await gate(page).getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL('https://unrelated.example.net/start');
  await expect.poll(() => ext.stats()).toMatchObject({ shown: 1, declined: 1, opened: 0 });
});

test('Go back without history shows a closing screen and never the page', async ({ context }) => {
  // Like a link opened in a new tab: the protected page is the only history entry.
  const page = await context.newPage();
  await page.evaluate(() => location.replace('https://x.com/home'));
  await page.waitForURL('https://x.com/home');
  await expectGate(page);
  expect(await page.evaluate(() => history.length)).toBe(1);
  await gate(page).getByRole('button', { name: 'Go back' }).click();
  const shadow = page.locator('typetwice-gate');
  await expect(shadow.getByRole('heading', { name: 'You can close this tab.' })).toBeVisible();
  expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName)).toBe('TYPETWICE-GATE');
  expect(await page.evaluate(() => document.body.inert)).toBe(true);
});

test('Go back that lands on the same site shows a new gate there', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await unlock(page);
  await page.evaluate(() => history.pushState({}, '', '/second'));
  await ext.expireGrants();
  await page.evaluate(() => history.pushState({}, '', '/third'));
  await expectGate(page);
  const first = await sentenceOf(page);

  await gate(page).getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL('https://x.com/second');
  await expectGate(page);
  // A new challenge, not the declined one (the bundled set avoids repeating the last sentence).
  await expect.poll(() => sentenceOf(page)).not.toBe(first);
  await expect.poll(() => ext.stats()).toMatchObject({ declined: 1 });
});

test('a worker restart keeps the typed text, the timer and the unlock', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const sentence = await sentenceOf(page);
  await gate(page).locator('.words').click();
  await page.keyboard.type(sentence.slice(0, 10));

  await (await worker()).evaluate(() => {
    (self as unknown as { marker: string }).marker = 'before restart';
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(500);

  await page.keyboard.type(sentence.slice(10));
  await expect(gate(page).locator('textarea')).toHaveValue(sentence);
  const open = gate(page).getByRole('button', { name: /Open anyway/ });
  await expect(open).toBeEnabled({ timeout: 10_000 });
  await open.click();
  await expectNoGate(page);

  // A new worker instance answered the unlock; the grant lives in session storage, not in its memory.
  expect(await (await worker()).evaluate(() => (self as unknown as { marker?: string }).marker)).toBeUndefined();
  const other = await context.newPage();
  await other.goto('https://twitter.com/home');
  await other.waitForTimeout(500);
  await expectNoGate(other);
});

test('switching tabs keeps the same sentence, text and progress', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const sentence = await sentenceOf(page);
  await typeSentence(page, sentence.slice(0, 5));

  const other = await context.newPage();
  await other.goto('https://unrelated.example.net/');
  await page.bringToFront();
  expect(await sentenceOf(page)).toBe(sentence);
  await expect(gate(page).locator('textarea')).toHaveValue(sentence.slice(0, 5));
});

test('stats count shown, opened and go back per challenge, not closed tabs', async ({ context, ext, extensionId }) => {
  const declined = await context.newPage();
  await declined.goto('https://unrelated.example.net/');
  await declined.goto('https://x.com/1');
  await expectGate(declined);
  await gate(declined).getByRole('button', { name: 'Go back' }).click();
  await expect(declined).toHaveURL('https://unrelated.example.net/');

  const closed = await context.newPage();
  await closed.goto('https://x.com/2');
  await expectGate(closed);
  await expect.poll(() => ext.stats()).toMatchObject({ shown: 2 });
  await closed.close();

  const opened = await context.newPage();
  await opened.goto('https://x.com/3');
  await unlock(opened);
  // Moving around while unlocked shows no new gates.
  await opened.evaluate(() => history.pushState({}, '', '/4'));

  await expect.poll(() => ext.stats()).toEqual({
    date: expect.any(String),
    shown: 3,
    opened: 1,
    declined: 1,
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#stat-shown')).toHaveText('3');
  await expect(popup.locator('#stat-opened')).toHaveText('1');
  await expect(popup.locator('#stat-declined')).toHaveText('1');
});

test('turning the extension off under an open gate shows a recovery screen, not a dead cover', async ({
  context,
  ext,
  extensionId,
}) => {
  await ext.enableSite('Instagram');
  const gated = await context.newPage();
  await gated.goto('https://x.com/home');
  await expectGate(gated);
  const unlocked = await context.newPage();
  await unlocked.goto('https://www.instagram.com/');
  await unlock(unlocked);

  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  await extensions.evaluate((id) => chrome.management.setEnabled(id, false), extensionId);

  const overlay = gated.locator('typetwice-gate');
  await expect(overlay.getByRole('heading', { name: 'TypeTwice was updated or turned off' })).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'Reload page' })).toBeVisible();
  await overlay.getByRole('button', { name: 'Reload page' }).click();
  await expect(gated.locator('#timeline')).toBeVisible();
  await expectNoGate(gated);

  // A page that was already open is left alone when the user moves on.
  await unlocked.evaluate(() => history.pushState({}, '', '/explore'));
  await unlocked.waitForTimeout(500);
  await expectNoGate(unlocked);
  expect(await unlocked.evaluate(() => document.body.inert)).toBe(false);
});
