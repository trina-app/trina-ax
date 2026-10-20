// End-to-end scenario of the integrated product in a real browser (and the real Electron app): `bun run dev`
// (team server in DEV mode with the real Claude Code / Codex engines on your own logins, the Node 25 relay with
// the team "demo"), driven through the web UI on http://localhost:19100 and http://demo.localhost:19161.
//
//   bun run e2e:ui                         fresh data folder, whole scenario (about 10 Claude and 1 Codex call)
//   E2E_REUSE=1 bun run e2e:ui -g "step 6" rerun one step against the product the last run left running
//                                          (E2E_KEEP=1 on the first run keeps it running afterwards)
//   E2E_RESUME=1 bun run e2e:ui -g "step 6|step 7"  start the product again on the last run's data, run some steps
//
// Engine calls are metered across runs (tests/.work/e2e-ui/engine-calls.json; E2E_MAX_CLAUDE / E2E_MAX_CODEX).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../.work/e2e-ui/results',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    browserName: 'chromium',
    viewport: { width: 1400, height: 900 },
    locale: 'ko-KR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  },
})
