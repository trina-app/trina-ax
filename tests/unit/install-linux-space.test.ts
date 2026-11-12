// QA TC-339: `install-linux.sh update` with about 1 GB free stopped mycel-server and mycel-launcher, ran out of space
// while it copied the new version, and exited with both stopped, root/VERSION at the new version while the old app was
// current, and a half copy filling the disk. These tests run the installer's "update space and rollback" part (the
// text between its BEGIN and END lines) with fake folders, a fake df and a fake systemctl: the free-space refusal, and
// the EXIT trap that puts root/ back, removes the new version and starts the units that ran.
// GNU tools and bash 4+ (Linux); in Docker from the repository root:
//   docker run --rm --user 1000:1000 -v "$PWD:/src:ro" -w /src oven/bun:1.3.12-debian bun test tests/unit/install-linux-space.test.ts
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '../..')
const SCRIPT = fs.readFileSync(path.join(REPO, 'scripts', 'install-linux.sh'), 'utf8')
const part = (() => {
  const a = SCRIPT.indexOf('# BEGIN update space and rollback'), b = SCRIPT.indexOf('# END update space and rollback')
  return a > 0 && b > a ? SCRIPT.slice(a, b) : ''
})()

test('the installer checks the space and records the units before it stops anything, and keeps root/ before step 7', () => {
  expect(part).not.toBe('')
  const at = (s: string, from = 0) => { const i = SCRIPT.indexOf(s, from); expect(`${s}: ${i > 0}`).toBe(`${s}: true`); return i }
  const stop = at('\nstop_units\nkill_accounts\n')
  expect(at('\ncheck_space\n')).toBeLessThan(stop)
  expect(at('\n  stage_version\n')).toBeLessThan(stop)
  // a half copy an earlier installer left is removed before the copy needs its space (review of #541)
  expect(at('\ndrop_stale\nspace_for_version\ncheck_space\n')).toBeLessThan(at('\n  stage_version\n'))
  expect(at('\ndrop_stale\n')).toBeGreaterThan(at('# ---- wait for an update that runs ----'))
  // from the firewall step on, a run without a switch keeps the new root files too; the units mark step 13 done
  expect(at('[ "$PHASE" = switched ] || PHASE=committed')).toBeGreaterThan(at('PHASE=switched', at('# ---- 9) server version')))
  expect(at('[ "$PHASE" = switched ] || PHASE=committed')).toBeLessThan(at('FW_OUT=$('))
  expect(at('\n  UNITS_DONE=1\n')).toBeGreaterThan(at('for f in "$ITMP/units"/*; do install'))
  expect(at('\nrecord_active\nPHASE=stopped\n')).toBeLessThan(stop)
  expect(at('\ntrap on_exit EXIT\n')).toBeLessThan(stop)
  const keep = at('\nkeep_root\n')
  expect(keep).toBeGreaterThan(stop)
  expect(keep).toBeLessThan(at('# ---- 7) root-owned files ----'))
  // the switch of app/current ends the part where root/ goes back; the units running again ends the trap's work
  expect(at('PHASE=switched', at('# ---- 9) server version'))).toBeLessThan(at('put "$ITMP/state.json"'))
  expect(at('\nPHASE=started\n')).toBeGreaterThan(at('systemctl restart "$ID-server.service"'))
  expect(at('\nPHASE=started\n')).toBeLessThan(at('# ---- 15) wait until the server answers'))
  // the old copy straight into app/versions after the stop is gone: it is staged in a root-only folder
  expect(SCRIPT).not.toContain('cp -a --no-preserve=ownership "$BUNDLE" "$DEST.partial"')
})

