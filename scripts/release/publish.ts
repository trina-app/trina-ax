// Publish an office release to this product's feed (RELEASE_CHANNEL, shared/src/release-channel.ts; docs/OFFICE.md
// "자동 업데이트"). On the owner's Mac. <dir> below is RELEASE_CHANNEL.officeDir.
//
//   bun scripts/release/publish.ts --channel beta|stable [--build] [--version X]
//       [--office dist/office/<officeBundle>-X-mac.zip]
//       [--windows desktop/release/<artifactBase>-Setup-Y-win-x64.exe]   (its latest.yml must be next to it)
//       [--min-from 0.2.0-0] [--notes "…" | --notes-file F] [--rollout staged|all] [--if-newer]
//       [--out DIR [--feed http://127.0.0.1:PORT]] [--dry-run]
//
// --rollout: staged (default) gives a stable release's manifest the staged roll-out (about 10% of the offices the first
// day, 50% the second, all from the third, server/src/system/rollout.ts); all, or the beta channel, has none.
//
// --build first builds both (bun run build:office with --version X; the Windows app with version X): otherwise the
// files are taken as given (default: dist/office/<officeBundle>-<version>-mac.zip and, when it exists,
// desktop/release/<artifactBase>-Setup-<version>-win-x64.exe; names from shared/src/product.ts). Then:
//   1. checks the files: the zip holds <officeBundle>-<version>/app/VERSION = version; latest.yml names the installer
//      with its sha512 and size
//   2. refuses to go back: the channel's current manifest (if any) must be older (the same version only re-uploads
//      identical files; --if-newer: a newer channel is left as it is, no error), and a file already published under
//      <dir>/<version>/ is never replaced by a different one (compared by content, not size)
//   3. uploads <dir>/<version>/<files> to the R2 bucket, then signs (~/.config/<keyDir>/release-key.pem) and uploads
//      the same signed manifest as <dir>/<version>/<channel>.json (kept for good: a server that runs this version
//      after the channel moved on still offers this version's Windows app, server/src/system/windows-app.ts; a re-run
//      keeps the first one when it names the same files) and <dir>/<channel>.json last, so the manifest never names a
//      file that is not there
//   4. reads the manifest back through the feed and verifies it like an office does
// --out DIR writes the feed into a folder instead (tests: a feed on this Mac, whose address --feed names, served to an
// install switched to it with `teamax update feed`); --dry-run checks and signs, uploads nothing.
// The API token (CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env) and the release key are never printed.
// The release workflow (.github/workflows/release.yml, docs/RELEASE-CI.md) runs it with the built files and
// TEAMAX_RELEASE_KEY / CLOUDFLARE_API_TOKEN from its secrets; nothing here asks anything.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions } from '../../server/src/system/update'
import { DEFAULT_FEED, fileUrl, manifestUrl, OFFICE_PRODUCT, OFFICE_RELEASE_KEYS, signRelease, verifyRelease, VERSION_RE, type Channel, type OfficeRelease, type ReleaseFile } from '../../server/src/office/release'
import { checkLatestYml } from '../../server/src/office/update'
import { newRollout, rampText } from '../../server/src/system/rollout'
import type { Bucket } from './cloudflare'
import { readReleaseKey } from './keygen'
import { compareRemote, feedReader, type RetryOptions } from './sign'
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

/** The manifest of a release: a stable one gets the staged roll-out unless `rollout` is 'all' (the tag message's
 * `Rollout: all`, docs/RELEASE-CI.md), a beta one none (server/src/system/rollout.ts newRollout). */
export function officeRelease(o: { channel: Channel; version: string; minFrom: string; notes: string; office: ReleaseFile; windows: OfficeRelease['windows']; rollout: 'staged' | 'all'; now?: Date; salt?: string }): OfficeRelease {
  const rollout = newRollout(o.channel, o.rollout, o.salt)
  return {
    format: 1, product: OFFICE_PRODUCT, channel: o.channel, version: o.version, minFrom: o.minFrom, publishedAt: (o.now ?? new Date()).toISOString(), notes: o.notes,
    office: [{ ...o.office, arch: 'universal' }], windows: o.windows, ...(rollout ? { rollout } : {}),
  }
}

