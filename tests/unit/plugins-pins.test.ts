// Official plugins without a plugin key (docs/PLUGINS.md "공식 플러그인 확인"): a package whose canonical manifest digest
// is pinned, for its version and platform, in the official list that ships inside the signed core release is official.
// A wrong digest, platform or version, an entry without a pin, a hidden list or any environment setting never makes a
// package official; a pin never lifts pending_clearance; HWP still needs MYCEL_HWP_PREVIEW=1 as well as the plugin on;
// the release tooling pins exactly the built packages and default release bundles still carry no plugin bytes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginCatalog, type CatalogEntry, type PluginPlatform } from '@mycel/shared/plugins'
import { defaultCatalogDir, loadCatalog, releasePins } from '../../server/src/plugins/catalog'
import { HWP_PLUGIN_ID } from '../../server/src/plugins/drivers'
import { parseStrictJson } from '../../server/src/plugins/json'
import { PluginManager, pluginsOf } from '../../server/src/plugins/manager'
import { buildPackage, PackageError, verifyPackage } from '../../server/src/plugins/package'
import { trustRoot } from '../../server/src/plugins/trust'
import { readArchive, writeArchive } from '../../server/src/plugins/archive'
import { buildHwpPlugin } from '../../scripts/plugins/build-hwp'
import { formatCatalog, pinCatalog } from '../../scripts/plugins/pin-catalog'
import { assertNoPluginPayload, stagePluginCatalog } from '../../scripts/plugins/release-check'
import type { HwpTarget } from '../../scripts/hwp-bundle'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { catalogDir, manifestDigest, newKey, noKeyTrust, pinnedEntry, skillManifest, skillPack, skillText } from '../lib/plugins'

setDefaultTimeout(60_000)
const REPO = path.resolve(import.meta.dir, '../..')
const ID = 'app.trina.office-starter'
const key = newKey()
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pins-'))
const reason = (fn: () => unknown) => { try { fn() } catch (e) { return (e as PackageError).reason ?? (e as Error).message } return 'accepted' }
const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
/** Official builds are unsigned: the pin is what makes them trusted. */
const build = (version = '1.0.0', skills?: Record<string, string>) => skillPack({ version, keyPem: null, skills }).bytes
const LINUX: PluginPlatform = { os: 'linux', arch: 'x64', libc: { family: 'glibc', minVersion: '2.39' } }
const MAC: PluginPlatform = { os: 'darwin', arch: 'arm64' }
/** A skill pack built for one platform (data-only packs may name one). */
function platformBuild(platform: PluginPlatform, version = '1.0.0') {
  const payload = new Map<string, Uint8Array>([['skills/minutes/SKILL.md', Buffer.from(skillText('minutes', 'Minutes.'))]])
  return buildPackage({ manifest: { ...skillManifest({ version, skills: ['minutes'] }), platforms: [platform] }, payload }).bytes
}
const pinsOf = (dir: string, runKind: 'selfhost' | 'hosted' | 'office' | 'dev' = 'selfhost') => releasePins(loadCatalog(dir, noKeyTrust(runKind)))

