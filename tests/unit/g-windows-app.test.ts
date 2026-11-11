// The Windows desktop app on a Linux team server (server/src/system/windows-app.ts, office/update.ts offerWindows): which
// servers do it, the signed office manifest from a fake feed into a fake downloads folder (what an existing Windows app
// then reads: /downloads/latest.yml and the installer), the server's own version as the upper bound, a bad file, a held
// version, a download that broke off, no disk room, a newer app put there by hand, the lock, a folder copy for a server
// without internet, and the ops service's timer. No real feed is contacted.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { fileUrl, OFFICE_PRODUCT, publicKeyOf, signRelease, type OfficeRelease } from '../../server/src/office/release'
import { readIndex, type StatfsLike } from '../../server/src/office/update'
import { serveDownload } from '../../server/src/routes/downloads'
import { verifyInstaller } from '../../desktop/src/common/update-verify'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'
import {
  downloadsDirOf, feedRootOf, folderFetch, readWindowsState, refreshWindowsApp, WINDOWS_EVERY_MS, WINDOWS_FIRST_MS, WINDOWS_TEXT, windowsAppFeedOf,
  windowsAppSourceOf, windowsDiagnostic, type WindowsAppOptions,
} from '../../server/src/system/windows-app'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'g-windows-app')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const FEED = 'http://127.0.0.1:45998'
const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const KEYS = [publicKeyOf(pem)]
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')

