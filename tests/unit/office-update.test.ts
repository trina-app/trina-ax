// Office mode automatic updates (docs/OFFICE.md "자동 업데이트", server/src/office/update.ts, release.ts): the signed
// manifest (signature, channel, files on the feed), downgrade and minFrom refusal, download hash / size checks, a whole
// run with a fake bundle (install, data untouched, rollback when the new version does not answer, the nightly run
// not retrying a rolled-back version), the Windows installer + latest.yml in data/downloads (index.json), the
// LaunchAgent plist, the web endpoints, and the desktop updater's configuration. The live run on a real install from
// the zip is tests/install/office-update-e2e.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { decide, fileUrl, manifestUrl, publicKeyOf, signRelease, verifyRelease, type OfficeRelease } from '../../server/src/office/release'
import {
  checkLatestYml, deliverWindows, download, feedOf, nextWindow, readIndex, readUpdateState, runUpdate, updatePlist, updateView, writeUpdateSettings,
  sha256File, type UpdateDeps,
} from '../../server/src/office/update'
import { settingsFrom } from '../../server/src/office/settings'
import { officeUpdateHooks } from '../../server/src/routes/office-update'
import builderConfig from '../../desktop/electron-builder.config'
import { compareVersions as desktopCompare, feedUrlFor, genericFeed, macNotice, updateMode } from '../../desktop/src/common/update'
import { harness, withOwner, addMember, OWNER_PW, type Harness } from './a-lib'
import { WORK } from '../lib/env'
import { PRODUCT } from '@mycel/shared'

const BASE = path.join(WORK, 'office-update')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const REPO = path.resolve(import.meta.dir, '..', '..')
const FEED = 'http://127.0.0.1:45999'
const keyPem = (crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)
const KEYS = [publicKeyOf(keyPem)]
const otherPem = (crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')

function release(over: Partial<OfficeRelease> = {}, files: { name: string; bytes: Uint8Array }[] = [{ name: 'TeamAX-office-0.3.0-mac.zip', bytes: new Uint8Array([1, 2, 3]) }]): OfficeRelease {
  const version = over.version ?? '0.3.0'
  return {
    format: 1, product: 'teamax-office', channel: 'beta', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: 'n',
    office: files.map((f) => ({ arch: 'universal' as const, file: f.name, url: fileUrl(FEED, version, f.name), sha256: sha(f.bytes), size: f.bytes.byteLength })),
    windows: null,
    ...over,
  }
}

describe('signed release manifest', () => {
  const ctx = { keys: KEYS, channel: 'beta' as const, feed: FEED }
  test('a manifest signed with a baked key verifies; the payload is returned', () => {
    const r = verifyRelease(signRelease(release(), keyPem), ctx)
    expect(r.version).toBe('0.3.0')
    expect(manifestUrl(FEED, 'beta')).toBe(`${FEED}/office/beta.json`)
  })
  test('a changed payload, another key, a missing signature or plain JSON is refused', () => {
    const env = JSON.parse(signRelease(release(), keyPem))
    const tampered = { ...env, payload: env.payload.replace('"0.3.0"', '"0.9.0"') }
    expect(() => verifyRelease(JSON.stringify(tampered), ctx)).toThrow(/signature does not verify/)
    expect(() => verifyRelease(signRelease(release(), otherPem), ctx)).toThrow(/unknown key/)
    expect(() => verifyRelease(JSON.stringify({ ...env, sig: '' }), ctx)).toThrow(/does not verify/)
    expect(() => verifyRelease(JSON.stringify(release()), ctx)).toThrow(/not a signed manifest/)
    expect(() => verifyRelease(signRelease(release(), keyPem), { ...ctx, keys: [] })).toThrow(/no release key/)
  })
  test('a release of the other channel is refused (a beta build offered as stable)', () => {
    expect(() => verifyRelease(signRelease(release({ channel: 'beta' }), keyPem), { ...ctx, channel: 'stable' })).toThrow(/stable manifest is a beta release/)
  })
  test('every file must be on the feed and named by its URL', () => {
    const off = release()
    off.office[0]!.url = 'https://evil.example/TeamAX-office-0.3.0-mac.zip'
    expect(() => verifyRelease(signRelease(off, keyPem), ctx)).toThrow(/not on the release feed/)
    const named = release()
    named.office[0]!.url = fileUrl(FEED, '0.3.0', 'other.zip')
    expect(() => verifyRelease(signRelease(named, keyPem), ctx)).toThrow(/does not name/)
    expect(() => signRelease(release({ version: '../x' }), keyPem)).toThrow()
  })
  test('the build trusts the key in ~/.config/teamax-release (public part baked into release.ts)', async () => {
    const { OFFICE_RELEASE_KEYS } = await import('../../server/src/office/release')
    expect(OFFICE_RELEASE_KEYS.length).toBeGreaterThan(0)
    for (const k of OFFICE_RELEASE_KEYS) expect(Buffer.from(k, 'base64').length).toBe(32)
    // the private key is never in the repository
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO, stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean)
    for (const f of tracked.filter((x) => /\.(pem|key)$/.test(x))) expect(fs.readFileSync(path.join(REPO, f), 'utf8')).not.toContain('PRIVATE KEY')
  })
})