/** <dir>/<version>/<channel>.json: this version's signed manifest on that channel, never replaced */
export const versionManifestKey = (version: string, channel: Channel) => `${DIR}/${version}/${channel}.json`

/** What to do with <dir>/<version>/<channel>.json: upload it when it is not there; keep an earlier one (a re-run) when it
 * verifies, is this version on this channel and names the same files; anything else stops the publish. */
export function versionManifestAction(existing: string | null, release: OfficeRelease, ctx: { keys: readonly string[]; feed: string }): 'upload' | 'keep' {
  if (existing === null) return 'upload'
  const key = versionManifestKey(release.version, release.channel)
  let prev: OfficeRelease
  try { prev = verifyRelease(existing, { keys: ctx.keys, channel: release.channel, feed: ctx.feed }) } catch (e) { throw new Error(`${key} is on the feed but does not verify (${(e as Error).message}): look at it by hand`) }
  const files = (r: OfficeRelease) => [...r.office, ...(r.windows ? [r.windows.installer, r.windows.latestYml] : [])].map((f) => `${f.file} ${f.sha256} ${f.size}`).sort().join('\n')
  const office = (r: OfficeRelease) => r.office.map((f) => `${f.file} ${f.sha256} ${f.size}`).sort().join('\n')
  if (prev.version !== release.version) throw new Error(`${key} is the manifest of ${prev.version}: look at it by hand`)
  if (files(prev) === files(release) && (prev.windows?.version ?? null) === (release.windows?.version ?? null)) return 'keep'
  // a re-run that adds the Windows installer to a release published without it: the same office files, more files
  if (!prev.windows && release.windows && office(prev) === office(release)) return 'upload'
  throw new Error(`${key} is already published with other files: publish a new version instead`)
}

export function describe(feed: string, version: string, file: string, type: string): Artifact {
  const name = path.basename(file)
  return { key: `${DIR}/${version}/${name}`, file, type, meta: { file: name, url: fileUrl(feed, version, name), sha256: sha256(file), size: fs.statSync(file).size } }
}

/** The files of `arts` the feed already holds with these exact bytes (not uploaded again). A file it holds with other
 * bytes stops the publish, never replaced: by content, because a rebuilt zip of the same version has the same size but
 * other bytes, and the manifest names the hash. */
export async function alreadyPublished(arts: Artifact[], read: Pick<ReturnType<typeof feedReader>, 'hash'>, o: RetryOptions = {}): Promise<Set<Artifact>> {
  const there = new Set<Artifact>()
  for (const a of arts) {
    const seen = await compareRemote(a.meta.url, () => read.hash(a.key), a.meta, o)
    if (seen === 'different') throw new Error(`${a.meta.url} is already published with other content: publish a new version instead`)
    if (seen === 'same') there.add(a)
  }
  return there
}

export interface OfficeFeedRun {
  feed: string
  release: OfficeRelease
  /** the signed manifest of `release` */
  signed: string
  arts: Artifact[]
  ifNewer: boolean
  dryRun: boolean
  keys: readonly string[]
  /** where the files go, and what a 404 from the feed is checked against; only a dry run may go without */
  bucket: Bucket | null
  fetch?: typeof fetch
  retry?: RetryOptions
  log?: (line: string) => void
}

const utf8 = (b: Uint8Array) => Buffer.from(b).toString('utf8')

