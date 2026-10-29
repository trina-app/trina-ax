// `bun run build:office`: the office-mode bundle (docs/OFFICE.md) — one zip an office's Mac mini installs without
// git, Go, Node, Homebrew or GitHub access.
//
//   bun scripts/build-office.ts [--version x.y.z] [--out dist/office] [--no-pandoc] [--keep-stage]
//                               [--with-desktop | --desktop-prebuilt]
//                               [--guide <pdf>] [--desk-guide <pdf>] [--team-host <host>]
//
// Output: <out>/<officeBundle>-<version>-mac.zip, containing <officeBundle>-<version>/ (PRODUCT, shared/src/product.ts):
//   office-install.sh, office-uninstall.sh, 설치-먼저-읽기.txt, Team-AX-사무실모드-설치가이드.pdf and the desks' guide
//   Team-AX-윈도우-데스크-가이드.pdf (<artifactBase>-…; docs/office, when built; --guide / --desk-guide put one team's
//   copies in instead, built by docs/install/build-pdf.ts --team-host … --out …, under their own file names)
//   app/docs/OFFICE.md (the runbook; the person at the office has no copy of the repository)
//   app/VERSION, app/teamax (control command), app/versions.json, app/product.env (the product's names for the
//   shell scripts: scripts/product-env.ts)
//   app/bin/darwin-arm64/{bun,rg,pandoc,cloudflared}  app/bin/darwin-amd64/{…}   (the installer keeps this Mac's one)
//   app/native/bin/darwin-{arm64,amd64}/{mycel-gate,mycel-bridge,mycel-launcher,mycel-ocr}
//   app/server/src/{main.js,office.js,admin.js,accounts.js}, app/server/migrations/*.sql
//   app/scripts/macos/engine.sb, app/web/dist/
// Needs `ARCHS="arm64 amd64" bash native/build.sh` and the web build first (the package script runs both).
// The desktop app installers are NOT in the zip (110–200 MB each). --with-desktop builds them (desktop: dist:win and
// dist:mac, the universal dmg; TEAMAX_KIT_TEAM / TEAMAX_KIT_LOCALE make one team's kit build) and copies them next to
// the zip as <artifactBase>-Setup-<v>-x64.exe and <artifactBase>-<v>-mac-universal.dmg; --desktop-prebuilt copies what
// desktop/release already has. Either way the installers are made first and the zip carries desktop.sha256 (their
// names and SHA-256), so office-install.sh offers exactly those under Settings → Apps and nothing else it finds;
// the office gets the zip and the installers in the same folder. --team-host (default TEAMAX_KIT_TEAM) puts that team's
// address into 설치-먼저-읽기.txt instead of team.example.com.
// bun, ripgrep, pandoc and cloudflared (the connector of the office internet address, docs/OFFICE.md "인터넷 주소") come
// from their GitHub releases, pinned by version and SHA-256 below, cached in dist/cache/ so a rebuild works offline.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inspectInstaller, MANIFEST } from '../server/src/office/desktop'
import { PRODUCT, productEnv } from '../shared/src/product'
import { SEMANTIC_EXTERNAL, vendorSemantic } from './vendor-semantic'
import { stageHwp } from './hwp-bundle'
import { RELEASE_NOTICE_FILES, writeReleaseNotices, reportReleaseNotices } from './release-notices'

const REPO = path.resolve(import.meta.dir, '..')
const ARCHS = [{ dir: 'darwin-arm64', bun: 'aarch64', rg: 'aarch64', pandoc: 'arm64', cf: 'arm64' }, { dir: 'darwin-amd64', bun: 'x64', rg: 'x86_64', pandoc: 'x86_64', cf: 'amd64' }] as const

/** cloudflared release in the bundle (Cloudflare's own build, signed by Cloudflare; --no-autoupdate keeps it there) */
export const CLOUDFLARED_VERSION = '2026.10.0'
/** SHA-256 of the cloudflared program inside each archive (the release notes' list; the archives' own hashes are in
 * DOWNLOADS and match GitHub's asset digests) */
export const CLOUDFLARED_BIN_SHA256: Record<string, string> = {
  arm64: '72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830',
  amd64: '0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da',
}

/** Pinned downloads (versions.json: bun 1.3.12, ripgrep 15.2.0, pandoc 3.9.0.2, cloudflared 2026.10.0). bun's and ripgrep's hashes match
 * their published SHASUMS; pandoc publishes none, these are the hashes of the files checked on 2026-10-21. */