/** a minimal PE32 with the NSIS header on a 512-byte boundary (what `teamax desktop add` accepts) */
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
function latestYml(version: string, file: string, exe: Uint8Array) {
  const s512 = crypto.createHash('sha512').update(exe).digest('base64')
  return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${s512}\n    size: ${exe.byteLength}\npath: ${file}\nsha512: ${s512}\nreleaseDate: '2026-11-01T00:00:00.000Z'\n`
}

/** a published release on the fake feed: the signed stable manifest, the installer, latest.yml */
function publish(version: string, o: { windows?: string | null; exe?: Buffer; served?: Buffer; key?: string; feed?: string } = {}) {
  const feed = o.feed ?? FEED
  const wv = o.windows === undefined ? version : o.windows
  const files = new Map<string, Uint8Array | string>()
  const zip = new Uint8Array([1, 2, 3])
  const zipName = `TeamAX-office-${version}-mac.zip`
  files.set(fileUrl(feed, version, zipName), zip)
  let windows: OfficeRelease['windows'] = null
  let exe: Buffer | null = null
  const name = `Team-AX-Setup-${wv}-win-x64.exe`
  if (wv) {
    exe = o.exe ?? fakeExe()
    const yml = latestYml(wv, name, exe)
    files.set(fileUrl(feed, version, name), o.served ?? exe)
    files.set(fileUrl(feed, version, 'latest.yml'), yml)
    windows = {
      version: wv,
      installer: { file: name, url: fileUrl(feed, version, name), sha256: sha(exe), size: exe.byteLength },
      latestYml: { file: 'latest.yml', url: fileUrl(feed, version, 'latest.yml'), sha256: sha(yml), size: Buffer.byteLength(yml) },
    }
  }
  const r: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: 'n',
    office: [{ arch: 'universal', file: zipName, url: fileUrl(feed, version, zipName), sha256: sha(zip), size: zip.byteLength }], windows,
  }
  files.set(`${feed}/office/stable.json`, signRelease(r, o.key ?? pem))
  return { files, exe, name, yml: wv ? files.get(fileUrl(feed, version, 'latest.yml')) as string : null }
}

function fakeFetch(files: Map<string, Uint8Array | string>, seen: string[] = []): NonNullable<WindowsAppOptions['fetch']> {
  return async (url) => {
    const u = url.split('?')[0]!
    seen.push(u)
    const b = files.get(u)
    if (b === undefined) return new Response('nf', { status: 404 })
    return new Response(typeof b === 'string' ? b : new Uint8Array(b))
  }
}

/** a disk of 40 GiB with `freeGiB` free */
const disk = (freeGiB: number): StatfsLike => () => ({ bsize: 4096, blocks: (40 * 2 ** 30) / 4096, bfree: (freeGiB * 2 ** 30) / 4096, bavail: (freeGiB * 2 ** 30) / 4096 })

function server(name: string) {
  const data = path.join(BASE, name, 'data')
  fs.rmSync(path.join(BASE, name), { recursive: true, force: true })
  fs.mkdirSync(data, { recursive: true })
  return { data, downloads: path.join(data, 'downloads') }
}
const opts = (s: { data: string }, files: Map<string, Uint8Array | string>, over: Partial<WindowsAppOptions> = {}, seen: string[] = []): WindowsAppOptions => ({
  dataDir: s.data, version: '0.3.0', channel: 'stable', feed: FEED, keys: KEYS, fetch: fakeFetch(files, seen), statfs: disk(20), ...over,
})

describe('which servers fill /downloads/ themselves', () => {
  const cfg = (o: Partial<AppConfig> = {}) => ({ mode: 'prod' as const, office: false, update: { channel: 'stable' as const, feedUrl: 'https://updates.example.test/server/stable.json' }, ...o })
  test('a Linux server (self-installed, Trina-hosted on its own machine, a hosted tenant) with a feed; not office, dev, a Mac, or no feed', () => {
    expect(windowsAppFeedOf(cfg(), 'linux')).toBe('https://updates.example.test')
    expect(windowsAppFeedOf(cfg({ deployment: 'self' }), 'linux')).toBe('https://updates.example.test')
    expect(windowsAppFeedOf(cfg({ office: true }), 'linux')).toBeNull()
    expect(windowsAppFeedOf(cfg({ deployment: 'hosted' }), 'linux')).toBe('https://updates.example.test')
    // where it comes from, for the owner's hint: a hosted tenant without a feed has nothing its owner could run
    expect(windowsAppSourceOf(cfg({ deployment: 'hosted' }), 'linux')).toBe('feed')
    expect(windowsAppSourceOf(cfg({ deployment: 'hosted', update: { channel: 'stable', feedUrl: null } }), 'linux')).toBeNull()
    expect(windowsAppSourceOf(cfg({ update: { channel: 'stable', feedUrl: null } }), 'linux')).toBe('folder')
    expect(windowsAppFeedOf(cfg({ mode: 'dev' }), 'linux')).toBeNull()
    expect(windowsAppFeedOf(cfg(), 'darwin')).toBeNull()
    expect(windowsAppFeedOf(cfg({ update: { channel: 'stable', feedUrl: null } }), 'linux')).toBeNull()
  })
  test('the feed root comes from server.json update.feedUrl: https, or http on this machine only', () => {
    expect(feedRootOf('https://updates.example.test/server/beta.json')).toBe('https://updates.example.test')
    expect(feedRootOf('https://example.test/feeds/x/server/stable.json')).toBe('https://example.test/feeds/x')
    expect(feedRootOf('http://127.0.0.1:4567/server/stable.json')).toBe('http://127.0.0.1:4567')
    for (const bad of ['http://updates.example.test/server/stable.json', 'https://u:p@example.test/server/stable.json', 'https://example.test/stable.json', 'file:///server/stable.json', '', null]) expect(feedRootOf(bad)).toBeNull()
  })
  test('the downloads folder is the one /downloads/* serves', () => {
    expect(downloadsDirOf('/var/lib/mycel/data', {})).toBe('/var/lib/mycel/data/downloads')
    expect(downloadsDirOf('/d', { MYCEL_DOWNLOADS_DIR: '/x' })).toBe('/x')
  })
})

describe('the signed release\'s Windows app into data/downloads', () => {
  test('offered from the feed: an older installer goes, latest.yml names it, an existing Windows app gets both; a second run downloads nothing', async () => {
    const s = server('offer')
    fs.mkdirSync(s.downloads, { recursive: true })
    fs.writeFileSync(path.join(s.downloads, 'Team-AX-Setup-0.2.0-win-x64.exe'), 'old')
    fs.writeFileSync(path.join(s.downloads, 'index.json'), JSON.stringify({ items: [{ platform: 'windows', file: 'Team-AX-Setup-0.2.0-win-x64.exe', version: '0.2.0', size: 3, signed: false }] }))
    const p = publish('0.3.0')
    const seen: string[] = []
    const r = await refreshWindowsApp(opts(s, p.files, {}, seen))
    expect(r).toEqual({ kind: 'offered', version: '0.3.0', message: null })
    const idx = readIndex(s.downloads)
    expect(idx.map((i) => `${i.platform} ${i.file} ${i.version} ${i.sha256}`)).toEqual([`windows ${p.name} 0.3.0 ${sha(p.exe!)}`])
    expect(fs.existsSync(path.join(s.downloads, 'Team-AX-Setup-0.2.0-win-x64.exe'))).toBe(false)
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(p.yml!)
    expect(fs.statSync(path.join(s.downloads, p.name)).mode & 0o777).toBe(0o600)
    // nothing left behind: the download folder, the lock, temporary names in the served folder
    expect(fs.readdirSync(path.join(s.data, 'updates'))).toEqual([])
    expect(fs.readdirSync(s.downloads).sort()).toEqual(['index.json', 'latest.yml', 'stable.json', p.name].sort())
    // the signed release that names the installer sits next to it (the Windows app checks it before installing)
    const signed = p.files.get(`${FEED}/office/stable.json`) as string
    expect(fs.readFileSync(path.join(s.downloads, 'stable.json'), 'utf8')).toBe(signed)
    const m = serveDownload(new Request('http://x/downloads/stable.json'), '/stable.json', s.downloads)
    expect(m.status).toBe(200)
    expect(m.headers.get('content-type')).toContain('json')
    expect(verifyInstaller({ manifest: await m.text(), installerSha256: sha(fs.readFileSync(path.join(s.downloads, p.name))), channel: 'stable', version: '0.3.0', current: '0.2.0', keys: KEYS, product: OFFICE_PRODUCT })).toMatchObject({ ok: true })
    expect(readWindowsState(s.data).last).toMatchObject({ kind: 'offered', version: '0.3.0' })
    // what a Windows app already in the field asks for (electron-updater, generic provider = <team>/downloads/)
    const y = serveDownload(new Request('http://x/downloads/latest.yml'), '/latest.yml', s.downloads)
    expect(y.status).toBe(200)
    expect(await y.text()).toBe(p.yml!)
    const e = serveDownload(new Request(`http://x/downloads/${p.name}`), `/${p.name}`, s.downloads)
    expect(e.status).toBe(200)
    expect(sha(new Uint8Array(await e.arrayBuffer()))).toBe(sha(p.exe!))
    // again: only the small manifest is read
    seen.length = 0
    expect((await refreshWindowsApp(opts(s, p.files, {}, seen))).kind).toBe('current')
    expect(seen).toEqual([`${FEED}/office/stable.json`])
    // a folder filled before this change (no manifest yet) gets it on the next run, without a download
    fs.rmSync(path.join(s.downloads, 'stable.json'))
    seen.length = 0
    expect((await refreshWindowsApp(opts(s, p.files, {}, seen))).kind).toBe('current')
    expect(seen).toEqual([`${FEED}/office/stable.json`])
    expect(fs.readFileSync(path.join(s.downloads, 'stable.json'), 'utf8')).toBe(signed)
    // a wrong latest.yml (changed by hand) is put right
    fs.writeFileSync(path.join(s.downloads, 'latest.yml'), 'version: 9.9.9\n')
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(p.yml!)
  })

  test('the desks follow the server: a release newer than the running version is not offered yet', async () => {
    const s = server('ahead')
    const p = publish('0.4.0')
    const seen: string[] = []
    expect(await refreshWindowsApp(opts(s, p.files, { version: '0.3.0' }, seen))).toMatchObject({ kind: 'ahead', version: '0.4.0' })
    // the server's own release was looked for (a release before 0.2.19 has no such manifest), nothing downloaded
    expect(seen).toEqual([`${FEED}/office/stable.json`, `${FEED}/office/0.3.0/stable.json`])
    expect(fs.existsSync(s.downloads)).toBe(false)
    // a pre-release server is older than the release of the same number
    expect((await refreshWindowsApp(opts(s, p.files, { version: '0.4.0-qa.1' }))).kind).toBe('ahead')
    // once the server runs it, the app comes
    expect((await refreshWindowsApp(opts(s, p.files, { version: '0.4.0' }))).kind).toBe('offered')
    // a server newer than the feed's head gets the head's app (an older app is never put over a newer one)
    const s2 = server('behind-feed')
    expect((await refreshWindowsApp(opts(s2, publish('0.3.0').files, { version: '0.3.1' }))).kind).toBe('offered')
  })

  test('a server the channel has passed (a hosted tenant waiting for its wave) offers its own release\'s app, from that release\'s kept manifest', async () => {
    const s = server('own-version')
    const head = publish('0.4.0')
    const own = publish('0.3.0')
    const files = new Map([...head.files, ...own.files])
    files.set(fileUrl(FEED, '0.3.0', 'stable.json'), own.files.get(`${FEED}/office/stable.json`)!)
    files.set(`${FEED}/office/stable.json`, head.files.get(`${FEED}/office/stable.json`)!)
    expect(await refreshWindowsApp(opts(s, files, { version: '0.3.0' }))).toMatchObject({ kind: 'offered', version: '0.3.0' })
    expect(readIndex(s.downloads).map((i) => `${i.version} ${i.sha256}`)).toEqual([`0.3.0 ${sha(own.exe!)}`])
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(own.yml!)
    // the manifest next to it is that release's own (it names this installer), not the channel's head
    expect(fs.readFileSync(path.join(s.downloads, 'stable.json'), 'utf8')).toBe(own.files.get(`${FEED}/office/stable.json`) as string)
    // that manifest must be that version: another release's text in its place is refused, nothing changes
    const s2 = server('own-version-wrong')
    const wrong = new Map(files)
    wrong.set(fileUrl(FEED, '0.3.0', 'stable.json'), publish('0.3.1').files.get(`${FEED}/office/stable.json`)!)
    const r = await refreshWindowsApp(opts(s2, wrong, { version: '0.3.0' }))
    expect(r.kind).toBe('failed')
    expect(r.message).toContain('is the manifest of 0.3.1, not 0.3.0')
    expect(fs.existsSync(s2.downloads)).toBe(false)
    // a head this build cannot read (another key), while the server's own release's manifest verifies: that one
    const s4 = server('own-version-head-bad')
    const badHead = new Map(files)
    badHead.set(`${FEED}/office/stable.json`, publish('0.4.0', { key: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string }).files.get(`${FEED}/office/stable.json`)!)
    expect(await refreshWindowsApp(opts(s4, badHead, { version: '0.3.0' }))).toMatchObject({ kind: 'offered', version: '0.3.0' })
    // and signed with a key this build does not trust: refused as well
    const s3 = server('own-version-key')
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    const forged = new Map(files)
    forged.set(fileUrl(FEED, '0.3.0', 'stable.json'), publish('0.3.0', { key: other }).files.get(`${FEED}/office/stable.json`)!)
    expect((await refreshWindowsApp(opts(s3, forged, { version: '0.3.0' }))).message).toContain('unknown key')
  })

  test('the publisher keeps each version\'s manifest for good: uploaded once, a re-run with the same files keeps it, other files stop it', async () => {
    const { versionManifestAction, versionManifestKey } = await import('../../scripts/release/publish')
    const ctx = { keys: KEYS, feed: FEED }
    const p = publish('0.3.0')
    const signed = p.files.get(`${FEED}/office/stable.json`) as string
    const rel = JSON.parse(JSON.parse(signed).payload) as OfficeRelease
    expect(versionManifestKey('0.3.0', 'stable')).toBe('office/0.3.0/stable.json')
    expect(versionManifestAction(null, rel, ctx)).toBe('upload')
    expect(versionManifestAction(signed, { ...rel, publishedAt: new Date(Date.now() + 1000).toISOString() }, ctx)).toBe('keep')
    const changed = { ...rel, windows: { ...rel.windows!, installer: { ...rel.windows!.installer, sha256: 'f'.repeat(64) } } }
    expect(() => versionManifestAction(signed, changed, ctx)).toThrow(/already published with other files/)
    // a re-run that adds the Windows installer to a release first published without one: replaced
    const noWin = publish('0.3.0', { windows: null }).files.get(`${FEED}/office/stable.json`) as string
    expect(versionManifestAction(noWin, rel, ctx)).toBe('upload')
    // ...but not one that changes the office zip at the same time
    const zipNoWin = JSON.parse(JSON.parse(noWin).payload) as OfficeRelease
    expect(() => versionManifestAction(noWin, { ...rel, office: [{ ...zipNoWin.office[0]!, sha256: 'e'.repeat(64) }] }, ctx)).toThrow(/other files/)
    // another version's text in that place
    expect(() => versionManifestAction(publish('0.3.1').files.get(`${FEED}/office/stable.json`) as string, rel, ctx)).toThrow(/manifest of 0.3.1/)
    expect(() => versionManifestAction(signed, rel, { ...ctx, keys: [publicKeyOf(crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)] })).toThrow(/does not verify/)
  })

  test('a file that does not match the signed manifest is refused, nothing offered changes, the version waits a day (--force tries again)', async () => {
    const s = server('bad')
    const good = publish('0.3.0')
    expect((await refreshWindowsApp(opts(s, good.files, { version: '0.3.0' }))).kind).toBe('offered')
    const exe = fakeExe()
    const tampered = Buffer.from(exe); tampered[tampered.length - 1] ^= 1
    const p = publish('0.3.1', { exe, served: tampered })
    const r = await refreshWindowsApp(opts(s, p.files, { version: '0.3.1' }))
    expect(r.kind).toBe('failed')
    expect(r.message).toContain('does not match the signed release')
    expect(readIndex(s.downloads).map((i) => i.version)).toEqual(['0.3.0'])
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(good.yml!)
    expect(fs.readdirSync(path.join(s.data, 'updates'))).toEqual([])
    const seen: string[] = []
    expect((await refreshWindowsApp(opts(s, p.files, { version: '0.3.1' }, seen))).kind).toBe('held')
    expect(seen).toEqual([`${FEED}/office/stable.json`])
    const later = new Date(Date.now() + 25 * 3600_000)
    expect((await refreshWindowsApp(opts(s, p.files, { version: '0.3.1', now: () => later }))).kind).toBe('failed')
    const fixed = publish('0.3.1', { exe })
    expect((await refreshWindowsApp(opts(s, fixed.files, { version: '0.3.1', force: true }))).kind).toBe('offered')
    expect(readWindowsState(s.data).failed).toBeNull()
  })

  test('a download that broke off is not held: the next run tries again', async () => {
    const s = server('broken-off')
    const p = publish('0.3.0')
    const flaky: NonNullable<WindowsAppOptions['fetch']> = async (url, init) => (url.endsWith('.exe') ? Promise.reject(new Error('connection reset')) : fakeFetch(p.files)(url, init))
    const r = await refreshWindowsApp(opts(s, p.files, { fetch: flaky }))
    expect(r.kind).toBe('failed')
    expect(r.message).toContain('connection reset')
    expect(readWindowsState(s.data).failed).toBeNull()
    expect(fs.readdirSync(path.join(s.data, 'updates'))).toEqual([])
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
  })

  test('a full disk while latest.yml goes in changes nothing in the folder: index.json, the old installer and latest.yml stay', async () => {
    const s = server('order')
    const old = publish('0.3.0')
    expect((await refreshWindowsApp(opts(s, old.files))).kind).toBe('offered')
    const before = fs.readFileSync(path.join(s.downloads, 'index.json'), 'utf8')
    // the temporary latest.yml cannot be written (a folder in its place: the write fails like a full disk would)
    fs.mkdirSync(path.join(s.downloads, `.latest.yml.tmp-${process.pid}`))
    const r = await refreshWindowsApp(opts(s, publish('0.3.1').files, { version: '0.3.1' }))
    expect(r.kind).toBe('failed')
    expect(fs.readFileSync(path.join(s.downloads, 'index.json'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(s.downloads, old.name))).toBe(true)
    expect(fs.existsSync(path.join(s.downloads, 'Team-AX-Setup-0.3.1-win-x64.exe'))).toBe(false)
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(old.yml!)
    expect(readWindowsState(s.data).failed).toBeNull() // a local problem: tried again at the next run
  })

  test('only latest.yml is wrong: that file alone is fetched again, the installer is not', async () => {
    const s = server('yml-only')
    const p = publish('0.3.0')
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
    fs.writeFileSync(path.join(s.downloads, 'latest.yml'), 'version: 0.0.1\n')
    const seen: string[] = []
    expect((await refreshWindowsApp(opts(s, p.files, {}, seen))).kind).toBe('offered')
    expect(seen).toEqual([`${FEED}/office/stable.json`, fileUrl(FEED, '0.3.0', 'latest.yml')])
    expect(fs.readFileSync(path.join(s.downloads, 'latest.yml'), 'utf8')).toBe(p.yml!)
  })

  test('a download that ends early is tried again at the next run, not held', async () => {
    const s = server('short')
    const p = publish('0.3.0')
    const short = new Map(p.files)
    short.set(fileUrl(FEED, '0.3.0', p.name), p.exe!.subarray(0, 1000))
    const r = await refreshWindowsApp(opts(s, short))
    expect(r.kind).toBe('failed')
    expect(r.message).toContain('ended after 1000')
    expect(readWindowsState(s.data).failed).toBeNull()
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
  })

  test('a file-system error here (the folder cannot be made) is not held against the release', async () => {
    const s = server('fs-error')
    fs.writeFileSync(s.downloads, 'a file where the folder should be')
    const p = publish('0.3.0')
    const r = await refreshWindowsApp(opts(s, p.files))
    expect(r.kind).toBe('failed')
    expect(readWindowsState(s.data).failed).toBeNull()
    expect(fs.readdirSync(path.join(s.data, 'updates'))).toEqual([])
    fs.rmSync(s.downloads)
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
  })

  test('Diagnostics says what the last run did (nothing before the first run)', async () => {
    const s = server('diag')
    expect(windowsDiagnostic(s.data, '0.3.0')).toBeNull()
    await refreshWindowsApp(opts(s, publish('0.4.0').files))
    expect(windowsDiagnostic(s.data, '0.3.0')).toEqual({ status: 'ok', text: WINDOWS_TEXT.ahead('0.4.0', '0.3.0') })
    await refreshWindowsApp(opts(s, publish('0.3.0').files, { statfs: disk(0.5) }))
    const d = windowsDiagnostic(s.data, '0.3.0')!
    expect(d.status).toBe('warn')
    expect(d.text.en).toContain('not enough disk space')
    expect(d.text.en).toContain('trina_admin desktop-refresh')
    await refreshWindowsApp(opts(s, publish('0.3.0').files))
    expect(windowsDiagnostic(s.data, '0.3.0')).toEqual({ status: 'ok', text: WINDOWS_TEXT.offered('0.3.0') })
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(WINDOWS_TEXT.offered('0.3.0')[l]).toContain('0.3.0')
      expect(WINDOWS_TEXT.failedHosted('x')[l]).not.toMatch(/trina_admin|desktop-refresh/)
    }
    // the feed cannot be read now, but the folder still offers 0.3.0: no "not offered" warning
    await refreshWindowsApp(opts(s, new Map(), { fetch: async () => { throw new Error('offline') } }))
    expect(windowsDiagnostic(s.data, '0.3.0')).toMatchObject({ status: 'ok', text: { en: expect.stringContaining('The Windows app 0.3.0 is offered by this server. The last look') } })
    // a release whose file did not match: held, and the advice names --force (a plain run would only say "held")
    const exe = fakeExe()
    const bad = Buffer.from(exe); bad[bad.length - 1] ^= 1
    const p = publish('0.3.1', { exe, served: bad })
    await refreshWindowsApp(opts(s, p.files, { version: '0.3.1' }))
    expect(windowsDiagnostic(s.data, '0.3.1')!.text.en).toContain('desktop-refresh --force')
    await refreshWindowsApp(opts(s, p.files, { version: '0.3.1' }))
    expect(readWindowsState(s.data).last?.kind).toBe('held')
    expect(windowsDiagnostic(s.data, '0.3.1')).toMatchObject({ status: 'warn', text: { en: expect.stringContaining('desktop-refresh --force') } })
    // a hosted tenant: the reason itself and the next update, no "a day later" (it has no daily run) and no command
    const hostedHeld = windowsDiagnostic(s.data, '0.3.1', undefined, true)!
    expect(hostedHeld.status).toBe('warn')
    expect(hostedHeld.text.en).toContain('does not match the signed release')
    expect(hostedHeld.text.en).toContain('next update')
    expect(hostedHeld.text.en).not.toMatch(/a day later|trina_admin|desktop-refresh/)
    // "comes once this server runs 0.4.0" is not shown once the server runs 0.4.0 (the next run says what it did)
    await refreshWindowsApp(opts(s, publish('0.4.0').files, { version: '0.3.1' }))
    expect(windowsDiagnostic(s.data, '0.3.1')?.status).toBe('ok')
    expect(windowsDiagnostic(s.data, '0.4.0')).toBeNull()
  })

  test('a manifest with another key, a missing release, a release without a Windows app: nothing downloaded', async () => {
    const s = server('refused')
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    const seen: string[] = []
    const r = await refreshWindowsApp(opts(s, publish('0.3.0', { key: other }).files, {}, seen))
    expect(r.kind).toBe('failed')
    expect(r.message).toContain('unknown key')
    // the server's own release's manifest was tried too (absent here), nothing downloaded
    expect(seen).toEqual([`${FEED}/office/stable.json`, `${FEED}/office/0.3.0/stable.json`])
    expect((await refreshWindowsApp(opts(s, new Map()))).kind).toBe('none')
    expect((await refreshWindowsApp(opts(s, publish('0.3.0', { windows: null }).files))).kind).toBe('none')
    expect((await refreshWindowsApp(opts(s, new Map(), { fetch: async () => { throw new Error('offline') } }))).message).toContain('cannot reach')
    expect(fs.existsSync(s.downloads)).toBe(false)
  })

  test('no room: nothing downloaded when the team disk would fall under its write reserve', async () => {
    const s = server('room')
    const p = publish('0.3.0')
    const seen: string[] = []
    // 40 GiB disk: the reserve is max(512 MiB, 2%) = 819 MiB
    const r = await refreshWindowsApp(opts(s, p.files, { statfs: disk(0.75) }, seen))
    expect(r.kind).toBe('no-room')
    expect(r.message).toContain('MB free')
    expect(seen).toEqual([`${FEED}/office/stable.json`])
    expect((await refreshWindowsApp(opts(s, p.files, { statfs: disk(0.9) }))).kind).toBe('offered')
  })

  test('a newer Windows app the owner put there is left as it is', async () => {
    const s = server('newer')
    fs.mkdirSync(s.downloads, { recursive: true })
    fs.writeFileSync(path.join(s.downloads, 'index.json'), JSON.stringify({ items: [{ platform: 'windows', file: 'Team-AX-Setup-0.9.0-win-x64.exe', version: '0.9.0', size: 3, signed: false }] }))
    expect(await refreshWindowsApp(opts(s, publish('0.3.0').files))).toMatchObject({ kind: 'newer', version: '0.9.0' })
    expect(readIndex(s.downloads).map((i) => i.version)).toEqual(['0.9.0'])
  })

  test('one run at a time (the timer and the admin command are two processes); a lock of a process that is gone is taken over', async () => {
    const s = server('lock')
    fs.mkdirSync(path.join(s.data, 'updates'), { recursive: true })
    fs.writeFileSync(path.join(s.data, 'updates', 'windows.lock'), String(process.pid))
    const p = publish('0.3.0')
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('busy')
    // the busy path leaves no temporary lock file behind
    expect(fs.readdirSync(path.join(s.data, 'updates')).sort()).toEqual(['windows.lock'])
    // a live pid on a lock older than a run can take (the pid was reused) does not block for ever
    const old = new Date(Date.now() - 4 * 3600_000)
    fs.utimesSync(path.join(s.data, 'updates', 'windows.lock'), old, old)
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('offered')
    fs.writeFileSync(path.join(s.data, 'updates', 'windows.lock'), '999999999')
    expect((await refreshWindowsApp(opts(s, p.files))).kind).toBe('current')
    expect(fs.readdirSync(path.join(s.data, 'updates'))).toEqual([])
    // a run never removes a lock that is not its own (another run took over meanwhile)
    const slow: NonNullable<WindowsAppOptions['fetch']> = async (url, init) => {
      fs.rmSync(path.join(s.data, 'updates', 'windows.lock'))
      fs.writeFileSync(path.join(s.data, 'updates', 'windows.lock'), String(process.pid))
      return fakeFetch(p.files)(url, init)
    }
    expect((await refreshWindowsApp(opts(s, p.files, { fetch: slow }))).kind).toBe('current')
    expect(fs.readFileSync(path.join(s.data, 'updates', 'windows.lock'), 'utf8')).toBe(String(process.pid))
    fs.rmSync(path.join(s.data, 'updates', 'windows.lock'))
  })

  test('without internet: the manifest and the two files copied into a folder are checked the same way (desktop-refresh --from)', async () => {
    const s = server('folder')
    const p = publish('0.3.0')
    const dir = path.join(BASE, 'folder', 'copied')
    fs.mkdirSync(dir, { recursive: true })
    for (const [url, body] of p.files) fs.writeFileSync(path.join(dir, url.split('/').pop()!), body)
    expect((await refreshWindowsApp(opts(s, p.files, { fetch: folderFetch(dir, FEED) }))).kind).toBe('offered')
    expect(readIndex(s.downloads)[0]!.sha256).toBe(sha(p.exe!))
    // a server older than the release copied there: not offered ("update the server first"), the folder's head is
    // never taken for the server's own version's manifest
    const s2 = server('folder-older')
    expect(await refreshWindowsApp(opts(s2, p.files, { version: '0.2.9', fetch: folderFetch(dir, FEED) }))).toMatchObject({ kind: 'ahead', version: '0.3.0' })
    // nothing outside the feed's addresses and plain names
    const f = folderFetch(dir, FEED)
    expect((await f(`${FEED}/office/0.2.9/stable.json`)).status).toBe(404)
    expect((await f('https://elsewhere.test/office/stable.json')).status).toBe(404)
    expect((await f(`${FEED}/office/0.3.0/..%2F..%2Fx`)).status).toBe(404)
  })
})

