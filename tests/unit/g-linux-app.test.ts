// The Linux desktop app's updates (docs/decisions/20261119-linux-desktop-app.md): the office manifest's `linux` entry,
// the publisher's --linux files and its re-run that adds them, a team server putting the two AppImages and
// latest-linux.yml / latest-linux-arm64.yml into its downloads folder from a fake feed (system/windows-app.ts and
// office/update.ts offerLinux), what /downloads/ serves then, the AppImage's check of a download against the signed
// release (desktop/src/common/update-verify.ts), the .deb's "a new version is out" check (linuxNotice) and the update
// modes. No real feed is contacted.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileUrl, OFFICE_PRODUCT, OfficeRelease as OfficeReleaseSchema, publicKeyOf, releaseFiles, signRelease, verifyRelease, type OfficeRelease } from '../../server/src/office/release'
import { checkLatestLinuxYml, dropUnnamedLinux, offerLinux, type StatfsLike } from '../../server/src/office/update'
import { LINUX_APPIMAGE_RE, linuxOfferedIn } from '../../server/src/office/desktop'
import { META_FILES, serveDownload } from '../../server/src/routes/downloads'
import { readWindowsState, refreshWindowsApp, type WindowsAppOptions } from '../../server/src/system/windows-app'
import { linuxNotice, verifyInstaller } from '../../desktop/src/common/update-verify'
import { updateMode } from '../../desktop/src/common/update'
import { PRODUCT } from '../../shared/src/product'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'g-linux-app')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const FEED = 'http://127.0.0.1:45998'
const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const KEYS = [publicKeyOf(pem)]
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const sha512 = (b: Uint8Array | string) => crypto.createHash('sha512').update(b).digest('base64')
const disk = (freeGiB: number): StatfsLike => () => ({ bsize: 4096, blocks: (40 * 2 ** 30) / 4096, bfree: (freeGiB * 2 ** 30) / 4096, bavail: (freeGiB * 2 ** 30) / 4096 })
const A = PRODUCT.artifactBase
const names = (v: string) => ({
  x64: { img: `${A}-${v}-linux-x86_64.AppImage`, deb: `${A}-${v}-linux-amd64.deb`, yml: 'latest-linux.yml' },
  arm64: { img: `${A}-${v}-linux-arm64.AppImage`, deb: `${A}-${v}-linux-arm64.deb`, yml: 'latest-linux-arm64.yml' },
})

/** electron-builder's merged yml: the AppImage and the .deb of one processor, `path:` either of them (`debFirst`) */
function linuxYml(version: string, img: string, imgBytes: Uint8Array, deb: string, debBytes: Uint8Array, debFirst = false) {
  const e = (u: string, b: Uint8Array) => `  - url: ${u}\n    sha512: ${sha512(b)}\n    size: ${b.byteLength}\n`
  const first = debFirst ? [deb, debBytes] as const : [img, imgBytes] as const
  return `version: ${version}\nfiles:\n${debFirst ? e(deb, debBytes) + e(img, imgBytes) : e(img, imgBytes) + e(deb, debBytes)}path: ${first[0]}\nsha512: ${sha512(first[1])}\nreleaseDate: '2026-11-19T00:00:00.000Z'\n`
}