export const DOWNLOADS: Record<string, { url: string; sha256: string }> = {
  'bun-darwin-aarch64.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-darwin-aarch64.zip', sha256: '6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c' },
  'bun-darwin-x64.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-darwin-x64.zip', sha256: '0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d' },
  'ripgrep-15.2.0-aarch64-apple-darwin.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' },
  'ripgrep-15.2.0-x86_64-apple-darwin.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz', sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' },
  'pandoc-3.9.0.2-arm64-macOS.zip': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-arm64-macOS.zip', sha256: '6e9eca844076bcbb599bbeebbba78a70f93b5307782b85c2c272872812c88875' },
  'cloudflared-2026.10.0-darwin-arm64.tgz': { url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-arm64.tgz', sha256: 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70' },
  'cloudflared-2026.10.0-darwin-amd64.tgz': { url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-amd64.tgz', sha256: '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f' },
  'pandoc-3.9.0.2-x86_64-macOS.zip': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-x86_64-macOS.zip', sha256: 'b9fbceabccbc8f34ac021a50483fc32f8160568d0b4b2c22d81bb29e3054fd82' },
}

/** the guides' file names start like the installers' (PRODUCT.artifactBase) */
export const FILE_NAME = PRODUCT.artifactBase
/** the printed office-mode guide (docs/office/guide.html → PDF, `build-pdf.ts --office`), copied next to office-install.sh */
export const OFFICE_PDF = `${FILE_NAME}-사무실모드-설치가이드.pdf`
/** the desks' guide (docs/office/windows-guide.html → PDF, `build-pdf.ts --windows`), copied next to it */
export const DESK_PDF = `${FILE_NAME}-윈도우-데스크-가이드.pdf`

const ENTRIES: [string, string][] = [
  ['server/src/main.ts', 'main.js'],
  ['server/src/office/cli.ts', 'office.js'],
  ['server/src/system/cli.ts', 'admin.js'],
  ['server/src/auth/cli.ts', 'accounts.js'],
  // the bounded child process that reads spreadsheets and Hangul files
  ['server/src/files/office-worker.ts', 'office-worker.js'],
  ['server/src/safe-ops/deck-worker.ts', 'deck-worker.js'],
  ['server/src/files/hwp-preflight.ts', 'hwp-preflight.js'],
]
/** native helpers per architecture (native/build.sh) */
const NATIVE = ['mycel-gate', 'mycel-bridge', 'mycel-launcher', 'mycel-ocr']

/** What the bundle folder must hold (paths relative to it; a trailing '/' = a folder that is not empty): what
 * office-install.sh reads and copies, and what the installed server runs. Checked after staging, before the zip is
 * made, so a copy step that went missing stops the build here instead of the install at the office. The guide PDFs
 * stay out (a build without them only warns). */
export function bundleManifest(o: { pandoc: boolean; desktop: boolean }): string[] {
  return [
    'office-install.sh', 'office-uninstall.sh', '설치-먼저-읽기.txt', ...(o.desktop ? [MANIFEST] : []),
    ...(process.env.MYCEL_HWP_PREVIEW === '1' ? ['app/native/bin/hwp/rhwp-darwin-arm64', 'app/native/bin/hwp/rhwp-darwin-x64', 'app/resources/hwp/manifest.json', 'app/resources/hwp/fonts/NotoSansKR-Regular.ttf'] : []),
    'app/VERSION', 'app/product.env', 'app/teamax', 'app/versions.json', 'app/docs/OFFICE.md', 'app/docs/OFFICE.en.md',
    ...RELEASE_NOTICE_FILES.map(f => `app/${f}`),
    ...ARCHS.flatMap((a) => [
      ...['bun', 'rg', 'cloudflared', ...(o.pandoc ? ['pandoc'] : [])].map((b) => `app/bin/${a.dir}/${b}`),
      ...NATIVE.map((b) => `app/native/bin/${a.dir}/${b}`),
    ]),
    ...ENTRIES.map(([, out]) => `app/server/src/${out}`), 'app/server/migrations/', 'app/server/node_modules/@huggingface/transformers/',
    'app/scripts/macos/engine.sb', 'app/web/dist/index.html',
  ]
}

/** the entries of `manifest` the stage folder lacks */
export function missingFromStage(stage: string, manifest: string[]): string[] {
  return manifest.filter((m) => {
    const p = path.join(stage, m)
    if (m.endsWith('/')) { try { return fs.readdirSync(p).length === 0 } catch { return true } }
    return !fs.existsSync(p)
  })
}

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

