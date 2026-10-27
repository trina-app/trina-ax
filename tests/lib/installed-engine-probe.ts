// Run only in a fresh subprocess: boundary doubles must never replace modules in other engine tests.
// The real engines.ts is exercised; every developer-home, fixture, sandbox and launcher operation is recorded.
import { mock } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [phase, encodedValue] = process.argv.slice(2)
const value: string | null = JSON.parse(encodedValue)
const trace = process.env.MYCEL_PROBE_TRACE!
const base = process.env.MYCEL_WORK!
const record = (operation: string) => fs.appendFileSync(trace, operation + '\n')
const setMode = () => { if (value !== null) process.env.MYCEL_LOCKDOWN_INSTALLED = value }
delete process.env.MYCEL_LOCKDOWN_INSTALLED
if (phase === 'import') setMode()

os.homedir = () => { record('home'); return process.env.HOME! }
mock.module('../../server/src/config', () => ({ which: (name: string) => { record('path:' + name); return path.join(base, name) } }))
mock.module('../../server/src/server', () => ({ startServer: async () => { record('launcher'); return {} } }))
mock.module('../../server/src/context', () => ({ devEngineSandbox: () => { record('sandbox'); return null } }))
mock.module('./stage1-runner', () => ({ TurnRunner: class { constructor() { record('runner') } } }))
mock.module('../../server/src/engine/codex', () => ({ writeLockedCatalog: () => { record('catalog'); return ['test-model'] } }))
mock.module('./env', () => ({ makeEnv: () => {
  record('fixture')
  fs.mkdirSync(base, { recursive: true })
  fs.writeFileSync(path.join(base, 'fixture-created'), 'synthetic fixture')
  return { cfg: {}, fx: { data: base }, db: { close() { record('db-close') } } }
} }))

let error: string | null = null
let result: { claude: string; codex?: string } | null = null
try {
  const { engineEnv } = await import('./engines')
  if (phase === 'call') {
    // A caller may set installed mode after another suite has already imported the module.
    fs.writeFileSync(trace, '')
    setMode()
  }
  const env = await engineEnv('installed-mode-probe')
  result = { claude: env.claude.authMode, codex: env.codex?.auth }
} catch (e) { error = e instanceof Error ? e.message : String(e) }
console.log(JSON.stringify({ error, result }))
