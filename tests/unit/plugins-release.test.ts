// Shipping official plugins (docs/PLUGINS.md "공식 플러그인 확인"): a server installs a pinned build from the official
// list by downloading it from the release feed (https, the feed's origin, public addresses, no redirects, the exact size
// and SHA-256 the list names) and then the normal permission prompt; a server that cannot run it (glibc < 2.39) says so
// and downloads nothing; hosted servers install this way while uploads stay off. A build the list revokes is turned off
// with an audit line and refused everywhere. Schema 1 is frozen: other package and list versions are refused.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_SCHEMA_VERSION, type CatalogEntry, type CatalogPin, type PluginPlatform } from '@mycel/shared/plugins'
import { loadCatalog } from '../../server/src/plugins/catalog'
import { readArchive, writeArchive } from '../../server/src/plugins/archive'
import { PluginManager, pluginsOf } from '../../server/src/plugins/manager'
import { PackageError, verifyPackage } from '../../server/src/plugins/package'
import { listSkills } from '../../server/src/chat/skills'
import { pinCatalog, formatCatalog } from '../../scripts/plugins/pin-catalog'
import { PLUGIN_FEED_BASE, uploadPlan } from '../../scripts/plugins/release-hwp'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { catalogDir, manifestDigest, noKeyTrust, pinnedEntry, skillPack } from '../lib/plugins'

setDefaultTimeout(60_000)
const ID = 'app.trina.office-starter'
const ORIGIN = 'https://feed.example'
const RELEASE_FEED = RELEASE_CHANNEL.feed
const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }]
const build = (version = '1.0.0') => skillPack({ version, keyPem: null }).bytes
const urlOf = (version: string) => `${ORIGIN}/plugins/${ID}/${version}/office-starter-${version}.trinaplugin`
const pinFor = (bytes: Uint8Array, version = '1.0.0', o: { url?: string; size?: number; sha?: string; platform?: PluginPlatform } = {}): CatalogPin => ({
  version, ...(o.platform ? { platform: o.platform } : {}), manifestSha256: manifestDigest(bytes),
  download: { url: o.url ?? urlOf(version), size: o.size ?? bytes.length, sha256: o.sha ?? sha256(bytes) },
})

/** A fake release feed: serves `files` by URL and records every request. */
function feed(files: Record<string, Uint8Array | (() => Response)>) {
  const calls: { url: string; redirect?: string }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect })
    const f = files[url]
    if (!f) return new Response('not found', { status: 404 })
    return typeof f === 'function' ? f() : new Response(new Uint8Array(f))
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

let app: CApp
let m: PluginManager
let dir: string
const list = async () => (await app.json('/api/admin/plugins', { as: 'carol' })).body
const fromList = (id = ID) => app.json('/api/admin/plugins/inspect-source', { ...jsonBody({ source: 'catalog', id }), as: 'carol' })
const install = (plan: any, enable = true) => app.json('/api/admin/plugins/install', {
  ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable, permissions: plan.permissions.filter((p: any) => p.required).map((p: any) => p.id) }), as: 'carol',
})
const remove = () => app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'carol' })
const useList = (entries: CatalogEntry[], extra: { revoked?: { id: string; manifestSha256: string }[] } = {}, files?: Record<string, Uint8Array | (() => Response)>) => {
  catalogDir(dir, entries)
  if (extra.revoked) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'))
    doc.revoked = extra.revoked
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(doc))
  }
  const f = feed(files ?? {})
  m.reconfigure({ catalogDir: dir, download: { fetch: f.fetch, lookup: PUBLIC, origin: ORIGIN } })
  return f
}

beforeAll(async () => {
  app = await makeCApp('plugins-release')
  m = pluginsOf(app.ctx)
  dir = path.join(app.data, 'release-catalog')
  m.reconfigure({ trust: noKeyTrust() })
})
afterAll(async () => { await app.close() })

