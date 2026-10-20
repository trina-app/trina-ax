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
