// Build a release bundle for the installed macOS server (component G, design tab 6 "번들").
//
//   bun scripts/build-bundle.ts --version 0.1.0 --out dist/release [--arch arm64|amd64|universal] [--sign-key release.pem]
//                               [--notes NOTES.md]
//
// Output (<out>):
//   app/<version>/          the version folder the installer / an update puts in app/versions/<version>:
//                           bin/bun, server/src/{main.js,admin.js,account.js,office-worker.js}, server/migrations/,
//                           native/{mycel-gate,mycel-bridge}, web/ (when web/dist exists), RELEASE_NOTES.md,
//                           manifest.json (+ manifest.sig when signed)
//   <version>.tar.zst       the same folder packed, for POST /api/admin/update / `admin.js stage-update`
//   root/                   the root-owned files (installed only by scripts/install-macos.sh, never by an update):
//                           mycel-bootstrap, mycel-launcher, mycel-account (scripts/macos/account.sh), engine.sb, pf-load,
//                           set-claude-token (+ safe-fs.sh)
//
// --arch (default: this Mac's): arm64 = Apple silicon, amd64 = Intel, universal = both in every program (lipo), for
// one bundle / setup package that installs on any Mac. Needs the native helpers of that arch first: `bun run
// build:native` (this Mac's), `ARCHS="arm64 amd64" bun run build:native` (also writes native/bin/darwin-universal).
// bin/bun is the bun running this script (the pinned version, versions.json); for another arch the same bun version is
// downloaded once from the Bun GitHub release, checked against its SHASUMS256.txt, and cached in dist/.cache/.
// Without --sign-key the bundle is unsigned (no release key exists yet): the installer then runs the bootstrap with
// --allow-unsigned and diagnostics say so.
//
// --os linux (default: this computer's OS) builds the Linux server bundle instead (linux-runtime spec 3.6.1, D10, D11;
// buildLinuxBundle below; the macOS path above is unchanged):
//
//   bun scripts/build-bundle.ts --os linux --version 0.3.0 --out dist/linux [--arch amd64|arm64] [--sign-key release.pem]
//                               [--notes NOTES.md] (--whisper-dir DIR | --no-whisper) [--strict]
//
// Only on a Linux machine of the bundle's arch (onnxruntime-node's and sharp's Linux binaries must be the ones `bun
// install` put there). Output (<out>): the install kit tree — install-linux.sh, VERSION, product.env, app/<version>/
// with bin/{bun,rg,pandoc,typst,whisper-cli[,whisper-cli-v2]} (scripts/linux/downloads.ts; whisper from the CI build),
// native/{mycel-gate,mycel-bridge,mycel-ocr}, server/, web/, root/ (the root-owned programs, inside the version folder
// so the signed manifest covers them and `mycel-ctl update` can take them from a verified bundle), engines.lock.json,
// engines/codex-<v>.model_catalog.json, deps.txt, RELEASE_NOTES.md, manifest.json (+ manifest.sig) — plus
// <version>-linux-<arch>.tar.zst (the version folder, for updates) and <kit>-<version>-linux-<arch>.tar.gz (the kit).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { packBundle, signManifest, writeManifest } from '../server/src/system/bundle'
import { walkTree } from '../server/src/system/manifest'
import { writeAtomic } from '../server/src/system/streams'
import { tarStream, type TarEntryInput } from '../server/src/system/tar'
import { PRODUCT, productEnv } from '../shared/src/product'
import { RELEASE_CHANNEL } from '../shared/src/release-channel'
import { cachedDownload, downloadFor, extractMember, LINUX_DOWNLOADS, type LinuxArch } from './linux/downloads'
import { checkEnginesLock, checkLockedCatalog, codexCatalogName, pinnedVersion } from './linux/lock-engines'
import { SEMANTIC_EXTERNAL, vendorSemantic } from './vendor-semantic'
import { stageHwp } from './hwp-bundle'
import { RELEASE_NOTICE_FILES, writeReleaseNotices, reportReleaseNotices } from './release-notices'