describe('release pins', () => {
  test('a pinned build is official without any key, and every stored byte is the pinned one', () => {
    const d = tmp()
    const bytes = build()
    const digest = manifestDigest(bytes)
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: digest }])])
    const cat = loadCatalog(d, noKeyTrust())
    expect(cat.source).toBe('release')
    const v = verifyPackage(bytes, noKeyTrust(), releasePins(cat))
    expect(v).toMatchObject({ trust: 'official', keyId: null, pinned: true, manifestSha256: digest, sigText: null })
    expect(sha256(v.manifestText)).toBe(digest)
    // a stray signature file does not change the verdict and is not stored
    const withSig = writeArchive(new Map([...readArchive(bytes), ['trina-plugin.sig', Buffer.from('{"keyId":"0000000000000000","sig":"x"}')]]))
    expect(verifyPackage(withSig, noKeyTrust(), releasePins(cat))).toMatchObject({ trust: 'official', sigText: null })
    // the file inventory is still checked: one changed byte is refused
    const changed = new Map(readArchive(bytes)); const b = Buffer.from(changed.get('skills/meeting-minutes/template.md')!); b[0] = b[0]! ^ 1
    changed.set('skills/meeting-minutes/template.md', b)
    expect(reason(() => verifyPackage(writeArchive(changed), noKeyTrust(), releasePins(cat)))).toBe('tampered')
    // without the pin the same bytes are refused in production
    expect(reason(() => verifyPackage(bytes, noKeyTrust()))).toBe('signature')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('wrong digest, wrong version, wrong platform or an entry without a pin: refused in production', () => {
    const d = tmp()
    const bytes = build()
    // wrong digest: another build of the same id and version
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(build('1.0.0', { other: 'Another build.' })) }])])
    expect(reason(() => verifyPackage(bytes, noKeyTrust(), pinsOf(d)))).toBe('signature')
    // wrong version: the list pins 1.0.0; a 1.0.1 build is not vouched for, and a pin cannot name another version
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }])])
    expect(reason(() => verifyPackage(build('1.0.1'), noKeyTrust(), pinsOf(d)))).toBe('signature')
    catalogDir(d, [pinnedEntry([{ version: '1.0.1', manifestSha256: manifestDigest(build('1.0.1')) }])])
    expect(loadCatalog(d, noKeyTrust())).toMatchObject({ source: 'none', entries: [] })
    // no pin at all
    catalogDir(d, [pinnedEntry([])])
    expect(reason(() => verifyPackage(bytes, noKeyTrust(), pinsOf(d)))).toBe('signature')
    // wrong platform: the macOS build's digest listed under Linux vouches for nothing, and neither does the right
    // digest under another C library floor
    const mac = platformBuild(MAC)
    const platforms = [LINUX, MAC]
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', platform: LINUX, manifestSha256: manifestDigest(mac) }], { platforms })])
    expect(reason(() => verifyPackage(mac, noKeyTrust(), pinsOf(d)))).toBe('signature')
    const linuxOld = platformBuild({ ...LINUX, libc: { family: 'glibc', minVersion: '2.36' } })
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', platform: LINUX, manifestSha256: manifestDigest(linuxOld) }], { platforms })])
    expect(reason(() => verifyPackage(linuxOld, noKeyTrust(), pinsOf(d)))).toBe('signature')
    // a platform-less pin never vouches for a build that names a platform
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(mac) }])])
    expect(reason(() => verifyPackage(mac, noKeyTrust(), pinsOf(d)))).toBe('signature')
    // the right platform: official
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', platform: MAC, manifestSha256: manifestDigest(mac) }], { platforms })])
    expect(verifyPackage(mac, noKeyTrust(), pinsOf(d)).trust).toBe('official')
    // a pin for a platform the entry does not list, or two pins for one platform: the list does not load
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', platform: { os: 'linux', arch: 'arm64' }, manifestSha256: manifestDigest(mac) }], { platforms })])
    expect(loadCatalog(d, noKeyTrust()).source).toBe('none')
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', platform: MAC, manifestSha256: manifestDigest(mac) }, { version: '1.0.0', platform: MAC, manifestSha256: manifestDigest(bytes) }], { platforms })])
    expect(loadCatalog(d, noKeyTrust()).source).toBe('none')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('a list whose signature does not verify vouches for nothing', () => {
    const d = tmp()
    const bytes = build()
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }])], {}, key.pem)
    // signed by a key this server does not trust: treated as tampering
    expect(loadCatalog(d, noKeyTrust()).source).toBe('none')
    expect(pinsOf(d)).toEqual([])
    expect(reason(() => verifyPackage(bytes, noKeyTrust(), pinsOf(d)))).toBe('signature')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('pending_clearance: a pin never makes the package installable; a development test key still can', () => {
    const d = tmp()
    const bytes = build()
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }], { availability: 'pending_clearance' })])
    for (const runKind of ['selfhost', 'hosted', 'office'] as const) expect(reason(() => verifyPackage(bytes, noKeyTrust(runKind), pinsOf(d, runKind)))).toBe('not_available')
    // internal review servers keep using test-signed packages with the operator's settings
    const testSigned = skillPack({ keyPem: key.pem }).bytes
    const dev = noKeyTrust('dev', { MYCEL_PLUGINS_TEST_KEYS: key.pub })
    expect(verifyPackage(testSigned, dev, pinsOf(d, 'dev')).trust).toBe('test')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('no environment setting adds a pin or makes a build official on hosted, office or an unmarked server', () => {
    const d = tmp()
    const bytes = build()
    const testSigned = skillPack({ keyPem: key.pem }).bytes
    const env = {
      MYCEL_PLUGINS_TEST_KEYS: key.pub, MYCEL_PLUGINS_ALLOW_UNSIGNED: '1', MYCEL_PLUGINS_TEST_SERVER: '1',
      // names someone might try: none of them is read
      MYCEL_PLUGINS_TEST_PINS: manifestDigest(bytes), MYCEL_PLUGINS_PINS: manifestDigest(bytes), MYCEL_PLUGINS_CATALOG: d, MYCEL_PLUGINS_CATALOG_DIR: d,
    }
    catalogDir(d, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }])])
    for (const runKind of ['hosted', 'office'] as const) {
      const root = trustRoot({ runKind, env, productionKeys: [] })
      expect(root.warnings).toEqual([])
      expect(reason(() => verifyPackage(bytes, root))).toBe('signature')
      expect(reason(() => verifyPackage(testSigned, root))).toBe('untrusted')
    }
    const { MYCEL_PLUGINS_TEST_SERVER: _marked, ...unmarked } = env
    expect(reason(() => verifyPackage(bytes, trustRoot({ runKind: 'selfhost', env: unmarked, productionKeys: [] })))).toBe('signature')
    // development may accept unsigned packages, but never as official
    expect(verifyPackage(bytes, trustRoot({ runKind: 'dev', env, productionKeys: [] })).trust).toBe('unverified')
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('the plugin code reads only the documented settings, and the list comes from the release folder', () => {
    const dir = path.join(REPO, 'server/src/plugins')
    const names = new Set<string>()
    for (const f of fs.readdirSync(dir)) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/MYCEL_[A-Z0-9_]+/g)) names.add(m[0])
    // a new setting here must be reviewed against hosted and office (docs/PLUGINS.md) before it joins this list
    expect([...names].sort()).toEqual(['MYCEL_PLUGINS_ALLOW_UNSIGNED', 'MYCEL_PLUGINS_TEST_KEYS', 'MYCEL_PLUGINS_TEST_SERVER'])
    expect(defaultCatalogDir()).toBe(path.join(REPO, 'resources/plugins'))
  })
})

