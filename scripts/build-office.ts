// `bun run build:office`: the office-mode bundle (docs/OFFICE.md) — one zip a clinic's Mac mini installs without
// git, Go, Node, Homebrew or GitHub access.
//
//   bun scripts/build-office.ts [--version 0.1.0] [--out dist/office] [--no-pandoc] [--keep-stage]
//
// Output: <out>/TeamAX-office-<version>-mac.zip, containing TeamAX-office-<version>/:
//   office-install.sh, office-uninstall.sh, 설치-먼저-읽기.txt
//   app/VERSION, app/teamax (control command), app/versions.json
//   app/bin/darwin-arm64/{bun,rg,pandoc}  app/bin/darwin-amd64/{bun,rg,pandoc}   (the installer keeps this Mac's one)
//   app/native/bin/darwin-{arm64,amd64}/{mycel-gate,mycel-bridge,mycel-launcher}
//   app/server/src/{main.js,office.js,admin.js,accounts.js}, app/server/migrations/*.sql
//   app/scripts/macos/engine.sb, app/web/dist/
// Needs `ARCHS="arm64 amd64" bash native/build.sh` and the web build first (the package script runs both).
// bun, ripgrep and pandoc come from their GitHub releases, pinned by version and SHA-256 below, cached in
// dist/cache/ so a rebuild works offline.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const ARCHS = [{ dir: 'darwin-arm64', bun: 'aarch64', rg: 'aarch64', pandoc: 'arm64' }, { dir: 'darwin-amd64', bun: 'x64', rg: 'x86_64', pandoc: 'x86_64' }] as const

/** Pinned downloads (versions.json: bun 1.3.12, ripgrep 15.2.0, pandoc 3.9.0.2). bun's and ripgrep's hashes match
 * their published SHASUMS; pandoc publishes none, these are the hashes of the files checked on 2026-10-21. */
export const DOWNLOADS: Record<string, { url: string; sha256: string }> = {
  'bun-darwin-aarch64.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-darwin-aarch64.zip', sha256: '6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c' },
  'bun-darwin-x64.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-darwin-x64.zip', sha256: '0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d' },
  'ripgrep-15.2.0-aarch64-apple-darwin.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' },
  'ripgrep-15.2.0-x86_64-apple-darwin.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz', sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' },
  'pandoc-3.9.0.2-arm64-macOS.zip': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-arm64-macOS.zip', sha256: '6e9eca844076bcbb599bbeebbba78a70f93b5307782b85c2c272872812c88875' },
  'pandoc-3.9.0.2-x86_64-macOS.zip': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-x86_64-macOS.zip', sha256: 'b9fbceabccbc8f34ac021a50483fc32f8160568d0b4b2c22d81bb29e3054fd82' },
}

const ENTRIES: [string, string][] = [
  ['server/src/main.ts', 'main.js'],
  ['server/src/office/cli.ts', 'office.js'],
  ['server/src/system/cli.ts', 'admin.js'],
  ['server/src/auth/cli.ts', 'accounts.js'],
]

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

