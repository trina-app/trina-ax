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

// macOS scripts (BSD mv -h, stat -f): run where they run; the Linux ports have their own cases below
describe.skipIf(process.platform !== 'darwin')('installer safe file helpers (safe-fs.sh)', () => {
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
describe.skipIf(process.platform !== 'darwin')('set-claude-token', () => {
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

// ---------------- Linux (scripts/install-linux.sh, scripts/linux/*; linux-runtime spec 3.1.3, 3.5) ----------------
// The static rules run everywhere; the helpers and set-claude-token run for real on Linux only (GNU stat/mv/chmod).
// In Docker from the repository root (unprivileged, like CI):
//   docker run --rm --user 1000:1000 -e MYCEL_WORK=/tmp/work -v "$PWD:/src:ro" -w /src oven/bun:1.3.12-debian \
//     bun test tests/unit/g-scripts.test.ts
const linux = process.platform === 'linux'
function linuxHelpers(root: string, snippet: string) {
  const script = `set -euo pipefail
die() { echo "die: $*" >&2; exit 9; }
SAFE_ROOTS=("$ROOT"); ITMP="$ROOT/.itmp"; mkdir -p "$ITMP"; chmod 700 "$ITMP"
. "${path.join(REPO, 'scripts', 'linux', 'safe-fs.sh')}"
${snippet}`
  const p = Bun.spawnSync(['/bin/bash', '-c', script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ROOT: root }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('Linux root scripts: syntax and rules', () => {
  test('syntax', () => {
    for (const f of ['scripts/install-linux.sh', 'scripts/linux/safe-fs.sh', 'scripts/linux/account.sh', 'scripts/linux/set-claude-token.sh']) {
      const p = Bun.spawnSync(['/bin/bash', '-n', path.join(REPO, f)], { stderr: 'pipe' })
      expect(`${f}: ${p.exitCode} ${p.stderr.toString()}`).toBe(`${f}: 0 `)
    }
  })

  test('the installer runs no program from the install folder as root and writes there only through put / install', () => {
    const s = read('scripts/install-linux.sh')
    expect(s).toMatch(/^KBUN="\$BUNDLE\/bin\/bun"$/m) // the bun of the kit being installed, not app/current's
    expect(s).not.toMatch(/"\$BASE\/app\/[^"]*bin\/bun"/)
    expect(s).not.toMatch(/>\s*"\$BASE\//) // no shell redirection straight into the install folder
    // chown -R only on copies root just made in root-only places
    for (const m of s.matchAll(/^[^#\n]*chown -R [^\n]*/gm)) expect(/\$DEST\.partial|\$RKIT|\$SBX\.new/.test(m[0])).toBe(true)
    // a repair run stops the role accounts' processes before touching their folders
    expect(s.indexOf('\nkill_accounts\n')).toBeGreaterThan(0)
    expect(s.indexOf('\nkill_accounts\n')).toBeLessThan(s.indexOf('mk root root 755 "$BASE"\n'))
    // the firewall is loaded before the units start (fail closed), the engine version runs as the engine account
    expect(s.indexOf('firewall apply --base')).toBeLessThan(s.indexOf('systemctl restart "$ID-launcher.service"'))
    expect(s).toMatch(/runuser -u "\$AGT_USER" -- \/usr\/bin\/env -i [^\n]*bwrap --unshare-all/)
    // downloads only over https, checked against the pinned SHA-256
    expect(s).toContain('--proto =https --proto-redir =https')
    expect(s).toMatch(/sha256sum "\$out"/)
  })

  test('unit templates: the spec\'s hardening, the launcher\'s sandbox flags, only known placeholders', () => {
    const dir = path.join(REPO, 'scripts', 'linux', 'systemd')
    const known = new Set(['BASE', 'ID', 'SRV', 'AGT', 'SRV_UID', 'AGT_UID', 'PORT', 'PROXY_PORT', 'TLS_PORT', 'PUBKEYS', 'ENGINE_ARGS', 'CA_BUNDLE', 'LANDLOCK', 'CGROUP', 'ALLOW_UNSIGNED_ENV'])
    const names = fs.readdirSync(dir).sort()
    expect(names).toEqual(['firewall.service.in', 'firewall.timer.in', 'launcher.service.in', 'server.service.in', 'update.service.in', 'update.timer.in'])
    for (const n of names) for (const m of fs.readFileSync(path.join(dir, n), 'utf8').matchAll(/@([A-Z_]+)@/g)) expect(known.has(m[1]!)).toBe(true)
    const l = fs.readFileSync(path.join(dir, 'launcher.service.in'), 'utf8')
    for (const k of ['--sandbox bwrap', '--dedicated-account', '--firewall-status @BASE@/run/firewall.json', '--cgroup @CGROUP@', '--landlock @LANDLOCK@', 'Delegate=memory pids cpu', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=\n', 'KillMode=control-group'])
      expect(l).toContain(k)
    // directives that break bwrap (spec 3.2.2 "넣지 않는 것") must not be set
    for (const k of ['ProtectKernelTunables=', 'ProtectProc=', 'PrivateDevices=', 'PrivateUsers=', 'RestrictNamespaces=', 'ProtectControlGroups=', 'MemoryDenyWriteExecute=', 'SystemCallFilter='])
      for (const n of ['launcher.service.in', 'server.service.in']) expect(fs.readFileSync(path.join(dir, n), 'utf8')).not.toContain('\n' + k)
    // systemd's ProtectHostname filters sethostname: bwrap --hostname (the engine sandbox) fails with EPERM (spike S1)
    expect(l).not.toContain('\nProtectHostname=')
    const srv = fs.readFileSync(path.join(dir, 'server.service.in'), 'utf8')
    expect(srv).toContain('MYCEL_SANDBOX_HELPER=@BASE@/root/mycel-sandbox')
    expect(srv).toContain('KillMode=mixed')
    const aa = read('scripts/linux/apparmor-bwrap.in')
    expect(aa).toMatch(/profile @ID@-bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\n\s+userns,/)
  })
})

describe.skipIf(!linux)('installer safe file helpers, Linux (scripts/linux/safe-fs.sh)', () => {
  test('put replaces a planted symlink instead of writing through it', () => {
    const root = path.join(W, 'lput')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'app'), { recursive: true })
    const victim = path.join(W, 'lvictim-put')
    fs.writeFileSync(victim, 'system file\n')
    fs.symlinkSync(victim, path.join(root, 'app', 'state.json'))
    fs.writeFileSync(path.join(root, 'src'), '{"ok":true}\n')
    const r = linuxHelpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 640 "$ROOT/app/state.json"`)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('system file\n')
    expect(fs.lstatSync(path.join(root, 'app', 'state.json')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(root, 'app', 'state.json'), 'utf8')).toBe('{"ok":true}\n')
    expect(fs.statSync(path.join(root, 'app', 'state.json')).mode & 0o777).toBe(0o640)
  })

  test('put replaces a planted link to a folder (mv -T renames over the link, not into the folder)', () => {
    const root = path.join(W, 'lput-dir')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    const victimDir = path.join(W, 'lvictim-dir')
    fs.rmSync(victimDir, { recursive: true, force: true })
    fs.mkdirSync(victimDir)
    fs.symlinkSync(victimDir, path.join(root, 'config', 'server.json'))
    fs.writeFileSync(path.join(root, 'src'), 'new\n')
    expect(linuxHelpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 600 "$ROOT/config/server.json"`).code).toBe(0)
    expect(fs.readdirSync(victimDir)).toEqual([])
    expect(fs.readFileSync(path.join(root, 'config', 'server.json'), 'utf8')).toBe('new\n')
  })

  test('put replaces a planted hard link instead of writing into the linked file', () => {
    const root = path.join(W, 'lput-hard')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    const victim = path.join(W, 'lvictim-hard')
    fs.writeFileSync(victim, 'system file\n')
    fs.chmodSync(victim, 0o644)
    fs.linkSync(victim, path.join(root, 'config', 'server.json'))
    fs.writeFileSync(path.join(root, 'src'), 'new\n')
    expect(linuxHelpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 600 "$ROOT/config/server.json"`).code).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('system file\n')
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644)
  })

  test('mk and put refuse a symlink anywhere on the way, and paths outside the install folders', () => {
    const root = path.join(W, 'lmk')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'app', 'engines'), { recursive: true })
    const outside = path.join(W, 'loutside')
    fs.rmSync(outside, { recursive: true, force: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.chmodSync(outside, 0o755)
    fs.symlinkSync(outside, path.join(root, 'app', 'engines', 'claude'))
    const r = linuxHelpers(root, `mk ${me.replace(':', ' ')} 700 "$ROOT/app/engines/claude/abc123"`)
    expect(r.code).toBe(9)
    expect(r.err).toContain('symbolic link')
    expect(fs.existsSync(path.join(outside, 'abc123'))).toBe(false)
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755)
    // GNU chmod follows a link: mk on the link itself must refuse before chmod
    expect(linuxHelpers(root, `mk ${me.replace(':', ' ')} 700 "$ROOT/app/engines/claude"`).code).toBe(9)
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755)
    fs.writeFileSync(path.join(root, 'src'), 'x')
    expect(linuxHelpers(root, `put "$ROOT/src" ${me.replace(':', ' ')} 600 "$ROOT/app/engines/claude/f"`).code).toBe(9)
    expect(linuxHelpers(root, `mk ${me.replace(':', ' ')} 700 "${outside}/x"`).err).toContain('outside the install folders')
    expect(linuxHelpers(root, `mk ${me.replace(':', ' ')} 700 "$ROOT/app/../../x"`).code).toBe(9)
    expect(linuxHelpers(root, `mk ${me.replace(':', ' ')} 750 "$ROOT/app/versions"`).code).toBe(0)
    expect(fs.statSync(path.join(root, 'app', 'versions')).mode & 0o777).toBe(0o750)
  })
})

describe.skipIf(!linux)('set-claude-token, Linux', () => {
  const base = path.join(W, 'lset-token')
  const secrets = path.join(base, 'secrets')
  const dest = path.join(secrets, 'claude-oauth-token')
  const TOKEN = 'sk-ant-oat01-' + 'a1B2_c3-dE4f'.repeat(8) // 13 + 96 characters, like a real one
  const run = (input: string, ...args: string[]) => {
    const p = Bun.spawnSync(['/bin/bash', path.join(REPO, 'scripts', 'linux', 'set-claude-token.sh'), '--base', base, ...args],
      { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MYCEL_SET_TOKEN_TEST: '1' }, stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const fresh = () => { fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(secrets, { recursive: true }); fs.chmodSync(secrets, 0o700) }

  test('stores a setup-token from stdin as a 600 file; a token wrapped over lines is joined; anything else is refused', () => {
    fresh()
    expect(run('hello world\n').code).not.toBe(0)
    expect(run('sk-ant-api03-' + 'x'.repeat(96) + '\n').code).not.toBe(0) // an API key is not a subscription token
    expect(run(TOKEN.slice(0, 60) + '\n').code).not.toBe(0) // cut short (only the first line of a wrapped paste)
    const argTok = run('', TOKEN)
    expect(argTok.code).not.toBe(0)
    expect(argTok.out + argTok.err).not.toContain(TOKEN)
    expect(fs.existsSync(dest)).toBe(false)
    // a terminal wrapped the token at 40 columns, with CRs and indentation (docs/INSTALL.md known issue 14)
    const wrapped = '  ' + TOKEN.match(/.{1,40}/g)!.join('\r\n   ') + '\r\n\n'
    const r = run(wrapped)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe(TOKEN + '\n')
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600)
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(fs.readdirSync(base).filter((n) => n.startsWith('.token-tmp'))).toEqual([])
  })

  test('replaces a planted link instead of writing through it; --remove forgets the token', () => {
    fresh()
    const victim = path.join(W, 'lvictim-token')
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