describe('installing a pinned package', () => {
  let app: CApp
  let m: PluginManager
  let cat: string
  const upload = (bytes: Uint8Array) => {
    const fd = new FormData()
    fd.set('file', new Blob([new Uint8Array(bytes)]), 'pack.trinaplugin')
    return app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd, as: 'carol' })
  }
  const install = (plan: any, o: Record<string, unknown> = {}) => app.json('/api/admin/plugins/install', {
    ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable: true, permissions: plan.permissions.filter((p: any) => p.required).map((p: any) => p.id), ...o }), as: 'carol',
  })
  const list = async () => (await app.json('/api/admin/plugins', { as: 'carol' })).body
  const remove = (id = ID) => app.json(`/api/admin/plugins/${id}`, { method: 'DELETE', as: 'carol' })

  beforeAll(async () => {
    app = await makeCApp('plugins-pins')
    m = pluginsOf(app.ctx)
    cat = path.join(app.data, 'pinned-catalog')
    catalogDir(cat, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(build()) }])])
    // production as shipped today: no plugin key
    m.reconfigure({ trust: noKeyTrust(), catalogDir: cat, env: {} })
  })
  afterAll(async () => { await app.close() })

  test('from a file: shown and installed as official, verified by the release; the audit says so', async () => {
    const before = await list()
    expect(before.catalogSource).toBe('release')
    expect(before.trust.productionKeys).toBe(0)
    // pinned for this server, but no bytes next to the list: install the official package file
    expect(before.catalog[0]).toMatchObject({ id: ID, availability: 'file' })
    const plan = await upload(build())
    expect(plan.status).toBe(200)
    expect(plan.body).toMatchObject({ trust: 'official', verifiedBy: 'release', keyId: null, supported: true })
    const done = await install(plan.body)
    expect(done.status).toBe(201)
    expect(done.body).toMatchObject({ trust: 'official', verifiedBy: 'release', enabled: true, source: 'file' })
    const audit = app.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'plugin.install' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ trust: 'official', verifiedBy: 'release', keyId: null, manifestSha256: plan.body.manifestSha256 })
    // the stored manifest is exactly the pinned bytes; no signature file is stored
    const row = app.ctx.db.query('SELECT store_dir, signature FROM plugin_packages WHERE plugin_id = ?').get(ID) as { store_dir: string; signature: string | null }
    expect(row.signature).toBeNull()
    const store = path.join(app.data, 'plugins/store', ID, row.store_dir)
    expect(sha256(fs.readFileSync(path.join(store, 'trina-plugin.json')))).toBe(plan.body.manifestSha256)
    expect(fs.existsSync(path.join(store, 'trina-plugin.sig'))).toBe(false)
    expect((await list()).catalog[0]).toMatchObject({ installedVersion: '1.0.0', updateAvailable: false })
    expect((await remove()).status).toBe(204)
  })

  test('an unpinned or other build is refused with a clear reason', async () => {
    const r = await upload(build('1.0.0', { other: 'Another build.' }))
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.body.error.params.reason).toBe('signature')
    expect((await upload(build('1.0.1'))).body.error.params.reason).toBe('signature')
  })

  test('from the server import folder and from the list when its bytes sit next to it', async () => {
    const bytes = build()
    fs.mkdirSync(path.join(app.data, 'plugins/import'), { recursive: true })
    fs.writeFileSync(path.join(app.data, 'plugins/import/office-starter.trinaplugin'), bytes)
    const viaImport = await app.json('/api/admin/plugins/inspect-source', { ...jsonBody({ source: 'import', name: 'office-starter.trinaplugin' }), as: 'carol' })
    expect(viaImport.body).toMatchObject({ trust: 'official', verifiedBy: 'release', source: 'import' })
    expect((await install(viaImport.body)).body).toMatchObject({ verifiedBy: 'release', source: 'import' })
    expect((await remove()).status).toBe(204)
    fs.rmSync(path.join(app.data, 'plugins/import'), { recursive: true, force: true })
    // an offline mirror: the package next to the unsigned list, pinned
    catalogDir(cat, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }], { package: { file: 'office.trinaplugin', sha256: sha256(bytes), size: bytes.length } })], { 'office.trinaplugin': bytes })
    m.reconfigure({ catalogDir: cat })
    expect((await list()).catalog[0]).toMatchObject({ availability: 'available' })
    const viaList = await app.json('/api/admin/plugins/inspect-source', { ...jsonBody({ source: 'catalog', id: ID }), as: 'carol' })
    expect(viaList.body).toMatchObject({ trust: 'official', verifiedBy: 'release', source: 'catalog' })
    expect((await install(viaList.body)).body).toMatchObject({ verifiedBy: 'release', source: 'catalog' })
    expect((await remove()).status).toBe(204)
    // the same unsigned list without a pin installs nothing from it
    catalogDir(cat, [pinnedEntry([], { package: { file: 'office.trinaplugin', sha256: sha256(bytes), size: bytes.length } })], { 'office.trinaplugin': bytes })
    m.reconfigure({ catalogDir: cat })
    expect((await list()).catalog[0]).toMatchObject({ availability: 'pending_clearance' })
    expect((await app.json('/api/admin/plugins/inspect-source', { ...jsonBody({ source: 'catalog', id: ID }), as: 'carol' })).body.error.params.reason).toBe('not_available')
  })

  test('pending_clearance: the card, a file and the list all refuse, even with the pinned bytes', async () => {
    const bytes = build()
    catalogDir(cat, [pinnedEntry([{ version: '1.0.0', manifestSha256: manifestDigest(bytes) }], { availability: 'pending_clearance', package: { file: 'office.trinaplugin', sha256: sha256(bytes), size: bytes.length } })], { 'office.trinaplugin': bytes })
    m.reconfigure({ catalogDir: cat })
    expect((await list()).catalog[0]).toMatchObject({ availability: 'pending_clearance' })
    expect((await upload(bytes)).body.error.params.reason).toBe('not_available')
    expect((await app.json('/api/admin/plugins/inspect-source', { ...jsonBody({ source: 'catalog', id: ID }), as: 'carol' })).body.error.params.reason).toBe('not_available')
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
  })

  test('a pinned build for another platform is official but cannot run here', async () => {
    const other: PluginPlatform = process.platform === 'darwin' ? LINUX : MAC
    const bytes = platformBuild(other)
    catalogDir(cat, [pinnedEntry([{ version: '1.0.0', platform: other, manifestSha256: manifestDigest(bytes) }], { platforms: [other] })])
    m.reconfigure({ catalogDir: cat })
    expect((await list()).catalog[0]).toMatchObject({ availability: 'unsupported' })
    const plan = await upload(bytes)
    expect(plan.body).toMatchObject({ trust: 'official', verifiedBy: 'release', supported: false })
    expect((await install(plan.body)).body.error.params.reason).toBe('unsupported')
  })

  test('hosted servers: still no package files, and test settings never make anything official', async () => {
    const hosted = await makeCApp('plugins-pins-hosted')
    try {
      ;(hosted.ctx.config as { deployment?: string }).deployment = 'hosted'
      const h = new PluginManager(hosted.ctx, { env: { MYCEL_PLUGINS_TEST_KEYS: key.pub, MYCEL_PLUGINS_ALLOW_UNSIGNED: '1', MYCEL_PLUGINS_TEST_SERVER: '1', MYCEL_PLUGINS_TEST_PINS: manifestDigest(build()) } })
      expect(h.trust.keys).toEqual([])
      // the only pins are the shipped list's
      expect(h.catalog().dir).toBe(defaultCatalogDir())
      expect(releasePins(h.catalog())).toEqual(releasePins(loadCatalog(defaultCatalogDir(), noKeyTrust('hosted'))))
      expect(h.list('en')).toMatchObject({ fileInstall: false, trustWarnings: [] })
      expect(() => h.inspect('carol', build(), 'file', 'en')).toThrow()
      expect(() => h.inspectCatalog('carol', HWP_PLUGIN_ID, 'en')).toThrow()
    } finally { await hosted.close() }
  })
})

