// The Mac desktop app's updates (Developer ID signed dmg, since 0.5.5): the office manifest's `mac` entry, a team server
// putting the update zip and latest-mac.yml into its downloads folder from a fake feed (system/windows-app.ts and
// office/update.ts offerMac), what /downloads/ serves then, the Mac app's check of a downloaded zip against the signed
// release (desktop/src/common/update-verify.ts), latest-mac.yml checks, the publisher's re-run that adds the Mac app,
// and the dmg entry that scripts/release/mac-app.ts rewrites after stapling. No real feed is contacted.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileUrl, OFFICE_PRODUCT, publicKeyOf, signRelease, verifyRelease, type OfficeRelease } from '../../server/src/office/release'
import { checkLatestMacYml, offerMac, type StatfsLike } from '../../server/src/office/update'
import { macOfferedIn, MAC_ZIP_RE } from '../../server/src/office/desktop'
import { serveDownload } from '../../server/src/routes/downloads'
import { readWindowsState, refreshWindowsApp, type WindowsAppOptions } from '../../server/src/system/windows-app'
import { verifyInstaller } from '../../desktop/src/common/update-verify'
import { updateMode } from '../../desktop/src/common/update'
import { rewriteDmgEntry } from '../../scripts/release/mac-app'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'g-mac-app')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const FEED = 'http://127.0.0.1:45997'
const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const KEYS = [publicKeyOf(pem)]
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const sha512 = (b: Uint8Array | string) => crypto.createHash('sha512').update(b).digest('base64')
const disk = (freeGiB: number): StatfsLike => () => ({ bsize: 4096, blocks: (40 * 2 ** 30) / 4096, bfree: (freeGiB * 2 ** 30) / 4096, bavail: (freeGiB * 2 ** 30) / 4096 })

function macYml(version: string, zipName: string, zip: Uint8Array, dmgName: string, dmg: Uint8Array) {
  return `version: ${version}\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512(zip)}\n    size: ${zip.byteLength}\n  - url: ${dmgName}\n    sha512: ${sha512(dmg)}\n    size: ${dmg.byteLength}\npath: ${zipName}\nsha512: ${sha512(zip)}\nreleaseDate: '2026-11-15T00:00:00.000Z'\n`
}

/** a release on the fake feed with a Mac app (and no Windows app): the signed manifest and the Mac files */
function publish(version: string, o: { served?: Buffer; yml?: (s: string) => string } = {}) {
  const files = new Map<string, Uint8Array | string>()
  const officeZip = new Uint8Array([1, 2, 3])
  const officeName = `TeamAX-office-${version}-mac.zip`
  files.set(fileUrl(FEED, version, officeName), officeZip)
  const zipName = `Trina-AX-${version}-mac-universal.zip`, dmgName = `Trina-AX-${version}-mac-universal.dmg`
  const zip = crypto.randomBytes(32 * 1024), dmg = crypto.randomBytes(16 * 1024)
  let yml = macYml(version, zipName, zip, dmgName, dmg)
  if (o.yml) yml = o.yml(yml)
  files.set(fileUrl(FEED, version, zipName), o.served ?? zip)
  files.set(fileUrl(FEED, version, 'latest-mac.yml'), yml)
  const f = (file: string, b: Uint8Array | string) => ({ file, url: fileUrl(FEED, version, file), sha256: sha(b), size: Buffer.byteLength(b) })
  const r: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: '',
    office: [{ arch: 'universal', ...f(officeName, officeZip) }], windows: null,
    mac: { version, dmg: f(dmgName, dmg), zip: f(zipName, zip), latestYml: f('latest-mac.yml', yml) },
  }
  const signed = signRelease(r, pem)
  files.set(`${FEED}/office/stable.json`, signed)
  return { files, r, signed, zip, zipName, yml }
}
const fakeFetch = (files: Map<string, Uint8Array | string>): NonNullable<WindowsAppOptions['fetch']> => async (url) => {
  const b = files.get(url.split('?')[0]!)
  return b === undefined ? new Response('nf', { status: 404 }) : new Response(typeof b === 'string' ? b : new Uint8Array(b))
}
function server(name: string) {
  const data = path.join(BASE, name, 'data')
  fs.rmSync(path.join(BASE, name), { recursive: true, force: true })
  fs.mkdirSync(data, { recursive: true })
  return { data, downloads: path.join(data, 'downloads') }
}
const opts = (s: { data: string }, files: Map<string, Uint8Array | string>, over: Partial<WindowsAppOptions> = {}): WindowsAppOptions => ({
  dataDir: s.data, version: '0.5.5', channel: 'stable', feed: FEED, keys: KEYS, fetch: fakeFetch(files), statfs: disk(20), ...over,
})
const get = (dir: string, name: string) => serveDownload(new Request(`http://x/downloads/${name}`), `/${name}`, dir)

