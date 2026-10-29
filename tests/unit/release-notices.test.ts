import { test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const sha = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex')
async function api() {
  expect(fs.existsSync(path.resolve(import.meta.dir, '../../scripts/release-notices.ts'))).toBe(true)
  return import('../../scripts/release-notices')
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notices-'))
  const repo = path.join(root, 'repo'), artifact = path.join(root, 'artifact')
  const put = (rel: string, bytes: string | Uint8Array) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p }
  put('LICENSE', 'Synthetic project license\r\n'); put('NOTICE', 'Synthetic project notice\n')
  put('package.json', JSON.stringify({ name: 'fixture', private: true, license: 'AGPL-3.0-only' }))
  put('bun.lock', 'fixture frozen lock bytes')
  put('shared/src/cloud-protocol/LICENSE', 'Synthetic separately scoped permission\n')
  put('server/package.json', JSON.stringify({ name: '@fixture/server', version: '1.0.0', license: 'AGPL-3.0-only', dependencies: { alpha: '1.0.0', beta: '1.0.0' } }))
  const pkg = (rel: string, name: string, version: string, dependencies = {}) => {
    put(rel + '/package.json', JSON.stringify({ name, version, license: 'MIT', dependencies, exports: './index.js' }))
    put(rel + '/LICENSE', `Synthetic ${name}@${version} permission\r\n`)
  }
  pkg('node_modules/alpha', 'alpha', '1.0.0'); pkg('node_modules/beta', 'beta', '1.0.0', { alpha: '2.0.0' })
  pkg('node_modules/beta/node_modules/alpha', 'alpha', '2.0.0')
  const options = { repoRoot: repo, artifactDir: artifact, version: '1.2.3', target: 'darwin' as const, arch: 'arm64', kind: 'bundle' as const, roots: [{ directory: 'server' }], includeWeb: false }
  return { root, repo, artifact, put, pkg, options, close: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('installed dependency versions and exact original notices survive exports restrictions and nested versions', async () => {
  const { writeReleaseNotices, verifyReleaseNotices } = await api(); const f = fixture()
  try {
    f.put('node_modules/alpha/ThirdPartyNotices.txt', 'Synthetic third-party attribution\n')
    const m = writeReleaseNotices(f.options)
    expect(m.packages.filter(p => p.name === 'alpha').map(p => p.version).sort()).toEqual(['1.0.0', '2.0.0'])
    expect(m.packages.some(p => p.name === 'beta')).toBe(true)
    expect(m.publicClear).toBe(false)
    expect(fs.readFileSync(path.join(f.artifact, 'LICENSE'))).toEqual(fs.readFileSync(path.join(f.repo, 'LICENSE')))
    expect(fs.readFileSync(path.join(f.artifact, 'NOTICE'))).toEqual(fs.readFileSync(path.join(f.repo, 'NOTICE')))
    const notices = m.documents.filter(d => d.source === 'package')
    expect(notices.some(d => d.sourcePath === 'ThirdPartyNotices.txt')).toBe(true)
    for (const d of m.documents) expect(sha(fs.readFileSync(path.join(f.artifact, d.path)))).toBe(d.sha256)
    expect(m.documents.some(d => d.source === 'shared-cloud-protocol')).toBe(true)
    expect(JSON.stringify(m)).not.toContain(f.root)
    expect(verifyReleaseNotices(f.artifact)).toEqual(m)
  } finally { f.close() }
})

test('missing installed dependencies, missing license text and unreviewed binaries are explicit pending findings', async () => {
  const { writeReleaseNotices } = await api(); const f = fixture()
  try {
    f.put('server/package.json', JSON.stringify({ name: '@fixture/server', version: '1.0.0', dependencies: { alpha: '1', absent: '1', buffer: '1' }, optionalDependencies: { 'optional-absent': '1' } }))
    fs.rmSync(path.join(f.repo, 'node_modules/alpha/LICENSE'))
    fs.mkdirSync(path.join(f.artifact, 'bin'), { recursive: true }); fs.writeFileSync(path.join(f.artifact, 'bin/bun'), 'synthetic binary')
    const m = writeReleaseNotices(f.options)
    expect(m.pending.some(p => p.code === 'dependency-not-installed' && p.component === 'absent')).toBe(true)
    expect(m.pending.some(p => p.code === 'builtin-name-without-installed-package' && p.component === 'buffer')).toBe(true)
    expect(m.pending.some(p => p.code === 'dependency-not-installed' && p.component === 'buffer')).toBe(false)
    expect(m.omitted.some(p => p.reason === 'optional-dependency-not-installed' && p.component === 'optional-absent')).toBe(true)
    expect(m.pending.some(p => p.code === 'license-text-missing' && p.component.startsWith('alpha@'))).toBe(true)
    expect(m.pending.some(p => p.code === 'native-notices-incomplete')).toBe(true)
    expect(m.artifacts.find(a => a.path === 'bin/bun')?.sha256).toBe(sha('synthetic binary'))
    expect(fs.readFileSync(path.join(f.artifact, 'licenses/README.txt'), 'utf8')).toContain('NOT publication approval')
  } finally { f.close() }
})

test('normal Bun store and internal license symlinks work while notice escapes and unsafe text fail without disclosure', async () => {
  const { writeReleaseNotices } = await api(); const f = fixture()
  try {
    const pkgDir = path.join(f.repo, 'node_modules/alpha'), store = path.join(f.repo, 'node_modules/.bun/alpha/node_modules/alpha')
    fs.mkdirSync(path.dirname(store), { recursive: true }); fs.renameSync(pkgDir, store); fs.symlinkSync(store, pkgDir)
    fs.renameSync(path.join(store, 'LICENSE'), path.join(store, 'LICENSE.txt')); fs.symlinkSync('LICENSE.txt', path.join(store, 'LICENSE'))
    expect(writeReleaseNotices(f.options).packages.some(p => p.name === 'alpha')).toBe(true)
    fs.unlinkSync(path.join(store, 'LICENSE')); const outside = path.join(f.root, 'private.txt'); fs.writeFileSync(outside, 'private fixture')
    fs.symlinkSync(outside, path.join(store, 'LICENSE'))
    expect(() => writeReleaseNotices(f.options)).toThrow('release_notice_path_escape')
    fs.unlinkSync(path.join(store, 'LICENSE')); fs.writeFileSync(path.join(store, 'LICENSE'), ['sk', 'ant', 'fixture-only-secret-body'].join('-'))
    try { writeReleaseNotices(f.options); throw new Error('expected rejection') } catch (e) {
      expect(String(e)).toContain('release_notice_unsafe_content'); expect(String(e)).not.toContain('fixture-only-secret-body'); expect(String(e)).not.toContain(f.root)
      expect((e as Error).stack).toBe('Error: release_notice_unsafe_content')
    }
  } finally { f.close() }
})

test('manifest validation detects removed or changed notices and rebuilding removes stale owned documents', async () => {
  const { writeReleaseNotices, verifyReleaseNotices } = await api(); const f = fixture()
  try {
    const m = writeReleaseNotices(f.options), doc = m.documents.find(d => d.source === 'package')!
    fs.appendFileSync(path.join(f.artifact, doc.path), 'tamper')
    expect(() => verifyReleaseNotices(f.artifact)).toThrow('release_notice_hash_mismatch')
    writeReleaseNotices(f.options); fs.rmSync(path.join(f.artifact, doc.path))
    expect(() => verifyReleaseNotices(f.artifact)).toThrow('release_notice_file_missing')
    fs.mkdirSync(path.join(f.artifact, 'licenses'), { recursive: true }); fs.writeFileSync(path.join(f.artifact, 'licenses/stale.txt'), 'stale')
    writeReleaseNotices(f.options)
    expect(fs.existsSync(path.join(f.artifact, 'licenses/stale.txt'))).toBe(false)
    expect(() => verifyReleaseNotices(f.artifact)).not.toThrow()
  } finally { f.close() }
})

test('release and office minimum manifests require the collected notices', async () => {
  const { RELEASE_NOTICE_FILES } = await api()
  const { bundleManifest } = await import('../../scripts/build-office')
  const { linuxBundleFiles } = await import('../../scripts/build-bundle')
  // Shared test also runs in the medical fork, whose office manifest requires explicit masking flags.
  const office = { pandoc: false, desktop: false, pii: false, model: false }
  for (const file of RELEASE_NOTICE_FILES) {
    expect(bundleManifest(office)).toContain('app/' + file)
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: '1.0.0', whisper: false, systemd: [] })).toContain(file)
  }
})