describe('installing from the official list by download', () => {
  test('the pinned build is downloaded from the feed, checked, then installed through the permission prompt', async () => {
    const bytes = build()
    const f = useList([pinnedEntry([pinFor(bytes)])], {}, { [urlOf('1.0.0')]: bytes })
    expect((await list()).catalog[0]).toMatchObject({ id: ID, availability: 'available' })
    // listing downloads nothing
    expect(f.calls).toEqual([])
    const plan = await fromList()
    expect(plan.status).toBe(200)
    expect(plan.body).toMatchObject({ id: ID, trust: 'official', verifiedBy: 'release', source: 'catalog', archiveSha256: sha256(bytes) })
    // one request, to exactly the pinned address, never following a redirect
    expect(f.calls).toEqual([{ url: urlOf('1.0.0'), redirect: 'error' }])
    // nothing is installed before the admin approves
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
    expect((await install(plan.body)).body).toMatchObject({ verifiedBy: 'release', source: 'catalog', enabled: true })
    // already installed: refused before anything is downloaded
    expect((await fromList()).body.error.params.reason).toBe('same_version')
    expect(f.calls).toHaveLength(1)
    expect((await remove()).status).toBe(204)
  })

  test('other bytes, more bytes, another address, a private address or a failed request are refused', async () => {
    const bytes = build(), other = build('1.0.0').subarray(0)
    const changed = Buffer.from(other); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    const cases: [Record<string, Uint8Array | (() => Response)>, CatalogPin, string][] = [
      // same size, one byte different: the SHA-256 the list names does not match
      [{ [urlOf('1.0.0')]: changed }, pinFor(bytes), 'tampered'],
      // more than the list says: refused while streaming, or by the announced length
      [{ [urlOf('1.0.0')]: Buffer.concat([bytes, Buffer.alloc(10)]) }, pinFor(bytes), 'tampered'],
      [{ [urlOf('1.0.0')]: () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length * 2) } }) }, pinFor(bytes), 'tampered'],
      // not on the release feed's origin
      [{ 'https://elsewhere.example/x.trinaplugin': bytes }, pinFor(bytes, '1.0.0', { url: 'https://elsewhere.example/x.trinaplugin' }), 'download'],
      // the feed is down, or answers 404
      [{ [urlOf('1.0.0')]: () => new Response('busy', { status: 503 }) }, pinFor(bytes), 'download'],
      [{}, pinFor(bytes), 'download'],
      [{ [urlOf('1.0.0')]: () => { throw new TypeError('redirect was not allowed') } }, pinFor(bytes), 'download'],
    ]
    for (const [files, pin, why] of cases) {
      useList([pinnedEntry([pin])], {}, files)
      const r = await fromList()
      expect(r.body.error?.params?.reason, JSON.stringify(pin.download)).toBe(why)
    }
    // the address resolves to a private network: refused before any request
    const f = useList([pinnedEntry([pinFor(bytes)])], {}, { [urlOf('1.0.0')]: bytes })
    m.reconfigure({ download: { fetch: f.fetch, lookup: async () => [{ address: '10.0.0.5', family: 4 }], origin: ORIGIN } })
    expect((await fromList()).body.error.params.reason).toBe('download')
    expect(f.calls).toEqual([])
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
  })

  test('an address off the feed is refused before any name is looked up; one download per plugin at a time', async () => {
    const bytes = build()
    const looked: string[] = []
    const f = useList([pinnedEntry([pinFor(bytes, '1.0.0', { url: 'https://elsewhere.example/x.trinaplugin' })])], {}, { 'https://elsewhere.example/x.trinaplugin': bytes })
    m.reconfigure({ download: { fetch: f.fetch, lookup: async (h) => { looked.push(h); return PUBLIC() }, origin: ORIGIN } })
    expect((await fromList()).body.error.params).toMatchObject({ reason: 'download', detail: 'the package address is not on the release feed' })
    expect(looked).toEqual([])
    expect(f.calls).toEqual([])
    // a second "Install" while the first download runs is refused, and the first one still completes
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    useList([pinnedEntry([pinFor(bytes)])], {}, {})
    m.reconfigure({ download: { lookup: PUBLIC, origin: ORIGIN, fetch: (async () => { await gate; return new Response(new Uint8Array(bytes)) }) as unknown as typeof fetch } })
    const first = fromList()
    await new Promise((r) => setTimeout(r, 50))
    expect((await fromList()).body.error.params).toMatchObject({ reason: 'download', detail: 'this plugin is already being downloaded' })
    release()
    const plan = (await first).body
    expect(plan).toMatchObject({ id: ID, trust: 'official', verifiedBy: 'release' })
    // finished: the next request downloads again
    const again = await fromList()
    expect(again.body).toMatchObject({ id: ID, trust: 'official' })
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
  })

  test('the release script never replaces a file already on the feed with other bytes', async () => {
    const a = build(), b = build('1.0.1')
    const file = (n: string) => `dist/${n}.trinaplugin`
    const base = `${RELEASE_FEED}/plugins/app.trina.hwp-preview/1.0.0/`
    const served: Record<string, Uint8Array> = { [`${base}same.trinaplugin`]: a, [`${base}other.trinaplugin`]: b }
    const f = (async (url: string) => {
      const hit = served[url.replace(/\?.*$/, '')]
      return hit ? new Response(new Uint8Array(hit)) : new Response('Not found\n', { status: 404 })
    }) as unknown as typeof fetch
    expect(await uploadPlan([{ file: file('same'), bytes: a }, { file: file('new'), bytes: a }], f)).toEqual([
      { file: file('same'), key: 'plugins/app.trina.hwp-preview/1.0.0/same.trinaplugin', skip: true },
      { file: file('new'), key: 'plugins/app.trina.hwp-preview/1.0.0/new.trinaplugin', skip: false },
    ])
    await expect(uploadPlan([{ file: file('new'), bytes: a }, { file: file('other'), bytes: a }], f)).rejects.toThrow(/already published with other bytes/)
  })

  test('a server the build cannot run on (glibc older than 2.39) says so and downloads nothing', async () => {
    const LINUX: PluginPlatform = { os: 'linux', arch: 'x64', libc: { family: 'glibc', minVersion: '2.39' } }
    const bytes = build()
    const f = useList([pinnedEntry([{ ...pinFor(bytes), platform: LINUX }], { platforms: [LINUX] })], {}, { [urlOf('1.0.0')]: bytes })
    m.reconfigure({ host: { os: 'linux', arch: 'x64', libc: '2.36' } })
    try {
      expect((await list()).catalog[0]).toMatchObject({ availability: 'unsupported', unsupported: 'libc' })
      const r = await fromList()
      expect(r.body.error.params).toMatchObject({ reason: 'unsupported', detail: 'libc' })
      expect(f.calls).toEqual([])
    } finally { m.reconfigure({ host: { os: process.platform, arch: process.arch, libc: null } }) }
  })

  test('hosted servers install from the list by download; package uploads stay off', async () => {
    const hosted = await makeCApp('plugins-release-hosted')
    try {
      ;(hosted.ctx.config as { deployment?: string }).deployment = 'hosted'
      const bytes = build()
      const d = path.join(hosted.data, 'catalog')
      catalogDir(d, [pinnedEntry([pinFor(bytes)])])
      const f = feed({ [urlOf('1.0.0')]: bytes })
      const h = new PluginManager(hosted.ctx, { trust: noKeyTrust('hosted'), catalogDir: d, download: { fetch: f.fetch, lookup: PUBLIC, origin: ORIGIN } })
      expect(h.list('en')).toMatchObject({ fileInstall: false })
      expect(() => h.inspect('carol', bytes, 'file', 'en')).toThrow()
      const plan = await h.inspectCatalog('carol', ID, 'en')
      expect(plan).toMatchObject({ trust: 'official', verifiedBy: 'release', source: 'catalog' })
      expect(h.install('carol', { token: plan.token, manifestSha256: plan.manifestSha256, enable: true, permissions: ['skills.company'] }, 'en')).toMatchObject({ enabled: true, verifiedBy: 'release' })
    } finally { await hosted.close() }
  })

  test('the real feed address is the only origin a server downloads from by default', () => {
    expect(PLUGIN_FEED_BASE).toBe('https://updates.trina.app/plugins')
    const shipped = loadCatalog(path.resolve(import.meta.dir, '../../resources/plugins'), noKeyTrust())
    for (const e of shipped.entries) for (const p of e.pins ?? []) if (p.download) expect(new URL(p.download.url).origin).toBe('https://updates.trina.app')
  })
})