/** Steps 2-4 at the top: everything that reads or writes the feed. Nothing goes up on a read that failed or a lone 404. */
export async function publishToFeed(o: OfficeFeedRun): Promise<'published' | 'head-stays' | 'dry-run'> {
  const { feed, release, signed, arts, keys, bucket } = o
  const { channel, version } = release
  const log = o.log ?? ((s: string) => console.log(s))
  if (!o.dryRun && !bucket) throw new Error('uploading needs the bucket: a 404 from the feed alone must not replace a published file')
  const read = feedReader(feed, { ...o.retry, fetch: o.fetch, holds: bucket?.holds })
  const headKey = `${DIR}/${channel}.json`

  // the channel never goes back, and a published file is never replaced by another one
  const cur = await read.bytes(headKey)
  // --if-newer on a channel that is ahead: its head stays, but this version's manifest on that channel still goes up
  // (a server of that channel that runs this version offers its Windows app from it)
  let headStays = false
  if (cur) {
    const prev = verifyRelease(utf8(cur), { keys, channel, feed })
    if (compareVersions(version, prev.version) < 0) {
      if (!o.ifNewer) throw new Error(`${channel} is at ${prev.version}; ${version} is older (the offices never go back)`)
      log(`${channel} is at ${prev.version}, newer than ${version}: its head is left as it is`)
      headStays = true
    } else log(`${channel} is at ${prev.version} now`)
  }
  const there = await alreadyPublished(arts, read, o.retry)
  // this version's manifest on this channel (kept for good; a re-run keeps the first one)
  const vkey = versionManifestKey(version, channel)
  const have = await read.bytes(vkey)
  const vaction = versionManifestAction(have ? utf8(have) : null, release, { keys, feed })
  if (vaction === 'keep') log(`= ${vkey} (already there, same files)`)
  if (o.dryRun || !bucket) { log('dry run: nothing uploaded'); return 'dry-run' }

  for (const a of arts) {
    if (there.has(a)) { log(`= ${a.key} (already there)`); continue }
    log(`↑ ${a.key}`)
    await bucket.put(a.key, a.file, a.type)
    const size = await read.size(a.key)
    if (size !== a.meta.size) throw new Error(`${a.meta.url} does not answer with the uploaded file (${size} bytes, not ${a.meta.size})`)
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-office-'))
  const tmp = path.join(tmpDir, `${channel}.json`)
  // a re-run (the version's manifest kept) puts that manifest at the head again, as first published: its publishedAt,
  // which the staged roll-out is measured from, and its salt stay (server/src/system/rollout.ts)
  fs.writeFileSync(tmp, vaction === 'keep' && have ? have : signed)
  try {
    if (vaction === 'upload') { log(`↑ ${vkey}`); await bucket.put(vkey, tmp, 'application/json') }
    if (headStays) return 'head-stays'
    await bucket.put(headKey, tmp, 'application/json')
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
  const got = verifyRelease(utf8(await read.back(headKey)), { keys, channel, feed })
  if (got.version !== version) throw new Error(`the feed answers ${got.version}, not ${version}`)
  log(`published: ${manifestUrl(feed, channel)} → ${version}`)
  return 'published'
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

  const rolloutMode = arg('--rollout') ?? 'staged'
  if (rolloutMode !== 'staged' && rolloutMode !== 'all') throw new Error('--rollout staged|all')
  const release = officeRelease({ channel, version, minFrom, notes, office: arts[0]!.meta, windows, rollout: rolloutMode })
  console.log(release.rollout ? `rollout: staged, ${rampText(release.rollout.ramp!)} (from publishedAt)` : 'rollout: none, every office at once')
  const signed = signRelease(release, readReleaseKey())
  verifyRelease(signed, { keys: OFFICE_RELEASE_KEYS, channel, feed }) // signed with the key this build trusts
  console.log(`release ${version} (${channel}, from ${minFrom}): ${arts.map((a) => `${a.meta.file} ${(a.meta.size / 1048576).toFixed(1)} MB`).join(', ')}`)

  if (out) {
    for (const a of arts) { fs.mkdirSync(path.join(out, path.dirname(a.key)), { recursive: true }); fs.copyFileSync(a.file, path.join(out, a.key)) }
    // a local feed (tests, QA): rebuilt files overwrite the old ones, so the version's manifest is written again too
    fs.writeFileSync(path.join(out, versionManifestKey(version, channel)), signed)
    fs.mkdirSync(path.join(out, DIR), { recursive: true })
    fs.writeFileSync(path.join(out, DIR, `${channel}.json`), signed)
    console.log(`written into ${out} (feed paths ${DIR}/…)`)
    return
  }

  const { openBucket } = await import('./cloudflare')
  // a dry run uploads nothing, so it may go without a token; it then asks nobody about a 404 (feedReader)
  const bucket = dry ? await openBucket().catch((e) => { console.log(`no bucket to ask (${(e as Error).message})`); return null }) : await openBucket()
  await publishToFeed({ feed, release, signed, arts, ifNewer: process.argv.includes('--if-newer'), dryRun: dry, keys: OFFICE_RELEASE_KEYS, bucket })
}

if (import.meta.main) {
  main().catch((e) => { console.error(`publish: ${(e as Error).message}`); process.exit(1) })
}
