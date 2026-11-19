import { defineConfig } from '@playwright/test'
import ci from './ci.config'

// The desktop workflow's Linux job (.github/workflows/desktop.yml "Desktop e2e (Linux, subset)",
// docs/decisions/20261119-linux-desktop-app.md "Desktop e2e subset"): the specs that cover what the Linux app has. Find
// work files, work consent, the folder window and meeting notes are off on Linux, so their specs would only skip; the
// whole suite stays on the Mac. A spec joins this list when it covers something Linux has.
// update.spec's one case is the Mac notice (index.json) and skips here; the .deb notice is unit-tested.
export const LINUX_SPECS = ['smoke', 'desktop', 'quit', 'settings', 'language', 'offline', 'update', 'local-apps'] as const

export default defineConfig({
  ...ci,
  testMatch: LINUX_SPECS.map((s) => `${s}.spec.ts`),
  globalTimeout: 20 * 60_000,
})
