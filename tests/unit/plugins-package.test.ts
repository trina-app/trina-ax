// Plugin packages (docs/PLUGINS.md): manifest validation, signatures (official / unknown / test key in production /
// tampered manifest / tampered file / signature from another domain), archive intake limits, platform and product
// checks, the native driver pin, the bundled catalog, the trust root and the release exclusion of plugin payloads.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { PLUGIN_TRUST, RELEASE_CHANNEL } from '@mycel/shared'
import { CatalogEntry, PLUGIN_CATALOG_DOMAIN, PLUGIN_MANIFEST_DOMAIN, PluginCatalog, PluginManifest } from '@mycel/shared/plugins'
import { readArchive, writeArchive, ARCHIVE_LIMITS } from '../../server/src/plugins/archive'
import { canonicalJson, parseStrictJson } from '../../server/src/plugins/json'
import { buildPackage, PackageError, verifyPackage } from '../../server/src/plugins/package'
import { checkSignature, signDetached, trustRoot } from '../../server/src/plugins/trust'
import { platformMismatch, productMismatch } from '../../server/src/plugins/platform'
import { driverMismatch } from '../../server/src/plugins/drivers'
import { loadCatalog } from '../../server/src/plugins/catalog'
import { checkTrust } from '../../scripts/plugins/trust'
import { assertNoPluginPayload, forbiddenPluginPath, stagePluginCatalog } from '../../scripts/plugins/release-check'
import { stageHwp, type HwpTarget } from '../../scripts/hwp-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { linuxBundleFiles } from '../../scripts/build-bundle'
import hwpPins from '../../resources/hwp/manifest.json'
import { catalogDir, newKey, packEntry, prodTrust, skillManifest, skillPack, sha256 } from '../lib/plugins'

const key = newKey()
const other = newKey()
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pkg-'))
const reason = (fn: () => unknown) => { try { fn() } catch (e) { return (e as PackageError).reason ?? (e as Error).message } return 'accepted' }

/** Rewrite one archive member (the archive is otherwise unchanged). */
function rewrite(bytes: Uint8Array, change: (files: Map<string, Uint8Array>) => void, executables = new Set<string>()) {
  const files = new Map<string, Uint8Array>(readArchive(bytes))
  change(files)
  return writeArchive(files, { executables })
}

/** A raw ustar header with any type flag, mode and name (for archive attacks the writer refuses to make). */
function rawEntry(name: string, data: Uint8Array, type = '0', mode = '0000644', linkname = '') {
  const h = Buffer.alloc(512)
  h.write(name, 0, 'utf8'); h.write(mode + '\0', 100, 'latin1'); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148)
  h.write(type, 156, 'latin1'); h.write(linkname, 157); h.write('ustar\0' + '00', 257, 'latin1')
  let sum = 0; for (const x of h) sum += x
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([h, Buffer.from(data), pad])
}
const tarOf = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)])

