import { expect, expectGate, expectNoGate, gate, sentenceOf, test, typeSentence, unlock } from './fixtures';

test.beforeEach(async ({ ext }) => {
  await ext.enableSite('X');
  await ext.setTiming(5);
});

test('covers a protected site with an opaque gate and leaves other sites alone', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  await expect(gate(page).locator('.top')).toContainText('X');
  await expect(gate(page).locator('.top')).toContainText('Pause before you scroll.');

  // The cover is on top: the page underneath cannot be clicked or read.
  const hit = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName);
  expect(hit).toBe('TYPETWICE-GATE');
  expect(await page.evaluate(() => document.body.inert)).toBe(true);

  for (const url of ['https://notx.com/', 'https://x.com.example.net/', 'https://unrelated.example.net/']) {
    const other = await context.newPage();
    await other.goto(url);
    await other.waitForTimeout(300);
    await expectNoGate(other);
  }
});

test('needs the exact sentence and the minimum time, then an explicit click', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const sentence = await sentenceOf(page);
  const open = gate(page).getByRole('button', { name: 'Open anyway · 5 min' });

  // One wrong character (case) blocks the unlock, even after the minimum time.
  const wrong = sentence[0] === sentence[0]!.toUpperCase() ? sentence[0]!.toLowerCase() + sentence.slice(1) : sentence.toUpperCase();
  await typeSentence(page, wrong);
  await expect(gate(page).locator('.c.incorrect').first()).toBeVisible();
  await page.waitForTimeout(5_500);
  await expect(gate(page).locator('.status')).toHaveText('Fix the highlighted characters to continue.');
  await expect(open).toBeDisabled();

  // Fix it with ordinary editing: select all and type again.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(sentence, { delay: 5 });
  await expect(open).toBeEnabled();

  // An extra space is a mismatch; deleting it makes the button usable again.
  await page.keyboard.type(' ');
  await expect(open).toBeDisabled();
  await expect(gate(page).locator('.c.extra')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(open).toBeEnabled();

  // Typing done does not open the site by itself.
  await page.waitForTimeout(500);
  await expectGate(page);
  await open.click();
  await expectNoGate(page);
  expect(await ext.stats()).toMatchObject({ shown: 1, opened: 1, declined: 0 });
});

test('cannot unlock before the minimum time even with the right text', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  await typeSentence(page);
  await expect(gate(page).locator('.status')).toHaveText(/^Stay here for [1-5] more seconds?\.$/);
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeDisabled();
  // Enter while waiting neither unlocks nor adds a line break.
  await page.keyboard.press('Enter');
  await expectGate(page);
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeEnabled({ timeout: 8_000 });
  await page.keyboard.press('Enter');
  await expectNoGate(page);
});

test('blocks paste and drop into the sentence field', async ({ context, ext }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const sentence = await sentenceOf(page);

  // Put the sentence on the real clipboard from an extension page, then paste with the keyboard.
  const options = await ext.openOptions();
  await options.bringToFront();
  await options.evaluate((text) => navigator.clipboard.writeText(text), sentence);
  await page.bringToFront();
  await gate(page).locator('.words').click();
  await page.keyboard.press('ControlOrMeta+V');
  await page.waitForTimeout(300);
  await expect(gate(page).locator('textarea')).toHaveValue('');

  // Control: the same keyboard paste works in an ordinary page, so the check above is meaningful.
  const plain = await context.newPage();
  await plain.goto('https://unrelated.example.net/');
  await plain.locator('#compose').click();
  await plain.keyboard.press('ControlOrMeta+V');
  await expect(plain.locator('#compose')).toHaveValue(sentence);
  await page.bringToFront();

  // A drop is refused as well.
  const frame = page.frames().find((f) => f.url().endsWith('/gate.html'))!;
  const dropped = await frame.evaluate((text) => {
    const area = document.querySelector('textarea')!;
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
    area.dispatchEvent(event);
    return event.defaultPrevented;
  }, sentence);
  expect(dropped).toBe(true);
  await expect(gate(page).locator('textarea')).toHaveValue('');
});

