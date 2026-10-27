// Installed mode is not implemented: requesting it must not fall back to the owner's real CLI logins.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function probe(phase: 'import' | 'call', value: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-engine-mode-'))
  dirs.push(dir)
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), work = path.join(dir, 'work')
  for (const d of [home, bin]) fs.mkdirSync(d)
  const trace = path.join(dir, 'operations')
  fs.writeFileSync(trace, '')
  // No inherited HOME, credentials, CLI configuration or PATH. The optional outer validation guard is propagated.
  const guard = process.env.P2_VALIDATION_GUARD
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', '--no-env-file', ...(guard ? ['--preload', guard] : []), path.join(import.meta.dir, '../lib/installed-engine-probe.ts'), phase, JSON.stringify(value)],
    env: { HOME: home, PATH: bin, TMPDIR: dir, LANG: 'C', NODE_ENV: 'test', MYCEL_WORK: work, MYCEL_PROBE_TRACE: trace },
    cwd: path.resolve(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000,
  })
  expect(child.exitCode).toBe(0)
  expect(child.stderr.toString()).toBe('')
  return {
    ...JSON.parse(child.stdout.toString()) as { error: string | null; result: { claude: string; codex?: string } | null },
    operations: fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    fixtureCreated: fs.existsSync(path.join(work, 'fixture-created')),
    homeEntries: fs.readdirSync(home),
  }
}

for (const phase of ['import', 'call'] as const) {
  for (const [label, value] of [['absolute path', '/var/lib/mycel-ci'], ['empty value', ''], ['relative path', 'mycel-ci']] as const) {
    test(`installed mode at ${phase}: ${label} never enters the developer harness`, () => {
      const r = probe(phase, value)
      expect(r.operations).toEqual([])
      expect(r.fixtureCreated).toBe(false)
      expect(r.homeEntries).toEqual([])
      expect(r.result).toBeNull()
      expect(r.error).toContain('MYCEL_LOCKDOWN_INSTALLED')
      expect(r.error).toContain('not implemented')
    })
  }
}

test('absent installed-mode variable preserves developer engine setup (all side effects doubled)', () => {
  const r = probe('import', null)
  expect(r.error).toBeNull()
  expect(r.result).toEqual({ claude: 'local-login', codex: 'dev-owner-symlink' })
  expect(r.operations).toEqual(['home', 'path:claude', 'home', 'path:codex', 'fixture', 'db-close', 'home', 'catalog', 'sandbox', 'home', 'launcher', 'runner'])
  expect(r.fixtureCreated).toBe(true)
  expect(r.homeEntries).toEqual([])
})
