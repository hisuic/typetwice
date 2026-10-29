import { expect, expectGate, gate, sentenceOf, test, typeSentence } from './fixtures';

const file = (name: string, text: string | Buffer) => ({
  name,
  mimeType: 'text/plain',
  buffer: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
});

test.beforeEach(async ({ ext }) => {
  await ext.enableSite('X');
  await ext.setTiming(5);
});

test('a file with problems is shown with line numbers and cannot be applied', async ({ ext }) => {
  const options = await ext.openOptions();
  await expect(options.locator('#corpus-status')).toHaveText('Using the 3 bundled sentences.');

  await options.locator('#file-input').setInputFiles(
    file('broken.txt', 'Fine line.\n\nZero​width.\nCafé time.\n'),
  );
  const preview = options.locator('#import-preview');
  await expect(preview.locator('h3')).toHaveText('broken.txt cannot be imported');
  await expect(preview.locator('.problems li')).toHaveText([
    'Line 3: unsupported character U+200B (zero-width space) at column 5.',
    'Line 4: unsupported character "é" (U+00E9) at column 4.',
  ]);
  await expect(preview.getByRole('button', { name: 'Replace sentences' })).toBeDisabled();

  const invalidUtf8 = Buffer.concat([Buffer.from('One.\nTwo '), Buffer.from([0xff]), Buffer.from('\n')]);
  await options.locator('#file-input').setInputFiles(file('latin1.txt', invalidUtf8));
  await expect(preview.locator('.problems li')).toHaveText([
    'Line 2: invalid UTF-8 byte 0xFF at byte 10. Save the file as UTF-8 and try again.',
  ]);
  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(preview).toBeHidden();
  await expect(options.locator('#corpus-status')).toHaveText('Using the 3 bundled sentences.');
});

test('importing replaces the sentences for new challenges only, and restoring brings back the bundled ones', async ({
  context,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await expectGate(page);
  const onScreen = await sentenceOf(page);
  await typeSentence(page, onScreen.slice(0, 4));

  const options = await ext.openOptions();
  await options.locator('#file-input').setInputFiles(
    file('mine.txt', '﻿“No,” I said… one more minute.\r\nShort one.\r\n\r\nShort one.\r\n'),
  );
  const preview = options.locator('#import-preview');
  await expect(preview.locator('h3')).toHaveText('Ready to import mine.txt');
  await expect(preview.locator('li')).toContainText([
    '2 sentences will replace the current ones.',
    '1 duplicate line will be skipped.',
    '1 line had curly quotes, dashes, ellipses or special spaces converted.',
  ]);
  await expect(preview.locator('.samples li')).toHaveText(['"No," I said... one more minute.', 'Short one.']);

  // Choosing the file alone changed nothing.
  await expect(options.locator('#corpus-status')).toHaveText('Using the 3 bundled sentences.');
  await preview.getByRole('button', { name: 'Replace sentences' }).click();
  await expect(options.locator('#corpus-status')).toContainText('Using 2 imported sentences from mine.txt');
  await expect(options.locator('#notice')).toContainText('a challenge already on screen keeps its sentence');

  // The gate already on screen keeps its sentence and can still be completed.
  await page.bringToFront();
  expect(await sentenceOf(page)).toBe(onScreen);
  await gate(page).locator('.words').click();
  await page.keyboard.type(onScreen.slice(4));
  await expect(gate(page).getByRole('button', { name: /Open anyway/ })).toBeEnabled({ timeout: 10_000 });

  const fresh = await context.newPage();
  await fresh.goto('https://twitter.com/new');
  await expectGate(fresh);
  expect(['"No," I said... one more minute.', 'Short one.']).toContain(await sentenceOf(fresh));

  // The imported set survives reloading the settings page (it is stored, not kept in memory).
  await options.reload();
  await expect(options.locator('#corpus-status')).toContainText('Using 2 imported sentences from mine.txt');

  await options.getByRole('button', { name: 'Restore bundled sentences' }).click();
  await expect(options.locator('#corpus-status')).toHaveText('Using the 3 bundled sentences.');
  await expect(options.getByRole('button', { name: 'Restore bundled sentences' })).toBeDisabled();
});

test('shows an error gate with a way out when the sentences cannot be loaded', async ({ context, ext, worker }) => {
  const options = await ext.openOptions();
  await options.locator('#file-input').setInputFiles(file('mine.txt', 'Only line.\n'));
  await options.getByRole('button', { name: 'Replace sentences' }).click();
  await expect(options.locator('#corpus-status')).toContainText('Using 1 imported sentence');
  // Simulate damaged storage.
  await (await worker()).evaluate(() => chrome.storage.local.remove('customCorpus'));

  const page = await context.newPage();
  await page.goto('https://unrelated.example.net/');
  await page.goto('https://x.com/home');
  await expect(gate(page).getByRole('heading', { name: 'Messages could not be loaded' })).toBeVisible();
  await expect(gate(page).getByRole('button', { name: 'Open settings' })).toBeVisible();
  await expect(gate(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  // The page is still covered, and Go back works.
  expect(await page.evaluate(() => document.body.inert)).toBe(true);
  await gate(page).getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL('https://unrelated.example.net/');
});