describe.skipIf(process.platform !== 'linux')('update space and rollback (Linux)', () => {
  function setup() {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'tc339-'))
    const base = path.join(w, 'base'), bin = path.join(w, 'bin'), kit = path.join(w, 'kit', 'app', '0.5.0')
    for (const d of [path.join(base, 'root'), path.join(base, 'app', 'versions', '0.4.0'), path.join(base, 'data'), bin, path.join(kit, 'root')]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(base, 'root', 'VERSION'), '0.4.0\n')
    fs.writeFileSync(path.join(base, 'root', 'mycel-launcher'), 'old launcher')
    fs.symlinkSync('versions/0.4.0', path.join(base, 'app', 'current'))
    fs.writeFileSync(path.join(kit, 'main.js'), 'x'.repeat(200_000))
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${w}/calls'\ncase "$1" in is-active) echo active ;; esac\n`, { mode: 0o755 })
    // df -Pk: FREE_KB available (the test sets it)
    // FREE_KB=fail: df fails; FREE_KB=quota:N: a disk of N KB that holds only the test folder
    fs.writeFileSync(path.join(bin, 'df'), `#!/bin/bash
case "$FREE_KB" in fail) echo "df: cannot read" >&2; exit 1 ;; quota:*) F=$(( \${FREE_KB#quota:} - $(du -sk '${w}' | cut -f1) )) ;; *) F=$FREE_KB ;; esac
printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 100000000 0 %s 0%% /\\n" "$F"\n`, { mode: 0o755 })
    const run = (snippet: string, freeKb: number | string = 50_000_000) => {
      const script = `set -euo pipefail
SYSTEMD=1 UNIT_DIR='${w}/units'
BASE='${base}' ID=mycel CMD=update VERSION=0.5.0 BUNDLE='${kit}' KROOT='${kit}/root' CLAUDE_FILE='' CODEX_FILE='' SRV_USER=$(id -un) SRV_GRP=$(id -gn)
KIT_WORK=$(mktemp -d) RKIT='${w}/rkit' ITMP='${base}/.install-tmp'
die() { echo "install: $*" >&2; exit 1; }
say() { echo "install: $*"; }
have_systemd() { return 0; }
chown() { [ "$1" = root:root ] || command chown "$@"; }  # (not root here)
${part}
trap on_exit EXIT
${snippet}`
      const p = Bun.spawnSync(['bash', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, FREE_KB: String(freeKb) }, stdout: 'pipe', stderr: 'pipe' })
      const calls = fs.existsSync(path.join(w, 'calls')) ? fs.readFileSync(path.join(w, 'calls'), 'utf8') : ''
      fs.rmSync(path.join(w, 'calls'), { force: true })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), calls }
    }
    fs.mkdirSync(path.join(w, 'units'))
    return { w, base, run, done: () => fs.rmSync(w, { recursive: true, force: true }) }
  }

  test('not enough space: refused before anything stops, in plain words with how much is needed and free', () => {
    const t = setup()
    try {
      const r = t.run(`need_on "$BASE/app/versions" 1048576\ncheck_space\nrecord_active\nPHASE=stopped\necho stopped`, 1_000_000)
      expect(r.code).toBe(1)
      expect(r.out).not.toContain('stopped')
      expect(r.err).toContain('not enough free space for 0.5.0')
      expect(r.err).toContain('it needs about 1.5 GB free, it has 1.0 GB')
      expect(r.err).toContain('Nothing was changed and the server keeps running')
      expect(r.calls).toBe('') // nothing asked of systemd, nothing started or stopped
      expect(fs.readFileSync(path.join(t.base, 'root', 'VERSION'), 'utf8')).toBe('0.4.0\n')
      // enough space passes; a half copy an earlier run left counts as free (it is removed after the stop)
      expect(t.run(`need_on "$BASE/app/versions" 1048576\ncheck_space\necho ok`, 2_000_000).out).toContain('ok')
      expect(t.run(`need_on "$BASE/app/versions" $(( 1048576 - 600000 ))\ncheck_space\necho ok`, 1_000_000).out).toContain('ok')
    } finally { t.done() }
  })

  test('a failure after the stop puts root/ back, removes the new version and the staged copy, starts the units that ran', () => {
    const t = setup()
    try {
      const r = t.run(`stage_version
OLD_CURRENT=$(readlink "$BASE/app/current")
record_active
PHASE=stopped
keep_root
# step 7 replaces root's files (install unlinks first), step 9 renames the version in, then a step fails
printf '0.5.0\\n' > "$KIT_WORK/v"; install -m 644 "$KIT_WORK/v" "$BASE/root/VERSION"
printf 'new launcher' > "$KIT_WORK/l"; install -m 755 "$KIT_WORK/l" "$BASE/root/mycel-launcher"
printf 'new' > "$KIT_WORK/n"; install -m 644 "$KIT_WORK/n" "$BASE/root/only-in-new"
DEST="$BASE/app/versions/$VERSION"; [ -e "$DEST" ] || DEST_NEW=1
mv -T "$STAGE/$VERSION" "$DEST"
mkdir "$DEST.partial"
die "installing root/mycel-sandbox failed"`)
      expect(r.code).toBe(1)
      expect(r.err).toContain('install: installing root/mycel-sandbox failed')
      expect(r.err).toContain('the update did not finish (exit 1)')
      expect(r.err).toContain('is as it was and 0.4.0 is still the app; started again: mycel-firewall.timer mycel-launcher.service mycel-server.service mycel-update.timer')
      expect(fs.readFileSync(path.join(t.base, 'root', 'VERSION'), 'utf8')).toBe('0.4.0\n')
      expect(fs.readFileSync(path.join(t.base, 'root', 'mycel-launcher'), 'utf8')).toBe('old launcher')
      expect(fs.existsSync(path.join(t.base, 'root', 'only-in-new'))).toBe(false)
      expect(fs.readdirSync(path.join(t.base, 'app', 'versions'))).toEqual(['0.4.0'])
      expect(fs.readlinkSync(path.join(t.base, 'app', 'current'))).toBe('versions/0.4.0')
      expect(fs.readdirSync(t.base).sort()).toEqual(['app', 'data', 'root'])
      expect(r.calls.split('\n').filter((l) => l.startsWith('start '))).toEqual(['start mycel-firewall.timer', 'start mycel-launcher.service', 'start mycel-server.service', 'start mycel-update.timer'])
    } finally { t.done() }
  })

  test('a unit that was stopped before the update stays stopped; the copy of root/ costs no space (hard links)', () => {
    const t = setup()
    try {
      fs.writeFileSync(path.join(t.w, 'bin', 'systemctl'), `#!/bin/sh\necho "$*" >> '${t.w}/calls'\ncase "$1 $2" in "is-active mycel-update.timer") echo inactive ;; is-active*) echo active ;; esac\n`, { mode: 0o755 })
      const r = t.run(`record_active\nPHASE=stopped\nkeep_root\nstat -c %h "$BASE/root/mycel-launcher"\nexit 3`)
      expect(r.code).toBe(3)
      expect(r.out.trim()).toBe('2')
      expect(r.calls).not.toContain('start mycel-update.timer')
      expect(r.calls).toContain('start mycel-server.service')
    } finally { t.done() }
  })

  test('a copy of root/ that stopped half way is never put back (found in the VM: a file that cannot be linked)', () => {
    const t = setup()
    try {
      // cp -al links some files, then fails (an immutable file cannot get a second link: EPERM)
      const r = t.run(`cp() { if [ "$1" = -al ]; then command cp -al "$2" "$3"; rm -f "$3/mycel-launcher"; return 1; fi; command cp "$@"; }
record_active
PHASE=stopped
keep_root
echo kept`)
      expect(r.code).toBe(1)
      expect(r.out).not.toContain('kept')
      expect(r.err).toContain('keeping a copy of')
      expect(fs.readFileSync(path.join(t.base, 'root', 'mycel-launcher'), 'utf8')).toBe('old launcher')
      expect(fs.readdirSync(t.base).sort()).toEqual(['app', 'data', 'root'])
      expect(r.calls).toContain('start mycel-server.service')
    } finally { t.done() }
  })

  test('a half copy an earlier installer left (TC-339 box) is removed before the copy; df that fails says so', () => {
    const t = setup()
    try {
      // a 3 MB disk: the kit (~200 KB), a 2.5 MB leftover partial; the margin is set small for this disk
      fs.mkdirSync(path.join(t.base, 'app', 'versions', '0.5.0.partial'))
      fs.writeFileSync(path.join(t.base, 'app', 'versions', '0.5.0.partial', 'big'), Buffer.alloc(2_500_000, 1))
      fs.mkdirSync(path.join(t.base, '.install-stage', '0.5.0'), { recursive: true })
      fs.writeFileSync(path.join(t.base, '.install-stage', '0.5.0', 'big'), Buffer.alloc(300_000, 1))
      const r = t.run(`SPACE_MARGIN_KB=100\nspace_for_version\ncheck_space\necho early-ok\ndrop_stale\nspace_for_version\ncheck_space\nstage_version\nls "$STAGE"`, 'quota:3300')
      expect(r.err).toBe('')
      expect(r.out).toContain('early-ok')
      expect(r.out).toContain('removed app/versions/0.5.0.partial')
      expect(r.out.trim().split('\n').pop()).toBe('0.5.0')
      expect(fs.readdirSync(path.join(t.base, 'app', 'versions'))).toEqual(['0.4.0'])
      // without the leftovers counted as free the same disk refuses
      const full = t.run(`SPACE_MARGIN_KB=100\nNEED_KB=() NEED_AT=()\nneed_on "$BASE/app/versions" 3200\ncheck_space`, 'quota:3300')
      expect(full.err).toContain('not enough free space')
      const df = t.run(`need_on "$BASE/app/versions" 1\ncheck_space`, 'fail')
      expect(df.code).toBe(1)
      expect(df.err).toContain('cannot read the free space of')
      expect(df.err).not.toContain('0.0 GB')
    } finally { t.done() }
  })

  test('a second Ctrl-C while the trap puts root/ back is ignored: root/ is whole and the units start', () => {
    const t = setup()
    try {
      const r = t.run(`trap 'exit 130' INT
trap 'exit 143' TERM HUP
mv() { command mv "$@"; if [ "$2" = "$BASE/root" ]; then kill -INT $$; kill -TERM $$; fi; }
record_active\nPHASE=stopped\nkeep_root
printf '0.5.0\\n' > "$KIT_WORK/v"; install -m 644 "$KIT_WORK/v" "$BASE/root/VERSION"
kill -INT $$
sleep 5`)
      expect(r.code).toBe(130)
      expect(fs.readFileSync(path.join(t.base, 'root', 'VERSION'), 'utf8')).toBe('0.4.0\n')
      expect(fs.readdirSync(t.base).sort()).toEqual(['app', 'data', 'root'])
      expect(r.calls).toContain('start mycel-server.service')
      expect(r.err).toContain('the update did not finish (exit 130)')
    } finally { t.done() }
  })

  test('a failure in the last steps of a run without a switch keeps the new root files; units rendered when step 13 had not run', () => {
    const t = setup()
    try {
      fs.writeFileSync(path.join(t.base, 'root', 'mycel-ctl'), '#!/bin/sh\n# render-units --base B --out D\necho "[Unit]" > "$5/mycel-server.service"\n', { mode: 0o755 })
      const r = t.run(`CMD=repair\nrecord_active\nPHASE=stopped\nkeep_root
printf '0.5.0\\n' > "$KIT_WORK/v"; install -m 644 "$KIT_WORK/v" "$BASE/root/VERSION"
PHASE=committed\ndie "loading the engine firewall failed"`)
      expect(r.code).toBe(1)
      expect(fs.readFileSync(path.join(t.base, 'root', 'VERSION'), 'utf8')).toBe('0.5.0\n')
      expect(r.err).toContain('the repair did not finish in its last steps (exit 1): the root files of 0.5.0 stay')
      expect(r.err).not.toContain('is as it was')
      expect(fs.readFileSync(path.join(t.w, 'units', 'mycel-server.service'), 'utf8')).toBe('[Unit]\n')
      expect(r.calls).toContain('daemon-reload')
      expect(r.calls).toContain('start mycel-server.service')
      // once step 13 put the units in, they are not rendered again
      fs.rmSync(path.join(t.w, 'units', 'mycel-server.service'))
      const r2 = t.run(`record_active\nPHASE=switched\nUNITS_DONE=1\nexit 1`)
      expect(fs.existsSync(path.join(t.w, 'units', 'mycel-server.service'))).toBe(false)
      expect(r2.calls).not.toContain('daemon-reload')
    } finally { t.done() }
  })

  test('after the switch: root/ stays new, the units start again; success and a failure before the stop start nothing', () => {
    const t = setup()
    try {
      const sw = t.run(`record_active\nPHASE=stopped\nkeep_root\nprintf '0.5.0\\n' > "$KIT_WORK/v"; install -m 644 "$KIT_WORK/v" "$BASE/root/VERSION"\nPHASE=switched\nexit 1`)
      expect(sw.code).toBe(1)
      expect(fs.readFileSync(path.join(t.base, 'root', 'VERSION'), 'utf8')).toBe('0.5.0\n')
      expect(sw.err).toContain('did not finish after the switch to 0.5.0')
      expect(sw.calls).toContain('start mycel-server.service')
      for (const snippet of ['record_active\nPHASE=stopped\nkeep_root\nPHASE=started\nexit 0', 'record_active\nPHASE=started\nexit 1', 'stage_version\nexit 1']) {
        const r = t.run(snippet)
        expect(r.calls.split('\n').filter((l) => l.startsWith('start '))).toEqual([])
        expect(fs.existsSync(path.join(t.base, '.install-stage'))).toBe(false)
        expect(fs.existsSync(path.join(t.base, '.install-root-old'))).toBe(false)
      }
    } finally { t.done() }
  })
})