/** a release on the fake feed with a Linux app (and no Windows or Mac app): the signed manifest and the files */
function publish(version: string, o: { served?: Buffer; yml?: (s: string) => string } = {}) {
  const files = new Map<string, Uint8Array | string>()
  const officeZip = new Uint8Array([1, 2, 3])
  const officeName = `TeamAX-office-${version}-mac.zip`
  files.set(fileUrl(FEED, version, officeName), officeZip)
  const n = names(version)
  const bytes = { x64: { img: crypto.randomBytes(24 * 1024), deb: crypto.randomBytes(8 * 1024) }, arm64: { img: crypto.randomBytes(24 * 1024), deb: crypto.randomBytes(8 * 1024) } }
  let ymlX = linuxYml(version, n.x64.img, bytes.x64.img, n.x64.deb, bytes.x64.deb)
  let ymlA = linuxYml(version, n.arm64.img, bytes.arm64.img, n.arm64.deb, bytes.arm64.deb, true)
  if (o.yml) { ymlX = o.yml(ymlX); ymlA = o.yml(ymlA) }
  files.set(fileUrl(FEED, version, n.x64.img), o.served ?? bytes.x64.img)
  files.set(fileUrl(FEED, version, n.arm64.img), bytes.arm64.img)
  files.set(fileUrl(FEED, version, n.x64.deb), bytes.x64.deb)
  files.set(fileUrl(FEED, version, n.arm64.deb), bytes.arm64.deb)
  files.set(fileUrl(FEED, version, n.x64.yml), ymlX)
  files.set(fileUrl(FEED, version, n.arm64.yml), ymlA)
  const f = (file: string, b: Uint8Array | string) => ({ file, url: fileUrl(FEED, version, file), sha256: sha(b), size: Buffer.byteLength(b) })
  const r: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: '',
    office: [{ arch: 'universal', ...f(officeName, officeZip) }], windows: null,
    linux: {
      version,
      appImageX64: f(n.x64.img, bytes.x64.img), appImageArm64: f(n.arm64.img, bytes.arm64.img),
      debX64: f(n.x64.deb, bytes.x64.deb), debArm64: f(n.arm64.deb, bytes.arm64.deb),
      latestYml: f(n.x64.yml, ymlX), latestYmlArm64: f(n.arm64.yml, ymlA),
    },
  }
  const signed = signRelease(r, pem)
  files.set(`${FEED}/office/stable.json`, signed)
  return { files, r, signed, bytes, n, ymlX, ymlA }
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
  dataDir: s.data, version: '0.5.17', channel: 'stable', feed: FEED, keys: KEYS, fetch: fakeFetch(files), statfs: disk(20), ...over,
})
const get = (dir: string, name: string) => serveDownload(new Request(`http://x/downloads/${name}`), `/${name}`, dir)

describe('the signed release names the Linux app', () => {
  test('a release with `linux` verifies and lists its six files; one without it has no `linux` key; an old server drops it', () => {
    const p = publish('0.5.17')
    const r = verifyRelease(p.signed, { keys: KEYS, channel: 'stable', feed: FEED })
    expect(r.linux?.appImageArm64.file).toBe(p.n.arm64.img)
    expect(releaseFiles(r).map((f) => f.file)).toEqual(expect.arrayContaining([p.n.x64.img, p.n.arm64.img, p.n.x64.deb, p.n.arm64.deb, 'latest-linux.yml', 'latest-linux-arm64.yml']))
    expect(releaseFiles(r).length).toBe(7) // the office zip + six
    // every Linux file must be on the feed
    const off = { ...p.r, linux: { ...p.r.linux!, debArm64: { ...p.r.linux!.debArm64, url: 'https://elsewhere.test/x.deb' } } }
    expect(() => verifyRelease(signRelease(off, pem), { keys: KEYS, channel: 'stable', feed: FEED })).toThrow(/not on the release feed/)
    const { linux: _, ...old } = p.r
    expect(JSON.parse(JSON.parse(signRelease(old as OfficeRelease, pem)).payload)).not.toHaveProperty('linux')
    // a server that does not know the field strips it (zod drops unknown keys), as with `mac` before 0.5.5
    const before = OfficeReleaseSchema.omit({ linux: true })
    expect(before.parse(JSON.parse(JSON.parse(p.signed).payload))).not.toHaveProperty('linux')
    // a half-filled entry is not readable
    const half = JSON.parse(JSON.parse(p.signed).payload)
    delete half.linux.debX64
    expect(() => OfficeReleaseSchema.parse(half)).toThrow()
  })
})

