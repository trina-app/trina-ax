// docker/seccomp.json is Docker's default profile plus one rule for bubblewrap as the unprivileged engine account
// (docker/seccomp.NOTICE). TC-2853: the launcher passes --hostname mycel-turn to bwrap, the rule had no sethostname, and
// every AI turn in Docker stopped with "bwrap: Can't set hostname to mycel-turn: Operation not permitted". docker/test.sh
// runs no real AI turn, so this check ties the rule to the flags the launcher passes.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '../..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
type Rule = { names: string[]; action: string; comment?: string; includes?: { caps?: string[] }; args?: unknown[] }
const profile = JSON.parse(read('docker/seccomp.json')) as { syscalls: Rule[] }
const added = profile.syscalls.filter((r) => r.comment?.startsWith('Trina AX:'))
const launcher = read('native/cmd/mycel-launcher/sandbox_linux.go')

describe('docker/seccomp.json', () => {
  test('has one added rule: allow, no capability or argument condition', () => {
    expect(added.length).toBe(1)
    expect(added[0]!.action).toBe('SCMP_ACT_ALLOW')
    expect(added[0]!.includes).toBeUndefined()
    expect(added[0]!.args).toBeUndefined()
  })

  test('the added rule has every call bubblewrap makes for the launcher\'s flags', () => {
    const names = new Set(added[0]!.names)
    for (const n of ['clone', 'unshare', 'setns', 'mount', 'umount2', 'pivot_root']) expect(names.has(n)).toBe(true)
    // --hostname needs sethostname (Docker's default allows it only with CAP_SYS_ADMIN)
    expect(launcher).toContain('"--hostname"')
    expect(names.has('sethostname')).toBe(true)
  })

  test('docker/test.sh checks bubblewrap with --hostname, as the launcher runs each turn', () => {
    expect(read('docker/test.sh')).toMatch(/bwrap [^\n]*--hostname mycel-turn/)
  })

  test('the NOTICE and the Docker install page name the same calls', () => {
    for (const f of ['docker/seccomp.NOTICE', 'docs/INSTALL-DOCKER.md']) expect(read(f)).toContain('sethostname')
  })
})
