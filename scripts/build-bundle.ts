// Build a release bundle for the installed macOS server (component G, design tab 6 "번들").
//
//   bun scripts/build-bundle.ts --version 0.1.0 --out dist/release [--arch arm64|amd64|universal] [--sign-key release.pem]
//                               [--notes NOTES.md]
//
// Output (<out>):
//   app/<version>/          the version folder the installer / an update puts in app/versions/<version>:
//                           bin/bun, server/src/{main.js,admin.js,account.js}, server/migrations/,
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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packBundle, signManifest, writeManifest } from '../server/src/system/bundle'

const REPO = path.resolve(import.meta.dir, '..')
export type BundleArch = 'arm64' | 'amd64' | 'universal'
export const hostArch = (): 'arm64' | 'amd64' => (process.arch === 'arm64' ? 'arm64' : 'amd64')
/** the files the installer copies into root/ (owned by root, never replaced by an update) */
export const ROOT_FILES = ['mycel-bootstrap', 'mycel-launcher', 'mycel-account', 'engine.sb', 'pf-load'] as const
/** server entry points: source -> bundled file in server/src/ */
const ENTRIES: [string, string][] = [['main.ts', 'main.js'], ['system/cli.ts', 'admin.js'], ['auth/cli.ts', 'account.js']]

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

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
  for (const [src, out] of ENTRIES) {
    const res = await Bun.build({
      entrypoints: [path.join(REPO, 'server', 'src', src)],
      target: 'bun',
      outdir: path.join(dir, 'server', 'src'),
      naming: out,
      define: { 'process.env.MYCEL_BUILD_VERSION': JSON.stringify(o.version) },
      minify: false,
    })
    if (!res.success) throw new Error(res.logs.map(String).join('\n'))
  }
  fs.mkdirSync(path.join(dir, 'server', 'migrations'), { recursive: true })
  for (const f of fs.readdirSync(path.join(REPO, 'server', 'migrations'))) {
    if (f.endsWith('.sql')) fs.copyFileSync(path.join(REPO, 'server', 'migrations', f), path.join(dir, 'server', 'migrations', f))
  }
  // runtime: the pinned bun that runs this script (versions.json), for the bundle's arch
  const bunFor = o.bunFor ?? bunBinary
  const bunOut = path.join(dir, 'bin', 'bun')
  if (arch === 'universal') lipoCreate([await bunFor('arm64'), await bunFor('amd64')], bunOut)
  else fs.copyFileSync(await bunFor(arch), bunOut)
  fs.chmodSync(bunOut, 0o755)
  fs.mkdirSync(path.join(dir, 'native'), { recursive: true })
  for (const b of ['mycel-gate', 'mycel-bridge']) {
    fs.copyFileSync(path.join(nativeDir, b), path.join(dir, 'native', b))
    fs.chmodSync(path.join(dir, 'native', b), 0o755)
  }
  const web = path.join(REPO, 'web', 'dist')
  if (fs.existsSync(web)) fs.cpSync(web, path.join(dir, 'web'), { recursive: true })
  if (o.notes) fs.copyFileSync(o.notes, path.join(dir, 'RELEASE_NOTES.md'))
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
  return { dir, archive: path.join(o.out, `${o.version}.tar.zst`), size: packed.size, sha256: packed.sha256, root, arch }
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

if (import.meta.main) {
  const version = arg('--version') ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')) as { version: string }).version
  const out = path.resolve(arg('--out') ?? path.join(REPO, 'dist', 'release'))
  const r = await buildBundle({ version, out, signKey: arg('--sign-key'), notes: arg('--notes'), arch: arg('--arch') ?? undefined })
  console.log(JSON.stringify(r, null, 1))
}
