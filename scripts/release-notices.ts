// Offline evidence collection, not a license grant or publication decision. No subprocesses or network calls.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'

export const RELEASE_NOTICE_FILES = ['LICENSE', 'licenses/manifest.json', 'licenses/README.txt'] as const
const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const VERSION = /^[0-9][a-z0-9.+_-]{0,127}$/i
const MAX_TEXT = 4 * 1024 * 1024
const hash = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const fail = (code: string): never => {
  const error = new Error(code)
  error.stack = `Error: ${code}` // Avoid caller/runtime stacks exposing local build paths in CLI logs.
  throw error
}
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep)
const rel = (s: string) => s.split(path.sep).join('/')
const safeRel = (s: string) => !!s && !path.isAbsolute(s) && !s.includes('\\') && s.split('/').every(p => p !== '..' && p !== '.' && /^[\w@().+ -]+$/.test(p))
const noticeName = (s: string) => /^(?:licen[cs]e(?:s)?|notice(?:s)?|copying|copyright|authors)(?:[._ -].*)?$/i.test(s) || /^(?:third[._ -]?party|thirdparty)[._ -]?(?:licen[cs]es?|notices?)(?:[._ -].*)?$/i.test(s)
const readmeName = (s: string) => /^readme(?:\.(?:md|txt|rst|markdown))?$/i.test(s)
const licensingContext = /licen[cs]e|copyright|permission|commercial|authori[sz]|许可证|授权|商业|라이선스|저작권/i

export interface NoticeDocument {
  path: string; sha256: string; bytes: number; source: 'project' | 'shared-cloud-protocol' | 'package'
  sourcePath: string; component?: string
}
export interface NoticePackage {
  id: string; name: string; version: string; packageJsonSha256: string; declaredLicense: string | null
  workspace: boolean; documents: string[]; consumers: string[]
}
export interface ReleaseNoticeManifest {
  format: 1; publicClear: false; coverage: 'partial-review-evidence'
  selection: 'installed-declared-runtime-and-peer-closure-superset'
  release: { version: string; target: string; arch: string; kind: string }
  inputs: { path: string; sha256: string }[]
  packages: NoticePackage[]; documents: NoticeDocument[]
  artifacts: { path: string; sha256: string; bytes: number; version: string | null }[]
  /** Exact document + manifest replicas served by the installed web root; no recursive self-hash. */
  webMirror: 'web/licenses' | 'web/dist/licenses' | null
  goModules: { name: string; version: string }[]
  pending: { code: string; component: string }[]
  omitted: { component: string; consumer: string; reason: 'optional-dependency-not-installed' }[]
  withheld: { component: string; sourcePath: string; sha256: string; bytes: number; reason: 'unsafe-readme-content' }[]
}
export interface ReleaseNoticeOptions {
  repoRoot: string; artifactDir: string; version: string; target: 'darwin' | 'linux' | 'browser' | 'win32' | 'portable'; arch: string; kind: 'bundle' | 'office' | 'web' | 'desktop'
  includeWeb?: boolean
  /** False for standalone JS distributions; payload hashes remain, Go/native coverage is not asserted. */
  includeNative?: boolean
  /** Repository-relative workspace directories; packages selects a specific bundled vendor, not all dev dependencies. */
  roots?: { directory: string; packages?: string[] }[]
}

