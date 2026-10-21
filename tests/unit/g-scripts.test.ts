// Component G: the root-run scripts (installer, uninstaller, pf-load). Running them needs root and a Mac
// (tests/install/g-macos-install.ts); this file checks what can be checked without root: the safe file helpers the
// installer uses in folders the role accounts own (scripts/macos/safe-fs.sh), run for real against planted links,
// plus syntax and the rules that keep a compromised server account from steering a root write.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from '../lib/env'

const REPO = path.resolve(import.meta.dir, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8')
fs.mkdirSync(path.join(WORK, 'g-scripts'), { recursive: true })
// real path: nolink checks every component from /, and the work folder may sit below a symlink (/tmp)
const W = fs.realpathSync(path.join(WORK, 'g-scripts'))

/** run a snippet with the helpers loaded; SAFE_ROOTS = [root] */
function helpers(root: string, snippet: string) {
  const script = `set -euo pipefail
die() { echo "die: $*" >&2; exit 9; }
SAFE_ROOTS=("$ROOT"); ITMP="$ROOT/.itmp"; mkdir -p "$ITMP"; chmod 700 "$ITMP"
. "${path.join(REPO, 'scripts', 'macos', 'safe-fs.sh')}"
${snippet}`
  const p = Bun.spawnSync(['/bin/bash', '-c', script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ROOT: root }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const me = `${process.getuid!()}:${process.getgid!()}`

describe('installer safe file helpers (safe-fs.sh)', () => {
  test('put replaces a planted symlink instead of writing through it', () => {
    const root = path.join(W, 'put')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'app'), { recursive: true })
    const victim = path.join(W, 'victim-put')
    fs.writeFileSync(victim, 'system file\n')
    fs.symlinkSync(victim, path.join(root, 'app', 'state.json'))
    fs.writeFileSync(path.join(root, 'src'), '{"ok":true}\n')
    const r = helpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 640 "$ROOT/app/state.json"`)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('system file\n')
    expect(fs.lstatSync(path.join(root, 'app', 'state.json')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(root, 'app', 'state.json'), 'utf8')).toBe('{"ok":true}\n')
    expect(fs.statSync(path.join(root, 'app', 'state.json')).mode & 0o777).toBe(0o640)
  })

  test('put replaces a planted hard link instead of writing into the linked file', () => {
    const root = path.join(W, 'put-hard')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    const victim = path.join(W, 'victim-hard')
    fs.writeFileSync(victim, 'system file\n')
    fs.linkSync(victim, path.join(root, 'config', 'server.json'))
    fs.writeFileSync(path.join(root, 'src'), 'new\n')
    expect(helpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 600 "$ROOT/config/server.json"`).code).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('system file\n')
    expect(fs.statSync(victim).mode & 0o777).not.toBe(0o600)
  })

  test('mk and put refuse a symlink anywhere on the way, and paths outside the install folders', () => {
    const root = path.join(W, 'mk')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'app', 'engines'), { recursive: true })
    const outside = path.join(W, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.chmodSync(outside, 0o755)
    fs.symlinkSync(outside, path.join(root, 'app', 'engines', 'claude'))
    const r = helpers(root, `mk ${me.replace(':', ' ')} 700 "$ROOT/app/engines/claude/abc123"`)
    expect(r.code).toBe(9)
    expect(r.err).toContain('symbolic link')
    expect(fs.existsSync(path.join(outside, 'abc123'))).toBe(false)
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755)
    fs.writeFileSync(path.join(root, 'src'), 'x')
    expect(helpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 600 "$ROOT/app/engines/claude/f"`).code).toBe(9)
    expect(helpers(root, `mk ${me.replace(':', ' ')} 700 "${outside}/x"`).err).toContain('outside the install folders')
    expect(helpers(root, `mk ${me.replace(':', ' ')} 700 "$ROOT/app/../../x"`).code).toBe(9)
    expect(helpers(root, `mk ${me.replace(':', ' ')} 750 "$ROOT/app/versions"`).code).toBe(0)
    expect(fs.statSync(path.join(root, 'app', 'versions')).mode & 0o777).toBe(0o750)
  })
})

describe('root scripts', () => {
  test('syntax', () => {
    for (const f of ['scripts/install-macos.sh', 'scripts/uninstall-macos.sh', 'scripts/macos/safe-fs.sh']) {
      expect(Bun.spawnSync(['/bin/bash', '-n', path.join(REPO, f)]).exitCode).toBe(0)
    }
    expect(Bun.spawnSync(['/bin/sh', '-n', path.join(REPO, 'scripts/macos/pf-load.sh')]).exitCode).toBe(0)
  })

  test('the installer runs no program from the install folder as root and writes there only through put', () => {
    const s = read('scripts/install-macos.sh')
    expect(s).toMatch(/^BUN="\$BUNDLE\/bin\/bun"$/m) // the bun of the bundle being installed, not app/current's
    expect(s).not.toMatch(/"\$BASE\/app\/current\/bin\/bun"\s+-e/)
    // no shell redirection straight into the install folder (put stages in the root-only $ITMP and renames)
    expect(s).not.toMatch(/>\s*"\$BASE\//)
    // chown -R only on the fresh copy it just made, never on an existing folder the server could fill with hard links
    for (const m of s.matchAll(/^[^#\n]*chown -R [^\n]*/gm)) expect(m[0]).toContain('$DEST.partial')
    // the logs top folder and crash/ are root's (launchd and newsyslog work there as root)
    expect(s).toContain('mk root wheel 755 "$LOGS"\n')
    expect(s).toContain('mk root wheel 755 "$LOGS/crash"\n')
    // a repair run stops the role accounts' processes before touching their folders
    expect(s.indexOf('pkill -KILL -u')).toBeLessThan(s.indexOf('mk root wheel 755 "$BASE"'))
  })

  test('pf-load writes only into the root-owned run/ folder, through a temp file and a rename', () => {
    const s = read('scripts/macos/pf-load.sh')
    for (const m of s.matchAll(/>\s*"([^"]+)"/g)) expect(['$T', '$TMP']).toContain(m[1]!)
    expect(s).toContain('STATUS="$BASE/run/pf.json"')
    expect(s).not.toContain('$BASE/status')
    expect(s).toMatch(/mktemp "\$BASE\/run\//)
  })

  test('the uninstaller does not chown hard links it finds in the kept data', () => {
    const s = read('scripts/uninstall-macos.sh')
    expect(s).not.toMatch(/chown -R root:wheel/)
    expect(s).toContain('-type f -links 1')
  })
})

// root/set-claude-token (subscription mode): how the owner stores the `claude setup-token` token for the server account.
// Run unprivileged here (MYCEL_SET_TOKEN_TEST=1, everything owned by the test user); the root run with the role
// accounts is in tests/install/g-macos-install.ts.
describe('set-claude-token', () => {
  const base = path.join(W, 'set-token')
  const secrets = path.join(base, 'secrets')
  const dest = path.join(secrets, 'claude-oauth-token')
  const TOKEN = 'sk-ant-oat01-' + 'a1B2_c3-'.repeat(8)
  const run = (input: string, ...args: string[]) => {
    const p = Bun.spawnSync(['/bin/bash', path.join(REPO, 'scripts', 'macos', 'set-claude-token.sh'), '--base', base, ...args],
      { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MYCEL_SET_TOKEN_TEST: '1' }, stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const fresh = () => { fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(secrets, { recursive: true }); fs.chmodSync(secrets, 0o700) }

  test('stores a setup-token from stdin as a 600 file; refuses anything else and changes nothing', () => {
    fresh()
    expect(run('hello world\n').code).not.toBe(0)
    expect(run('sk-ant-api03-' + 'x'.repeat(40) + '\n').code).not.toBe(0) // an API key is not a subscription token
    const argTok = run('', TOKEN)
    expect(argTok.code).not.toBe(0) // never on the command line
    expect(argTok.out + argTok.err).not.toContain(TOKEN) // and a token pasted there is not printed back
    expect(fs.existsSync(dest)).toBe(false)
    const r = run(`  ${TOKEN}\r\n`)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe(TOKEN + '\n')
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600)
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(fs.readdirSync(base).filter((n) => n.startsWith('.token-tmp'))).toEqual([]) // staging folder cleaned up
  })

  test('replaces a planted link instead of writing through it; --remove forgets the token', () => {
    fresh()
    const victim = path.join(W, 'victim-token')
    fs.writeFileSync(victim, 'someone else\n')
    fs.symlinkSync(victim, dest)
    expect(run(TOKEN + '\n').code).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('someone else\n')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(run('', '--remove').code).toBe(0)
    expect(fs.existsSync(dest)).toBe(false)
  })

  test('refuses a secrets folder others can open, or a linked one', () => {
    fresh()
    fs.chmodSync(secrets, 0o755)
    expect(run(TOKEN + '\n').code).not.toBe(0)
    fs.rmSync(secrets, { recursive: true })
    fs.mkdirSync(path.join(base, 'elsewhere'), { mode: 0o700 })
    fs.symlinkSync(path.join(base, 'elsewhere'), secrets)
    expect(run(TOKEN + '\n').code).not.toBe(0)
    expect(fs.readdirSync(path.join(base, 'elsewhere'))).toEqual([])
  })
})