describe('HWP keeps its double gate', () => {
  const target = `${process.platform}-${process.arch}` as HwpTarget
  test('a pinned official HWP build installs as official but previews only with MYCEL_HWP_PREVIEW=1; the shipped list refuses it', async () => {
    const app = await makeCApp('plugins-pins-hwp')
    try {
      const { bytes } = await buildHwpPlugin({ target, keyPem: null, provision: false })
      const digest = manifestDigest(bytes)
      const shipped = PluginCatalog.parse(parseStrictJson(fs.readFileSync(path.join(REPO, 'resources/plugins/catalog.json'), 'utf8')))
      const hwp = shipped.entries.find((e) => e.id === HWP_PLUGIN_ID)!
      const platform = verifyPackage(bytes, noKeyTrust('dev', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' })).manifest.platforms![0]!
      const m = pluginsOf(app.ctx)
      // the shipped list (pending_clearance) with this build pinned: still not installable
      const pending = catalogDir(path.join(app.data, 'pending'), [{ ...hwp, pins: [{ version: hwp.version, platform, manifestSha256: digest }] } as CatalogEntry])
      m.reconfigure({ trust: noKeyTrust(), catalogDir: pending, env: { MYCEL_HWP_PREVIEW: '1' } })
      const fd = () => { const f = new FormData(); f.set('file', new Blob([new Uint8Array(bytes)]), 'hwp.trinaplugin'); return f }
      expect((await app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd(), as: 'carol' })).body.error.params.reason).toBe('not_available')
      // once cleared (availability flipped by a reviewed edit), the pinned build is official
      const cleared = catalogDir(path.join(app.data, 'cleared'), [{ ...hwp, availability: 'available', pins: [{ version: hwp.version, platform, manifestSha256: digest }] } as CatalogEntry])
      m.reconfigure({ catalogDir: cleared, env: {} })
      const plan = (await app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd(), as: 'carol' })).body
      expect(plan).toMatchObject({ id: HWP_PLUGIN_ID, trust: 'official', verifiedBy: 'release', supported: true })
      // the optional page-image permission is offered (the prompt ticks it); install with it
      expect(plan.permissions.find((p: any) => p.id === 'model.send.preview-pixels')).toMatchObject({ required: false })
      const done = await app.json('/api/admin/plugins/install', { ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable: true, permissions: plan.permissions.map((p: any) => p.id) }), as: 'carol' })
      expect(done.body).toMatchObject({ trust: 'official', verifiedBy: 'release', enabled: true, status: 'unsupported', unsupported: 'gate' })
      // on, official, but the release gate is closed: no renderer, no AI tool
      expect(m.usable(HWP_PLUGIN_ID)).toBe(false)
      expect(m.hwpEngine().identity).toBe('hwp-disabled')
      expect(m.hwpToolUsable()).toBe(false)
      // both conditions: the gate open as well
      m.reconfigure({ env: { MYCEL_HWP_PREVIEW: '1' } })
      expect(m.usable(HWP_PLUGIN_ID)).toBe(true)
      expect(m.hwpToolUsable()).toBe(true)
    } finally { await app.close() }
  })
})