function original(file: string, boundary: string): Buffer {
  let real: string
  try { real = fs.realpathSync(file) } catch { return fail('release_notice_file_missing') }
  if (!inside(boundary, real)) fail('release_notice_path_escape')
  const st = fs.statSync(real)
  if (!st.isFile() || st.size > MAX_TEXT) fail('release_notice_invalid_text_file')
  return fs.readFileSync(real)
}
function safeText(b: Buffer): void {
  const text = b.toString('utf8')
  // Preserve accepted originals byte-for-byte; reject suspicious files instead of redacting legal text.
  if (b.includes(0) || /\/(?:Users|home)\/[\w.-]+\//.test(text) || /[A-Z]:\\Users\\/i.test(text) ||
      /(?:sk-(?:ant|proj)-[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{16,})/i.test(text)) fail('release_notice_unsafe_content')
}
function textFile(file: string, boundary: string): Buffer { const b = original(file, boundary); safeText(b); return b }
function jsonFile(file: string, boundary: string): { bytes: Buffer; value: any } {
  const bytes = original(file, boundary)
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) } } catch { return fail('release_notice_invalid_package_json') }
}
function destination(root: string, file: string): string {
  if (!safeRel(file)) fail('release_notice_invalid_output_path')
  const out = path.join(root, file)
  for (let p = out; inside(root, p); p = path.dirname(p)) {
    let st: fs.Stats | undefined
    try { st = fs.lstatSync(p) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (st?.isSymbolicLink()) fail('release_notice_output_symlink')
    if (st && (p === out ? !st.isFile() : !st.isDirectory())) fail('release_notice_output_file_type')
    if (p === root) break
  }
  return out
}
function sanitized<T>(fn: () => T): T {
  try { return fn() } catch (e) {
    // fs/JSON errors can contain absolute private paths or original input. Export only our fixed error codes.
    if (e instanceof Error && /^release_notice_[a-z_]+$/.test(e.message)) throw e
    return fail('release_notice_io_failure')
  }
}
function stagedFiles(root: string, excluded: string[] = []): { name: string; file: string }[] {
  const files: { name: string; file: string }[] = []; let entries = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 64) fail('release_notice_scan_limit')
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 150_000) fail('release_notice_scan_limit')
      const file = path.join(dir, e.name), name = rel(path.relative(root, file))
      if (excluded.includes(name)) continue
      if (e.isSymbolicLink()) fail('release_notice_artifact_symlink')
      if (!safeRel(name)) fail('release_notice_invalid_artifact_name')
      if (e.isDirectory()) walk(file, depth + 1)
      else if (e.isFile()) files.push({ name, file })
      else fail('release_notice_artifact_file_type')
    }
  }
  walk(root, 0); return files
}
const outerFiles = ['manifest.json', 'manifest.sig']
const mirrorPath = (directory: string, file: string) => `${directory}/${file.replace(/^licenses\//, '')}`
function write(root: string, file: string, bytes: Uint8Array | string): void {
  const out = destination(root, file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, bytes, { mode: 0o644 })
}
function noticeFiles(root: string, withheld: { name: string; bytes: Buffer }[]): { name: string; bytes: Buffer }[] {
  const found: { name: string; bytes: Buffer }[] = []; let entries = 0
  function walk(dir: string, depth: number) {
    if (depth > 16) fail('release_notice_scan_limit')
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (++entries > 50_000) fail('release_notice_scan_limit')
      if (['node_modules', '.git', '.cache'].includes(e.name)) continue
      const p = path.join(dir, e.name), name = rel(path.relative(root, p))
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!noticeName(e.name) && !readmeName(e.name)) continue
      if (!safeRel(name)) fail('release_notice_invalid_source_name')
      const bytes = original(p, root)
      if (readmeName(e.name) && !licensingContext.test(bytes.toString('utf8'))) continue
      try { safeText(bytes) } catch (error) {
        if (!readmeName(path.basename(p)) || !(error instanceof Error) || error.message !== 'release_notice_unsafe_content') throw error
        withheld.push({ name, bytes }); continue
      }
      found.push({ name, bytes })
    }
  }
  walk(root, 0); return found
}
function resolvePackage(name: string, base: string, repo: string): string | null {
  if (!NAME.test(name)) fail('release_notice_invalid_package_name')
  const dirs = createRequire(path.join(base, 'package.json')).resolve.paths(name) ?? []
  for (const nodeModules of dirs) {
    const candidate = path.join(nodeModules, name)
    // Never inspect global/user package stores. Bun/pnpm symlinks inside this installation are supported.
    if (!inside(repo, candidate) || !fs.existsSync(path.join(candidate, 'package.json'))) continue
    const real = fs.realpathSync(candidate)
    if (!inside(repo, real)) fail('release_notice_path_escape')
    return real
  }
  return null
}