describe('what an installed version does with a release', () => {
  test('newer: install; same: current; older: never (no downgrade); below minFrom: by hand', () => {
    expect(decide('0.2.0', { version: '0.3.0', minFrom: '0.2.0-0' }).kind).toBe('install')
    expect(decide('0.3.0', { version: '0.3.0', minFrom: '0.2.0-0' }).kind).toBe('current')
    expect(decide('0.3.0', { version: '0.2.9', minFrom: '0.2.0-0' }).kind).toBe('older')
    expect(decide('0.3.0-beta.10', { version: '0.3.0-beta.9', minFrom: '0.2.0-0' }).kind).toBe('older')
    expect(decide('0.3.0-beta.2', { version: '0.3.0', minFrom: '0.2.0-0' }).kind).toBe('install')
    const old = decide('0.1.0', { version: '0.3.0', minFrom: '0.2.0-0' })
    expect(old.kind).toBe('too-old')
    expect(decide('0.2.0-beta.1', { version: '0.2.0-beta.2', minFrom: '0.2.0-0' }).kind).toBe('install')
  })
  test('the feed is updates.treesoop.com unless a test points at this Mac', () => {
    expect(feedOf({})).toBe('https://updates.treesoop.com')
    expect(feedOf({ feed: 'https://evil.example' })).toBe('https://updates.treesoop.com')
    expect(feedOf({ feed: 'http://192.168.1.5:80' })).toBe('https://updates.treesoop.com')
    expect(feedOf({ feed: 'http://127.0.0.1:45999' })).toBe('http://127.0.0.1:45999')
  })
})

/** fetch answering from a map of URL -> bytes (anything else 404) */
function fakeFetch(files: Map<string, Uint8Array | string>, seen: string[] = []): UpdateDeps['fetch'] {
  return async (url) => {
    const u = url.split('?')[0]!
    seen.push(u)
    const b = files.get(u)
    if (b === undefined) return new Response('nf', { status: 404 })
    return new Response(typeof b === 'string' ? b : new Uint8Array(b))
  }
}

