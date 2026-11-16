import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// The desktop workflow (.github/workflows/desktop.yml) on a macOS runner: the whole suite, as `bun run test:e2e` runs it,
// with a ceiling for the run (an Electron that never exits cannot hold the job: e2e/fixture-run.ts stops the standalone
// fixtures, helpers.ts close() the launched apps), one retry (a runner hiccup shows as flaky, not red) and an html report
// next to the results, which the workflow uploads when the job fails.
export default defineConfig({
  ...base,
  globalTimeout: 25 * 60_000,
  retries: 1,
  reporter: [['list'], ['html', { outputFolder: './.work/report', open: 'never' }]],
})
