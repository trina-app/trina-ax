// The dev environment on srt and Ubuntu 24.04 (VM check 2026-11-12, docs/DECISIONS.md "Dev environment on srt: Ubuntu
// 24.04 stays off"). AppArmor needs no profile of its own: srt's apply-seccomp inherits the installer's <ID>-bwrap. The
// stop is polkit: systemd 255 sends no unit name for a transient scope. This file runs the OS rules of install-srt.sh
// and install-linux.sh for real in bash, and checks the bwrap check and the srt probe of install-srt.sh.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { LINUX_DEV_ENV_SRT_FILES } from '../../scripts/build-bundle'

const REPO = path.resolve(import.meta.dir, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8')
const INSTALL = read('scripts/dev-env/srt/install-srt.sh')
const LINUX = read('scripts/install-linux.sh')

function bash(script: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(['/bin/bash', '-c', script], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

describe('install-srt.sh and Ubuntu 24.04', () => {
  test('the OS rule: Debian 13 only; Ubuntu 24.04 stops with the polkit reason, not AppArmor', () => {
    const rule = /^case "\$OS" in\n[\s\S]*?^esac$/m.exec(INSTALL)![0]
    const run = (os: string) => bash(`die() { echo "STOP: $*"; exit 1; }\nOS="${os}"\n${rule}\necho ok`)
    expect(run('debian 13').out).toBe('ok')
    const u = run('ubuntu 24.04').out
    expect(u).toStartWith('STOP: Ubuntu 24.04 is not supported yet')
    expect(u).toContain('systemd 255 gives polkit no unit name for a transient scope')
    expect(u).not.toMatch(/AppArmor/i)
    for (const os of ['debian 12', 'ubuntu 22.04', 'fedora 41']) expect(run(os).out).toBe('STOP: this script is for Debian 13 (found ' + os + ')')
    expect(INSTALL).not.toContain('not done yet')
  })

  test('the OS rule comes before anything changes', () => {
    expect(INSTALL.indexOf('case "$OS" in')).toBeLessThan(INSTALL.indexOf('pk_apt_install'))
    expect(INSTALL.indexOf('case "$OS" in')).toBeGreaterThan(INSTALL.indexOf('# ---- look first'))
  })

  test('no AppArmor profile of its own; bwrap is checked where user namespaces are restricted', () => {
    expect(INSTALL).not.toContain('apparmor_parser')
    expect(INSTALL).not.toContain('trina-srt')
    expect(LINUX_DEV_ENV_SRT_FILES.some((f) => f.startsWith('apparmor'))).toBe(false)
    expect(INSTALL).toContain('RESTRICT_USERNS=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)')
    const at = (s: string) => { const i = INSTALL.indexOf(s); expect(i).toBeGreaterThan(0); return i }
    const check = INSTALL.slice(at('# ---- where AppArmor restricts user namespaces: bwrap'), at('install -d -o root -g root -m 755 /etc/polkit-1/rules.d'))
    expect(check).toContain('if [ "$RESTRICT_USERNS" = 1 ]; then')
    expect(check).toContain('runuser -u "$SRV_USER" -- bwrap --unshare-user --ro-bind / / true')
    // after the image-mode exit: a chroot has no server account
    expect(at('image mode done')).toBeLessThan(at('# ---- where AppArmor restricts user namespaces: bwrap'))
  })

  test('the srt probe: one command as the server account with no_new_privs, as the server unit runs it', () => {
    expect(read('scripts/linux/systemd/server.service.in')).toContain('\nNoNewPrivileges=yes')
    const a = INSTALL.indexOf('# where AppArmor restricts user namespaces: one command through srt'), b = INSTALL.indexOf('if [ "$DROPIN_CHANGED" = 1 ]; then')
    expect(a).toBeGreaterThan(INSTALL.indexOf('the server account can start a .service: the polkit rule is too wide'))
    const probe = INSTALL.slice(a, b)
    expect(probe).toContain('if [ "$RESTRICT_USERNS" = 1 ]; then')
    expect(probe).toContain('setpriv --no-new-privs runuser -u "$SRV_USER" -- env -i')
    expect(probe).toContain('"$SRT_DIR/cli.js" -s "$PD/settings.json" -c \'echo srt-ok\'')
    expect(probe).toContain('grep -qx srt-ok <<< "$OUT"')
    expect(probe).toContain('rm -rf "$PD"\n    die ')
  })
})

describe('install-linux.sh: the dev environment rule', () => {
  const block = LINUX.slice(LINUX.indexOf('DEVENV_ON=0 DEVENV_WHY=""'), LINUX.indexOf('MACH=$(uname -m)'))
  const run = (v: Record<string, string>) => bash(`given() { return 1; }\ndie() { echo "STOP: $*"; exit 1; }\n${block}\necho "on=$DEVENV_ON why=$DEVENV_WHY"`,
    { HOSTED: '0', DEV_ENV: '', MINIMAL: '0', SYSTEMD: '1', ...v })
  test('on by default on Debian 13 only', () => {
    expect(run({ OSID: 'debian', OSVER: '13' }).out).toBe('on=1 why=')
    expect(run({ OSID: 'debian', OSVER: '12' }).out).toBe('on=0 why=off: install-srt.sh supports Debian 13 only (this is debian 12)')
  })
  test('Ubuntu 24.04: off with the polkit reason; --dev-env stops with it', () => {
    const u = run({ OSID: 'ubuntu', OSVER: '24.04' }).out
    expect(u).toStartWith('on=0 why=off: not on Ubuntu 24.04 yet (its systemd 255 gives polkit no unit name for a transient scope')
    expect(u).not.toMatch(/AppArmor|spike/i)
    expect(run({ OSID: 'ubuntu', OSVER: '24.04', DEV_ENV: '1' }).out).toStartWith('STOP: --dev-env: the dev environment is not on Ubuntu 24.04 yet')
  })
  test('the other reasons still come first', () => {
    expect(run({ OSID: 'ubuntu', OSVER: '24.04', DEV_ENV: '0' }).out).toBe('on=0 why=off (--no-dev-env)')
    expect(run({ OSID: 'ubuntu', OSVER: '24.04', MINIMAL: '1' }).out).toStartWith('on=0 why=off: --minimal')
    expect(run({ OSID: 'ubuntu', OSVER: '24.04', SYSTEMD: '0' }).out).toStartWith('on=0 why=off: it needs systemd')
    expect(run({ OSID: 'ubuntu', OSVER: '24.04', HOSTED: '1' }).out).toBe('on=0 why=')
  })
})