describe('the ops service of an installed Linux server', () => {
  const base = path.join(BASE, 'ops')
  let ctx: AppContext
  let feed: ReturnType<typeof Bun.serve>
  const asked: string[] = []
  beforeAll(() => {
    for (const d of ['app', 'config', 'data', 'team']) fs.mkdirSync(path.join(base, d), { recursive: true })
    // signed with a test key the build does not trust: the run must ask this feed and refuse the manifest
    feed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => { asked.push(new URL(req.url).pathname); return new Response(publish('0.3.0', { feed: `http://127.0.0.1:${feed.port}` }).files.get(`http://127.0.0.1:${feed.port}/office/stable.json`) as string) } })
    const cfg: AppConfig = {
      mode: 'prod', configFile: path.join(base, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(base, 'team'), dataDir: path.join(base, 'data'), logDir: null, logLevel: 'error',
      engine: { authMode: 'managed', runDir: path.join(base, 'r') }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: `http://127.0.0.1:${feed.port}/server/stable.json` },
      validateResponses: false, setupToken: null,
    }
    ctx = createContext({ config: cfg, db: openDb(path.join(cfg.dataDir, 'app.db')), log: silentLogger })
  })
  afterAll(async () => { feed.stop(true); await ctx.close() })
  const ops = (platform: NodeJS.Platform = 'linux') => new OpsService(ctx, { layout: resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, platform), platform, engines: async () => [], launcherStatus: async () => null })

  test('15 minutes after start, then every 6 hours, from the feed of server.json; the build\'s keys decide', async () => {
    const made: { kind: 'timeout' | 'interval'; ms: number; fn: () => void }[] = []
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval }
    const fake = (kind: 'timeout' | 'interval') => ((fn: () => void, ms: number) => { made.push({ kind, ms, fn }); return { unref() {} } }) as unknown as typeof setTimeout
    const started = (auto: boolean, hosted = false) => {
      made.length = 0
      ctx.config.update.auto = auto
      ctx.config.deployment = hosted ? 'hosted' : undefined
      const o = ops()
      expect(o.windowsAppFeed()).toBe(`http://127.0.0.1:${feed.port}`)
      let runs = 0
      o.refreshWindowsApp = async () => { runs++; return null }
      globalThis.setTimeout = fake('timeout'); globalThis.setInterval = fake('interval') as unknown as typeof setInterval
      try {
        o.start()
        const first = made.find((t) => t.kind === 'timeout' && t.ms === WINDOWS_FIRST_MS)!
        expect(first).toBeDefined()
        first.fn()
        expect(runs).toBe(1)
        const every = made.find((t) => t.kind === 'interval' && t.ms === WINDOWS_EVERY_MS)
        every?.fn()
        return { every: !!every, runs }
      } finally {
        globalThis.setTimeout = real.setTimeout; globalThis.setInterval = real.setInterval
        ;(o as unknown as { timers: unknown[] }).timers.splice(0)
        ctx.config.update.auto = undefined
        ctx.config.deployment = undefined
      }
    }
    expect(started(true)).toEqual({ every: true, runs: 2 })
    // automatic updates off: only after a start (that is, after its owner updated it), never on its own in between
    expect(started(false)).toEqual({ every: false, runs: 1 })
    // a hosted tenant: only after a start (the control plane's update restarts it), even if server.json said auto
    expect(started(true, true)).toEqual({ every: false, runs: 1 })
    // the real run: it reads <feed>/office/stable.json and refuses a manifest this build cannot verify
    const r = await ops().refreshWindowsApp()
    expect(r?.kind).toBe('failed')
    expect(r?.message).toContain('unknown key')
    // the head, then this server's own release's manifest (this fake answers every path with the same head)
    expect(asked).toEqual(['/office/stable.json', `/office/${ctx.version}/stable.json`])
    expect(fs.existsSync(path.join(base, 'data', 'downloads'))).toBe(false)
    // and Admin › System › Diagnostics says so
    const line = (await ops().diagnostics('en')).checks.find((c) => c.id === 'windows_app')
    expect(line).toMatchObject({ status: 'warn', group: 'update' })
    expect(line?.detail).toContain('unknown key')
    expect(line?.detail).toContain('trina_admin desktop-refresh')
    // a hosted tenant's owner gets the same line without a server command (it has no shell there)
    ctx.config.deployment = 'hosted'
    try {
      const hosted = (await ops().diagnostics('en')).checks.find((c) => c.id === 'windows_app')
      expect(hosted).toMatchObject({ status: 'warn', group: 'update' })
      expect(hosted?.detail).toContain('unknown key')
      expect(hosted?.detail).toContain('contact support')
      expect(hosted?.detail).not.toMatch(/trina_admin|sudo|INSTALL-LINUX/)
    } finally { ctx.config.deployment = undefined }
  })

  test('not on a Mac or in office mode; a hosted tenant does it from its own feed', () => {
    expect(ops('darwin').windowsAppFeed()).toBeNull()
    ctx.config.office = true
    try { expect(ops().windowsAppFeed()).toBeNull() } finally { ctx.config.office = false }
    ctx.config.deployment = 'hosted'
    try { expect(ops().windowsAppFeed()).toBe(`http://127.0.0.1:${feed.port}`) } finally { ctx.config.deployment = undefined }
  })
})

