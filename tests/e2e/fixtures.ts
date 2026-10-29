import { test as base, chromium, expect, type BrowserContext, type FrameLocator, type Page, type Worker } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Hosts served from a local fixture page instead of the network. The test
 * copy of the extension declares them as host_permissions, so that
 * chrome.permissions.request() resolves without the browser's prompt (which
 * automation cannot click). The shipped manifest is not changed.
 */
export const TEST_HOSTS = ['x.com', 'twitter.com', 'instagram.com', 'example.org'];
const ROUTED = /^https?:\/\/([a-z0-9-]+\.)*(x\.com|twitter\.com|instagram\.com|example\.org|example\.net|notx\.com)\//;
const SITE_HTML = readFileSync(new URL('./fixtures/site.html', import.meta.url), 'utf8');

export const BROWSER = (process.env.E2E_BROWSER ?? 'chromium') as 'chromium' | 'chrome' | 'brave';
const BRAVE_PATH = process.env.BRAVE_PATH ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  worker: () => Promise<Worker>;
  ext: ExtensionHelpers;
}

export interface ExtensionHelpers {
  openOptions(): Promise<Page>;
  enableSite(name: string): Promise<void>;
  setTiming(minDurationSeconds: number, unlockDurationMinutes?: number): Promise<void>;
  stats(): Promise<{ shown: number; opened: number; declined: number }>;
  expireGrants(options?: { refresh?: boolean }): Promise<void>;
}

export const test = base.extend<Fixtures>({
  context: async ({}, use) => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'typetwice-ext-'));
    cpSync(resolve('dist'), extensionDir, { recursive: true });
    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.host_permissions = TEST_HOSTS.map((host) => `*://*.${host}/*`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const userDataDir = mkdtempSync(join(tmpdir(), 'typetwice-profile-'));
    const context = await launch(userDataDir, extensionDir);
    await context.route(ROUTED, (route) => {
      const url = new URL(route.request().url());
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (url.pathname.startsWith('/strict')) {
        headers['content-security-policy'] =
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'none'; child-src 'none'; require-trusted-types-for 'script'";
        headers['cross-origin-embedder-policy'] = 'require-corp';
        headers['cross-origin-opener-policy'] = 'same-origin';
      }
      return route.fulfill({ status: 200, headers, body: SITE_HTML.replace('Fixture site', `${url.host}${url.pathname}`) });
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extensionDir, { recursive: true, force: true });
  },

  worker: async ({ context }, use) => {
    let id: string | undefined;
    await use(async () => {
      const existing = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
      if (existing) {
        id = new URL(existing.url()).host;
        return existing;
      }
      const started = context.waitForEvent('serviceworker');
      if (id) {
        // The worker went idle; any extension page wakes it up again.
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/popup.html`);
        await page.close();
      }
      const worker = await started;
      id = new URL(worker.url()).host;
      return worker;
    });
  },

  extensionId: async ({ worker }, use) => {
    await use(new URL((await worker()).url()).host);
  },

  ext: async ({ context, extensionId, worker }, use) => {
    let options: Page | null = null;
    const helpers: ExtensionHelpers = {
      async openOptions() {
        if (options && !options.isClosed()) return options;
        options = await context.newPage();
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        await expect(options.locator('.site').first()).toBeVisible();
        return options;
      },
      async enableSite(name) {
        const page = await helpers.openOptions();
        const row = page.locator('.site', { has: page.locator('.site-name', { hasText: name }) });
        await row.getByRole('switch').check();
        await expect(row.locator('.chip')).toHaveText('Protected');
      },
      async setTiming(minDurationSeconds, unlockDurationMinutes) {
        const page = await helpers.openOptions();
        await page.locator('#min-duration').fill(String(minDurationSeconds));
        await page.locator('#min-duration').press('Tab');
        await expect(page.locator('#min-duration')).toHaveValue(String(minDurationSeconds));
        if (unlockDurationMinutes !== undefined) {
          await page.locator('#unlock-duration').fill(String(unlockDurationMinutes));
          await page.locator('#unlock-duration').press('Tab');
        }
        await expect
          .poll(async () =>
            (await worker()).evaluate(async () => {
              const { settings } = await chrome.storage.local.get('settings');
              return (settings as { minDurationSeconds?: number } | undefined)?.minDurationSeconds;
            }),
          )
          .toBe(minDurationSeconds);
      },
      async stats() {
        const values = await (await worker()).evaluate(async () => {
          const { stats } = await chrome.storage.local.get('stats');
          return Object.values(stats ?? {}) as { shown: number; opened: number; declined: number }[];
        });
        return values[0] ?? { shown: 0, opened: 0, declined: 0 };
      },
      async expireGrants({ refresh = true } = {}) {
        await (await worker()).evaluate(async (refreshTabs) => {
          const stored = await chrome.storage.session.get('grants');
          const grants = (stored.grants ?? {}) as Record<string, number>;
          for (const siteId of Object.keys(grants)) grants[siteId] = Date.now() - 1;
          await chrome.storage.session.set({ grants });
          if (!refreshTabs) return;
          for (const tab of await chrome.tabs.query({})) {
            if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'REFRESH' }, { frameId: 0 }).catch(() => {});
          }
        }, refresh);
      },
    };
    await use(helpers);
  },
});

async function launch(userDataDir: string, extensionDir: string): Promise<BrowserContext> {
  if (BROWSER === 'chrome') {
    // Branded Chrome ignores --load-extension; load the unpacked copy over CDP instead.
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-extension-debugging'],
    });
    const session = await context.browser()!.newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked' as never, { path: extensionDir } as never);
    return context;
  }
  return chromium.launchPersistentContext(userDataDir, {
    channel: BROWSER === 'chromium' ? 'chromium' : undefined,
    executablePath: BROWSER === 'brave' ? BRAVE_PATH : undefined,
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
}

// ---------------------------------------------------------------------------
// Page helpers

export const gate = (page: Page): FrameLocator => page.frameLocator('typetwice-gate iframe');

export async function expectGate(page: Page): Promise<void> {
  await expect(page.locator('typetwice-gate')).toHaveCount(1);
  await expect(gate(page).locator('textarea')).toBeAttached();
}

export async function expectNoGate(page: Page): Promise<void> {
  await expect(page.locator('typetwice-gate')).toHaveCount(0);
}

/** The sentence currently asked for, read from the input's accessible label. */
export async function sentenceOf(page: Page): Promise<string> {
  const label = await gate(page).locator('textarea').getAttribute('aria-label');
  return label!.replace(/^Type this sentence: /, '');
}

export async function typeSentence(page: Page, text?: string): Promise<string> {
  const sentence = text ?? (await sentenceOf(page));
  await gate(page).locator('.words').click();
  await page.keyboard.type(sentence, { delay: 5 });
  return sentence;
}

export async function unlock(page: Page): Promise<void> {
  await expectGate(page);
  await typeSentence(page);
  const open = gate(page).getByRole('button', { name: /Open anyway/ });
  await expect(open).toBeEnabled({ timeout: 15_000 });
  await open.click();
  await expectNoGate(page);
}

export { expect };
