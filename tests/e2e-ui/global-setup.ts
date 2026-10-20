import { healthy, readState, RELAYED, startDev } from './lib/dev'

export default async function globalSetup() {
  if (process.env.E2E_REUSE === '1') {
    if (!(await healthy()) || !(await healthy(RELAYED))) throw new Error('E2E_REUSE=1 but the product is not running (run once with E2E_KEEP=1)')
    console.log(`[e2e-ui] reusing the running product (dev pid ${readState().devPid})`)
    return
  }
  // E2E_RESUME=1: start the product again on the data of the last run (e.g. to continue after a failed step)
  const s = await startDev({ keepData: process.env.E2E_RESUME === '1' })
  console.log(`[e2e-ui] bun run dev started (pid ${s.devPid}); log: tests/.work/e2e-ui/dev.log`)
}