const REPO = path.resolve(import.meta.dir, '..')
export type BundleArch = 'arm64' | 'amd64' | 'universal'
export const hostArch = (): 'arm64' | 'amd64' => (process.arch === 'arm64' ? 'arm64' : 'amd64')
/** the files the installer copies into root/ (owned by root, never replaced by an update) */
export const ROOT_FILES = ['mycel-bootstrap', 'mycel-launcher', 'mycel-account', 'engine.sb', 'pf-load'] as const
/** server entry points: source -> bundled file in server/src/ */
// office-worker.js: the bounded child process that reads spreadsheets and Hangul files (files/office-worker.ts)
const ENTRIES: [string, string][] = [['main.ts', 'main.js'], ['system/cli.ts', 'admin.js'], ['auth/cli.ts', 'account.js'], ['files/office-worker.ts', 'office-worker.js'], ['files/hwp-preflight.ts', 'hwp-preflight.js']]

export async function buildBundle(o: { version: string; out: string; signKey?: string | null; notes?: string | null; arch?: string; bunFor?: (arch: 'arm64' | 'amd64') => Promise<string> }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  const arch = (o.arch ?? hostArch()) as BundleArch
  if (!['arm64', 'amd64', 'universal'].includes(arch)) throw new Error(`--arch must be arm64, amd64 or universal, not ${arch}`)
  const nativeDir = path.join(REPO, 'native', 'bin', `darwin-${arch}`)
  for (const b of ['mycel-gate', 'mycel-bridge', 'mycel-launcher', 'mycel-bootstrap']) {
    if (!fs.existsSync(path.join(nativeDir, b))) {
      throw new Error(`${path.join(nativeDir, b)} missing: run \`${arch === 'universal' ? 'ARCHS="arm64 amd64" ' : arch === hostArch() ? '' : `ARCHS=${arch} `}bun run build:native\``)
    }
  }
  const dir = path.join(o.out, 'app', o.version)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true, mode: 0o755 })

  // server: one self-contained file per entry point; migrations next to it (db.ts reads ../migrations)
  await buildServerEntries(dir, o.version)
  // search by meaning: its runtime next to the server files (scripts/vendor-semantic.ts; arm64 / universal)
  if (arch !== 'amd64') vendorSemantic(path.join(dir, 'server'))
  copyMigrations(dir)
  // runtime: the pinned bun that runs this script (versions.json), for the bundle's arch
  const bunFor = o.bunFor ?? bunBinary
  const bunOut = path.join(dir, 'bin', 'bun')
  if (arch === 'universal') lipoCreate([await bunFor('arm64'), await bunFor('amd64')], bunOut)
  else fs.copyFileSync(await bunFor(arch), bunOut)
  fs.chmodSync(bunOut, 0o755)
  fs.mkdirSync(path.join(dir, 'native'), { recursive: true })
  // mycel-ocr (scanned PDFs, images) when this Mac built it (native/build.sh, swiftc): optional, the server works without it
  for (const b of ['mycel-gate', 'mycel-bridge', 'mycel-ocr']) {
    if (b === 'mycel-ocr' && !fs.existsSync(path.join(nativeDir, b))) continue
    fs.copyFileSync(path.join(nativeDir, b), path.join(dir, 'native', b))
    fs.chmodSync(path.join(dir, 'native', b), 0o755)
  }
  const web = path.join(REPO, 'web', 'dist')
  if (fs.existsSync(web)) fs.cpSync(web, path.join(dir, 'web'), { recursive: true })
  if (o.notes) fs.copyFileSync(o.notes, path.join(dir, 'RELEASE_NOTES.md'))
  await stageHwp(REPO, dir, arch === 'universal' ? ['darwin-arm64', 'darwin-x64'] : [arch === 'amd64' ? 'darwin-x64' : 'darwin-arm64'])
  const notices = writeReleaseNotices({ repoRoot: REPO, artifactDir: dir, version: o.version, target: 'darwin', arch, kind: 'bundle', includeWeb: fs.existsSync(web) })
  reportReleaseNotices(notices)
  for (const p of walkDirs(dir)) fs.chmodSync(p, 0o755)
  await writeManifest(dir, o.version)
  if (o.signKey) await signManifest(dir, fs.readFileSync(o.signKey, 'utf8'))
  const packed = await packBundle(dir, path.join(o.out, `${o.version}.tar.zst`))

  // root-owned files (installer only)
  const root = path.join(o.out, 'root')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  for (const b of ['mycel-bootstrap', 'mycel-launcher']) fs.copyFileSync(path.join(nativeDir, b), path.join(root, b))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'account.sh'), path.join(root, 'mycel-account'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'engine.sb'), path.join(root, 'engine.sb'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'pf-load.sh'), path.join(root, 'pf-load'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'set-claude-token.sh'), path.join(root, 'set-claude-token'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'safe-fs.sh'), path.join(root, 'safe-fs.sh'))
  for (const f of ['mycel-bootstrap', 'mycel-launcher', 'mycel-account', 'pf-load', 'set-claude-token']) fs.chmodSync(path.join(root, f), 0o755)
  fs.writeFileSync(path.join(o.out, 'VERSION'), o.version + '\n')
  // the product's name for install-macos.sh (the role accounts' full names): shared/src/product.ts
  fs.writeFileSync(path.join(o.out, 'product.env'), productEnv())
  return { dir, archive: path.join(o.out, `${o.version}.tar.zst`), size: packed.size, sha256: packed.sha256, root, arch, notices: { publicClear: false, pending: notices.pending.length, manifest: 'licenses/manifest.json' } }
}