describe('signatures', () => {
  test('an official key verifies; an unknown key, a missing signature and a key outside its scope do not', () => {
    const good = skillPack({ keyPem: key.pem }).bytes
    const v = verifyPackage(good, prodTrust(key.pub))
    expect(v.trust).toBe('official')
    expect(v.keyId).toBe(key.keyId)
    expect(reason(() => verifyPackage(skillPack({ keyPem: other.pem }).bytes, prodTrust(key.pub)))).toBe('untrusted')
    expect(reason(() => verifyPackage(skillPack({ keyPem: null }).bytes, prodTrust(key.pub)))).toBe('signature')
    // a key for app.trina.* cannot sign another namespace
    expect(reason(() => verifyPackage(skillPack({ id: 'com.example.pack', keyPem: key.pem }).bytes, prodTrust(key.pub)))).toBe('untrusted')
  })

  test('a test key is trusted only in development or on an operator-marked test server, never hosted or office', () => {
    const pkg = skillPack({ keyPem: other.pem }).bytes
    const env = { MYCEL_PLUGINS_TEST_KEYS: other.pub }
    expect(verifyPackage(pkg, trustRoot({ runKind: 'dev', env, productionKeys: [] })).trust).toBe('test')
    // production mode: the test key alone is not enough
    expect(reason(() => verifyPackage(pkg, trustRoot({ runKind: 'selfhost', env, productionKeys: [] })))).toBe('untrusted')
    const marked = trustRoot({ runKind: 'selfhost', env: { ...env, MYCEL_PLUGINS_TEST_SERVER: '1' }, productionKeys: [] })
    expect(verifyPackage(pkg, marked).trust).toBe('test')
    expect(marked.warnings).toEqual(['test_keys', 'test_server'])
    for (const runKind of ['hosted', 'office'] as const) {
      const r = trustRoot({ runKind, env: { ...env, MYCEL_PLUGINS_TEST_SERVER: '1', MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }, productionKeys: [] })
      expect(r.warnings).toEqual([])
      expect(r.ignored.length).toBe(3)
      expect(reason(() => verifyPackage(pkg, r))).toBe('untrusted')
      expect(reason(() => verifyPackage(skillPack({ keyPem: null }).bytes, r))).toBe('signature')
    }
  })

  test('a changed manifest, a changed file byte and a signature over another domain are refused', () => {
    const { bytes } = skillPack({ keyPem: key.pem })
    const trust = prodTrust(key.pub)
    const manifestChanged = rewrite(bytes, (f) => {
      const m = JSON.parse(Buffer.from(f.get('trina-plugin.json')!).toString())
      m.i18n.en.description = 'Something else entirely.'
      f.set('trina-plugin.json', Buffer.from(JSON.stringify(m)))
    })
    expect(reason(() => verifyPackage(manifestChanged, trust))).toBe('signature')
    const fileChanged = rewrite(bytes, (f) => { const b = Buffer.from(f.get('skills/meeting-minutes/template.md')!); b[0] = b[0]! ^ 1; f.set('skills/meeting-minutes/template.md', b) })
    expect(reason(() => verifyPackage(fileChanged, trust))).toBe('tampered')
    const extra = rewrite(bytes, (f) => f.set('skills/meeting-minutes/extra.md', Buffer.from('not listed')))
    expect(reason(() => verifyPackage(extra, trust))).toBe('tampered')
    const missing = rewrite(bytes, (f) => f.delete('skills/weekly-report/template.md'))
    expect(reason(() => verifyPackage(missing, trust))).toBe('tampered')
    // the same key signing the manifest the way releases sign (raw bytes) or as a catalog does not count
    const reuse = (domain: string | null) => rewrite(bytes, (f) => {
      const text = Buffer.from(f.get('trina-plugin.json')!).toString()
      const canon = canonicalJson(JSON.parse(text))
      const sig = domain === null
        ? JSON.stringify({ keyId: key.keyId, sig: crypto.sign(null, Buffer.from(text), crypto.createPrivateKey(key.pem)).toString('base64') })
        : signDetached(key.pem, domain, canon)
      f.set('trina-plugin.sig', Buffer.from(sig))
    })
    expect(reason(() => verifyPackage(reuse(null), trust))).toBe('signature')
    expect(reason(() => verifyPackage(reuse(PLUGIN_CATALOG_DOMAIN), trust))).toBe('signature')
    expect(reason(() => verifyPackage(reuse(PLUGIN_MANIFEST_DOMAIN), trust))).toBe('accepted')
  })

  test('unsigned packages need the development setting, and their files are still checked', () => {
    const dev = trustRoot({ runKind: 'dev', env: { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }, productionKeys: [] })
    expect(dev.warnings).toEqual(['unsigned'])
    const unsigned = skillPack({ keyPem: null }).bytes
    expect(verifyPackage(unsigned, dev).trust).toBe('unverified')
    const changed = rewrite(unsigned, (f) => f.set('skills/meeting-minutes/template.md', Buffer.from('changed')))
    expect(reason(() => verifyPackage(changed, dev))).toBe('tampered')
  })

  test('the catalog signature has its own domain; an unsigned list is information only; a bad signature hides the list', () => {
    const d = tmp()
    const entry = packEntry('app.trina.office-starter', '1.0.0', 'office.trinaplugin', Buffer.from('x'))
    expect(loadCatalog(catalogDir(d, [entry]), prodTrust(key.pub)).source).toBe('release')
    expect(loadCatalog(catalogDir(d, [entry], {}, key.pem), prodTrust(key.pub)).source).toBe('signed')
    expect(loadCatalog(catalogDir(d, [entry], {}, other.pem), prodTrust(key.pub))).toMatchObject({ source: 'none', entries: [] })
    catalogDir(d, [entry], {}, key.pem)
    const doc = JSON.parse(fs.readFileSync(path.join(d, 'catalog.json'), 'utf8')); doc.entries[0].version = '9.9.9'
    fs.writeFileSync(path.join(d, 'catalog.json'), JSON.stringify(doc))
    expect(loadCatalog(d, prodTrust(key.pub)).source).toBe('none')
    // a manifest signature is not a catalog signature
    fs.writeFileSync(path.join(d, 'catalog.sig'), signDetached(key.pem, PLUGIN_MANIFEST_DOMAIN, canonicalJson(doc)))
    expect(loadCatalog(d, prodTrust(key.pub)).source).toBe('none')
    expect(checkSignature(prodTrust(key.pub), PLUGIN_CATALOG_DOMAIN, canonicalJson(doc), signDetached(key.pem, PLUGIN_CATALOG_DOMAIN, canonicalJson(doc)), 'catalog')).toMatchObject({ ok: true })
    fs.rmSync(d, { recursive: true, force: true })
  })
})

