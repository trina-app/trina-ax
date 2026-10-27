// Publish an office release to this product's feed (RELEASE_CHANNEL, shared/src/release-channel.ts; docs/OFFICE.md
// "자동 업데이트"). On the owner's Mac. <dir> below is RELEASE_CHANNEL.officeDir.
//
//   bun scripts/release/publish.ts --channel beta|stable [--build] [--version X]
//       [--office dist/office/<officeBundle>-X-mac.zip]
//       [--windows desktop/release/<artifactBase>-Setup-Y-win-x64.exe]   (its latest.yml must be next to it)
//       [--min-from 0.2.0-0] [--notes "…" | --notes-file F] [--out DIR [--feed http://127.0.0.1:PORT]] [--dry-run]
//
// --build first builds both (bun run build:office with --version X; the Windows app with version X): otherwise the
// files are taken as given (default: dist/office/<officeBundle>-<version>-mac.zip and, when it exists,
// desktop/release/<artifactBase>-Setup-<version>-win-x64.exe; names from shared/src/product.ts). Then:
//   1. checks the files: the zip holds <officeBundle>-<version>/app/VERSION = version; latest.yml names the installer
//      with its sha512 and size
//   2. refuses to go back: the channel's current manifest (if any) must be older (the same version only re-uploads
//      identical files), and a file already published under <dir>/<version>/ is never replaced by a different one
//   3. uploads <dir>/<version>/<files> to the R2 bucket, then signs (~/.config/<keyDir>/release-key.pem) and
//      uploads <dir>/<channel>.json last, so the manifest never names a file that is not there
//   4. reads the manifest back through the feed and verifies it like an office does
// --out DIR writes the feed into a folder instead (tests: a feed on this Mac, whose address --feed names, served to an
// install switched to it with `teamax update feed`); --dry-run checks and signs, uploads nothing.
// The API token (CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env) and the release key are never printed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions } from '../../server/src/system/update'
import { DEFAULT_FEED, fileUrl, manifestUrl, OFFICE_PRODUCT, OFFICE_RELEASE_KEYS, signRelease, verifyRelease, VERSION_RE, type Channel, type OfficeRelease, type ReleaseFile } from '../../server/src/office/release'
import { checkLatestYml } from '../../server/src/office/update'
import { readReleaseKey } from './keygen'
import { PRODUCT } from '../../shared/src/product'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

const DIR = RELEASE_CHANNEL.officeDir

const ZIP_VERSION = new RegExp(`^${PRODUCT.officeBundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([^/]+)/app/VERSION$`)

const REPO = path.resolve(import.meta.dir, '..', '..')
/** the first version with the updater: anything older installs the zip by hand once */
export const DEFAULT_MIN_FROM = '0.2.0-0'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sha256 = (f: string, algo = 'sha256', enc: 'hex' | 'base64' = 'hex') => {
  const h = crypto.createHash(algo)
  const fd = fs.openSync(f, 'r')
  const buf = Buffer.allocUnsafe(4 << 20)
  try { for (let pos = 0; ;) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n } } finally { fs.closeSync(fd) }
  return h.digest(enc)
}

function run(cmd: string[], env: Record<string, string> = {}, cwd = REPO) {
  console.log(`$ ${cmd.join(' ')}`)
  const p = Bun.spawnSync(cmd, { cwd, env: { ...(process.env as Record<string, string>), ...env }, stdout: 'inherit', stderr: 'inherit' })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed (${p.exitCode})`)
}

/** what latest.yml says (version, path) — the small YAML electron-builder writes */
export function readLatestYml(text: string): { version: string | null; path: string | null } {
  const val = (k: string) => new RegExp(`^${k}:\\s*'?([^'\\n]*?)'?\\s*$`, 'm').exec(text)?.[1] ?? null
  return { version: val('version'), path: val('path') }
}

