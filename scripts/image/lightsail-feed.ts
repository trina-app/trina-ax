// The Lightsail team image (trina-cloud docs/research/lightsail-paid-teams.md §6.2): the parts of
// scripts/image/build-lightsail.sh and the `lightsail` job of .github/workflows/team-image.yml that are not AWS CLI calls.
//
//   bun scripts/image/lightsail-feed.ts r2-put     --key K --file F          the stage into the release bucket (in parts)
//   bun scripts/image/lightsail-feed.ts r2-presign --key K --method GET|PUT [--expires 7200]
//                                                                             a presigned URL on stdout (never logged)
//   bun scripts/image/lightsail-feed.ts r2-get     --key K --out F           exit 3 when the object is not there
//   bun scripts/image/lightsail-feed.ts r2-delete  --key K
//   bun scripts/image/lightsail-feed.ts check      --version X --manifest F [--trust k,…]
//   bun scripts/image/lightsail-feed.ts publish    --version X --manifest F [--out DIR [--feed URL] [--trust k,…]] [--dry-run]
//   bun scripts/image/lightsail-feed.ts prune-select --snapshots F --instances F [--keep 5] [--min-age-days 14]
//                                                    [--protect-template T …] [--now ISO]
//
// R2: the build files go under ci/lightsail-build/ of the release bucket. The feed Worker serves only server/, office
// and plugins paths (scripts/release/worker.js), so nothing there is public; the job deletes them at the end. The S3
// credentials come from CLOUDFLARE_API_TOKEN (r2-s3.ts r2Target); a presigned URL is the only thing the builder gets.
//
// On the feed (server/<version>/, beside the AMI manifest; .json and .sig are never cached):
//   teamax-<tv>.lightsail.json (+ .sha256, .sig)   {"v":1,"kind":"lightsail","templateVersion","region","snapshotName",
//                                                  "fromBundleId","blueprintId","blueprintVersion","kitVersion","builtAt"}
//   .sig = base64 Ed25519 of the release key over "ax-template-v1\n<tv>\n<sha256 of the manifest file>", what hostd
//   installTemplate (lightsail driver) checks. team-image.json is not changed: the template version is the AMI's, and
//   the control plane looks for teamax-<templateVersion>.lightsail.json itself (as for the qcow2).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { verifyTemplateSig } from '../release/publish-ami'
import { cloudflareStore, dirStore, type FeedStore } from '../release/publish-server'
import { putLarge, type S3Target } from '../release/r2-s3'
import { RELEASE_VERSION_RE } from '../release/release-ci'
import { hashFile } from '../release/sign'
import { signV4, type AwsCreds } from '../release/sigv4'
import { selectPrune, type ImageFact, type InstanceFact } from './ami-prune-select'

export const LS_RE = /^teamax-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-d13-\d{8})\.lightsail\.json$/
export const lsManifestName = (tv: string) => `teamax-${tv}.lightsail.json`
/** the R2 prefix of the build files; never served by the feed Worker */
export const BUILD_PREFIX = 'ci/lightsail-build/'

export interface LsManifest {
  v: 1; kind: 'lightsail'; templateVersion: string; region: string; snapshotName: string; fromBundleId: string
  blueprintId: string; blueprintVersion: string; kitVersion: string; builtAt: string
}

// ---------------------------------------------------------------- R2 (S3 API)

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const hmac = (key: string | Buffer, s: string) => crypto.createHmac('sha256', key).update(s).digest()
const objectUrl = (t: Pick<S3Target, 'endpoint' | 'bucket'>, key: string) => `${t.endpoint}/${t.bucket}/${key.split('/').map(enc).join('/')}`

function checkKey(key: string): void {
  if (!key.startsWith(BUILD_PREFIX) || !/^[A-Za-z0-9._/-]+$/.test(key) || key.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`R2 key ${key} is not under ${BUILD_PREFIX}`)
  }
}

