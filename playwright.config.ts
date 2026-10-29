import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests load the built extension (dist/) into a real browser.
 * Choose the browser with E2E_BROWSER=chromium (default), chrome or brave.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list']],
});