describe('manifest', () => {
  test('strict fields, duplicate keys, kinds and the rules between kinds, permissions and files', () => {
    expect(() => parseStrictJson('{"id":"a","id":"b"}')).toThrow(/duplicate key/)
    expect(() => parseStrictJson('{"a":' + '['.repeat(40) + ']'.repeat(40) + '}')).toThrow(/nested/)
    const { bytes } = skillPack({ keyPem: key.pem })
    const dup = rewrite(bytes, (f) => f.set('trina-plugin.json', Buffer.from(Buffer.from(f.get('trina-plugin.json')!).toString().replace('"schemaVersion": 0,', '"schemaVersion": 0, "schemaVersion": 0,'))))
    expect(reason(() => verifyPackage(dup, prodTrust(key.pub)))).toBe('manifest')
    const unknown = rewrite(bytes, (f) => { const m = JSON.parse(Buffer.from(f.get('trina-plugin.json')!).toString()); m.hooks = { start: 'curl x | sh' }; f.set('trina-plugin.json', Buffer.from(JSON.stringify(m))) })
    expect(reason(() => verifyPackage(unknown, prodTrust(key.pub)))).toBe('manifest')
    const base = { ...skillManifest({ skills: ['a'] }), files: [{ path: 'skills/a/SKILL.md', sha256: 'a'.repeat(64), size: 1 }] }
    expect(PluginManifest.safeParse(base).success).toBe(true)
    expect(PluginManifest.safeParse({ ...base, schemaVersion: 1 }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, permissions: { required: [], optional: [] } }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, permissions: { required: ['skills.company', 'shell.anything'], optional: [] } }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, files: [...base.files, { path: 'bin/tool', sha256: 'b'.repeat(64), size: 1, executable: true }] }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, files: [{ path: '../escape', sha256: 'a'.repeat(64), size: 1 }] }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, kinds: ['skill-pack', 'native-tool'] }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, i18n: { en: { name: ' padded', description: 'x' } } }).success).toBe(false)
    // a documented placeholder kind parses but is not installable in stage 1
    const preset = buildPackage({ manifest: { ...skillManifest({ skills: ['a'] }), kinds: ['skill-pack', 'connector-preset'] }, payload: new Map([['skills/a/SKILL.md', Buffer.from('---\nname: a\ndescription: d\n---\n')]]), keyPem: key.pem })
    expect(reason(() => verifyPackage(preset.bytes, prodTrust(key.pub)))).toBe('kind')
  })
})

