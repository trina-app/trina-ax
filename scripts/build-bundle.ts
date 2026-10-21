// Build a release bundle for the installed macOS server (component G, design tab 6 "번들").
//
//   bun scripts/build-bundle.ts --version 0.1.0 --out dist/release [--sign-key release.pem] [--notes NOTES.md]
//
// Output (<out>):
//   app/<version>/          the version folder the installer / an update puts in app/versions/<version>:
//                           bin/bun, server/src/{main.js,admin.js}, server/migrations/, native/{mycel-gate,mycel-bridge},
//                           web/ (when web/dist exists), RELEASE_NOTES.md, manifest.json (+ manifest.sig when signed)
//   <version>.tar.zst       the same folder packed, for POST /api/admin/update / `admin.js stage-update`
//   root/                   the root-owned files (installed only by scripts/install-macos.sh, never by an update):
//                           mycel-bootstrap, mycel-launcher, engine.sb, pf-load, set-claude-token (+ safe-fs.sh)
// Needs `bun run build:native` first. Without --sign-key the bundle is unsigned (no release key exists yet): the
// installer then runs the bootstrap with --allow-unsigned and diagnostics say so.
import fs from 'node:fs'
import path from 'node:path'
import { packBundle, signManifest, writeManifest } from '../server/src/system/bundle'

const REPO = path.resolve(import.meta.dir, '..')

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

export async function buildBundle(o: { version: string; out: string; signKey?: string | null; notes?: string | null; arch?: string }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  const arch = o.arch ?? (process.arch === 'arm64' ? 'arm64' : 'amd64')
  const nativeDir = path.join(REPO, 'native', 'bin', `darwin-${arch}`)
  for (const b of ['mycel-gate', 'mycel-bridge', 'mycel-launcher', 'mycel-bootstrap']) {
    if (!fs.existsSync(path.join(nativeDir, b))) throw new Error(`${path.join(nativeDir, b)} missing: run \`bun run build:native\``)
  }
  const dir = path.join(o.out, 'app', o.version)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true, mode: 0o755 })

  // server: one self-contained file per entry point; migrations next to it (db.ts reads ../migrations)
  const res = await Bun.build({
    entrypoints: [path.join(REPO, 'server', 'src', 'main.ts'), path.join(REPO, 'server', 'src', 'system', 'cli.ts')],
    target: 'bun',
    outdir: path.join(dir, 'server', 'src'),
    naming: '[name].js',
    define: { 'process.env.MYCEL_BUILD_VERSION': JSON.stringify(o.version) },
    minify: false,
  })
  if (!res.success) throw new Error(res.logs.map(String).join('\n'))
  fs.renameSync(path.join(dir, 'server', 'src', 'cli.js'), path.join(dir, 'server', 'src', 'admin.js'))
  fs.mkdirSync(path.join(dir, 'server', 'migrations'), { recursive: true })
  for (const f of fs.readdirSync(path.join(REPO, 'server', 'migrations'))) {
    if (f.endsWith('.sql')) fs.copyFileSync(path.join(REPO, 'server', 'migrations', f), path.join(dir, 'server', 'migrations', f))
  }
  // runtime: the pinned bun that runs this script (versions.json)
  fs.copyFileSync(process.execPath, path.join(dir, 'bin', 'bun'))
  fs.chmodSync(path.join(dir, 'bin', 'bun'), 0o755)
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
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'engine.sb'), path.join(root, 'engine.sb'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'pf-load.sh'), path.join(root, 'pf-load'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'set-claude-token.sh'), path.join(root, 'set-claude-token'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'safe-fs.sh'), path.join(root, 'safe-fs.sh'))
  fs.writeFileSync(path.join(o.out, 'VERSION'), o.version + '\n')
  return { dir, archive: path.join(o.out, `${o.version}.tar.zst`), size: packed.size, sha256: packed.sha256, root }
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