test('web-served notice replicas are exact, checked and covered by the signed bundle manifest', async () => {
  const { writeReleaseNotices, verifyReleaseNotices } = await api(); const f = fixture()
  try {
    fs.mkdirSync(path.join(f.artifact, 'web'), { recursive: true }); fs.writeFileSync(path.join(f.artifact, 'web/index.html'), '<html>fixture</html>')
    const m = writeReleaseNotices({ ...f.options, includeWeb: true })
    expect(m.webMirror).toBe('web/licenses')
    expect(fs.readFileSync(path.join(f.artifact, 'web/licenses/manifest.json'))).toEqual(fs.readFileSync(path.join(f.artifact, 'licenses/manifest.json')))
    for (const d of m.documents) expect(fs.readFileSync(path.join(f.artifact, 'web/licenses', d.path.replace(/^licenses\//, '')))).toEqual(fs.readFileSync(path.join(f.artifact, d.path)))
    const { writeManifest, signManifest } = await import('../../server/src/system/bundle')
    const outer = await writeManifest(f.artifact, f.options.version)
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const signed = await signManifest(f.artifact, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(crypto.verify(null, fs.readFileSync(path.join(f.artifact, 'manifest.json')), publicKey, Buffer.from(signed.sig, 'base64'))).toBe(true)
    for (const d of m.documents) {
      expect(outer.files[d.path]?.sha256).toBe(d.sha256)
      expect(outer.files['web/licenses/' + d.path.replace(/^licenses\//, '')]?.sha256).toBe(d.sha256)
    }
    expect(outer.files['licenses/manifest.json']?.sha256).toBe(outer.files['web/licenses/manifest.json']?.sha256)
    expect(() => verifyReleaseNotices(f.artifact)).not.toThrow()
    fs.appendFileSync(path.join(f.artifact, 'web/licenses/LICENSE'), 'changed')
    expect(() => verifyReleaseNotices(f.artifact)).toThrow('release_notice_hash_mismatch')
    writeReleaseNotices({ ...f.options, includeWeb: true })
    fs.writeFileSync(path.join(f.artifact, 'web/unlisted.js'), 'fixture')
    expect(() => verifyReleaseNotices(f.artifact)).toThrow('release_notice_inventory_mismatch')
    fs.rmSync(path.join(f.artifact, 'web/unlisted.js'))
    const office = writeReleaseNotices({ ...f.options, includeWeb: true, kind: 'office' })
    expect(office.webMirror).toBe('web/dist/licenses')
    expect(() => verifyReleaseNotices(f.artifact)).not.toThrow()
  } finally { f.close() }
})

test('dangling output links cannot write outside the stage', async () => {
  const { writeReleaseNotices } = await api(); const f = fixture()
  try {
    fs.mkdirSync(f.artifact, { recursive: true })
    const outside = path.join(f.root, 'not-created'); fs.symlinkSync(outside, path.join(f.artifact, 'LICENSE'))
    expect(() => writeReleaseNotices(f.options)).toThrow('release_notice_output_symlink')
    expect(fs.existsSync(outside)).toBe(false)
  } finally { f.close() }
})

test('only explicitly matching core workspaces inherit root LICENSE; aliases use resolved names and private metadata stays out', async () => {
  const { writeReleaseNotices } = await api(); const f = fixture()
  try {
    f.pkg('node_modules/alias', 'actual-package', '3.4.5')
    const privateMetadata = { _where: f.root, _resolved: 'https://fixture-user:fixture-password@example.invalid/private' }
    f.put('node_modules/alias/package.json', JSON.stringify({ name: 'actual-package', version: '3.4.5', license: 'MIT', ...privateMetadata }))
    f.put('ee/cloud/package.json', JSON.stringify({ name: '@fixture/cloud', version: '1.0.0', license: 'AGPL-3.0-only' }))
    f.put('server/package.json', JSON.stringify({ name: '@fixture/server', version: '1.0.0', license: 'AGPL-3.0-only', dependencies: { alias: 'npm:actual-package@3.4.5' } }))
    const m = writeReleaseNotices({ ...f.options, roots: [{ directory: 'server' }, { directory: 'ee/cloud' }] })
    expect(m.packages.find(p => p.name === '@fixture/server')?.documents).toContain('LICENSE')
    expect(m.pending.some(p => p.code === 'workspace-grant-needs-review' && p.component === '@fixture/cloud@1.0.0')).toBe(true)
    expect(m.packages.some(p => p.name === 'actual-package' && p.version === '3.4.5')).toBe(true)
    expect(JSON.stringify(m)).not.toContain(f.root); expect(JSON.stringify(m)).not.toContain('fixture-password')
  } finally { f.close() }
})

test('unsafe optional README is withheld with original hash and pending evidence; license originals still fail closed', async () => {
  const { writeReleaseNotices } = await api(); const f = fixture()
  try {
    const unsafe = 'License usage example in ' + path.join('/Users', 'synthetic-user', 'project') + '\n'
    f.put('node_modules/alpha/README.md', unsafe)
    const m = writeReleaseNotices(f.options)
    expect(m.withheld.some(d => d.sourcePath === 'README.md' && d.sha256 === sha(unsafe))).toBe(true)
    expect(m.pending.some(p => p.code === 'unsafe-readme-withheld')).toBe(true)
    expect(JSON.stringify(m)).not.toContain('synthetic-user')
    const pemShape = ['-----BEGIN ', 'PRIVATE KEY-----', '\nfixture\n'].join('')
    f.put('node_modules/alpha/LICENSE', pemShape)
    expect(() => writeReleaseNotices(f.options)).toThrow('release_notice_unsafe_content')
  } finally { f.close() }
})

test('standalone web and desktop collect explicit roots without claiming native runtime coverage', async () => {
  const { writeReleaseNotices, verifyReleaseNotices } = await api(); const f = fixture()
  try {
    f.put('native/go.mod', 'module synthetic.invalid/native\nrequire synthetic.invalid/dependency v1.2.3\n')
    fs.mkdirSync(path.join(f.artifact, 'assets'), { recursive: true }); fs.writeFileSync(path.join(f.artifact, 'assets/fixture.wasm'), 'synthetic wasm')
    const web = writeReleaseNotices({ ...f.options, target: 'browser', kind: 'web', arch: 'neutral', includeWeb: true, includeNative: false })
    expect(web.webMirror).toBeNull(); expect(web.goModules).toEqual([])
    expect(web.inputs.some(p => p.path.startsWith('native/'))).toBe(false)
    expect(web.pending.some(p => p.code === 'native-notices-incomplete')).toBe(false)
    expect(web.pending.some(p => p.code === 'browser-assets-attribution-incomplete')).toBe(true)
    expect(web.artifacts.some(p => p.path === 'assets/fixture.wasm')).toBe(true)
    expect(() => verifyReleaseNotices(f.artifact)).not.toThrow()
    const desktop = writeReleaseNotices({ ...f.options, target: 'portable', arch: 'any', kind: 'desktop', includeNative: false })
    expect(desktop.release.target).toBe('portable'); expect(desktop.release.arch).toBe('any')
    expect(desktop.pending.some(p => p.code === 'electron-packager-notices-not-verified')).toBe(true)
    expect(desktop.goModules).toEqual([]); expect(desktop.webMirror).toBeNull()
  } finally { f.close() }
})


test('nested ECMA copyright notices are preserved byte for byte', async () => {
  const { writeReleaseNotices, verifyReleaseNotices } = await api(); const f = fixture()
  try {
    const name = 'licenses/ECMA-text-copyright-notice.txt'
    const bytes = 'Synthetic ECMA copyright notice\r\n'
    f.put('node_modules/alpha/' + name, bytes)
    const manifest = writeReleaseNotices(f.options)
    const doc = manifest.documents.find(d => d.sourcePath === name)
    expect(doc).toBeDefined()
    expect(fs.readFileSync(path.join(f.artifact, doc!.path), 'utf8')).toBe(bytes)
    verifyReleaseNotices(f.artifact)
  } finally { f.close() }
})
