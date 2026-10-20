import { healthy, readState, RELAYED, startDev } from './lib/dev'

export default async function globalSetup() {
  if (process.env.E2E_REUSE === '1') {
    if (!(await healthy()) || !(await healthy(RELAYED))) throw new Error('E2E_REUSE=1 but the product is not running (run once with E2E_KEEP=1)')
    console.log(`[e2e-ui] reusing the running product (dev pid ${readState().devPid})`)
    return
  }
  const s = await startDev()
  console.log(`[e2e-ui] bun run dev started (pid ${s.devPid}); log: tests/.work/e2e-ui/dev.log`)
}