describe('the signed release names the Mac app', () => {
  test('a release with `mac` verifies; its files must be on the feed; a release without it stays as before (no `mac` key)', () => {
    const p = publish('0.5.5')
    expect(verifyRelease(p.signed, { keys: KEYS, channel: 'stable', feed: FEED }).mac?.zip.file).toBe(p.zipName)
    const off = { ...p.r, mac: { ...p.r.mac!, zip: { ...p.r.mac!.zip, url: 'https://elsewhere.test/x.zip' } } }
    expect(() => verifyRelease(signRelease(off, pem), { keys: KEYS, channel: 'stable', feed: FEED })).toThrow(/not on the release feed/)
    const { mac: _, ...old } = p.r
    expect(JSON.parse(JSON.parse(signRelease(old as OfficeRelease, pem)).payload)).not.toHaveProperty('mac')
  })
})

describe('a team server offers the Mac app update', () => {
  test('zip + latest-mac.yml + the signed manifest go into the folder, are served, and the Mac app accepts that zip', async () => {
    const s = server('offer')
    const p = publish('0.5.5')
    const r = await refreshWindowsApp(opts(s, p.files))
    expect(r.kind).toBe('none') // no Windows app in this release
    expect(readWindowsState(s.data).mac?.last).toMatchObject({ kind: 'offered', version: '0.5.5' })
    expect(fs.readdirSync(s.downloads).sort()).toEqual([p.zipName, 'latest-mac.yml', 'stable.json'].sort())
    expect(macOfferedIn(s.downloads)).toEqual({ version: '0.5.5', zip: p.zipName })
    // what the Mac app's electron-updater reads, and the zip it names
    expect(await (await get(s.downloads, 'latest-mac.yml')).text()).toBe(p.yml)
    const z = await get(s.downloads, p.zipName)
    expect(z.status).toBe(200)
    expect(z.headers.get('content-type')).toBe('application/zip')
    const bytes = new Uint8Array(await z.arrayBuffer())
    expect(sha(bytes)).toBe(sha(p.zip))
    // the Mac app checks the download against /downloads/stable.json
    const manifest = await (await get(s.downloads, 'stable.json')).text()
    const ok = verifyInstaller({ manifest, installerSha256: sha(bytes), channel: 'stable', version: '0.5.5', current: '0.5.4', keys: KEYS, product: OFFICE_PRODUCT, platform: 'mac' })
    expect(ok.ok).toBe(true)
    // the same release has no Windows app: the Windows check refuses it
    expect(verifyInstaller({ manifest, installerSha256: sha(bytes), channel: 'stable', version: '0.5.5', current: '0.5.4', keys: KEYS, product: OFFICE_PRODUCT })).toEqual({ ok: false, reason: expect.stringMatching(/no Windows app/) })
    // another zip, or another version, is refused
    expect(verifyInstaller({ manifest, installerSha256: sha('evil'), channel: 'stable', version: '0.5.5', current: '0.5.4', keys: KEYS, product: OFFICE_PRODUCT, platform: 'mac' }).ok).toBe(false)
    expect(verifyInstaller({ manifest, installerSha256: sha(bytes), channel: 'stable', version: '0.5.6', current: '0.5.4', keys: KEYS, product: OFFICE_PRODUCT, platform: 'mac' })).toEqual({ ok: false, reason: expect.stringMatching(/names the Mac app 0.5.5, not 0.5.6/) })
    // a second run: current, nothing downloaded again
    expect((await refreshWindowsApp(opts(s, new Map([[`${FEED}/office/stable.json`, p.signed]])))).kind).toBe('none')
    expect(readWindowsState(s.data).mac?.last?.kind).toBe('current')
    // a zip the folder holds that latest-mac.yml does not name, and index.json-less names, are never served
    fs.writeFileSync(path.join(s.downloads, 'Trina-AX-0.5.1-mac-universal.zip'), 'old')
    expect((await get(s.downloads, 'Trina-AX-0.5.1-mac-universal.zip')).status).toBe(404)
  })

  test('the next release replaces the zip; an older release never replaces a newer one; the server\'s version caps it', async () => {
    const s = server('next')
    const a = publish('0.5.5')
    await refreshWindowsApp(opts(s, a.files))
    const b = publish('0.5.6')
    // the server still runs 0.5.5: 0.5.6's app waits
    await refreshWindowsApp(opts(s, b.files, { version: '0.5.5' }))
    expect(readWindowsState(s.data).mac?.last?.kind).toBe('ahead')
    await refreshWindowsApp(opts(s, b.files, { version: '0.5.6' }))
    expect(readWindowsState(s.data).mac?.last).toMatchObject({ kind: 'offered', version: '0.5.6' })
    expect(fs.readdirSync(s.downloads).filter((f) => MAC_ZIP_RE.test(f))).toEqual([b.zipName])
    const res = await offerMac(s.downloads, path.join(s.data, 'tmp'), a.r.mac!, { fetch: fakeFetch(a.files), log: () => {} })
    expect(res).toEqual({ kind: 'newer', version: '0.5.6' })
  })

  test('a zip or latest-mac.yml that does not match the signed release changes nothing and is held for a day', async () => {
    const s = server('bad')
    const good = publish('0.5.5')
    await refreshWindowsApp(opts(s, good.files))
    const tampered = crypto.randomBytes(32 * 1024)
    const p = publish('0.5.6', { served: tampered })
    await refreshWindowsApp(opts(s, p.files, { version: '0.5.6' }))
    expect(readWindowsState(s.data).mac?.last?.kind).toBe('failed')
    expect(readWindowsState(s.data).mac?.last?.message).toContain('does not match the signed release')
    expect(macOfferedIn(s.downloads)?.version).toBe('0.5.5')
    await refreshWindowsApp(opts(s, p.files, { version: '0.5.6' }))
    expect(readWindowsState(s.data).mac?.last?.kind).toBe('held')
    // a latest-mac.yml naming another file (signed as it is) is refused too
    const q = publish('0.5.7', { yml: (y) => y.replace(/^path: .*$/m, 'path: ../../etc/passwd') })
    await refreshWindowsApp(opts(s, q.files, { version: '0.5.7' }))
    expect(readWindowsState(s.data).mac?.last?.message).toMatch(/latest-mac.yml names/)
    expect(macOfferedIn(s.downloads)?.version).toBe('0.5.5')
    // no room: nothing downloaded
    const r = publish('0.5.8')
    await refreshWindowsApp(opts(s, r.files, { version: '0.5.8', statfs: disk(0.1) }))
    expect(readWindowsState(s.data).mac?.last?.kind).toBe('no-room')
  })
})