export function writeReleaseNotices(o: ReleaseNoticeOptions): ReleaseNoticeManifest {
  return sanitized(() => collect(o))
}
function collect(o: ReleaseNoticeOptions): ReleaseNoticeManifest {
  const repo = fs.realpathSync(o.repoRoot), artifact = path.resolve(o.artifactDir)
  if (artifact === repo || inside(artifact, repo) || !VERSION.test(o.version) || !/^[a-z0-9-]+$/.test(o.arch) || !['darwin', 'linux', 'browser', 'win32', 'portable'].includes(o.target) || !['bundle', 'office', 'web', 'desktop'].includes(o.kind)) fail('release_notice_invalid_options')
  fs.mkdirSync(artifact, { recursive: true })
  destination(artifact, 'licenses/manifest.json')
  fs.rmSync(path.join(artifact, 'licenses'), { recursive: true, force: true })
  const m: ReleaseNoticeManifest = {
    format: 1, publicClear: false, coverage: 'partial-review-evidence', selection: 'installed-declared-runtime-and-peer-closure-superset',
    release: { version: o.version, target: o.target, arch: o.arch, kind: o.kind }, inputs: [], packages: [], documents: [], artifacts: [], goModules: [], pending: [], omitted: [], withheld: [],
    webMirror: o.includeWeb && ['bundle', 'office'].includes(o.kind) ? (o.kind === 'office' ? 'web/dist/licenses' : 'web/licenses') : null,
  }
  if (m.webMirror) {
    destination(artifact, `${m.webMirror}/manifest.json`)
    fs.rmSync(path.join(artifact, m.webMirror), { recursive: true, force: true })
  }
  const pending = (code: string, component: string) => { if (!m.pending.some(p => p.code === code && p.component === component)) m.pending.push({ code, component }) }
  const copy = (bytes: Buffer, file: string, source: NoticeDocument['source'], sourcePath: string, component?: string) => {
    write(artifact, file, bytes); m.documents.push({ path: file, sha256: hash(bytes), bytes: bytes.length, source, sourcePath, ...(component ? { component } : {}) })
  }
  if (!fs.existsSync(path.join(repo, 'LICENSE'))) fail('release_notice_root_license_missing')
  copy(textFile(path.join(repo, 'LICENSE'), repo), 'LICENSE', 'project', 'LICENSE')
  if (fs.existsSync(path.join(repo, 'NOTICE'))) copy(textFile(path.join(repo, 'NOTICE'), repo), 'NOTICE', 'project', 'NOTICE')
  else if (fs.existsSync(path.join(artifact, 'NOTICE'))) fs.unlinkSync(destination(artifact, 'NOTICE'))
  const protocol = 'shared/src/cloud-protocol/LICENSE'
  if (fs.existsSync(path.join(repo, protocol))) copy(textFile(path.join(repo, protocol), repo), 'licenses/shared-cloud-protocol/LICENSE', 'shared-cloud-protocol', protocol)
  else if (fs.existsSync(path.dirname(path.join(repo, protocol)))) pending('scoped-license-missing', 'shared/cloud-protocol')
  for (const file of ['bun.lock', 'versions.json', ...(o.includeNative !== false ? ['native/go.mod', 'native/go.sum'] : [])]) {
    if (fs.existsSync(path.join(repo, file))) m.inputs.push({ path: file, sha256: hash(original(path.join(repo, file), repo)) })
  }
  if (!m.inputs.some(i => i.path === 'bun.lock')) pending('lockfile-missing', 'npm-installation')

  const rootPackage = fs.existsSync(path.join(repo, 'package.json')) ? jsonFile(path.join(repo, 'package.json'), repo).value : {}
  const visited = new Map<string, NoticePackage>(); const identities = new Map<string, NoticePackage>()
  const visit = (dir: string, consumer: string) => {
    dir = fs.realpathSync(dir)
    if (!inside(repo, dir)) fail('release_notice_path_escape')
    const previous = visited.get(dir)
    if (previous) { if (!previous.consumers.includes(consumer)) previous.consumers.push(consumer); return }
    if (visited.size >= 2500) fail('release_notice_package_limit')
    const pj = jsonFile(path.join(dir, 'package.json'), dir), p = pj.value
    if (!NAME.test(p.name ?? '') || !VERSION.test(p.version ?? '')) fail('release_notice_invalid_package_identity')
    safeText(Buffer.from(p.name + ' ' + p.version))
    const workspace = !rel(path.relative(repo, dir)).split('/').includes('node_modules')
    const withheld: { name: string; bytes: Buffer }[] = []
    const docs = workspace ? [] : noticeFiles(dir, withheld)
    const licenseReference = typeof p.license === 'string' ? /^SEE LICEN[CS]E IN (.+)$/i.exec(p.license)?.[1] : undefined
    if (licenseReference) {
      if (!safeRel(licenseReference)) fail('release_notice_path_escape')
      if (!docs.some(d => d.name === licenseReference)) {
        const file = path.join(dir, licenseReference)
        if (fs.existsSync(file)) docs.push({ name: licenseReference, bytes: textFile(file, dir) })
        else pending('referenced-license-missing', `${p.name}@${p.version}`)
      }
    }
    docs.sort((a, b) => a.name < b.name ? -1 : 1)
    const identity = `${p.name}@${p.version}-${hash(Buffer.concat([pj.bytes, ...[...docs, ...withheld].flatMap(d => [Buffer.from(d.name), d.bytes])])).slice(0, 16)}`
    let item = identities.get(identity)
    if (!item) {
      const declaredLicense = typeof p.license === 'string' && /^[a-z0-9().+ _/-]{1,200}$/i.test(p.license) && !p.license.includes('..') && !p.license.startsWith('/') ? p.license : null
      if (declaredLicense) safeText(Buffer.from(declaredLicense))
      item = { id: identity, name: p.name, version: p.version, packageJsonSha256: hash(pj.bytes), declaredLicense, workspace, documents: [], consumers: [consumer] }
      identities.set(identity, item); m.packages.push(item)
      for (const d of withheld) {
        m.withheld.push({ component: identity, sourcePath: d.name, sha256: hash(d.bytes), bytes: d.bytes.length, reason: 'unsafe-readme-content' })
        pending('unsafe-readme-withheld', `${p.name}@${p.version}`)
      }
      for (const doc of docs) {
        const file = `licenses/packages/${identity.replace('/', '__')}/${doc.name}`
        copy(doc.bytes, file, 'package', doc.name, identity); item.documents.push(file)
      }
      const inherited = workspace && ['server', 'shared', 'web'].includes(rel(path.relative(repo, dir))) && typeof p.license === 'string' && p.license === rootPackage.license
      if (inherited) item.documents.push('LICENSE')
      if (!inherited && !docs.some(d => d.name === licenseReference || /^(?:licen[cs]e|copying|copyright)/i.test(path.basename(d.name)))) pending(workspace ? 'workspace-grant-needs-review' : 'license-text-missing', `${p.name}@${p.version}`)
      if (!declaredLicense || /unlicensed|proprietary|see license/i.test(declaredLicense)) pending('license-declaration-needs-review', `${p.name}@${p.version}`)
      if (docs.some(d => readmeName(path.basename(d.name)))) pending('readme-license-context-needs-review', `${p.name}@${p.version}`)
    } else if (!item.consumers.includes(consumer)) item.consumers.push(consumer)
    visited.set(dir, item)
    const dependencies = { ...p.peerDependencies, ...p.dependencies, ...p.optionalDependencies }
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = resolvePackage(name, dir, repo)
      if (resolved) visit(resolved, identity)
      else if (p.optionalDependencies?.[name] || p.peerDependenciesMeta?.[name]?.optional) m.omitted.push({ component: name, consumer: identity, reason: 'optional-dependency-not-installed' })
      else if (isBuiltin(name)) pending('builtin-name-without-installed-package', name)
      else pending('dependency-not-installed', name)
    }
  }
  const roots = o.roots ?? (o.kind === 'web'
    ? [{ directory: 'web' }, { directory: 'web', packages: ['@tailwindcss/browser'] }]
    : o.kind === 'desktop' ? [{ directory: 'desktop' }]
    : [{ directory: 'server' }, ...(o.includeWeb ? [{ directory: 'web' }, { directory: 'web', packages: ['@tailwindcss/browser'] }] : [])])
  for (const root of roots) {
    if (!safeRel(root.directory)) fail('release_notice_invalid_root')
    const dir = path.join(repo, root.directory)
    if (root.packages) for (const name of root.packages) {
      const resolved = resolvePackage(name, dir, repo)
      if (resolved) visit(resolved, `vendor:${root.directory}`); else pending('dependency-not-installed', name)
    }
    else if (fs.existsSync(path.join(dir, 'package.json'))) visit(dir, `workspace:${root.directory}`)
    else pending('workspace-manifest-missing', root.directory)
  }

  // Track actual staged binaries without executing them or pretending npm notices cover embedded native code.
  const versionsFile = path.join(repo, 'versions.json')
  const versions = fs.existsSync(versionsFile) ? jsonFile(versionsFile, repo).value : {}
  let hasNative = false
  for (const { file, name } of stagedFiles(artifact, ['licenses', 'LICENSE', 'NOTICE', ...outerFiles, ...(m.webMirror ? [m.webMirror] : [])])) {
      if (o.includeNative !== false && (/^(?:bin|native|root)\//.test(name) || /\.(?:node|dylib|dll|wasm|so(?:\.[\d.]+)?)$/.test(name))) hasNative = true
      const basename = path.basename(name), bytes = fs.readFileSync(file), key = basename === 'rg' ? 'ripgrep' : basename
      const version = VERSION.test(versions[key] ?? '') ? versions[key] : basename.startsWith('mycel-') ? o.version : null
      m.artifacts.push({ path: name, sha256: hash(bytes), bytes: bytes.length, version })
  }
  if (hasNative) pending('native-notices-incomplete', 'runtime-binaries-and-embedded-dependencies')
  if (o.target === 'darwin' && o.kind === 'bundle') pending('installer-root-notices-not-enumerated', 'root-owned-installer-programs-outside-version-folder')
  if (o.kind === 'office') pending('office-kit-extras-not-enumerated', 'installer-guides-and-separate-desktop-installers-outside-app-folder')
  if (o.kind === 'desktop') pending('electron-packager-notices-not-verified', 'electron-runtime-native-components-and-installers-outside-js-dist')
  if (o.includeWeb || o.kind === 'web') pending('browser-assets-attribution-incomplete', 'fonts-images-wasm-and-copied-assets')
  const goMod = path.join(repo, 'native/go.mod')
  if (hasNative && fs.existsSync(goMod)) {
    const text = original(goMod, repo).toString('utf8')
    for (const match of text.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9._~/-]+)\s+(v[0-9A-Za-z.+_-]+)/gm)) m.goModules.push({ name: match[1], version: match[2] })
    pending('go-module-and-toolchain-notices-incomplete', 'native/go.mod')
  }
  pending('license-and-source-obligations-not-reviewed', 'whole-artifact')
  pending('declared-graph-not-exact-bundler-inventory', 'npm-and-browser-vendors')
  for (const p of m.packages) { p.documents.sort(); p.consumers.sort() }
  m.packages.sort((a, b) => a.id.localeCompare(b.id)); m.documents.sort((a, b) => a.path.localeCompare(b.path)); m.artifacts.sort((a, b) => a.path.localeCompare(b.path))
  m.pending.sort((a, b) => `${a.code}:${a.component}`.localeCompare(`${b.code}:${b.component}`))
  m.omitted.sort((a, b) => `${a.component}:${a.consumer}`.localeCompare(`${b.component}:${b.consumer}`))
  const readme = `Release notice evidence — NOT publication approval\npublicClear=false; coverage=partial-review-evidence\n\nOriginal installed-package license/notice and licensing README bytes are preserved. Package metadata is not a grant.\nThe declared runtime/peer closure is a conservative superset, not an exact bundle inventory. Native toolchain, embedded code, assets and corresponding-source obligations need separate review.\n\nPending (${m.pending.length}):\n${m.pending.map(p => `- ${p.code}: ${p.component}`).join('\n')}\n`
  write(artifact, 'licenses/README.txt', readme)
  m.documents.push({ path: 'licenses/README.txt', source: 'project', sourcePath: 'generated-review-status', sha256: hash(readme), bytes: Buffer.byteLength(readme) })
  const manifest = JSON.stringify(m, null, 2) + '\n'
  write(artifact, 'licenses/manifest.json', manifest)
  if (m.webMirror) {
    for (const d of m.documents) write(artifact, mirrorPath(m.webMirror, d.path), fs.readFileSync(path.join(artifact, d.path)))
    write(artifact, `${m.webMirror}/manifest.json`, manifest)
  }
  verifyReleaseNotices(artifact)
  return m
}