export function officeZipVersion(zip: string): string {
  const p = Bun.spawnSync(['/usr/bin/unzip', '-Z1', zip], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${zip} is not a zip`)
  const v = p.stdout.toString().split('\n').map((l) => ZIP_VERSION.exec(l.trim())?.[1]).find(Boolean)
  if (!v) throw new Error(`${zip} has no ${PRODUCT.officeBundle}-<version>/app/VERSION`)
  const inside = Bun.spawnSync(['/usr/bin/unzip', '-p', zip, `${PRODUCT.officeBundle}-${v}/app/VERSION`], { stdout: 'pipe' }).stdout.toString().trim()
  if (inside !== v) throw new Error(`${zip}: app/VERSION says ${inside}, the folder says ${v}`)
  return v
}

export interface Artifact { key: string; file: string; type: string; meta: ReleaseFile }

export function describe(feed: string, version: string, file: string, type: string): Artifact {
  const name = path.basename(file)
  return { key: `${DIR}/${version}/${name}`, file, type, meta: { file: name, url: fileUrl(feed, version, name), sha256: sha256(file), size: fs.statSync(file).size } }
}

async function main() {
  const channel = arg('--channel') as Channel | undefined
  if (channel !== 'stable' && channel !== 'beta') throw new Error('--channel stable|beta is required')
  const version = arg('--version') ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')) as { version: string }).version
  if (!VERSION_RE.test(version)) throw new Error(`version ${version} is not like 1.2.3 or 1.2.3-beta.1`)
  const minFrom = arg('--min-from') ?? DEFAULT_MIN_FROM
  if (!VERSION_RE.test(minFrom) || compareVersions(minFrom, version) > 0) throw new Error(`--min-from ${minFrom} must be a version not newer than ${version}`)
  const notes = arg('--notes-file') ? fs.readFileSync(arg('--notes-file')!, 'utf8') : arg('--notes') ?? ''
  const out = arg('--out')
  const dry = process.argv.includes('--dry-run')
  const feed = arg('--feed') ?? DEFAULT_FEED
  if (feed !== DEFAULT_FEED && (!out || !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(feed))) throw new Error('--feed is only for --out with a feed on this Mac (http://127.0.0.1:<port>)')

  if (process.argv.includes('--build')) {
    run(['bun', 'run', 'build:office', '--', '--version', version])
    run(['bun', 'run', '--cwd', 'desktop', 'dist:win', '--', `-c.extraMetadata.version=${version}`])
  }
  const zip = path.resolve(arg('--office') ?? path.join(REPO, 'dist', 'office', `${PRODUCT.officeBundle}-${version}-mac.zip`))
  if (!fs.existsSync(zip)) throw new Error(`${zip} not found (--build, or bun run build:office -- --version ${version})`)
  const zv = officeZipVersion(zip)
  if (zv !== version) throw new Error(`${zip} is version ${zv}, not ${version}`)
  const arts: Artifact[] = [describe(feed, version, zip, 'application/zip')]

  let windows: OfficeRelease['windows'] = null
  const exeArg = arg('--windows') ?? (() => { const d = path.join(REPO, 'desktop', 'release', `${PRODUCT.artifactBase}-Setup-${version}-win-x64.exe`); return fs.existsSync(d) ? d : undefined })()
  if (exeArg && !process.argv.includes('--no-windows')) {
    const exe = path.resolve(exeArg)
    const yml = path.join(path.dirname(exe), 'latest.yml')
    if (!fs.existsSync(yml)) throw new Error(`${yml} not found: the Windows build writes it next to the installer (desktop/package.json build.publish)`)
    const y = readLatestYml(fs.readFileSync(yml, 'utf8'))
    if (!y.version || !VERSION_RE.test(y.version)) throw new Error(`${yml}: no version`)
    checkLatestYml(fs.readFileSync(yml, 'utf8'), y.version, path.basename(exe), sha256(exe, 'sha512', 'base64'), fs.statSync(exe).size)
    const ie = describe(feed, version, exe, 'application/vnd.microsoft.portable-executable')
    const ye = describe(feed, version, yml, 'text/yaml; charset=utf-8')
    arts.push(ie, ye)
    windows = { version: y.version, installer: ie.meta, latestYml: ye.meta }
  }

  const release: OfficeRelease = {
    format: 1, product: OFFICE_PRODUCT, channel, version, minFrom, publishedAt: new Date().toISOString(), notes,
    office: [{ ...arts[0]!.meta, arch: 'universal' }], windows,
  }
  const signed = signRelease(release, readReleaseKey())
  verifyRelease(signed, { keys: OFFICE_RELEASE_KEYS, channel, feed }) // signed with the key this build trusts
  console.log(`release ${version} (${channel}, from ${minFrom}): ${arts.map((a) => `${a.meta.file} ${(a.meta.size / 1048576).toFixed(1)} MB`).join(', ')}`)

  if (out) {
    for (const a of arts) { fs.mkdirSync(path.join(out, path.dirname(a.key)), { recursive: true }); fs.copyFileSync(a.file, path.join(out, a.key)) }
    fs.mkdirSync(path.join(out, DIR), { recursive: true })
    fs.writeFileSync(path.join(out, DIR, `${channel}.json`), signed)
    console.log(`written into ${out} (feed paths ${DIR}/…)`)
    return
  }

  // the channel never goes back, and a published file is never replaced by another one
  const cur = await fetch(`${manifestUrl(feed, channel)}?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (cur?.ok) {
    const prev = verifyRelease(await cur.text(), { keys: OFFICE_RELEASE_KEYS, channel, feed })
    if (compareVersions(version, prev.version) < 0) throw new Error(`${channel} is at ${prev.version}; ${version} is older (the offices never go back)`)
    console.log(`${channel} is at ${prev.version} now`)
  } else if (cur && cur.status !== 404) throw new Error(`${manifestUrl(feed, channel)}: HTTP ${cur.status}`)
  for (const a of arts) {
    const h = await fetch(a.meta.url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) }).catch(() => null)
    if (h?.ok) {
      const same = Number(h.headers.get('content-length')) === a.meta.size
      if (!same) throw new Error(`${a.meta.url} is already published with another size: publish a new version instead`)
      ;(a as Artifact & { skip?: boolean }).skip = true
    }
  }
  if (dry) { console.log('dry run: nothing uploaded'); return }

  const { Cloudflare } = await import('./cloudflare')
  const cf = new Cloudflare()
  const { account } = await cf.accountAndZone()
  for (const a of arts) {
    if ((a as Artifact & { skip?: boolean }).skip) { console.log(`= ${a.key} (already there)`); continue }
    console.log(`↑ ${a.key}`)
    await cf.putObject(account, a.key, a.file, a.type)
    const h = await fetch(a.meta.url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
    if (!h.ok || Number(h.headers.get('content-length')) !== a.meta.size) throw new Error(`${a.meta.url} does not answer with the uploaded file (HTTP ${h.status})`)
  }
  const tmp = path.join(REPO, 'dist', `.${channel}.json.tmp-${process.pid}`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, signed)
  try { await cf.putObject(account, `${DIR}/${channel}.json`, tmp, 'application/json') } finally { fs.rmSync(tmp, { force: true }) }
  const back = await fetch(`${manifestUrl(feed, channel)}?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) })
  const got = verifyRelease(await back.text(), { keys: OFFICE_RELEASE_KEYS, channel, feed })
  if (got.version !== version) throw new Error(`the feed answers ${got.version}, not ${version}`)
  console.log(`published: ${manifestUrl(feed, channel)} → ${version}`)
}

if (import.meta.main) {
  main().catch((e) => { console.error(`publish: ${(e as Error).message}`); process.exit(1) })
}
