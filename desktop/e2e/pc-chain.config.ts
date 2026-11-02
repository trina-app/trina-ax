import { defineConfig } from '@playwright/test'

/** The PC runner through the whole chain: the real team server and web app with the real desktop app (pc-chain.spec.ts).
 * Needs `bash native/build.sh` and `bun run --cwd web build`; not part of `bun run test:e2e`. */
export default defineConfig({
  testDir: '.',
  testMatch: /pc-chain\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './.work/results-chain',
})