/** SigV4 query presign (S3 "Authenticating Requests: Using Query Parameters"); only the host header is signed */
export function presign(o: { method: 'GET' | 'PUT'; url: string; region: string; creds: AwsCreds; expires: number; now?: Date }): string {
  if (!Number.isInteger(o.expires) || o.expires < 1 || o.expires > 604800) throw new Error('presign: expires is 1 to 604800 seconds')
  const u = new URL(o.url)
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${o.region}/s3/aws4_request`
  const q: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.creds.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(o.expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  if (o.creds.sessionToken) q.push(['X-Amz-Security-Token', o.creds.sessionToken])
  const query = q.map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')
  const canonical = [o.method, u.pathname || '/', query, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n')
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.creds.secretAccessKey}`, day), o.region), 's3'), 'aws4_request')
  const sig = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex')
  return `${u.origin}${u.pathname}?${query}&X-Amz-Signature=${sig}`
}

async function s3(t: S3Target, method: 'GET' | 'DELETE', key: string): Promise<Response> {
  const url = objectUrl(t, key)
  return (t.fetch ?? fetch)(url, { method, headers: signV4({ method, url, region: 'auto', service: 's3', creds: t.creds }), signal: AbortSignal.timeout(120_000) })
}

export async function r2Get(t: S3Target, key: string): Promise<Buffer | null> {
  checkKey(key)
  const r = await s3(t, 'GET', key)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GET ${key}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

export async function r2Delete(t: S3Target, key: string): Promise<void> {
  checkKey(key)
  const r = await s3(t, 'DELETE', key)
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${key}: HTTP ${r.status}`)
}

// ---------------------------------------------------------------- the manifest

/** checked as hostd installTemplate checks it, plus what the release CI promises (the kit, the file name, the region) */
export function checkLsManifest(version: string, manifest: string, keys: readonly string[] = RELEASE_CHANNEL.keys): LsManifest & { sha256: string } {
  if (!RELEASE_VERSION_RE.test(version)) throw new Error(`--version ${version} is not a release version`)
  const name = path.basename(manifest)
  const m = LS_RE.exec(name)
  if (!m) throw new Error(`${name} is not a Lightsail manifest name (teamax-<templateVersion>.lightsail.json)`)
  const tv = m[1]!
  if (!tv.startsWith(`${version}-d13-`)) throw new Error(`${name} is template ${tv}, not one of release ${version}`)
  const bytes = fs.readFileSync(manifest)
  if (bytes.length > 64 * 1024) throw new Error(`${name} is larger than 64 KiB (hostd refuses it)`)
  let j: Partial<LsManifest>
  try { j = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${name} is not JSON`) }
  if (j.v !== 1 || j.kind !== 'lightsail') throw new Error(`${name}: not a v1 Lightsail manifest`)
  if (j.templateVersion !== tv) throw new Error(`${name} says templateVersion ${String(j.templateVersion)}`)
  if (j.kitVersion !== version) throw new Error(`${name} has kit ${String(j.kitVersion)}, not ${version}`)
  if (typeof j.region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(j.region)) throw new Error(`${name}: bad region ${String(j.region)}`)
  // the release CI names the snapshot teamax-<tv>; hostd accepts any name of this form, then reads its tags
  if (j.snapshotName !== `teamax-${tv}` || !/^[A-Za-z0-9._-]{1,255}$/.test(j.snapshotName)) throw new Error(`${name}: snapshotName ${String(j.snapshotName)} is not teamax-${tv}`)
  if (typeof j.fromBundleId !== 'string' || !/^[a-z0-9]+_\d+_\d+$/.test(j.fromBundleId)) throw new Error(`${name}: bad fromBundleId ${String(j.fromBundleId)}`)
  if (typeof j.blueprintId !== 'string' || !/^debian_13$/.test(j.blueprintId)) throw new Error(`${name}: blueprintId ${String(j.blueprintId)} is not debian_13`)
  for (const k of ['blueprintVersion', 'builtAt'] as const) if (typeof j[k] !== 'string' || !j[k]) throw new Error(`${name}: no ${k}`)
  const sha256 = hashFile(manifest)
  if (fs.readFileSync(`${manifest}.sha256`, 'utf8').trim() !== `${sha256}  ${name}`) throw new Error(`${name}.sha256 does not name this file's bytes (sha256 ${sha256})`)
  if (!verifyTemplateSig(tv, sha256, fs.readFileSync(`${manifest}.sig`, 'utf8'), keys)) throw new Error(`${name}.sig is not a signature of this product's release key over this manifest`)
  return { ...(j as LsManifest), sha256 }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