describe('archive intake', () => {
  const trust = prodTrust(key.pub)
  test('links, hard links, parent and absolute paths, hidden names, duplicates, special bits and odd types are refused', () => {
    const d = Buffer.from('x')
    for (const bad of [
      tarOf(rawEntry('../escape.md', d)), tarOf(rawEntry('/etc/passwd', d)), tarOf(rawEntry('skills/.hidden', d)),
      tarOf(rawEntry('link', Buffer.alloc(0), '2', '0000777', '/etc/passwd')), tarOf(rawEntry('hard', Buffer.alloc(0), '1', '0000644', 'trina-plugin.json')),
      tarOf(rawEntry('fifo', Buffer.alloc(0), '6')), tarOf(rawEntry('pax', d, 'x')), tarOf(rawEntry('a.md', d), rawEntry('a.md', d)),
      tarOf(rawEntry('Case.md', d), rawEntry('case.md', d)), tarOf(rawEntry('suid', d, '0', '0004755')), tarOf(rawEntry('a', d), rawEntry('a/b', d)),
    ]) expect(reason(() => verifyPackage(bad, trust))).toBe('archive')
    expect(reason(() => verifyPackage(Buffer.from('not an archive at all'), trust))).toBe('archive')
  })
  test('size, entry count and decompression bombs stay bounded', () => {
    expect(reason(() => verifyPackage(Buffer.alloc(ARCHIVE_LIMITS.archiveBytes + 1), trust))).toBe('archive')
    const many = tarOf(...Array.from({ length: ARCHIVE_LIMITS.entries + 1 }, (_, i) => rawEntry(`f${i}`, Buffer.alloc(0))))
    expect(reason(() => verifyPackage(many, trust))).toBe('archive')
    // 40 MiB of zeros gzip to ~40 KiB: more than 100 times
    const bomb = zlib.gzipSync(tarOf(rawEntry('zeros', Buffer.alloc(40 * 1024 * 1024))))
    expect(bomb.length).toBeLessThan(1024 * 1024)
    expect(reason(() => verifyPackage(bomb, trust))).toBe('archive')
    // the expanded total is capped whatever the compression ratio
    const random = crypto.randomBytes(2 * 1024 * 1024)
    expect(() => readArchive(zlib.gzipSync(tarOf(rawEntry('big', random))), { ...ARCHIVE_LIMITS, expandedBytes: 1024 * 1024 })).toThrow(/expands too far/)
  })
  test('the gzip form of a good package verifies too', () => {
    expect(verifyPackage(skillPack({ keyPem: key.pem, gzip: true }).bytes, trust).trust).toBe('official')
  })
})

