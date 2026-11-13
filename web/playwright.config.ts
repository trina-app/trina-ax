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
  // writes test-results/feature-coverage.json: the endpoints the run reached (docs/FEATURES.md)
  globalTeardown: './test/e2e/feature-coverage.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1360, height: 860 },
    locale: 'ko-KR',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 860 }, locale: 'ko-KR' } },
    // Safari / the iPhone app's engine, for what differs there: the artifact frame's connection rules, uploads through
    // XMLHttpRequest, the message box's mention layer, the phone's Back over each tab's stack, the phone's files, a
    // phone's attach sheet (the file inputs iOS opens; WebKit grants no clipboard permissions, so none are asked for) and the
    // phone app's photo picker (the files its bridge hands over)
    { name: 'webkit', testMatch: /(sandbox-exfil|upload-progress|room-mentions|room-mention-all|phone-back-parent|phone-files|phone-attach-sheet|phone-photo-picker)\.spec\.ts/, use: { ...devices['Desktop Safari'], viewport: { width: 1360, height: 860 }, locale: 'ko-KR', permissions: [] } },
  ],
  webServer: {
    command: `bun test/mock/serve.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { MOCK_PORT: String(PORT) },
  },
})