describe('download', () => {
  const dir = path.join(BASE, 'dl')
  const bytes = crypto.randomBytes(200_000)
  const f = { file: 'x.zip', url: `${FEED}/office/0.3.0/x.zip`, sha256: sha(bytes), size: bytes.byteLength }
  test('the right file is kept; a wrong hash or a larger file is refused and nothing is left', async () => {
    expect(fs.readFileSync(await download(f, dir, { fetch: fakeFetch(new Map([[f.url, bytes]])) }))).toEqual(bytes)
    fs.rmSync(dir, { recursive: true, force: true })
    const bad = Buffer.from(bytes); bad[5] ^= 1
    await expect(download(f, dir, { fetch: fakeFetch(new Map([[f.url, bad]])) })).rejects.toThrow(/does not match the signed release/)
    await expect(download(f, dir, { fetch: fakeFetch(new Map([[f.url, Buffer.concat([bytes, Buffer.from('x')])]])) })).rejects.toThrow(/larger than the release/)
    await expect(download(f, dir, { fetch: fakeFetch(new Map()) })).rejects.toThrow(/HTTP 404/)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

// ---- a whole run with a fake bundle -------------------------------------------------------------------------------

/** the fake bundle's installer: --check-only passes; otherwise app -> app.previous, the bundle's app -> app, like
 * office-install.sh (FAIL_INSTALL in the bundle: exit 3 before changing anything) */
const FAKE_INSTALLER = `#!/bin/bash
PREFIX=""; CHECK=0
while [ $# -gt 0 ]; do case "$1" in --prefix) PREFIX=$2; shift 2;; --check-only) CHECK=1; shift;; *) shift;; esac; done
SRC=$(cd "$(dirname "$0")" && pwd)
[ "$CHECK" = 1 ] && { echo "check ok"; exit 0; }
[ -f "$SRC/FAIL_INSTALL" ] && exit 3
rm -rf "$PREFIX/app.previous"; mv "$PREFIX/app" "$PREFIX/app.previous"; cp -R "$SRC/app" "$PREFIX/app"; echo installed
`

function makeZip(version: string, o: { failInstall?: boolean } = {}): Uint8Array {
  const stage = path.join(BASE, `bundle-${version}-${crypto.randomBytes(3).toString('hex')}`)
  const top = path.join(stage, `${PRODUCT.officeBundle}-${version}`)
  fs.mkdirSync(path.join(top, 'app'), { recursive: true })
  fs.writeFileSync(path.join(top, 'app', 'VERSION'), version + '\n')
  fs.writeFileSync(path.join(top, 'office-install.sh'), FAKE_INSTALLER, { mode: 0o755 })
  if (o.failInstall) fs.writeFileSync(path.join(top, 'FAIL_INSTALL'), '')
  const zip = path.join(stage, 'b.zip')
  expect(Bun.spawnSync(['/usr/bin/ditto', '-c', '-k', '--keepParent', top, zip]).exitCode).toBe(0)
  return fs.readFileSync(zip)
}

function makeHome(name: string, version: string): string {
  const home = path.join(BASE, name)
  fs.rmSync(home, { recursive: true, force: true })
  for (const d of ['app', 'data', 'team', 'tls', 'config']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, 'app', 'VERSION'), version + '\n')
  fs.writeFileSync(path.join(home, 'data', 'app.db'), 'database')
  fs.writeFileSync(path.join(home, 'team', 'notes.txt'), 'team file')
  fs.writeFileSync(path.join(home, 'tls', 'ca.crt'), 'ca')
  fs.writeFileSync(path.join(home, 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.test-update\n')
  writeUpdateSettings(home, { channel: 'beta', feed: FEED })
  return home
}

const dataOf = (home: string) => ['data/app.db', 'team/notes.txt', 'tls/ca.crt', 'config/office.env'].map((f) => fs.readFileSync(path.join(home, f), 'utf8'))

interface Fake { deps: Partial<UpdateDeps>; calls: string[]; down: Set<string> }
/** health answers with app/VERSION unless that version is in `down` (it "does not start") */
function fakeDeps(home: string, files: Map<string, Uint8Array | string>): Fake {
  const calls: string[] = []
  const down = new Set<string>()
  let t = Date.now()
  return {
    calls, down,
    deps: {
      fetch: fakeFetch(files),
      async exec(cmd, o) {
        const joined = cmd.join(' ')
        if (cmd.some((c) => c.endsWith('admin.js'))) { calls.push(`backup ${cmd.slice(3).join(' ')}`); return { code: 0, out: '' } }
        if (cmd.some((c) => c.endsWith('office.js'))) { calls.push('old install'); return { code: 0, out: '' } }
        if (cmd[0] === '/bin/bash') calls.push(`installer ${cmd.slice(2).join(' ').replace(home, '<home>')}`)
        const p = Bun.spawnSync(cmd, { cwd: o.cwd, env: o.env, stdout: 'pipe', stderr: 'pipe' })
        return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() + (joined ? '' : '') }
      },
      async health() {
        const v = fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()
        return down.has(v) ? null : v
      },
      async stopAgents() { calls.push('stop agents') },
      sleep: async (ms) => { t += ms },
      now: () => new Date(t),
      log: () => {},
    },
  }
}

function publish(files: Map<string, Uint8Array | string>, version: string, zip: Uint8Array, over: Partial<OfficeRelease> = {}) {
  const name = `${PRODUCT.officeBundle}-${version}-mac.zip`
  files.set(fileUrl(FEED, version, name), zip)
  files.set(manifestUrl(FEED, 'beta'), signRelease(release({ version, ...over }, [{ name, bytes: zip }]), keyPem))
}

describe('a whole update run (fake bundle, fake health)', () => {
  const short = { healthWaitMs: 10_000, stableMs: 1000, idleWaitMs: 1000, keys: KEYS }
  // Office mode is one Mac (docs/OFFICE.md): the updater unpacks the office zip with /usr/bin/ditto (update.ts
  // unpack) and the fake bundle is made with it too. Linux servers update through system/update.ts (tar + zstd), with
  // its own tests (g-update*.test.ts). The runs that need a release zip are macOS only; the rest run everywhere.
  const withZip = test.skipIf(process.platform !== 'darwin')

  withZip('newer version: check, backup, install, health with the new version; data/, team/, tls/, config/ untouched', async () => {
    const home = makeHome('run-ok', '0.2.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.3.0', makeZip('0.3.0'))
    const before = dataOf(home)
    const f = fakeDeps(home, files)
    const chk = await runUpdate(home, { reason: 'check', deps: f.deps, ...short })
    expect(chk.kind).toBe('available')
    expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
    const r = await runUpdate(home, { reason: 'schedule', deps: f.deps, ...short })
    expect(r).toMatchObject({ kind: 'updated', version: '0.3.0' })
    expect(f.calls).toEqual(['installer --prefix <home> --update --check-only', 'backup --scope db --kind pre-update', 'installer --prefix <home> --update'])
    expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.3.0')
    expect(fs.readFileSync(path.join(home, 'app.previous', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
    expect(dataOf(home)).toEqual(before)
    const st = readUpdateState(home)
    expect(st.lastUpdate).toMatchObject({ from: '0.2.0', to: '0.3.0', result: 'updated' })
    expect(st.running).toBeNull()
    expect(st.available).toBeNull()
    expect(fs.existsSync(path.join(home, 'update', 'staging'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'update', 'lock'))).toBe(false)
    // the same version again: nothing to do
    expect((await runUpdate(home, { reason: 'schedule', deps: f.deps, ...short })).kind).toBe('up-to-date')
  })

  withZip('downgrade and minFrom: refused, nothing downloaded or installed', async () => {
    const home = makeHome('run-down', '0.3.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.2.5', makeZip('0.2.5'))
    const f = fakeDeps(home, files)
    const r = await runUpdate(home, { reason: 'now', deps: f.deps, ...short })
    expect(r.kind).toBe('refused')
    expect(r.message).toMatch(/no downgrades/)
    expect(f.calls).toEqual([])
    const home2 = makeHome('run-minfrom', '0.2.0')
    const files2 = new Map<string, Uint8Array | string>()
    publish(files2, '0.4.0', makeZip('0.4.0'), { minFrom: '0.3.0' })
    const f2 = fakeDeps(home2, files2)
    const r2 = await runUpdate(home2, { reason: 'now', deps: f2.deps, ...short })
    expect(r2.kind).toBe('refused')
    expect(r2.message).toMatch(/only from 0\.3\.0/)
    expect(f2.calls).toEqual([])
    expect(readUpdateState(home2).available?.version).toBe('0.4.0')
  })

  test('a channel with no release yet (404) is up to date, not a failure', async () => {
    const home = makeHome('run-404', '0.2.0')
    const r = await runUpdate(home, { reason: 'schedule', deps: fakeDeps(home, new Map()).deps, ...short })
    expect(r).toMatchObject({ kind: 'up-to-date', version: '0.2.0' })
  })

  withZip('a manifest that does not verify installs nothing', async () => {
    const home = makeHome('run-badsig', '0.2.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.3.0', makeZip('0.3.0'))
    files.set(manifestUrl(FEED, 'beta'), signRelease(release({ version: '0.3.0' }), otherPem))
    const f = fakeDeps(home, files)
    const r = await runUpdate(home, { reason: 'now', deps: f.deps, ...short })
    expect(r.kind).toBe('refused')
    expect(f.calls).toEqual([])
  })

  withZip('the new version does not answer: rolled back to the old one, data intact; the nightly run does not retry it, "now" does', async () => {
    const home = makeHome('run-rollback', '0.2.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.3.0', makeZip('0.3.0'))
    const before = dataOf(home)
    const f = fakeDeps(home, files)
    f.down.add('0.3.0')
    const r = await runUpdate(home, { reason: 'now', deps: f.deps, ...short })
    expect(r.kind).toBe('rolled-back')
    expect(r.message).toMatch(/did not answer.*rolled back to 0\.2\.0/)
    expect(f.calls.slice(-2)).toEqual(['stop agents', 'old install'])
    expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
    expect(fs.readFileSync(path.join(home, 'app.failed', 'VERSION'), 'utf8').trim()).toBe('0.3.0')
    expect(fs.existsSync(path.join(home, 'app.previous'))).toBe(false)
    expect(dataOf(home)).toEqual(before)
    const st = readUpdateState(home)
    expect(st.lastUpdate).toMatchObject({ from: '0.2.0', to: '0.3.0', result: 'rolled-back' })
    expect(Object.keys(st.failed)).toEqual(['0.3.0'])
    // tonight: not again
    f.calls.length = 0
    const night = await runUpdate(home, { reason: 'schedule', deps: f.deps, ...short })
    expect(night.kind).toBe('skipped')
    expect(f.calls).toEqual([])
    // asked for: tried again (and now it starts)
    f.down.clear()
    const now = await runUpdate(home, { reason: 'now', deps: f.deps, ...short })
    expect(now.kind).toBe('updated')
    expect(readUpdateState(home).failed).toEqual({})
    expect(fs.existsSync(path.join(home, 'app.failed'))).toBe(false)
  })

  withZip('an installer that fails before changing anything: the old version is started again, app untouched', async () => {
    const home = makeHome('run-installfail', '0.2.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.3.0', makeZip('0.3.0', { failInstall: true }))
    const f = fakeDeps(home, files)
    const r = await runUpdate(home, { reason: 'now', deps: f.deps, ...short })
    expect(r.kind).toBe('rolled-back')
    expect(r.message).toMatch(/installer exited 3/)
    expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
    expect(fs.existsSync(path.join(home, 'app.failed'))).toBe(false)
  })

  withZip('paused: the nightly run does nothing; a zip that is not the release is refused before installing', async () => {
    const home = makeHome('run-paused', '0.2.0')
    const files = new Map<string, Uint8Array | string>()
    publish(files, '0.3.0', makeZip('0.3.0'))
    writeUpdateSettings(home, { paused: true })
    const f = fakeDeps(home, files)
    expect((await runUpdate(home, { reason: 'schedule', deps: f.deps, ...short })).kind).toBe('paused')
    expect(f.calls).toEqual([])
    // a signed release whose zip holds another version
    writeUpdateSettings(home, { paused: false })
    const files2 = new Map<string, Uint8Array | string>()
    publish(files2, '0.3.0', makeZip('0.2.9'))
    const r = await runUpdate(home, { reason: 'now', deps: fakeDeps(home, files2).deps, ...short })
    expect(r.kind).toBe('failed')
    expect(r.message).toContain(`${PRODUCT.officeBundle}-0.3.0`)
    expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
  })
})

// ---- the Windows app in data/downloads ------------------------------------------------------------------------

/** a minimal PE32 with the NSIS header on a 512-byte boundary (what `teamax desktop add` accepts; office-desktop.test.ts) */
function fakeExe(size = 64 * 1024): Buffer {
  const b = crypto.randomBytes(size)
  b.write('MZ', 0, 'latin1')
  const pe = 0x80
  b.writeUInt32LE(pe, 0x3c)
  b.write('PE\0\0', pe, 'latin1')
  b.writeUInt16LE(0x10b, pe + 24)
  const dirs = pe + 24 + 96
  for (let i = 0; i < 16 * 8; i++) b[dirs + i] = 0
  const at = 20 * 512
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0xef, 0xbe, 0xad, 0xde]).copy(b, at)
  b.write('NullsoftInst', at + 8, 'latin1')
  b.writeUInt32LE(200, at + 20)
  b.writeUInt32LE(size - at, at + 24)
  return b
}

function latestYml(version: string, file: string, exe: Uint8Array, urlName = file) {
  const s512 = crypto.createHash('sha512').update(exe).digest('base64')
  return `version: ${version}\nfiles:\n  - url: ${urlName}\n    sha512: ${s512}\n    size: ${exe.byteLength}\npath: ${file}\nsha512: ${s512}\nreleaseDate: '2026-10-21T00:00:00.000Z'\n`
}

describe('the Windows installer for the desks (data/downloads, latest.yml, index.json)', () => {
  test('offered next to the Mac app, older Windows installer removed, latest.yml last; a second run changes nothing', async () => {
    const home = makeHome('win', '0.3.0')
    const dir = path.join(home, 'data', 'downloads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Team-AX-Setup-0.1.0-win-x64.exe'), 'old')
    fs.writeFileSync(path.join(dir, 'Team-AX-0.1.0-mac-universal.dmg'), 'dmg')
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [
      { platform: 'windows', file: 'Team-AX-Setup-0.1.0-win-x64.exe', version: '0.1.0', size: 3, signed: false },
      { platform: 'mac', file: 'Team-AX-0.1.0-mac-universal.dmg', version: '0.1.0', size: 3, signed: false },
    ] }))
    const exe = fakeExe()
    const name = 'Team-AX-Setup-0.3.0-win-x64.exe'
    const yml = latestYml('0.3.0', name, exe)
    const files = new Map<string, Uint8Array | string>([[fileUrl(FEED, '0.3.0', name), exe], [fileUrl(FEED, '0.3.0', 'latest.yml'), yml]])
    const r = release({ windows: { version: '0.3.0', installer: { file: name, url: fileUrl(FEED, '0.3.0', name), sha256: sha(exe), size: exe.byteLength }, latestYml: { file: 'latest.yml', url: fileUrl(FEED, '0.3.0', 'latest.yml'), sha256: sha(yml), size: Buffer.byteLength(yml) } } })
    expect(await deliverWindows(home, r, { fetch: fakeFetch(files), log: () => {} })).toBe('0.3.0')
    const idx = readIndex(dir)
    expect(idx.map((i) => `${i.platform} ${i.file} ${i.version}`)).toEqual(['windows Team-AX-Setup-0.3.0-win-x64.exe 0.3.0', 'mac Team-AX-0.1.0-mac-universal.dmg 0.1.0'])
    expect(idx[0]!.sha256).toBe(sha(exe))
    expect(fs.existsSync(path.join(dir, 'Team-AX-Setup-0.1.0-win-x64.exe'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')).toBe(yml)
    expect(sha256File(path.join(dir, name))).toBe(sha(exe))
    expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600)
    expect(readUpdateState(home).desktop?.version).toBe('0.3.0')
    expect(await deliverWindows(home, r, { fetch: fakeFetch(new Map()), log: () => {} })).toBeNull()
    // /downloads/latest.yml is served (electron-updater asks for it), other unlisted files are not
    const { serveDownload } = await import('../../server/src/routes/downloads')
    const y = serveDownload(new Request('http://x/downloads/latest.yml'), '/latest.yml', dir)
    expect(y.status).toBe(200)
    expect(await y.text()).toBe(yml)
    expect(y.headers.get('content-type')).toContain('yaml')
    fs.writeFileSync(path.join(dir, 'other.yml'), 'x')
    expect(serveDownload(new Request('http://x/downloads/other.yml'), '/other.yml', dir).status).toBe(404)
    expect(serveDownload(new Request('http://x/downloads/' + name), '/' + name, dir).status).toBe(200)
  })

  test('latest.yml must name exactly that installer with its sha512 and size', () => {
    const exe = crypto.randomBytes(1000)
    const s512 = crypto.createHash('sha512').update(exe).digest('base64')
    const n = 'Team-AX-Setup-0.3.0-win-x64.exe'
    expect(() => checkLatestYml(latestYml('0.3.0', n, exe), '0.3.0', n, s512, exe.byteLength)).not.toThrow()
    expect(() => checkLatestYml(latestYml('0.3.0', n, exe, 'https://evil.example/x.exe'), '0.3.0', n, s512, exe.byteLength)).toThrow(/file urls/)
    expect(() => checkLatestYml(latestYml('0.2.0', n, exe), '0.3.0', n, s512, exe.byteLength)).toThrow(/version/)
    expect(() => checkLatestYml(latestYml('0.3.0', n, exe), '0.3.0', n, 'AAAA', exe.byteLength)).toThrow(/sha512/)
    expect(() => checkLatestYml(latestYml('0.3.0', n, exe), '0.3.0', n, s512, 5)).toThrow(/size/)
  })
})

describe('the update LaunchAgent and the schedule', () => {
  test('plist: <label>.update, nightly StartCalendarInterval, not kept alive, not run at load, the log', () => {
    const s = settingsFrom('/Users/x/TeamAX', { TEAMAX_CLAUDE_BIN: '/Users/x/.local/bin/claude' })
    const p = updatePlist(s, '03:00', '/usr/bin:/bin')
    expect(p).toContain('<key>Label</key><string>app.team-ax.office.update</string>')
    expect(p).toContain('<key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>')
    expect(p).toContain('<key>RunAtLoad</key><false/>')
    expect(p).not.toContain('KeepAlive')
    expect(p).toContain('<string>/Users/x/TeamAX/app/server/src/office.js</string><string>update</string><string>run</string>')
    expect(p).toContain('/Users/x/TeamAX/logs/update.log')
    expect(p).toContain('<key>TEAMAX_CLAUDE_BIN</key><string>/Users/x/.local/bin/claude</string>')
    expect(updatePlist(s, '23:45', '/usr/bin')).toContain('<integer>23</integer><key>Minute</key><integer>45</integer>')
  })
  test('an update run rewrites the agent plist without reloading it (it is the running job) and leaves a marker the supervisor acts on later', async () => {
    const { syncUpdateAgent, reloadMarkedUpdateAgent } = await import('../../server/src/office/update-cli')
    const home = makeHome('agent-marker', '0.3.0')
    const agents = path.join(BASE, 'agents-marker')
    process.env.TEAMAX_AGENTS_DIR = agents
    try {
      const s = settingsFrom(home, { TEAMAX_LABEL: 'app.team-ax.marker-test' })
      expect(syncUpdateAgent(s, '/usr/bin', { ...process.env, TEAMAX_UPDATE_RUN: '1' })).toBe('')
      expect(fs.readFileSync(path.join(agents, 'app.team-ax.marker-test.update.plist'), 'utf8')).toContain('StartCalendarInterval')
      expect(fs.existsSync(path.join(home, 'update', 'agent-reload'))).toBe(true)
      // the same plist again: no new marker needed
      fs.rmSync(path.join(home, 'update', 'agent-reload'))
      syncUpdateAgent(s, '/usr/bin', { ...process.env, TEAMAX_UPDATE_RUN: '1' })
      expect(fs.existsSync(path.join(home, 'update', 'agent-reload'))).toBe(false)
      // while an update runs the supervisor waits
      fs.writeFileSync(path.join(home, 'update', 'agent-reload'), '')
      fs.writeFileSync(path.join(home, 'update', 'state.json'), JSON.stringify({ running: { pid: process.pid, since: new Date().toISOString(), step: 'install', phase: 'x', target: '0.3.1' } }))
      expect(reloadMarkedUpdateAgent({ ...s, label: 'app.team-ax.marker-test' })).toBe('')
      expect(fs.existsSync(path.join(home, 'update', 'agent-reload'))).toBe(true)
    } finally { delete process.env.TEAMAX_AGENTS_DIR }
  })
  test('next window: today if still ahead, else tomorrow; none while paused', () => {
    const at = (h: number, m: number) => { const d = new Date(2026, 9, 21, h, m); return d }
    expect(nextWindow('03:00', at(1, 0))!.getDate()).toBe(21)
    expect(nextWindow('03:00', at(1, 0))!.getHours()).toBe(3)
    expect(nextWindow('03:00', at(3, 0))!.getDate()).toBe(22)
    expect(nextWindow('03:00', at(14, 0), true)).toBeNull()
    expect(() => writeUpdateSettings(path.join(BASE, 'settings-x'), { time: '25:00' })).toThrow(/HH:MM/)
  })
})

describe('Admin > System endpoints', () => {
  let h: Harness
  let home: string
  const kicks: string[] = []
  beforeAll(async () => {
    home = makeHome('web', '0.2.0')
    fs.writeFileSync(path.join(home, 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.webtest\n')
    officeUpdateHooks.kickstart = (l) => kicks.push(l)
    h = await harness('office-update-web', { office: true, configFile: path.join(home, 'config', 'server.json') })
  })
  afterAll(async () => { officeUpdateHooks.kickstart = null; await h.close() })

  test('owner and admin see the state and can ask for an update / pause; a member cannot', async () => {
    const owner = await withOwner(h)
    const st = await owner.call('GET', '/api/admin/office-update')
    expect(st).toMatchObject({ current: '0.2.0', channel: 'beta', paused: false, time: '03:00', agentInstalled: false, nextWindowAt: null, running: null })
    // no update agent yet (an install from before automatic updates): "now" says how to get it
    const no = await owner.try('POST', '/api/admin/office-update', { action: 'now', password: OWNER_PW })
    expect(no.status).toBe(409)
    expect(kicks).toEqual([])
    const agents = path.join(BASE, 'agents')
    fs.mkdirSync(agents, { recursive: true })
    process.env.TEAMAX_AGENTS_DIR = agents
    fs.writeFileSync(path.join(agents, 'app.team-ax.webtest.update.plist'), '')
    try {
      // "now" asks for the password again; a request without the CSRF header is refused before anything happens
      expect((await owner.try('POST', '/api/admin/office-update', { action: 'now' })).status).toBe(403)
      expect((await owner.try('POST', '/api/admin/office-update', { action: 'now', password: 'not the password' })).status).toBe(403)
      expect((await owner.try('POST', '/api/admin/office-update', { action: 'now', password: OWNER_PW }, { 'x-mycel-csrf': '' })).status).toBe(403)
      expect(kicks).toEqual([])
      expect(fs.existsSync(path.join(home, 'update', 'request.json'))).toBe(false)
      const now = await owner.call('POST', '/api/admin/office-update', { action: 'now', password: OWNER_PW })
      expect(now.requested).toBe(true)
      expect(kicks).toEqual(['app.team-ax.webtest.update'])
      expect(JSON.parse(fs.readFileSync(path.join(home, 'update', 'request.json'), 'utf8'))).toMatchObject({ action: 'now', by: 'olga' })
      const admin = await addMember(h, owner, { username: 'adam', role: 'admin' })
      // an admin can ask for an update too (with the admin's own password): the request waits for the agent
      fs.rmSync(path.join(home, 'update', 'request.json'))
      expect((await admin.client.call('POST', '/api/admin/office-update', { action: 'now', password: admin.password })).requested).toBe(true)
      expect(kicks).toEqual(['app.team-ax.webtest.update', 'app.team-ax.webtest.update'])
      // the server only wrote the request: app/ is untouched (the agent installs)
      expect(fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim()).toBe('0.2.0')
      expect(fs.readdirSync(path.join(home, 'update')).sort()).toEqual(['request.json', 'settings.json'])
      const p = await admin.client.call('POST', '/api/admin/office-update', { action: 'pause' })
      expect(p.paused).toBe(true)
      expect(p.nextWindowAt).toBeNull()
      expect((await owner.call('POST', '/api/admin/office-update', { action: 'resume' })).paused).toBe(false)
      const member = await addMember(h, owner, { username: 'mia' })
      expect((await member.client.try('GET', '/api/admin/office-update')).status).toBe(403)
      expect((await member.client.try('POST', '/api/admin/office-update', { action: 'now' })).status).toBe(403)
      const actions = (h.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'office_update.%' ORDER BY rowid").all() as { action: string }[]).map((r) => r.action)
      expect(actions).toEqual(['office_update.now', 'office_update.now', 'office_update.pause', 'office_update.resume'])
    } finally { delete process.env.TEAMAX_AGENTS_DIR }
  })

  test('outside office mode the status is null and the actions are refused', async () => {
    const h2 = await harness('office-update-dev', {})
    try {
      const owner = await withOwner(h2)
      expect(await owner.call('GET', '/api/admin/office-update')).toBeNull()
      expect((await owner.try('POST', '/api/admin/office-update', { action: 'now', password: OWNER_PW })).status).toBe(409)
    } finally { await h2.close() }
  })

  test('the view shows the next window once the agent is installed', () => {
    const v = updateView(home, { now: new Date(2026, 9, 21, 12, 0), agentInstalled: true })
    expect(new Date(v.nextWindowAt!).getHours()).toBe(3)
  })
})

describe('desktop updater configuration', () => {
  test('Windows packaged = electron-updater; Mac = notice; unpacked = off (tests can force a mode)', () => {
    expect(updateMode('win32', true)).toBe('auto-install')
    expect(updateMode('darwin', true)).toBe('notice')
    expect(updateMode('linux', true)).toBe('off')
    expect(updateMode('win32', false)).toBe('off')
    expect(updateMode('darwin', false, 'auto-install')).toBe('auto-install')
  })
  test('the feed is the team address + /downloads/, with the session as a Bearer token; never plain http on the internet', () => {
    const tok = 'a'.repeat(43)
    expect(genericFeed('https://team.example.com', tok)).toEqual({ provider: 'generic', url: 'https://team.example.com/downloads/', requestHeaders: { Authorization: `Bearer ${tok}` } })
    expect(genericFeed('https://team.example.com', null)).toEqual({ provider: 'generic', url: 'https://team.example.com/downloads/' })
    expect(genericFeed('https://team.example.com', 'bad token\r\nx')?.requestHeaders).toBeUndefined()
    expect(feedUrlFor('http://team.example.com')).toBeNull()
    expect(feedUrlFor('http://acme.localhost:19100')).toBe('http://acme.localhost:19100/downloads/')
    expect(feedUrlFor('https://u:p@x.example')).toBeNull()
  })
  test('Mac notice: only a newer Mac app from index.json', () => {
    const idx = { items: [{ platform: 'windows', file: 'w.exe', version: '9.0.0' }, { platform: 'mac', file: 'a.dmg', version: '0.2.0' }, { platform: 'mac', file: 'b.dmg', version: '0.3.0-beta.1' }] }
    expect(macNotice(idx, '0.2.0')).toEqual({ version: '0.3.0-beta.1', file: 'b.dmg' })
    expect(macNotice(idx, '0.3.0')).toBeNull()
    expect(macNotice({ items: 'x' }, '0.1.0')).toBeNull()
    expect(desktopCompare('0.3.0-beta.10', '0.3.0-beta.9')).toBe(1)
  })
  test('electron-builder: generic publish (latest.yml + app-update.yml), no publisherName, electron-updater bundled', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8'))
    const build = builderConfig as unknown as { publish: unknown; win: Record<string, unknown>; nsis: Record<string, unknown> }
    // channel latest: a pre-release build (0.2.0-beta.2) also writes latest.yml, the file the app asks the team for
    expect(build.publish).toEqual([{ provider: 'generic', url: 'https://localhost.invalid/downloads/', channel: 'latest' }])
    expect(build.win.publisherName).toBeUndefined()
    expect(build.nsis.oneClick).toBe(true)
    expect(pkg.build).toBeUndefined() // one config: desktop/electron-builder.config.ts
    expect(pkg.devDependencies['electron-updater']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.dependencies?.['electron-updater']).toBeUndefined()
    const main = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'updater.ts'), 'utf8')
    expect(main).toContain('autoInstallOnAppQuit = true')
    expect(main).toContain('disableDifferentialDownload = true')
    expect(main).toContain('allowDowngrade = false')
  })
})