describe('platform, product and driver', () => {
  test('platform mismatch reasons: OS, CPU and the Debian 12 glibc', () => {
    const linux = [{ os: 'linux' as const, arch: 'x64' as const, libc: { family: 'glibc' as const, minVersion: '2.39' } }]
    expect(platformMismatch(linux, { os: 'linux', arch: 'x64', libc: '2.39' })).toBeNull()
    expect(platformMismatch(linux, { os: 'linux', arch: 'x64', libc: '2.36' })).toBe('libc')
    expect(platformMismatch(linux, { os: 'linux', arch: 'x64', libc: null })).toBe('libc')
    expect(platformMismatch(linux, { os: 'linux', arch: 'arm64', libc: '2.40' })).toBe('arch')
    expect(platformMismatch(linux, { os: 'darwin', arch: 'arm64', libc: null })).toBe('os')
    expect(platformMismatch(undefined, { os: 'win32', arch: 'x64', libc: null })).toBeNull()
    expect(productMismatch({ apiVersion: 1, minVersion: '0.2.9' }, '0.2.9')).toBeNull()
    expect(productMismatch({ apiVersion: 1, minVersion: '0.3.0' }, '0.2.9')).toBe('product')
    expect(productMismatch({ apiVersion: 2, minVersion: '0.1.0' }, '0.2.9')).toBe('api')
  })
  test('rhwp-v1 accepts only the executable and font core pinned', () => {
    const target = 'linux-x64'
    const m = PluginManifest.parse({
      schemaVersion: 0, id: 'app.trina.hwp-preview', version: '1.0.0', publisher: { id: 'trina', name: 'Trina' }, kinds: ['native-tool', 'preview'],
      product: { apiVersion: 1, minVersion: '0.1.0' }, scopes: { install: ['company'], enable: ['company'] }, i18n: { en: { name: 'HWP Preview', description: 'Pages.' } },
      permissions: { required: ['files.read.selected', 'preview.render', 'runtime.native.isolated'], optional: ['model.send.preview-pixels'] },
      platforms: [{ os: 'linux', arch: 'x64', libc: { family: 'glibc', minVersion: '2.39' } }],
      runtime: { driver: 'rhwp-v1', executable: 'bin/rhwp', fonts: ['fonts/NotoSansKR-Regular.ttf'] },
      contributes: { tools: [{ id: 'render-page', name: 'hwp_render', driver: 'rhwp-v1' }], previews: [{ extensions: ['hwp', 'hwpx'], tool: 'render-page', viewer: 'core-raster-v1' }] },
      license: 'MIT AND OFL-1.1', components: [{ name: 'rhwp', version: hwpPins.version, license: 'MIT' }], notices: [],
      files: [{ path: 'bin/rhwp', sha256: 'c'.repeat(64), size: 1, executable: true }, { path: 'fonts/NotoSansKR-Regular.ttf', sha256: hwpPins.fonts[0]!.sha256, size: 1 }],
    })
    const sha = (exe: string) => (p: string) => p === 'bin/rhwp' ? exe : p.startsWith('fonts/') ? hwpPins.fonts[0]!.sha256 : undefined
    expect(driverMismatch(m, sha(hwpPins.targets[target].binary))).toBeNull()
    expect(driverMismatch(m, sha('d'.repeat(64)))).toBe('driver')
    expect(driverMismatch({ ...m, id: 'app.trina.other-renderer' }, sha(hwpPins.targets[target].binary))).toBe('driver')
    expect(driverMismatch({ ...m, contributes: { ...m.contributes, tools: [{ id: 'render-page', name: 'read', driver: 'rhwp-v1' }] } }, sha(hwpPins.targets[target].binary))).toBe('driver')
  })
})

