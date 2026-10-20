// Component G: the menubar app's status model (Swift), compiled and run with the command line tools on macOS.
import { expect, test } from 'bun:test'
import path from 'node:path'

const mac = process.platform === 'darwin' && !!Bun.which('swiftc')
test.skipIf(!mac)('menubar status model: parsing, replaced / firewall / switched-off states, languages', () => {
  const p = Bun.spawnSync(['bash', path.resolve(import.meta.dir, '..', '..', 'menubar', 'build.sh'), '--test'], { stdout: 'pipe', stderr: 'pipe' })
  const out = p.stdout.toString()
  if (p.exitCode !== 0) console.error(out, p.stderr.toString())
  expect(p.exitCode).toBe(0)
  expect(out).toContain('all menubar model tests passed')
}, 300_000)
