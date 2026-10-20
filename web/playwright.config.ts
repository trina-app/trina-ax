// End-to-end smoke tests of the built web app against the mock team server (test/mock): the real serveWeb()
// headers (CSP etc.), the REST contract and the WebSocket protocol. Run: bun run build && bun run e2e
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.MOCK_PORT ?? 19143)

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1360, height: 860 },
    locale: 'ko-KR',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 860 }, locale: 'ko-KR' } }],
  webServer: {
    command: `bun test/mock/serve.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { MOCK_PORT: String(PORT) },
  },
})