describe('trust root and release contents', () => {
  test('the shipped trust root holds no release key and no committed test key; the trust tool refuses both', () => {
    for (const k of PLUGIN_TRUST.keys) expect(RELEASE_CHANNEL.keys).not.toContain(k.publicKey)
    expect(() => checkTrust({ keys: [{ publicKey: RELEASE_CHANNEL.keys[0], publishers: ['trina'], idPrefixes: ['app.trina.'] }] }, null)).toThrow(/release key/)
    expect(() => checkTrust({ keys: [{ publicKey: key.pub, publishers: ['trina'], idPrefixes: ['app.trina.'] }] }, key.pub)).toThrow(/TEST key/)
    expect(checkTrust({ keys: [{ publicKey: key.pub, publishers: ['trina'], idPrefixes: ['app.trina.'], catalog: true }] }, other.pub)).toHaveLength(1)
    // a release key listed by mistake is ignored at runtime too
    expect(trustRoot({ runKind: 'selfhost', env: {}, productionKeys: [{ publicKey: RELEASE_CHANNEL.keys[0]!, publishers: ['trina'], idPrefixes: ['app.trina.'], catalog: true }] }).keys).toEqual([])
    // no private key anywhere in the repository
    const repo = path.resolve(import.meta.dir, '../..')
    const hits = Bun.spawnSync(['git', 'grep', '-l', '-e', 'BEGIN PRIVATE KEY', '-e', 'BEGIN OPENSSH PRIVATE KEY', '--', '.'], { cwd: repo }).stdout.toString().trim().split('\n').filter(Boolean)
    expect(hits.filter((f) => !f.endsWith('.ts') && !f.endsWith('.md') && !f.endsWith('.sh') && !f.endsWith('.go'))).toEqual([])
    expect(fs.existsSync(path.join(repo, 'editions/trina/branding/plugin-trust.json'))).toBe(true)
  })

  test('the bundled official list is metadata only: HWP not yet available, no package, no test signature', () => {
    const repo = path.resolve(import.meta.dir, '../..')
    const cat = PluginCatalog.parse(JSON.parse(fs.readFileSync(path.join(repo, 'resources/plugins/catalog.json'), 'utf8')))
    expect(cat.entries.every((e) => !e.package)).toBe(true)
    expect(cat.entries.find((e) => e.id === 'app.trina.hwp-preview')).toMatchObject({ availability: 'pending_clearance', recommendedFor: { locales: ['ko'] } })
    expect(fs.readdirSync(path.join(repo, 'resources/plugins')).sort()).toEqual(['catalog.json'])
    expect(CatalogEntry.safeParse({ ...cat.entries[0], default: true }).success).toBe(false)
  })

  test('server, office and Linux bundles never carry the renderer, its font or a plugin package — even with MYCEL_HWP_PREVIEW=1', async () => {
    const prior = process.env.MYCEL_HWP_PREVIEW
    const stage = tmp(), repo = path.resolve(import.meta.dir, '../..')
    try {
      for (const flag of [undefined, '1']) {
        if (flag) process.env.MYCEL_HWP_PREVIEW = flag; else delete process.env.MYCEL_HWP_PREVIEW
        for (const rel of ['native/bin/hwp', 'resources/hwp']) { fs.mkdirSync(path.join(stage, rel), { recursive: true }); fs.writeFileSync(path.join(stage, rel, 'stale'), 'old QA assets') }
        await stageHwp(repo, stage, [`${process.platform}-${process.arch}` as HwpTarget])
        for (const rel of ['native/bin/hwp', 'resources/hwp']) expect(fs.existsSync(path.join(stage, rel))).toBe(false)
        const lists = [bundleManifest({ pandoc: false, desktop: false }), linuxBundleFiles({ arch: 'arm64', codexVersion: 'test', whisper: false, systemd: [] }), linuxBundleFiles({ arch: 'amd64', codexVersion: 'test', whisper: false, systemd: [] })]
        for (const l of lists) { expect(l.filter(forbiddenPluginPath)).toEqual([]); expect(l.some((p) => p.endsWith('resources/plugins/catalog.json'))).toBe(true) }
      }
      stagePluginCatalog(repo, stage)
      expect(fs.readdirSync(path.join(stage, 'resources/plugins'))).toEqual(['catalog.json'])
      assertNoPluginPayload(stage)
      fs.writeFileSync(path.join(stage, 'resources/plugins/app.trina.hwp-preview-1.0.0-linux-x64.trinaplugin'), 'x')
      expect(() => assertNoPluginPayload(stage)).toThrow(/plugin payload/)
      for (const p of ['app/native/bin/hwp/rhwp-darwin-arm64', 'licenses/hwp/rhwp-MIT.txt', 'resources/hwp/fonts/NotoSansKR-Regular.ttf', 'x/NotoSansKR-Regular.ttf', 'a.trinaplugin']) expect(forbiddenPluginPath(p)).toBe(true)
      for (const p of ['resources/plugins/catalog.json', 'resources/plugins/catalog.sig', 'server/src/hwp-preflight.js', 'licenses/LICENSE']) expect(forbiddenPluginPath(p)).toBe(false)
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
      if (prior === undefined) delete process.env.MYCEL_HWP_PREVIEW; else process.env.MYCEL_HWP_PREVIEW = prior
    }
  })

  test('the desktop app packs only its own build output', async () => {
    const cfg = (await import('../../desktop/electron-builder.config.ts')).default as { files: string[]; extraResources?: unknown }
    expect(cfg.files).toEqual(['dist/**/*', '!dist/**/*.map', 'package.json'])
    expect(cfg.extraResources).toBeUndefined()
  })
})

test('canonical JSON sorts keys and is what signatures cover', () => {
  expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}')
  expect(sha256(Buffer.from(canonicalJson({ a: 1 })))).toBe(sha256(Buffer.from('{"a":1}')))
})