export interface PublishLsResult { status: 'published' | 'there'; uploaded: string[]; manifest: LsManifest & { sha256: string } }

/** the three files beside the AMI manifest; a file on the feed is never replaced by other bytes, the manifest goes last */
export async function publishLightsail(o: { version: string; manifest: string; store: FeedStore; keys?: readonly string[]; dryRun?: boolean; log?: (l: string) => void }): Promise<PublishLsResult> {
  const log = o.log ?? console.log
  const m = checkLsManifest(o.version, o.manifest, o.keys)
  const dir = `server/${o.version}`
  const name = path.basename(o.manifest)
  const files: [key: string, file: string, type: string][] = [
    [`${dir}/${name}.sha256`, `${o.manifest}.sha256`, 'text/plain; charset=utf-8'],
    [`${dir}/${name}.sig`, `${o.manifest}.sig`, 'text/plain; charset=utf-8'],
    [`${dir}/${name}`, o.manifest, 'application/json'],
  ]
  const todo: typeof files = []
  for (const f of files) {
    const there = await o.store.get(f[0])
    if (there === null) todo.push(f)
    else if (!same(there, fs.readFileSync(f[1]))) throw new Error(`${f[0]} is on the feed with other bytes: it is never replaced (one Lightsail image per template)`)
  }
  if (todo.length === 0) { log(`${dir}/${name}: on the feed already`); return { status: 'there', uploaded: [], manifest: m } }
  if (o.dryRun) { log(`dry run: would upload ${todo.map((f) => f[0]).join(', ')}`); return { status: 'published', uploaded: [], manifest: m } }
  for (const [key, file, type] of todo) { await o.store.put(key, file, type); log(`uploaded ${key}`) }
  for (const [key, file] of files) {
    const back = await o.store.get(key)
    if (!back || !same(back, fs.readFileSync(file))) throw new Error(`${key}: the feed does not answer with the uploaded bytes`)
  }
  log(`${dir}: Lightsail image ${m.templateVersion} published (${m.snapshotName} in ${m.region}, sha256 ${m.sha256})`)
  return { status: 'published', uploaded: todo.map((f) => f[0]), manifest: m }
}

// ---------------------------------------------------------------- prune (the rules of ami-prune-select.ts)

interface LsTag { key: string; value?: string }
interface LsSnapshot { name: string; createdAt?: string | number; state?: string; tags?: LsTag[] }
interface LsInstance { name: string; tags?: LsTag[] }

/** only CI images (ax:managed=image, ax:built-by=release-ci, name teamax-…) are candidates; any instance of any owner
 *  with an ax:template tag protects that template (hostd's replace path needs the image of a team's current template) */
