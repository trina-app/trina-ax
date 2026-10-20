import { defineConfig } from '@playwright/test'

/** Desktop app e2e: launches the built Electron app (bun run build) against fake team servers. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './.work/results',
  webServer: {
    command: 'bun fake-team-server.ts',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:19151/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
