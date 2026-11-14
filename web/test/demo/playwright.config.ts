// The hands-on demo's walk (web/demo/, docs/AGENTS/plan/20261114-0507-mina-demo.md): the built demo (bun run
// build:demo) served as static files, the whole story clicked through at 1440 and 390 px, light and dark.
// Run: bun run build:demo && bunx playwright test -c test/demo/playwright.config.ts
// DEMO_SHOTS=<folder> also saves a screenshot of each chapter there. DEMO_BASE=/demo/ walks a build made with the same
// DEMO_BASE, served under that path (test/demo/serve.ts, with the demo's CSP).
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.DEMO_PORT ?? 19243)
const BASE = `/${(process.env.DEMO_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
const phone = { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }

export default defineConfig({
  testDir: '.',
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/demo',
  use: { baseURL: `http://localhost:${PORT}${BASE}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'en-US' },
  projects: [
    { name: '1440-light', use: { ...desktop, colorScheme: 'light' } },
    { name: '390-light', use: { ...phone, colorScheme: 'light' } },
    { name: '1440-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: '390-dark', use: { ...phone, colorScheme: 'dark' } },
  ],
  webServer: {
    command: 'bun test/demo/serve.ts',
    url: `http://localhost:${PORT}${BASE}`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