/** Stage the exact documentation shipped in an office ZIP, also usable without native/runtime downloads. */
export function stageOfficeDocs(stage: string, o: { guide?: string; deskGuide?: string; teamHost?: string } = {}) {
  const app = path.join(stage, 'app')
  const scripts = path.join(REPO, 'scripts', 'office')
  // the guide travels with the program (the person at the office has no copy of the repository)
  fs.mkdirSync(path.join(app, 'docs'), { recursive: true })
  for (const name of ['OFFICE.md', 'OFFICE.en.md']) {
    // The full runbooks are self-contained; preserve offline language navigation.
    // Additional reference pages not in the kit point to the public source.
    const text = fs.readFileSync(path.join(REPO, 'docs', name), 'utf8').replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, target: string) => {
      if (['OFFICE.md', 'OFFICE.en.md'].includes(target)) return `](${target})`
      const rel = path.posix.normalize(path.posix.join('docs', target))
      return `](https://github.com/trina-app/trina-ax/blob/main/${rel})`
    })
    fs.writeFileSync(path.join(app, 'docs', name), text)
  }
  const pdf = o.guide ?? path.join(REPO, 'docs', 'office', OFFICE_PDF)
  if (fs.existsSync(pdf)) fs.copyFileSync(pdf, path.join(stage, path.basename(pdf)))
  else if (o.guide) throw new Error(`--guide ${pdf}: not found`)
  else console.warn(`warning: ${pdf} not built (bun docs/install/build-pdf.ts --office): the zip has only app/docs/OFFICE.md`)
  const deskPdf = o.deskGuide ?? path.join(REPO, 'docs', 'office', DESK_PDF)
  if (fs.existsSync(deskPdf)) fs.copyFileSync(deskPdf, path.join(stage, path.basename(deskPdf)))
  else if (o.deskGuide) throw new Error(`--desk-guide ${deskPdf}: not found`)
  else console.warn(`warning: ${deskPdf} not built (bun docs/install/build-pdf.ts --windows)`)
  // the first thing the office reads: the guides' real file names and (for one team's kit) its address
  if (o.teamHost !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(o.teamHost)) throw new Error(`--team-host ${o.teamHost}: not a host name`)
  const readme = fs.readFileSync(path.join(scripts, 'README.txt'), 'utf8')
    .split(OFFICE_PDF).join(path.basename(pdf)).split(DESK_PDF).join(path.basename(deskPdf))
    .split('team.example.com').join(o.teamHost ?? 'team.example.com')
  fs.writeFileSync(path.join(stage, '설치-먼저-읽기.txt'), readme)
  return { pdf, deskPdf }
}

export async function buildOffice(o: {
  version: string; out: string; pandoc: boolean; keepStage?: boolean; desktop?: { file: string; sha256: string }[]
  /** one team's guide PDFs (default docs/office/OFFICE_PDF and DESK_PDF), copied under their own names */
  guide?: string; deskGuide?: string
  /** that team's internet address for 설치-먼저-읽기.txt (default: the team.example.com example) */
  teamHost?: string
}) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  if (process.platform !== 'darwin') throw new Error('build the office bundle on a Mac (ditto, codesign)')
  for (const a of ARCHS) for (const b of NATIVE) {
    if (!fs.existsSync(path.join(REPO, 'native', 'bin', a.dir, b))) throw new Error(`native/bin/${a.dir}/${b} missing: run ARCHS="arm64 amd64" bash native/build.sh`)
  }
  if (!fs.existsSync(path.join(REPO, 'web', 'dist', 'index.html'))) throw new Error('web/dist missing: run bun run --cwd web build')

  const name = `${PRODUCT.officeBundle}-${o.version}`
  const stage = path.join(o.out, name)
  const app = path.join(stage, 'app')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(app, 'server', 'src'), { recursive: true })

  // server, supervisor, the two admin tools and the office worker: one self-contained file each, next to each other
  for (const [entry, out] of ENTRIES) {
    const res = await Bun.build({
      entrypoints: [path.join(REPO, entry)], target: 'bun', outdir: path.join(stage, '.build'), naming: '[name].js', minify: false,
      external: SEMANTIC_EXTERNAL,
      define: { 'process.env.MYCEL_BUILD_VERSION': JSON.stringify(o.version) },
    })
    if (!res.success) throw new Error(res.logs.map(String).join('\n'))
    fs.renameSync(res.outputs[0]!.path, path.join(app, 'server', 'src', out))
  }
  fs.rmSync(path.join(stage, '.build'), { recursive: true, force: true })
  // search by meaning: its runtime next to the server files (scripts/vendor-semantic.ts; arm64 Macs)
  vendorSemantic(path.join(app, 'server'))
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
    const cf = path.join(bin, 'cloudflared')
    extractOne(await cached(`cloudflared-${CLOUDFLARED_VERSION}-darwin-${a.cf}.tgz`), 'cloudflared', cf, scratch)
    if (sha256(cf) !== CLOUDFLARED_BIN_SHA256[a.cf]) throw new Error(`cloudflared ${a.cf}: SHA-256 ${sha256(cf)}, expected ${CLOUDFLARED_BIN_SHA256[a.cf]}`)
    const nat = path.join(app, 'native', 'bin', a.dir)
    fs.mkdirSync(nat, { recursive: true })
    for (const b of NATIVE) {
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
  const { pdf } = stageOfficeDocs(stage, o)
  fs.writeFileSync(path.join(app, 'VERSION'), o.version + '\n')
  // the product's names for office-install.sh / office-uninstall.sh (they print them; nothing is run from it)
  fs.writeFileSync(path.join(app, 'product.env'), productEnv({ PRODUCT_OFFICE_PDF: fs.existsSync(pdf) ? path.basename(pdf) : '' }))
  // the installers built with this zip (office-install.sh offers only these: server/src/office/desktop.ts readManifest)
  if (o.desktop?.length) fs.writeFileSync(path.join(stage, MANIFEST), o.desktop.map((d) => `${d.sha256}  ${path.basename(d.file)}\n`).join(''))

  await stageHwp(REPO, app, ['darwin-arm64', 'darwin-x64'])
  const notices = writeReleaseNotices({ repoRoot: REPO, artifactDir: app, version: o.version, target: 'darwin', arch: 'universal', kind: 'office', includeWeb: true })
  reportReleaseNotices(notices)
  const lack = missingFromStage(stage, bundleManifest({ pandoc: o.pandoc, desktop: !!o.desktop?.length }))
  if (lack.length) throw new Error(`the bundle is incomplete: ${lack.join(', ')}`)

  const zip = path.join(o.out, `${name}-mac.zip`)
  fs.rmSync(zip, { force: true })
  sh(['/usr/bin/ditto', '-c', '-k', '--keepParent', '--norsrc', stage, zip])
  if (!o.keepStage) fs.rmSync(stage, { recursive: true, force: true })
  return { zip, size: fs.statSync(zip).size, sha256: sha256(zip), stage: o.keepStage ? stage : null, notices: { publicClear: false, pending: notices.pending.length, manifest: 'app/licenses/manifest.json' } }
}