describe('revocation', () => {
  test('a later list that revokes an installed build turns it off, audits it once and refuses it everywhere', async () => {
    const bytes = build()
    useList([pinnedEntry([pinFor(bytes)])], {}, { [urlOf('1.0.0')]: bytes })
    expect((await install((await fromList()).body)).body).toMatchObject({ enabled: true })
    const skills = () => listSkills(app.ctx.files, app.ctx.files.principal('alice')).filter((s) => s.path.startsWith(`skills/${ID}/`))
    expect(skills().length).toBeGreaterThan(0)
    // the next release withdraws that exact build (and still lists its pin by mistake: the revocation wins)
    useList([pinnedEntry([pinFor(bytes)])], { revoked: [{ id: ID, manifestSha256: manifestDigest(bytes) }] })
    const view = (await list()).installed[0]
    expect(view).toMatchObject({ id: ID, enabled: false, status: 'unsupported', unsupported: 'revoked' })
    expect(skills()).toEqual([])
    expect(m.usable(ID)).toBe(false)
    const audits = () => app.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'plugin.revoke'").all() as { actor_id: string | null; target: string; detail: string }[]
    expect(audits()).toHaveLength(1)
    expect(audits()[0]).toMatchObject({ actor_id: null, target: ID })
    expect(JSON.parse(audits()[0]!.detail)).toMatchObject({ version: '1.0.0', manifestSha256: manifestDigest(bytes) })
    // a restart with the same list: no second line
    new PluginManager(app.ctx, { trust: noKeyTrust(), catalogDir: dir })
    expect(audits()).toHaveLength(1)
    // turning it on, installing the same build again (from a file) and the list card all refuse
    expect((await app.json(`/api/admin/plugins/${ID}/enable`, { ...jsonBody({}), as: 'carol' })).body.error.params.reason).toBe('revoked')
    const fd = new FormData(); fd.set('file', new Blob([new Uint8Array(bytes)]), 'pack.trinaplugin')
    expect((await app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd, as: 'carol' })).body.error.params.reason).toBe('revoked')
    expect((await list()).catalog[0].availability).toBe('pending_clearance')
    expect((await remove()).status).toBe(204)
  })

  test('rolling back to a revoked version is refused; the newer build keeps working', async () => {
    const v1 = build('1.0.0'), v2 = build('1.1.0')
    useList([pinnedEntry([pinFor(v1)])], {}, { [urlOf('1.0.0')]: v1 })
    expect((await install((await fromList()).body)).status).toBe(201)
    useList([pinnedEntry([pinFor(v2, '1.1.0')], { version: '1.1.0' })], {}, { [urlOf('1.1.0')]: v2 })
    expect((await install((await fromList()).body)).body).toMatchObject({ version: '1.1.0', previousVersion: '1.0.0' })
    useList([pinnedEntry([pinFor(v2, '1.1.0')], { version: '1.1.0' })], { revoked: [{ id: ID, manifestSha256: manifestDigest(v1) }] })
    expect((await list()).installed[0]).toMatchObject({ version: '1.1.0', enabled: true, status: 'enabled' })
    expect((await app.json(`/api/admin/plugins/${ID}/rollback`, { ...jsonBody({}), as: 'carol' })).body.error.params.reason).toBe('revoked')
    expect((await remove()).status).toBe(204)
  })

  test('the pin script never pins a revoked build', () => {
    const bytes = build()
    const text = formatCatalog({ schemaVersion: PLUGIN_SCHEMA_VERSION, sequence: 1, entries: [pinnedEntry([]) ].map(({ pins: _p, ...e }) => e), revoked: [{ id: ID, manifestSha256: manifestDigest(bytes) }] })
    expect(() => pinCatalog(text, [{ file: 'office-starter-1.0.0.trinaplugin', bytes }], { cleared: [], testKeyId: null })).toThrow(/revoked/)
    // with a download base it records the address, size and SHA-256 of exactly that file
    const ok = pinCatalog(text.replace(/"revoked": \[[^\]]*\]/s, '"revoked": []'), [{ file: 'dist/office-starter-1.0.0.trinaplugin', bytes }], { cleared: [], testKeyId: null, downloadBase: `${ORIGIN}/plugins/` })
    expect(ok.pins[0]!.pin.download).toEqual({ url: urlOf('1.0.0'), size: bytes.length, sha256: sha256(bytes) })
  })
})

describe('the frozen format (schema 1)', () => {
  test('a package of another schema version is refused as such, before trust', () => {
    const bytes = build()
    for (const version of [0, 2, '1', null]) {
      const files = new Map(readArchive(bytes))
      const doc = JSON.parse(Buffer.from(files.get('trina-plugin.json')!).toString())
      doc.schemaVersion = version
      files.set('trina-plugin.json', Buffer.from(JSON.stringify(doc)))
      let why = 'accepted'
      try { verifyPackage(writeArchive(files), noKeyTrust('dev', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' })) } catch (e) { why = (e as PackageError).reason }
      expect(why, String(version)).toBe('schema')
    }
    expect(verifyPackage(bytes, noKeyTrust('dev', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' })).manifest.schemaVersion).toBe(1)
  })

  test('a list of another schema version is not read', () => {
    for (const version of [0, 2]) {
      catalogDir(dir, [pinnedEntry([])])
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'))
      doc.schemaVersion = version
      fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(doc))
      expect(loadCatalog(dir, noKeyTrust())).toMatchObject({ source: 'none', entries: [], revoked: [] })
    }
  })
})
