import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx src/fixtures/serve.ts --port 4319',
    url: 'http://127.0.0.1:4319/robots.txt',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