describe('a team server offers the Linux AppImages', () => {
  test('both AppImages + both yml + the signed manifest go into the folder (no .deb), are served, and the AppImage accepts its file', async () => {
    const s = server('offer')
    const p = publish('0.5.17')
    const r = await refreshWindowsApp(opts(s, p.files))
    expect(r.kind).toBe('none') // no Windows app in this release
    expect(readWindowsState(s.data).linux?.last).toMatchObject({ kind: 'offered', version: '0.5.17' })
    expect(fs.readdirSync(s.downloads).sort()).toEqual(['.linux-arm64.json', '.linux-x64.json', p.n.arm64.img, p.n.x64.img, 'latest-linux-arm64.yml', 'latest-linux.yml', 'stable.json'].sort())
    expect(linuxOfferedIn(s.downloads)).toEqual([{ arch: 'x64', version: '0.5.17', appImage: p.n.x64.img }, { arch: 'arm64', version: '0.5.17', appImage: p.n.arm64.img }])
    // what the AppImage's electron-updater reads, and the files the yml names
    expect(META_FILES).toEqual(expect.arrayContaining(['latest-linux.yml', 'latest-linux-arm64.yml']))
    expect(await (await get(s.downloads, 'latest-linux.yml')).text()).toBe(p.ymlX)
    expect(await (await get(s.downloads, 'latest-linux-arm64.yml')).text()).toBe(p.ymlA)
    const z = await get(s.downloads, p.n.x64.img)
    expect(z.status).toBe(200)
    expect(z.headers.get('content-disposition')).toContain('attachment')
    const bytes = new Uint8Array(await z.arrayBuffer())
    expect(sha(bytes)).toBe(sha(p.bytes.x64.img))
    expect(sha(new Uint8Array(await (await get(s.downloads, p.n.arm64.img)).arrayBuffer()))).toBe(sha(p.bytes.arm64.img))
    // the .deb is never in the folder or served (it is named by the yml, but only AppImages are offered)
    expect((await get(s.downloads, p.n.x64.deb)).status).toBe(404)
    // the AppImage checks the download against /downloads/stable.json, for its own processor
    const manifest = await (await get(s.downloads, 'stable.json')).text()
    const base = { manifest, channel: 'stable' as const, version: '0.5.17', current: '0.5.16', keys: KEYS, product: OFFICE_PRODUCT, platform: 'linux' as const }
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), arch: 'x64' }).ok).toBe(true)
    expect(verifyInstaller({ ...base, installerSha256: sha(p.bytes.arm64.img), arch: 'arm64' }).ok).toBe(true)
    // the other processor's file, another file, another version, an unknown processor, or a Windows check: refused
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), arch: 'arm64' })).toEqual({ ok: false, reason: expect.stringMatching(/not the one the signed release names/) })
    expect(verifyInstaller({ ...base, installerSha256: sha('evil'), arch: 'x64' }).ok).toBe(false)
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), arch: 'x64', version: '0.5.18' })).toEqual({ ok: false, reason: expect.stringMatching(/names the Linux app 0.5.17, not 0.5.18/) })
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), arch: 'ia32' })).toEqual({ ok: false, reason: expect.stringMatching(/no update for ia32/) })
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), arch: 'x64', current: '0.5.17' }).ok).toBe(false)
    expect(verifyInstaller({ ...base, installerSha256: sha(bytes), platform: 'windows' })).toEqual({ ok: false, reason: expect.stringMatching(/no Windows app/) })
    // a second run: current, nothing downloaded again
    expect((await refreshWindowsApp(opts(s, new Map([[`${FEED}/office/stable.json`, p.signed]])))).kind).toBe('none')
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('current')
    // an AppImage the folder holds that no yml names, and the sidecars, are never served
    fs.writeFileSync(path.join(s.downloads, `${A}-0.5.1-linux-x86_64.AppImage`), 'old')
    expect((await get(s.downloads, `${A}-0.5.1-linux-x86_64.AppImage`)).status).toBe(404)
    expect((await get(s.downloads, '.linux-x64.json')).status).toBe(404)
  })

  test('the next release replaces the AppImages; an older release never replaces a newer one; the server\'s version caps it', async () => {
    const s = server('next')
    const a = publish('0.5.17')
    await refreshWindowsApp(opts(s, a.files))
    const b = publish('0.5.18')
    // the server still runs 0.5.17: 0.5.18's app waits
    await refreshWindowsApp(opts(s, b.files))
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('ahead')
    expect(linuxOfferedIn(s.downloads).map((x) => x.version)).toEqual(['0.5.17', '0.5.17'])
    await refreshWindowsApp(opts(s, b.files, { version: '0.5.18' }))
    expect(readWindowsState(s.data).linux?.last).toMatchObject({ kind: 'offered', version: '0.5.18' })
    expect(fs.readdirSync(s.downloads).filter((f) => LINUX_APPIMAGE_RE.test(f)).sort()).toEqual([b.n.arm64.img, b.n.x64.img].sort())
    const res = await offerLinux(s.downloads, path.join(s.data, 'tmp'), a.r.linux!, { fetch: fakeFetch(a.files), log: () => {} })
    expect(res).toEqual({ kind: 'newer', version: '0.5.18' })
  })

  test('an AppImage or a yml that does not match the signed release changes nothing and is held for a day; no room: nothing downloaded', async () => {
    const s = server('bad')
    const good = publish('0.5.17')
    await refreshWindowsApp(opts(s, good.files))
    const p = publish('0.5.18', { served: crypto.randomBytes(24 * 1024) })
    await refreshWindowsApp(opts(s, p.files, { version: '0.5.18' }))
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('failed')
    expect(readWindowsState(s.data).linux?.last?.message).toContain('does not match the signed release')
    expect(linuxOfferedIn(s.downloads).map((x) => x.version)).toEqual(['0.5.17', '0.5.17'])
    await refreshWindowsApp(opts(s, p.files, { version: '0.5.18' }))
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('held')
    // a yml (signed as it is) whose files list names another file is refused, before the folder changes
    const q = publish('0.5.19', { yml: (y) => y.replace(/url: (\S+)\.deb/, 'url: ../../etc/passwd') })
    await refreshWindowsApp(opts(s, q.files, { version: '0.5.19' }))
    expect(readWindowsState(s.data).linux?.last?.message).toMatch(/file urls must be just/)
    expect(linuxOfferedIn(s.downloads).map((x) => x.version)).toEqual(['0.5.17', '0.5.17'])
    expect(fs.readdirSync(s.downloads).filter((f) => f.includes('0.5.19'))).toEqual([])
    const r = publish('0.5.20')
    await refreshWindowsApp(opts(s, r.files, { version: '0.5.20', statfs: disk(0.1) }))
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('no-room')
    expect(fs.readdirSync(s.downloads).filter((f) => f.includes('0.5.20'))).toEqual([])
  })

  test('a damaged AppImage of the same size is fetched again; a release without a Linux app drops the older one', async () => {
    const s = server('damaged')
    const p = publish('0.5.17')
    await refreshWindowsApp(opts(s, p.files))
    const f = path.join(s.downloads, p.n.arm64.img)
    const bad = Buffer.from(p.bytes.arm64.img); bad[0] ^= 1
    fs.writeFileSync(f, bad)
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000))
    await refreshWindowsApp(opts(s, p.files, { force: true }))
    expect(readWindowsState(s.data).linux?.last?.kind).toBe('offered')
    expect(sha(fs.readFileSync(f))).toBe(sha(p.bytes.arm64.img))
    const { linux: _, ...noLinux } = publish('0.5.18').r
    dropUnnamedLinux(s.downloads, noLinux as OfficeRelease)
    expect(linuxOfferedIn(s.downloads)).toEqual([])
    expect(fs.readdirSync(s.downloads).filter((x) => LINUX_APPIMAGE_RE.test(x) || x.startsWith('latest-linux'))).toEqual([])
    // a newer Linux app than such a release stays
    const t = server('kept')
    await refreshWindowsApp(opts(t, publish('0.5.19').files, { version: '0.5.19' }))
    dropUnnamedLinux(t.downloads, noLinux as OfficeRelease)
    expect(linuxOfferedIn(t.downloads).map((x) => x.version)).toEqual(['0.5.19', '0.5.19'])
  })
})