function sh(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${p.stderr.toString().trim()}`)
  return p.stdout.toString()
}

const sha256 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** A pinned download from dist/cache (fetched once). The hash is checked every time. */
async function cached(name: string): Promise<string> {
  const d = DOWNLOADS[name]!
  const dir = path.join(REPO, 'dist', 'cache')
  const f = path.join(dir, name)
  if (!fs.existsSync(f)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`downloading ${d.url}`)
    const res = await fetch(d.url)
    if (!res.ok) throw new Error(`${d.url}: HTTP ${res.status}`)
    fs.writeFileSync(`${f}.part`, new Uint8Array(await res.arrayBuffer()))
    fs.renameSync(`${f}.part`, f)
  }
  const got = sha256(f)
  if (got !== d.sha256) { fs.rmSync(f); throw new Error(`${name}: SHA-256 ${got}, expected ${d.sha256} (removed; run again to download it again)`) }
  return f
}

/** Unpack `archive` into a scratch folder and copy the one member ending in `/<member>` to `dest`. */
function extractOne(archive: string, member: string, dest: string, scratch: string) {
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.mkdirSync(scratch, { recursive: true })
  if (archive.endsWith('.zip')) sh(['/usr/bin/ditto', '-x', '-k', archive, scratch])
  else sh(['/usr/bin/tar', '-xzf', archive, '-C', scratch])
  const found = walk(scratch).find((f) => f.endsWith(`/${member}`) && !f.includes('__MACOSX'))
  if (!found) throw new Error(`${member} not found in ${archive}`)
  fs.copyFileSync(found, dest)
  fs.chmodSync(dest, 0o755)
  fs.rmSync(scratch, { recursive: true, force: true })
}

function walk(d: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

export async function buildOffice(o: { version: string; out: string; pandoc: boolean; keepStage?: boolean }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  if (process.platform !== 'darwin') throw new Error('build the office bundle on a Mac (ditto, codesign)')
  for (const a of ARCHS) for (const b of ['mycel-gate', 'mycel-bridge', 'mycel-launcher']) {
    if (!fs.existsSync(path.join(REPO, 'native', 'bin', a.dir, b))) throw new Error(`native/bin/${a.dir}/${b} missing: run ARCHS="arm64 amd64" bash native/build.sh`)
  }
  if (!fs.existsSync(path.join(REPO, 'web', 'dist', 'index.html'))) throw new Error('web/dist missing: run bun run --cwd web build')

  const name = `TeamAX-office-${o.version}`
  const stage = path.join(o.out, name)
  const app = path.join(stage, 'app')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(app, 'server', 'src'), { recursive: true })

  // server, supervisor and the two admin tools: one self-contained file each, next to each other
  for (const [entry, out] of ENTRIES) {
    const res = await Bun.build({
      entrypoints: [path.join(REPO, entry)], target: 'bun', outdir: path.join(stage, '.build'), naming: '[name].js', minify: false,
      define: { 'process.env.MYCEL_BUILD_VERSION': JSON.stringify(o.version) },
    })
    if (!res.success) throw new Error(res.logs.map(String).join('\n'))
    fs.renameSync(res.outputs[0]!.path, path.join(app, 'server', 'src', out))
  }
  fs.rmSync(path.join(stage, '.build'), { recursive: true, force: true })
  fs.mkdirSync(path.join(app, 'server', 'migrations'))
  for (const f of fs.readdirSync(path.join(REPO, 'server', 'migrations'))) if (f.endsWith('.sql')) fs.copyFileSync(path.join(REPO, 'server', 'migrations', f), path.join(app, 'server', 'migrations', f))
  fs.mkdirSync(path.join(app, 'scripts', 'macos'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts', 'macos', 'engine.sb'), path.join(app, 'scripts', 'macos', 'engine.sb'))
  fs.cpSync(path.join(REPO, 'web', 'dist'), path.join(app, 'web', 'dist'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'versions.json'), path.join(app, 'versions.json'))

  // per-architecture programs
  const scratch = path.join(o.out, '.extract')
  for (const a of ARCHS) {
    const bin = path.join(app, 'bin', a.dir)
    fs.mkdirSync(bin, { recursive: true })
    extractOne(await cached(`bun-darwin-${a.bun}.zip`), 'bun', path.join(bin, 'bun'), scratch)
    extractOne(await cached(`ripgrep-15.2.0-${a.rg}-apple-darwin.tar.gz`), 'rg', path.join(bin, 'rg'), scratch)
    if (o.pandoc) extractOne(await cached(`pandoc-3.9.0.2-${a.pandoc}-macOS.zip`), 'bin/pandoc', path.join(bin, 'pandoc'), scratch)
    const nat = path.join(app, 'native', 'bin', a.dir)
    fs.mkdirSync(nat, { recursive: true })
    for (const b of ['mycel-gate', 'mycel-bridge', 'mycel-launcher']) {
      fs.copyFileSync(path.join(REPO, 'native', 'bin', a.dir, b), path.join(nat, b))
      fs.chmodSync(path.join(nat, b), 0o755)
    }
  }

  // scripts
  const scripts = path.join(REPO, 'scripts', 'office')
  fs.copyFileSync(path.join(scripts, 'teamax'), path.join(app, 'teamax'))
  fs.chmodSync(path.join(app, 'teamax'), 0o755)
  for (const f of ['office-install.sh', 'office-uninstall.sh']) {
    fs.copyFileSync(path.join(scripts, f), path.join(stage, f))
    fs.chmodSync(path.join(stage, f), 0o755)
  }
  fs.copyFileSync(path.join(scripts, 'README.txt'), path.join(stage, '설치-먼저-읽기.txt'))
  fs.writeFileSync(path.join(app, 'VERSION'), o.version + '\n')

  const zip = path.join(o.out, `${name}-mac.zip`)
  fs.rmSync(zip, { force: true })
  sh(['/usr/bin/ditto', '-c', '-k', '--keepParent', '--norsrc', stage, zip])
  if (!o.keepStage) fs.rmSync(stage, { recursive: true, force: true })
  return { zip, size: fs.statSync(zip).size, sha256: sha256(zip), stage: o.keepStage ? stage : null }
}

if (import.meta.main) {
  const version = arg('--version') ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')) as { version: string }).version
  const r = await buildOffice({ version, out: path.resolve(arg('--out') ?? path.join(REPO, 'dist', 'office')), pandoc: !process.argv.includes('--no-pandoc'), keepStage: process.argv.includes('--keep-stage') })
  console.log(JSON.stringify(r, null, 1))
}
