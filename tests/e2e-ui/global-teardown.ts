import { readState, stopDev } from './lib/dev'

export default async function globalTeardown() {
  if (process.env.E2E_KEEP === '1' || process.env.E2E_REUSE === '1') return
  stopDev(readState().devPid)
}