describe('latest-linux.yml', () => {
  const v = '0.5.17'
  const n = names(v).x64
  const img = Buffer.from('i'), deb = Buffer.from('d')
  const ai = { file: n.img, sha512: sha512(img), size: 1 }
  test('its files list holds the AppImage (sha512, size), whatever `path:` names; otherwise only the .deb', () => {
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb), v, ai)).not.toThrow()
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb, true), v, ai)).not.toThrow() // path: the .deb
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb), '0.5.18', ai)).toThrow(/version/)
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb), v, { ...ai, sha512: sha512('x') })).toThrow(/sha512 or size/)
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb), v, { ...ai, size: 2 })).toThrow(/sha512 or size/)
    expect(() => checkLatestLinuxYml(linuxYml(v, n.deb, deb, n.deb, deb), v, ai)).toThrow(/lists no/)
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, 'https://evil.test/x.deb', deb), v, ai)).toThrow(/must be just/)
    expect(() => checkLatestLinuxYml(linuxYml(v, n.img, img, n.deb, deb).replace(/^path: .*$/m, 'path: other.AppImage'), v, ai)).toThrow(/files list does not hold/)
  })
})

describe('the publisher', () => {
  test('--linux takes the six files of the build folder, checks each yml against its AppImage, and adds them to the release', async () => {
    const { linuxApp, officeRelease } = await import('../../scripts/release/publish')
    const dir = path.join(BASE, 'build')
    fs.mkdirSync(dir, { recursive: true })
    const v = '0.5.17'
    const n = names(v)
    const b = { xi: crypto.randomBytes(2048), xd: crypto.randomBytes(1024), ai: crypto.randomBytes(2048), ad: crypto.randomBytes(1024) }
    fs.writeFileSync(path.join(dir, n.x64.img), b.xi); fs.writeFileSync(path.join(dir, n.x64.deb), b.xd)
    fs.writeFileSync(path.join(dir, n.arm64.img), b.ai); fs.writeFileSync(path.join(dir, n.arm64.deb), b.ad)
    fs.writeFileSync(path.join(dir, n.x64.yml), linuxYml(v, n.x64.img, b.xi, n.x64.deb, b.xd, true))
    fs.writeFileSync(path.join(dir, n.arm64.yml), linuxYml(v, n.arm64.img, b.ai, n.arm64.deb, b.ad))
    const arts: { key: string }[] = []
    const l = linuxApp(FEED, v, dir, arts as never)
    expect(l.version).toBe(v)
    expect(l.appImageX64).toEqual({ file: n.x64.img, url: fileUrl(FEED, v, n.x64.img), sha256: sha(b.xi), size: 2048 })
    expect(l.debArm64.sha256).toBe(sha(b.ad))
    expect(arts.map((a) => a.key).sort()).toEqual([n.x64.img, n.x64.deb, n.x64.yml, n.arm64.img, n.arm64.deb, n.arm64.yml].map((f) => `office/${v}/${f}`).sort())
    const r = officeRelease({ channel: 'stable', version: v, minFrom: '0.2.0-0', notes: '', office: { file: 'o.zip', url: fileUrl(FEED, v, 'o.zip'), sha256: sha('o'), size: 1 }, windows: null, linux: l, rollout: 'all' })
    expect(verifyRelease(signRelease(r, pem), { keys: KEYS, channel: 'stable', feed: FEED }).linux).toEqual(l)
    // without --linux: no `linux` key
    expect(officeRelease({ ...r, office: r.office[0]!, windows: null, rollout: 'all', linux: null })).not.toHaveProperty('linux')
    // an AppImage that is not the one its yml names, or a missing file: stopped
    fs.writeFileSync(path.join(dir, n.arm64.img), crypto.randomBytes(2048))
    expect(() => linuxApp(FEED, v, dir, [])).toThrow(/sha512 or size/)
    fs.rmSync(path.join(dir, n.arm64.deb))
    expect(() => linuxApp(FEED, v, dir, [])).toThrow(/not found/)
  })

  test('a re-run that adds the Linux app to a release published without it uploads; one that changes or drops it stops', async () => {
    const { versionManifestAction } = await import('../../scripts/release/publish')
    const ctx = { keys: KEYS, feed: FEED }
    const p = publish('0.5.17')
    const { linux: _, ...noLinux } = p.r
    expect(versionManifestAction(signRelease(noLinux as OfficeRelease, pem), p.r, ctx)).toBe('upload')
    expect(versionManifestAction(p.signed, p.r, ctx)).toBe('keep')
    const changed = { ...p.r, linux: { ...p.r.linux!, appImageX64: { ...p.r.linux!.appImageX64, sha256: 'f'.repeat(64) } } }
    expect(() => versionManifestAction(p.signed, changed, ctx)).toThrow(/other files/)
    expect(() => versionManifestAction(p.signed, noLinux as OfficeRelease, ctx)).toThrow(/other files/)
  })
})