describe('release tooling', () => {
  const opts = { cleared: [] as string[], testKeyId: null as string | null }
  const shippedText = () => fs.readFileSync(path.join(REPO, 'resources/plugins/catalog.json'), 'utf8')

  test('the committed layout round-trips, so pinning changes only the pins', () => {
    const text = shippedText()
    expect(formatCatalog(PluginCatalog.parse(parseStrictJson(text)))).toBe(text)
    expect(pinCatalog(text, [], opts)).toMatchObject({ text, changed: false })
  })

  test('the pin script pins exactly the built packages, is idempotent, and drops pins of an older version', () => {
    const base = formatCatalog({ schemaVersion: 0, sequence: 1, entries: [pinnedEntry([], { platforms: [LINUX, MAC] })].map(({ pins: _p, ...e }) => e) })
    const mac = platformBuild(MAC), linux = platformBuild(LINUX)
    const r = pinCatalog(base, [{ file: 'mac.trinaplugin', bytes: mac }, { file: 'linux.trinaplugin', bytes: linux }], opts)
    expect(r.changed).toBe(true)
    const doc = PluginCatalog.parse(JSON.parse(r.text))
    expect(doc.sequence).toBe(2)
    // in the entry's platform order, each with its own digest
    expect(doc.entries[0]!.pins).toEqual([
      { version: '1.0.0', platform: LINUX, manifestSha256: manifestDigest(linux) },
      { version: '1.0.0', platform: MAC, manifestSha256: manifestDigest(mac) },
    ])
    expect(formatCatalog(doc)).toBe(r.text)
    // the pinned list makes these exact builds official
    const d = tmp(); fs.writeFileSync(path.join(d, 'catalog.json'), r.text)
    expect(verifyPackage(mac, noKeyTrust(), pinsOf(d)).trust).toBe('official')
    expect(verifyPackage(linux, noKeyTrust(), pinsOf(d)).trust).toBe('official')
    fs.rmSync(d, { recursive: true, force: true })
    // again: nothing changes (the --check mode)
    expect(pinCatalog(r.text, [{ file: 'mac.trinaplugin', bytes: mac }], opts).changed).toBe(false)
    // a version bump: the old pins go, the new build is pinned
    const bumped = r.text.replace('"version": "1.0.0",\n      "publisher"', '"version": "1.1.0",\n      "publisher"')
    const next = PluginCatalog.parse(JSON.parse(pinCatalog(bumped, [{ file: 'mac.trinaplugin', bytes: platformBuild(MAC, '1.1.0') }], opts).text))
    expect(next.entries[0]!.pins).toEqual([{ version: '1.1.0', platform: MAC, manifestSha256: manifestDigest(platformBuild(MAC, '1.1.0')) }])
  })

  test('the pin script refuses anything that is not exactly the entry', () => {
    const base = formatCatalog({ schemaVersion: 0, sequence: 1, entries: [pinnedEntry([], { platforms: [LINUX, MAC] })].map(({ pins: _p, ...e }) => e) })
    const err = (bytes: Uint8Array, o = opts) => { try { pinCatalog(base, [{ file: 'x.trinaplugin', bytes }], o); return 'pinned' } catch (e) { return (e as Error).message } }
    expect(err(platformBuild(MAC, '1.0.1'))).toContain('the official list is at 1.0.0')
    expect(err(platformBuild({ os: 'linux', arch: 'arm64' }))).toContain('is not one the list names')
    expect(err(build())).toContain('exactly one platform')
    const morePerms = buildPackage({ manifest: { ...skillManifest({ skills: ['minutes'], permissions: ['skills.company', 'files.read.selected'] }), platforms: [MAC] }, payload: new Map([['skills/minutes/SKILL.md', Buffer.from(skillText('minutes', 'Minutes.'))]]) }).bytes
    expect(err(morePerms)).toContain('permissions differ')
    expect(err(Buffer.from('not a package'))).toContain('archive')
    const signedWithTest = buildPackage({ manifest: { ...skillManifest({ skills: ['minutes'] }), platforms: [MAC] }, payload: new Map([['skills/minutes/SKILL.md', Buffer.from(skillText('minutes', 'Minutes.'))]]), keyPem: key.pem }).bytes
    expect(err(signedWithTest, { ...opts, testKeyId: key.keyId })).toContain('TEST key')
    expect(() => pinCatalog(base, [{ file: 'a.trinaplugin', bytes: platformBuild(MAC) }, { file: 'b.trinaplugin', bytes: platformBuild(MAC) }], opts)).toThrow(/two packages/)
  })

  test('HWP builds are pinned only for cleared targets, and a pinned list still ships no plugin bytes', async () => {
    const target = `${process.platform}-${process.arch}` as HwpTarget
    const { bytes } = await buildHwpPlugin({ target, keyPem: null, provision: false })
    const text = shippedText()
    expect(() => pinCatalog(text, [{ file: 'hwp.trinaplugin', bytes }], { cleared: [], testKeyId: null })).toThrow(/not cleared/)
    const r = pinCatalog(text, [{ file: 'hwp.trinaplugin', bytes }], { cleared: [target], testKeyId: null })
    const hwp = PluginCatalog.parse(JSON.parse(r.text)).entries.find((e) => e.id === HWP_PLUGIN_ID)!
    expect(hwp.pins).toHaveLength(1)
    // pinning never flips availability
    expect(hwp.availability).toBe('pending_clearance')
    // a release folder built from the pinned list: digests only, no package, renderer or font
    const repo = tmp(), stage = tmp()
    fs.mkdirSync(path.join(repo, 'resources/plugins'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'resources/plugins/catalog.json'), r.text)
    stagePluginCatalog(repo, stage)
    expect(fs.readdirSync(path.join(stage, 'resources/plugins'))).toEqual(['catalog.json'])
    assertNoPluginPayload(stage)
    expect(fs.statSync(path.join(stage, 'resources/plugins/catalog.json')).size).toBeLessThan(16 * 1024)
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true })
  })

  test('the shipped list pins nothing that is not cleared', () => {
    const shipped = PluginCatalog.parse(parseStrictJson(shippedText()))
    // HWP stays pending until the founder clears its licensing; any pin there must still be refused at install
    expect(shipped.entries.find((e) => e.id === HWP_PLUGIN_ID)).toMatchObject({ availability: 'pending_clearance' })
    for (const e of shipped.entries) for (const p of e.pins ?? []) expect(p.version).toBe(e.version)
  })
})