export function selectLsPrune(o: { snapshots: LsSnapshot[]; instances: LsInstance[]; keepReleases: number; minAgeDays: number; protectTemplates: string[]; now: Date }) {
  const tagsOf = (t?: LsTag[]) => (t ?? []).map((x) => ({ Key: x.key, Value: x.value ?? '' }))
  const tagv = (t: LsTag[] | undefined, k: string) => t?.find((x) => x.key === k)?.value
  const ci = o.snapshots.filter((s) => tagv(s.tags, 'ax:managed') === 'image' && tagv(s.tags, 'ax:built-by') === 'release-ci' && /^teamax-/.test(s.name))
  const images: ImageFact[] = ci.map((s) => ({
    id: s.name, tags: tagsOf(s.tags), snaps: [],
    created: s.createdAt === undefined ? null : new Date(typeof s.createdAt === 'number' ? s.createdAt * 1000 : s.createdAt).toISOString(),
  }))
  const instances: InstanceFact[] = o.instances.map((i) => ({ id: i.name, image: null, template: tagv(i.tags, 'ax:template') ?? null }))
  return selectPrune({ images, launchTemplateImages: [], instances, volumes: [], keepReleases: o.keepReleases, minAgeDays: o.minAgeDays, protectTemplates: o.protectTemplates, now: o.now, idRe: /^teamax-[0-9A-Za-z.-]+$/ })
    .map((d) => (ci.find((s) => s.name === d.id)?.state === 'available' || d.action === 'keep' ? d : { ...d, action: 'keep' as const, reasons: ['not available'] }))
}

// ---------------------------------------------------------------- CLI

export async function main(argv: string[]): Promise<unknown> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const need = (n: string) => { const v = arg(n); if (!v) throw new Error(`${argv[0]}: ${n} is required`); return v }
  const keys = arg('--trust')?.split(',')
  const target = async () => (await import('../release/r2-s3')).r2Target()
  switch (argv[0]) {
    case 'r2-put': { const key = need('--key'); checkKey(key); await putLarge(await target(), key, need('--file'), 'application/octet-stream'); return key }
    case 'r2-presign': {
      const key = need('--key'); checkKey(key)
      const method = need('--method'); if (method !== 'GET' && method !== 'PUT') throw new Error('--method GET|PUT')
      const t = await target()
      const url = presign({ method, url: objectUrl(t, key), region: 'auto', creds: t.creds, expires: Number(arg('--expires') ?? 7200) })
      process.stdout.write(url + '\n')
      return url
    }
    case 'r2-get': {
      const b = await r2Get(await target(), need('--key'))
      if (!b) process.exit(3)
      fs.writeFileSync(need('--out'), b)
      return b.length
    }
    case 'r2-delete': await r2Delete(await target(), need('--key')); return null
    case 'check': { const m = checkLsManifest(need('--version'), need('--manifest'), keys); console.log(`ok: ${m.templateVersion} ${m.snapshotName} ${m.region} sha256 ${m.sha256}`); return m }
    case 'publish': {
      const out = arg('--out')
      const store = out ? dirStore(out, arg('--feed') ?? RELEASE_CHANNEL.feed) : await cloudflareStore(RELEASE_CHANNEL.feed)
      return publishLightsail({ version: need('--version'), manifest: need('--manifest'), store, keys, dryRun: argv.includes('--dry-run') })
    }
    case 'prune-select': {
      const read = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8') || '[]') as T
      const protect: string[] = []
      argv.forEach((a, i) => { if (a === '--protect-template' && argv[i + 1]) protect.push(argv[i + 1]!) })
      const keep = Number(arg('--keep') ?? 5), minAge = Number(arg('--min-age-days') ?? 14)
      if (!Number.isInteger(keep) || keep < 1 || !Number.isFinite(minAge) || minAge < 0) throw new Error('bad --keep or --min-age-days')
      const out = selectLsPrune({ snapshots: read(need('--snapshots')), instances: read(need('--instances')), keepReleases: keep, minAgeDays: minAge, protectTemplates: protect, now: arg('--now') ? new Date(arg('--now')!) : new Date() })
      for (const d of out) console.log([d.action, d.id, d.template || '-', d.action === 'keep' ? d.reasons.join('; ') : ''].join('\t'))
      return out
    }
  }
  throw new Error('usage: lightsail-feed.ts r2-put|r2-presign|r2-get|r2-delete|check|publish|prune-select …')
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`lightsail-feed: ${(e as Error).message}`); process.exit(1) })
}