describe('admin.js desktop-refresh', () => {
  const base = path.join(BASE, 'cli')
  const run = (feedUrl: string | null, ...args: string[]) => {
    for (const d of ['team', 'data']) fs.mkdirSync(path.join(base, d), { recursive: true })
    const cfgFile = path.join(base, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), update: { channel: 'stable', feedUrl } }))
    const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), 'desktop-refresh', ...args], { env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  test('--from: a full path, the server channel\'s manifest in it; a release this build cannot verify exits non-zero; nothing on the network', () => {
    const dir = path.join(BASE, 'cli-copied')
    fs.mkdirSync(dir, { recursive: true })
    expect(run('https://updates.example.test/server/stable.json', '--from', 'relative/folder')).toMatchObject({ code: 1, err: expect.stringContaining('full path') })
    expect(run('https://updates.example.test/server/stable.json', '--from', dir)).toMatchObject({ code: 1, err: expect.stringContaining('stable.json is missing') })
    // signed with a test key: this build refuses it, and says so with exit 1
    const p = publish('0.3.0', { feed: 'https://updates.example.test' })
    for (const [url, body] of p.files) fs.writeFileSync(path.join(dir, url.split('/').pop()!), body)
    const r = run('https://updates.example.test/server/stable.json', '--from', dir)
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out)).toMatchObject({ kind: 'failed', message: expect.stringContaining('unknown key') })
    // no feed and no folder: what to do instead
    expect(run(null)).toMatchObject({ code: 1, err: expect.stringContaining('--from <folder>') })
  }, 60_000) // four admin.js processes, each loading the server code (about 2 s apiece in a Linux container)
})