/** The desktop installers desktop/release has (built first unless `build` is false), copied into `out` under the names
 * office-install.sh looks for. Each is checked like `teamax desktop add` checks it. */
export function desktopInstallers(o: { out: string; build: boolean; release?: string; version?: string }): { file: string; size: number; sha256: string }[] {
  const desktop = path.join(REPO, 'desktop')
  const version = o.version ?? (JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as { version: string }).version
  const release = o.release ?? path.join(desktop, 'release')
  const want: [string, string, string][] = [
    ['dist:win', `${PRODUCT.artifactBase}-Setup-${version}-win-x64.exe`, `${PRODUCT.artifactBase}-Setup-${version}-x64.exe`],
    ['dist:mac', `${PRODUCT.artifactBase}-${version}-mac-universal.dmg`, `${PRODUCT.artifactBase}-${version}-mac-universal.dmg`],
  ]
  fs.mkdirSync(o.out, { recursive: true })
  const out: { file: string; size: number; sha256: string }[] = []
  for (const [script, built, name] of want) {
    if (o.build) {
      console.log(`building the desktop app: bun run --cwd desktop ${script}`)
      const p = Bun.spawnSync(['bun', 'run', '--cwd', desktop, script], { stdout: 'inherit', stderr: 'inherit', env: process.env })
      if (p.exitCode !== 0) throw new Error(`bun run --cwd desktop ${script} failed`)
    }
    const src = path.join(release, built)
    if (!fs.existsSync(src)) throw new Error(`${src} missing: run bun run --cwd desktop ${script} (or build-office.ts --with-desktop)`)
    inspectInstaller(src)
    const dest = path.join(o.out, name)
    fs.copyFileSync(src, `${dest}.part`)
    fs.renameSync(`${dest}.part`, dest)
    out.push({ file: dest, size: fs.statSync(dest).size, sha256: sha256(dest) })
  }
  return out
}

if (import.meta.main) {
  const version = arg('--version') ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')) as { version: string }).version
  const out = path.resolve(arg('--out') ?? path.join(REPO, 'dist', 'office'))
  const withDesktop = process.argv.includes('--with-desktop'), prebuilt = process.argv.includes('--desktop-prebuilt')
  // the installers first: the zip lists them (desktop.sha256)
  const desktop = withDesktop || prebuilt ? desktopInstallers({ out, build: withDesktop }) : null
  const guide = arg('--guide'), deskGuide = arg('--desk-guide')
  const teamHost = (arg('--team-host') ?? process.env.TEAMAX_KIT_TEAM ?? '').trim().toLowerCase() || undefined
  const r = await buildOffice({
    version, out, pandoc: !process.argv.includes('--no-pandoc'), keepStage: process.argv.includes('--keep-stage'), desktop: desktop ?? undefined,
    guide: guide ? path.resolve(guide) : undefined, deskGuide: deskGuide ? path.resolve(deskGuide) : undefined, teamHost,
  })
  console.log(JSON.stringify({ ...r, ...(desktop ? { desktop } : {}) }, null, 1))
}