/** The server's entry points as self-contained files in <dir>/server/src (both OS bundles). */
async function buildServerEntries(dir: string, version: string): Promise<void> {
  for (const [src, out] of ENTRIES) {
    const res = await Bun.build({
      entrypoints: [path.join(REPO, 'server', 'src', src)],
      target: 'bun',
      outdir: path.join(dir, 'server', 'src'),
      naming: out,
      external: SEMANTIC_EXTERNAL,
      define: { 'process.env.MYCEL_BUILD_VERSION': JSON.stringify(version) },
      minify: false,
    })
    if (!res.success) throw new Error(res.logs.map(String).join('\n'))
  }
}

/** server/migrations/*.sql next to the server files (db.ts reads ../migrations). */
function copyMigrations(dir: string): void {
  fs.mkdirSync(path.join(dir, 'server', 'migrations'), { recursive: true })
  for (const f of fs.readdirSync(path.join(REPO, 'server', 'migrations'))) {
    if (f.endsWith('.sql')) fs.copyFileSync(path.join(REPO, 'server', 'migrations', f), path.join(dir, 'server', 'migrations', f))
  }
}

/** A bun executable of this bun's version for `arch`: this one, or the release download (checked, cached). */
export async function bunBinary(arch: 'arm64' | 'amd64'): Promise<string> {
  if (process.platform === 'darwin' && arch === hostArch()) return process.execPath
  const name = arch === 'arm64' ? 'bun-darwin-aarch64' : 'bun-darwin-x64'
  const cache = path.join(REPO, 'dist', '.cache', `bun-${Bun.version}`, name)
  const exe = path.join(cache, 'bun')
  if (fs.existsSync(exe)) return exe
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}`
  const sums = await (await mustFetch(`${base}/SHASUMS256.txt`)).text()
  const want = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.zip$`, 'm').exec(sums)?.[1]
  if (!want) throw new Error(`${name}.zip is not in SHASUMS256.txt of bun ${Bun.version}`)
  const zip = Buffer.from(await (await mustFetch(`${base}/${name}.zip`)).arrayBuffer())
  const got = new Bun.CryptoHasher('sha256').update(zip).digest('hex')
  if (got !== want) throw new Error(`${name}.zip sha256 ${got} does not match SHASUMS256.txt (${want})`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-bun-'))
  try {
    fs.writeFileSync(path.join(tmp, 'bun.zip'), zip)
    const p = Bun.spawnSync(['/usr/bin/ditto', '-x', '-k', path.join(tmp, 'bun.zip'), tmp], { stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(`unpacking ${name}.zip failed: ${p.stderr.toString()}`)
    fs.mkdirSync(cache, { recursive: true })
    fs.copyFileSync(path.join(tmp, name, 'bun'), exe)
    fs.chmodSync(exe, 0o755)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return exe
}

async function mustFetch(url: string): Promise<Response> {
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`)
  return r
}

/** Mach-O universal file from single-arch ones (the same file twice is refused by lipo). */
export function lipoCreate(inputs: string[], out: string): void {
  const p = Bun.spawnSync(['/usr/bin/lipo', '-create', ...inputs, '-output', out], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`lipo -create failed: ${p.stderr.toString().trim()}`)
}

function* walkDirs(d: string): Generator<string> {
  yield d
  for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) yield* walkDirs(path.join(d, e.name))
}

// ======================= Linux server bundle (linux-runtime spec 3.6.1) =======================

/** native/bin/linux-<arch>/ programs: in the version folder's native/ (run by the server) */
export const LINUX_NATIVE = ['mycel-gate', 'mycel-bridge', 'mycel-ocr'] as const
/** native/bin/linux-<arch>/ programs that go to app/<v>/root/ (installed root-owned into <base>/root/) */
export const LINUX_ROOT_NATIVE = ['mycel-bootstrap', 'mycel-launcher', 'mycel-sandbox', 'mycel-ctl'] as const
/** repository scripts -> app/<v>/root/<name> (scripts/linux/* are scripts/install-linux.sh's helpers) */
export const LINUX_ROOT_SCRIPTS: readonly (readonly [string, string])[] = [
  ['scripts/linux/account.sh', 'mycel-account'],
  ['scripts/linux/set-claude-token.sh', 'set-claude-token'],
  ['scripts/linux/safe-fs.sh', 'safe-fs.sh'],
  ['scripts/linux/apparmor-bwrap.in', 'apparmor-bwrap.in'],
  ['scripts/macos/codex-catalog.mjs', 'codex-catalog.mjs'],
]
/** executables among the root files (the rest are read: templates, sourced helpers, the catalog locker run by bun) */
const LINUX_ROOT_EXEC = new Set<string>([...LINUX_ROOT_NATIVE, 'mycel-account', 'set-claude-token'])
/** the bundled tools in app/<v>/bin/ besides whisper (scripts/linux/downloads.ts) */
export const LINUX_TOOLS = ['bun', 'rg', 'pandoc', 'typst'] as const
/** the install kit's name: <kit>-<version>-linux-<arch>.tar.gz (the office zip's naming, PRODUCT.officeBundle) */
export const SERVER_KIT = PRODUCT.officeBundle.replace(/-office$/, '-server')
export const kitName = (version: string, arch: LinuxArch) => `${SERVER_KIT}-${version}-linux-${arch}`

export interface BundleArgs {
  os: 'darwin' | 'linux'
  version: string | null
  out: string | null
  arch: string | null
  signKey: string | null
  notes: string | null
  whisperDir: string | null
  noWhisper: boolean
  strict: boolean
}

/** The command line (pure; --os defaults to this computer's). */
export function parseBundleArgs(argv: string[], platform: string = process.platform): BundleArgs {
  const val = (name: string): string | null => {
    const i = argv.indexOf(name)
    if (i < 0) return null
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
    return v
  }
  const osArg = val('--os') ?? (platform === 'linux' ? 'linux' : 'darwin')
  if (osArg !== 'darwin' && osArg !== 'linux') throw new Error(`--os must be darwin or linux, not ${osArg}`)
  const a: BundleArgs = {
    os: osArg, version: val('--version'), out: val('--out'), arch: val('--arch'), signKey: val('--sign-key'), notes: val('--notes'),
    whisperDir: val('--whisper-dir'), noWhisper: argv.includes('--no-whisper'), strict: argv.includes('--strict'),
  }
  if (a.os === 'darwin' && (a.whisperDir || a.noWhisper || a.strict)) throw new Error('--whisper-dir, --no-whisper and --strict are for --os linux')
  if (a.whisperDir && a.noWhisper) throw new Error('give --whisper-dir or --no-whisper, not both')
  return a
}

/** A Linux bundle is built on Linux of the same arch (D10: the platform binaries of onnxruntime-node and sharp are
 * the ones `bun install` put into node_modules there; a Mac has its own). */
export function assertLinuxHost(arch: string, platform: string = process.platform, host: string = hostArch()): LinuxArch {
  if (arch !== 'amd64' && arch !== 'arm64') throw new Error(`--arch must be amd64 or arm64 for a Linux bundle, not ${arch}`)
  if (platform !== 'linux' || arch !== host) {
    throw new Error(`Linux bundles are built on a Linux runner of the same architecture (리눅스 번들은 같은 아키텍처의 리눅스 러너에서 만드세요): this is ${platform}-${host}, the bundle is linux-${arch}`)
  }
  return arch
}

/** whisper-cli builds of the CI job for `arch`: amd64 has the AVX2/FMA/F16C build and the SSE4.2-only fallback. */
export const whisperFiles = (arch: LinuxArch) => (arch === 'amd64' ? ['whisper-cli', 'whisper-cli-v2'] : ['whisper-cli'])

/** Every file a Linux version folder must hold (relative paths; the server's own files are checked by name). */
export function linuxBundleFiles(o: { arch: LinuxArch; codexVersion: string; whisper: boolean; systemd: string[] }): string[] {
  return [
    ...RELEASE_NOTICE_FILES,
    ...LINUX_TOOLS.map((t) => `bin/${t}`),
    ...(o.whisper ? whisperFiles(o.arch).map((w) => `bin/${w}`) : []),
    ...LINUX_NATIVE.map((n) => `native/${n}`),
    'resources/hwp/manifest.json', 'resources/hwp/fonts/NotoSansKR-Regular.ttf', `native/bin/hwp/rhwp-linux-${o.arch === 'amd64' ? 'x64' : 'arm64'}`, 'server/src/hwp-preflight.js',
    'server/src/main.js', 'server/src/admin.js', 'server/src/account.js', 'server/src/office-worker.js',
    ...LINUX_ROOT_NATIVE.map((n) => `root/${n}`),
    ...LINUX_ROOT_SCRIPTS.map(([, d]) => `root/${d}`),
    ...o.systemd.map((u) => `root/systemd/${u}`),
    'engines.lock.json', codexCatalogName(o.codexVersion), 'deps.txt',
  ]
}

/** e_machine of an ELF executable: 'amd64' (x86-64), 'arm64' (AArch64), or null (not a 64-bit little-endian ELF). */
export function elfArch(file: string): LinuxArch | null {
  const fd = fs.openSync(file, 'r')
  try {
    const h = Buffer.alloc(20)
    if (fs.readSync(fd, h, 0, 20, 0) < 20 || h.readUInt32BE(0) !== 0x7f454c46 || h[4] !== 2 || h[5] !== 1) return null
    const m = h.readUInt16LE(18)
    return m === 0x3e ? 'amd64' : m === 0xb7 ? 'arm64' : null
  } finally {
    fs.closeSync(fd)
  }
}

function gzip(src: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const z = zlib.createGzip({ level: 9 })
  const input = Readable.from(src)
  input.on('error', (e) => z.destroy(e))
  return input.pipe(z) as unknown as AsyncIterable<Uint8Array>
}

export async function buildLinuxBundle(o: {
  version: string; out: string; signKey?: string | null; notes?: string | null; arch?: string | null
  /** the CI build of whisper.cpp (whisperFiles(arch)); without it, noWhisper must say so */
  whisperDir?: string | null; noWhisper?: boolean
  /** release builds: every optional part must be there (web, whisper, the installer and its helpers) */
  strict?: boolean
}) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  const arch = assertLinuxHost(o.arch ?? hostArch())
  const versions = JSON.parse(fs.readFileSync(path.join(REPO, 'versions.json'), 'utf8')) as Record<string, string>
  const claudeV = pinnedVersion(versions, 'claude-code'), codexV = pinnedVersion(versions, 'codex-cli')
  const missing: string[] = []
  const nativeDir = path.join(REPO, 'native', 'bin', `linux-${arch}`)
  for (const b of [...LINUX_NATIVE, ...LINUX_ROOT_NATIVE]) {
    const f = path.join(nativeDir, b)
    if (!fs.existsSync(f)) throw new Error(`${f} missing: run \`bash native/build.sh\` (ARCHS=${arch})`)
    if (elfArch(f) !== arch) throw new Error(`${f} is not a linux-${arch} program`)
  }
  if (!o.whisperDir && !o.noWhisper) throw new Error('whisper-cli: pass --whisper-dir <the CI build-whisper artifact> or --no-whisper (no voice transcription in this bundle)')
  if (o.noWhisper && o.strict) throw new Error('--strict (release) bundles carry whisper-cli: pass --whisper-dir')
  const lockFile = path.join(REPO, 'scripts', 'linux', 'engines.lock.json')
  const lock = checkEnginesLock(JSON.parse(fs.readFileSync(lockFile, 'utf8')), { claude: claudeV, codex: codexV })
  const catalogSrc = path.join(REPO, 'scripts', 'linux', codexCatalogName(codexV))
  checkLockedCatalog(JSON.parse(fs.readFileSync(catalogSrc, 'utf8')))

  const dir = path.join(o.out, 'app', o.version)
  fs.rmSync(path.join(o.out, 'app'), { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true, mode: 0o755 })
  const scratch = path.join(o.out, '.unpack')

  // server: the same files as the macOS bundle, with the Linux runtime of search by meaning
  await buildServerEntries(dir, o.version)
  vendorSemantic(path.join(dir, 'server'), { os: 'linux', arch })
  copyMigrations(dir)

  // tools: pinned downloads (bun is the x64-baseline build on amd64, see scripts/linux/downloads.ts)
  for (const t of LINUX_TOOLS) {
    const name = downloadFor(t, arch)
    extractMember(await cachedDownload(name), LINUX_DOWNLOADS[name]!.member!, path.join(dir, 'bin', t), scratch)
  }
  if (o.whisperDir) {
    for (const w of whisperFiles(arch)) {
      const f = path.join(o.whisperDir, w)
      if (!fs.existsSync(f)) throw new Error(`${f} missing (the build-whisper job makes ${whisperFiles(arch).join(' and ')} for linux-${arch})`)
      fs.copyFileSync(f, path.join(dir, 'bin', w))
    }
  } else {
    console.warn('warning: --no-whisper: this bundle has no whisper-cli (voice and video transcription stay off)')
  }
  for (const f of fs.readdirSync(path.join(dir, 'bin'))) {
    fs.chmodSync(path.join(dir, 'bin', f), 0o755)
    if (elfArch(path.join(dir, 'bin', f)) !== arch) throw new Error(`bin/${f} is not a linux-${arch} program`)
  }
  fs.mkdirSync(path.join(dir, 'native'), { recursive: true })
  for (const b of LINUX_NATIVE) {
    fs.copyFileSync(path.join(nativeDir, b), path.join(dir, 'native', b))
    fs.chmodSync(path.join(dir, 'native', b), 0o755)
  }

  // root-owned programs and the installer's helpers, inside the signed version folder (spec 3.6.1)
  const root = path.join(dir, 'root')
  fs.mkdirSync(path.join(root, 'systemd'), { recursive: true })
  for (const b of LINUX_ROOT_NATIVE) fs.copyFileSync(path.join(nativeDir, b), path.join(root, b))
  for (const [src, dst] of LINUX_ROOT_SCRIPTS) {
    if (fs.existsSync(path.join(REPO, src))) fs.copyFileSync(path.join(REPO, src), path.join(root, dst))
    else missing.push(src)
  }
  const unitDir = path.join(REPO, 'scripts', 'linux', 'systemd')
  const units = fs.existsSync(unitDir) ? fs.readdirSync(unitDir).filter((f) => f.endsWith('.in')).sort() : []
  if (!units.length) missing.push('scripts/linux/systemd/*.in')
  for (const u of units) fs.copyFileSync(path.join(unitDir, u), path.join(root, 'systemd', u))
  for (const f of fs.readdirSync(root)) if (fs.statSync(path.join(root, f)).isFile()) fs.chmodSync(path.join(root, f), LINUX_ROOT_EXEC.has(f) ? 0o755 : 0o644)
  for (const u of units) fs.chmodSync(path.join(root, 'systemd', u), 0o644)

  // engines (downloaded by the installer, never bundled: D11), packages, notes, web
  fs.copyFileSync(lockFile, path.join(dir, 'engines.lock.json'))
  fs.mkdirSync(path.join(dir, 'engines'), { recursive: true })
  fs.copyFileSync(catalogSrc, path.join(dir, codexCatalogName(codexV)))
  fs.copyFileSync(path.join(REPO, 'scripts', 'linux', 'deps.txt'), path.join(dir, 'deps.txt'))
  if (o.notes) fs.copyFileSync(o.notes, path.join(dir, 'RELEASE_NOTES.md'))
  const web = path.join(REPO, 'web', 'dist')
  if (fs.existsSync(web)) fs.cpSync(web, path.join(dir, 'web'), { recursive: true })
  else missing.push('web/dist (bun run build:web)')
  const installer = path.join(REPO, 'scripts', 'install-linux.sh')
  if (!fs.existsSync(installer)) missing.push('scripts/install-linux.sh')
  if (missing.length && o.strict) throw new Error(`--strict: missing ${missing.join(', ')}`)
  for (const m of missing) console.warn(`warning: ${m} is missing; the bundle is incomplete`)

  await stageHwp(REPO, dir, [arch === 'amd64' ? 'linux-x64' : 'linux-arm64'])
  const notices = writeReleaseNotices({ repoRoot: REPO, artifactDir: dir, version: o.version, target: 'linux', arch, kind: 'bundle', includeWeb: fs.existsSync(web) })
  reportReleaseNotices(notices)

  for (const p of walkDirs(dir)) fs.chmodSync(p, 0o755)
  const absent = new Set(LINUX_ROOT_SCRIPTS.filter(([src]) => missing.includes(src)).map(([, d]) => `root/${d}`))
  for (const f of linuxBundleFiles({ arch, codexVersion: codexV, whisper: !!o.whisperDir, systemd: units })) {
    if (!absent.has(f) && !fs.existsSync(path.join(dir, f))) throw new Error(`bundle file ${f} was not written`)
  }
  await writeManifest(dir, o.version)
  if (o.signKey) await signManifest(dir, fs.readFileSync(o.signKey, 'utf8'))
  const archive = path.join(o.out, `${o.version}-linux-${arch}.tar.zst`)
  const packed = await packBundle(dir, archive)

  // the kit: <out> itself (install-linux.sh, VERSION, product.env, app/<version>/), packed under one top folder
  if (fs.existsSync(installer)) { fs.copyFileSync(installer, path.join(o.out, 'install-linux.sh')); fs.chmodSync(path.join(o.out, 'install-linux.sh'), 0o755) }
  fs.writeFileSync(path.join(o.out, 'VERSION'), o.version + '\n')
  // the product's names and release feed for install-linux.sh (a new install updates from <feed>/server/)
  fs.writeFileSync(path.join(o.out, 'product.env'), productEnv({ RELEASE_FEED: RELEASE_CHANNEL.feed }))
  fs.rmSync(scratch, { recursive: true, force: true })
  const kit = await packLinuxKit(o.out, o.version, arch)
  return { os: 'linux' as const, dir, archive, size: packed.size, sha256: packed.sha256, kit: kit.file, kitSize: kit.size, kitSha256: kit.sha256, arch, engines: { claude: lock.claude.version, codex: lock.codex.version }, missing, notices: { publicClear: false, pending: notices.pending.length, manifest: 'licenses/manifest.json' } }
}

/** The install kit <out>/<kit>-<version>-linux-<arch>.tar.gz: <out> itself (install-linux.sh, VERSION, product.env,
 * app/<version>/) under one top folder. Also used by scripts/release/release-ci.ts after it signs a CI build. */
export async function packLinuxKit(out: string, version: string, arch: LinuxArch): Promise<{ file: string; size: number; sha256: string }> {
  const dir = path.join(out, 'app', version)
  const top = kitName(version, arch)
  const entries: TarEntryInput[] = [{ name: top, type: 'dir', mode: 0o755 }]
  for (const f of ['install-linux.sh', 'VERSION', 'product.env']) {
    if (fs.existsSync(path.join(out, f))) entries.push({ name: `${top}/${f}`, type: 'file', source: path.join(out, f), mode: f.endsWith('.sh') ? 0o755 : 0o644 })
  }
  entries.push({ name: `${top}/app`, type: 'dir', mode: 0o755 }, { name: `${top}/app/${version}`, type: 'dir', mode: 0o755 })
  const { files, dirs } = await walkTree(dir)
  for (const d of dirs) entries.push({ name: `${top}/app/${version}/${d.rel}`, type: 'dir', mode: d.mode, mtimeMs: d.mtimeMs })
  for (const f of files) entries.push({ name: `${top}/app/${version}/${f.rel}`, type: 'file', source: f.abs, mode: f.mode })
  const file = path.join(out, `${top}.tar.gz`)
  const kit = await writeAtomic(gzip(tarStream(entries)), file, 0o644)
  return { file, size: kit.size, sha256: kit.sha256 }
}

if (import.meta.main) {
  const a = parseBundleArgs(process.argv.slice(2))
  const version = a.version ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')) as { version: string }).version
  if (a.os === 'linux') {
    const out = path.resolve(a.out ?? path.join(REPO, 'dist', 'linux'))
    const r = await buildLinuxBundle({ version, out, signKey: a.signKey, notes: a.notes, arch: a.arch, whisperDir: a.whisperDir, noWhisper: a.noWhisper, strict: a.strict })
    console.log(JSON.stringify(r, null, 1))
  } else {
    const out = path.resolve(a.out ?? path.join(REPO, 'dist', 'release'))
    const r = await buildBundle({ version, out, signKey: a.signKey, notes: a.notes, arch: a.arch ?? undefined })
    console.log(JSON.stringify(r, null, 1))
  }
}