describe('latest-mac.yml', () => {
  const zip = { file: 'Trina-AX-0.5.5-mac-universal.zip', sha512: sha512('z'), size: 1 }
  const dmg = { file: 'Trina-AX-0.5.5-mac-universal.dmg', sha512: sha512('d'), size: 1 }
  const y = macYml('0.5.5', zip.file, Buffer.from('z'), dmg.file, Buffer.from('d'))
  test('names the zip (path, sha512, size) and only the zip and the dmg', () => {
    expect(() => checkLatestMacYml(y, '0.5.5', zip, dmg)).not.toThrow()
    expect(() => checkLatestMacYml(y, '0.5.5', zip, { file: dmg.file, size: 1 })).not.toThrow()
    expect(() => checkLatestMacYml(y, '0.5.6', zip, dmg)).toThrow(/version/)
    expect(() => checkLatestMacYml(y, '0.5.5', { ...zip, sha512: sha512('x') }, dmg)).toThrow(/sha512/)
    expect(() => checkLatestMacYml(y, '0.5.5', zip, { ...dmg, size: 2 })).toThrow(/dmg sha512 or size/)
    expect(() => checkLatestMacYml(y.replace(`url: ${dmg.file}`, 'url: https://evil.test/x.dmg'), '0.5.5', zip, dmg)).toThrow(/must be just/)
  })
  test('the dmg entry is written again after stapling (mac-app.ts); the zip entry stays', () => {
    const t = rewriteDmgEntry(y, dmg.file, sha512('stapled'), 7)
    expect(() => checkLatestMacYml(t, '0.5.5', zip, { file: dmg.file, sha512: sha512('stapled'), size: 7 })).not.toThrow()
    expect(t.split('\n').filter((l) => l !== '').length).toBe(y.split('\n').filter((l) => l !== '').length)
    expect(() => rewriteDmgEntry(y, 'other.dmg', 'x', 1)).toThrow(/no entry/)
  })
})

describe('the publisher and the desktop app', () => {
  test('a re-run that adds the Mac app to a release published without it uploads; one that changes it stops', async () => {
    const { versionManifestAction } = await import('../../scripts/release/publish')
    const ctx = { keys: KEYS, feed: FEED }
    const p = publish('0.5.5')
    const { mac: _, ...noMac } = p.r
    const first = signRelease(noMac as OfficeRelease, pem)
    expect(versionManifestAction(first, p.r, ctx)).toBe('upload')
    expect(versionManifestAction(p.signed, p.r, ctx)).toBe('keep')
    const changed = { ...p.r, mac: { ...p.r.mac!, zip: { ...p.r.mac!.zip, sha256: 'f'.repeat(64) } } }
    expect(() => versionManifestAction(p.signed, changed, ctx)).toThrow(/other files/)
    // dropping the Mac app on a re-run is no addition either
    expect(() => versionManifestAction(p.signed, noMac as OfficeRelease, ctx)).toThrow(/other files/)
  })
  test('a packaged Mac app updates itself now (not a store build)', () => {
    expect(updateMode('darwin', true)).toBe('auto-install')
    expect(updateMode('darwin', true, undefined, true)).toBe('off')
    expect(updateMode('darwin', false)).toBe('off')
  })
})