test('counts time only while the sentence field has focus', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  await expect(gate(page).locator('.timer')).toHaveText('Minimum 5s · starts when you type');
  await page.waitForTimeout(1_500);
  // Opening the page did not start the timer.
  await expect(gate(page).locator('.timer')).toHaveText('Minimum 5s · starts when you type');

  await typeSentence(page);
  // Move focus to "Go back": the timer pauses and keeps its progress.
  await page.keyboard.press('Tab');
  await expect(gate(page).getByRole('button', { name: 'Go back' })).toBeFocused();
  await expect(gate(page).locator('.timer')).toHaveText(/^Paused · [1-5]s to go$/);
  await expect(gate(page).locator('.hint')).toHaveText('Timer paused. Click the sentence to continue.');
  await page.waitForTimeout(6_000);
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeDisabled();

  // Clicking the sentence resumes the timer where it stopped.
  await gate(page).locator('.words').click();
  await expect(gate(page).locator('.timer')).toHaveText(/^[1-5]s to go$/);
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeEnabled({ timeout: 8_000 });
});

test('keeps keystrokes, clicks and scrolling away from the page and restores it afterwards', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);

  // Keys pressed while the page itself has focus, and keys typed into the gate,
  // never reach the page's shortcut handlers.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('jkl');
  await expect(gate(page).locator('textarea')).toHaveValue('');
  await typeSentence(page);
  expect(await page.evaluate(() => (window as unknown as { pageKeys: number }).pageKeys)).toBe(0);

  await page.mouse.click(10, 10);
  await page.mouse.wheel(0, 2_000);
  await page.keyboard.press('PageDown');
  expect(await page.evaluate(() => (window as unknown as { likes: number }).likes)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Tab moves through the gate's own controls only.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.tagName);
    expect(['TYPETWICE-GATE', 'BODY']).toContain(active);
  }

  await gate(page).locator('.words').click();
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeEnabled({ timeout: 8_000 });
  await gate(page).getByRole('button', { name: /Open anyway/ }).click();
  await expectNoGate(page);

  // Nothing the gate changed is left behind.
  expect(await page.evaluate(() => document.body.inert)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeNull();
  await page.locator('#like').click();
  expect(await page.evaluate(() => (window as unknown as { likes: number }).likes)).toBe(1);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('display and unlock state follow the input after editing, selection replace, undo and redo', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const sentence = await sentenceOf(page);
  const open = gate(page).getByRole('button', { name: /Open anyway/ });

  /** The drawn characters must match a strict comparison of the textarea's real value. */
  const expectConsistent = async () => {
    const value = await gate(page).locator('textarea').inputValue();
    let correct = 0;
    let incorrect = 0;
    for (let i = 0; i < Math.min(value.length, sentence.length); i += 1) {
      if (value[i] === sentence[i]) correct += 1;
      else incorrect += 1;
    }
    await expect(gate(page).locator('.c.correct')).toHaveCount(correct);
    await expect(gate(page).locator('.c.incorrect')).toHaveCount(incorrect);
    await expect(gate(page).locator('.c.extra')).toHaveCount(Math.max(0, value.length - sentence.length));
    return value;
  };

  await typeSentence(page);
  await page.waitForTimeout(5_200);
  await expect(open).toBeEnabled();

  // Move left and insert a stray character in the middle.
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('#');
  expect(await expectConsistent()).not.toBe(sentence);
  await expect(open).toBeDisabled();

  // Forward-delete it again with Delete after stepping back over it.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  expect(await expectConsistent()).toBe(sentence);
  await expect(open).toBeEnabled();

  // Replace a selection made with Shift+Arrow.
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.type('ZZ');
  await expectConsistent();
  await expect(open).toBeDisabled();

  // Undo and redo go through the browser's own history (its step size is the browser's
  // choice); after every step the display follows the real value.
  let value = '';
  for (let step = 0; step < 4 && value !== sentence; step += 1) {
    await page.keyboard.press('ControlOrMeta+Z');
    value = await expectConsistent();
  }
  expect(value).toBe(sentence);
  await expect(open).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect(await expectConsistent()).not.toBe(sentence);
  await expect(open).toBeDisabled();
});

test('works on pages with a strict CSP, Trusted Types and COEP', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://x.com/strict');
  await unlock(page);
});