/** Validate before the outer bundle manifest/signature/archive is produced. No self-hash recursion. */
export function verifyReleaseNotices(artifactDir: string): ReleaseNoticeManifest {
  return sanitized(() => verify(artifactDir))
}
function verify(artifactDir: string): ReleaseNoticeManifest {
  const root = fs.realpathSync(artifactDir)
  let m: ReleaseNoticeManifest
  const manifestPath = destination(root, 'licenses/manifest.json')
  const manifest = original(manifestPath, root)
  try { m = JSON.parse(manifest.toString('utf8')) } catch { return fail('release_notice_manifest_invalid') }
  if (m.format !== 1 || m.publicClear !== false || !Array.isArray(m.documents) || !Array.isArray(m.artifacts) || !Array.isArray(m.packages) || !Array.isArray(m.pending) || ![null, 'web/licenses', 'web/dist/licenses'].includes(m.webMirror)) fail('release_notice_manifest_invalid')
  const known = new Set<string>()
  for (const d of [...m.documents, ...m.artifacts]) {
    if (!safeRel(d.path) || known.has(d.path) || d.path === 'licenses/manifest.json') fail('release_notice_manifest_invalid')
    known.add(d.path)
    const file = destination(root, d.path)
    if (!fs.existsSync(file)) fail('release_notice_file_missing')
    const bytes = fs.readFileSync(file)
    if (bytes.length !== d.bytes || hash(bytes) !== d.sha256) fail('release_notice_hash_mismatch')
  }
  if (!known.has('LICENSE') || !known.has('licenses/README.txt')) fail('release_notice_manifest_invalid')
  for (const p of m.packages) for (const doc of p.documents) if (!known.has(doc)) fail('release_notice_manifest_invalid')
  known.add('licenses/manifest.json')
  if (m.webMirror) {
    for (const d of [...m.documents, { path: 'licenses/manifest.json', bytes: manifest.length, sha256: hash(manifest) }]) {
      const file = mirrorPath(m.webMirror, d.path)
      if (known.has(file)) fail('release_notice_manifest_invalid')
      known.add(file)
      const bytes = original(destination(root, file), root)
      if (bytes.length !== d.bytes || hash(bytes) !== d.sha256) fail('release_notice_hash_mismatch')
    }
  }
  const actual = stagedFiles(root, outerFiles)
  if (actual.length !== known.size || actual.some(f => !known.has(f.name))) fail('release_notice_inventory_mismatch')
  return m
}

export function reportReleaseNotices(m: ReleaseNoticeManifest): void {
  console.warn(`release notices: ${m.packages.length} installed packages; ${m.pending.length} pending findings; publicClear=false (review artifact, NOT publication approval)`)
}