describe('the desktop app on Linux', () => {
  test('a packaged AppImage updates itself; a packaged .deb gets the notice; unpacked and store builds are off', () => {
    expect(updateMode('linux', true, undefined, false, false, '/home/a/Apps/Trina-AX.AppImage')).toBe('auto-install')
    expect(updateMode('linux', true)).toBe('notice')
    expect(updateMode('linux', true, undefined, false, false, '')).toBe('notice')
    expect(updateMode('linux', false, undefined, false, false, '/x.AppImage')).toBe('off')
    expect(updateMode('linux', true, undefined, true, false, '/x.AppImage')).toBe('off')
  })

  test('the .deb\'s notice: a newer `linux` version in the signed manifest of the right product and channel, else nothing', () => {
    const p = publish('0.5.17')
    const o = { channel: 'stable' as const, current: '0.5.16', keys: KEYS, product: OFFICE_PRODUCT }
    expect(linuxNotice(p.signed, o)).toEqual({ version: '0.5.17' })
    expect(linuxNotice(p.signed, { ...o, current: '0.5.17' })).toBeNull()
    expect(linuxNotice(p.signed, { ...o, current: '0.6.0' })).toBeNull()
    expect(linuxNotice(p.signed, { ...o, channel: 'beta' })).toBeNull()
    expect(linuxNotice(p.signed, { ...o, product: 'other' })).toBeNull()
    expect(linuxNotice(p.signed, { ...o, keys: [publicKeyOf(crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)] })).toBeNull()
    const { linux: _, ...noLinux } = p.r
    expect(linuxNotice(signRelease(noLinux as OfficeRelease, pem), o)).toBeNull()
    expect(linuxNotice('not json', o)).toBeNull()
  })
})
