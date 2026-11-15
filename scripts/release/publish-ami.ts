// Publish the new-team server image (the EC2 AMI's signed v2 manifest, scripts/image/ami-manifest-v2.sh) beside its
// release on this product's feed, so the control plane finds it by release version (docs/RELEASE-CI.md "새 팀 서버
// 이미지"). The Team image workflow (.github/workflows/team-image.yml) runs it after a stable release; the owner can too.
//
//   bun scripts/release/publish-ami.ts --version X --manifest dist/image/teamax-<templateVersion>.v2.ami.json
//       [--out FEED_DIR [--feed https://127.0.0.1:PORT] [--trust <public key>,…]] [--dry-run]
//
// On the feed (the Worker serves server/<version>/<file>; .json and .sig are never cached):
//   server/<version>/teamax-<templateVersion>.v2.ami.json (+ .sha256, .sig)   the manifest as ami-manifest-v2.sh wrote it
//   server/<version>/team-image.json   {"v":1,"templateVersion","manifest","sha256"}: the release's image, uploaded last.
//                                      Not signed: it only names the manifest, whose .sig the CP and hostd check.
// 1. the manifest is checked as hostd checks it: v2, kind ami, x86_64, its templateVersion is the file name's and starts
//    with the release version (<version>-d13-<yyyymmdd>), the .sha256 names its bytes and the .sig (base64 Ed25519 over
//    "ax-template-v1\n<templateVersion>\n<sha256 hex>") verifies with a key this product trusts
// 2. a file already on the feed is never replaced by a different one (the same bytes are left as they are); a release
//    that has a team-image.json for another template stops the run (one image per release)
// 3. uploads the three files, then team-image.json, and reads every one back through the feed
// The Cloudflare token: CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env (cloudflare.ts). No release key is needed:
// the manifest is signed by ami-manifest-v2.sh already.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { cloudflareStore, dirStore, type FeedStore } from './publish-server'
import { RELEASE_VERSION_RE } from './release-ci'
import { hashFile } from './sign'

/** the file name ami-manifest-v2.sh writes (the CP and hostd take only a URL ending in .ami.json) */
export const MANIFEST_NAME_RE = /^teamax-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-d13-\d{8})\.v2\.ami\.json$/
export const POINTER = 'team-image.json'

export interface TeamImage { v: 1; templateVersion: string; manifest: string; sha256: string }

/** Ed25519 over the template message with a raw base64 signature (build-ami.sh, ami-manifest-v2.sh; hostd checks it). */
export function verifyTemplateSig(templateVersion: string, sha256: string, sigBase64: string, keys: readonly string[]): boolean {
  const msg = Buffer.from(`ax-template-v1\n${templateVersion}\n${sha256}`)
  const sig = Buffer.from(sigBase64.trim(), 'base64')
  if (sig.length !== 64) return false
  return keys.some((k) => {
    const raw = Buffer.from(k, 'base64')
    if (raw.length !== 32) return false
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    return crypto.verify(null, msg, pub, sig)
  })
}

/** Everything checked before anything goes up; returns what team-image.json says. */
export function checkManifest(version: string, manifest: string, keys: readonly string[] = RELEASE_CHANNEL.keys): TeamImage {
  if (!RELEASE_VERSION_RE.test(version)) throw new Error(`--version ${version} is not a release version`)
  const name = path.basename(manifest)
  const m = MANIFEST_NAME_RE.exec(name)
  if (!m) throw new Error(`${name} is not a v2 AMI manifest name (teamax-<templateVersion>.v2.ami.json)`)
  const templateVersion = m[1]!
  if (!templateVersion.startsWith(`${version}-d13-`)) throw new Error(`${name} is template ${templateVersion}, not one of release ${version} (${version}-d13-<yyyymmdd>)`)
  const bytes = fs.readFileSync(manifest)
  let j: { v?: unknown; kind?: unknown; templateVersion?: unknown; architecture?: unknown; kitVersion?: unknown; images?: unknown }
  try { j = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${name} is not JSON`) }
  if (j.v !== 2 || j.kind !== 'ami' || j.architecture !== 'x86_64') throw new Error(`${name}: not a v2 x86_64 AMI manifest`)
  if (j.templateVersion !== templateVersion) throw new Error(`${name} says templateVersion ${String(j.templateVersion)}`)
  if (j.kitVersion !== version) throw new Error(`${name} has kit ${String(j.kitVersion)}, not ${version}`)
  const images = j.images as Record<string, { imageId?: unknown; rootSnapshotId?: unknown }> | undefined
  if (!images || typeof images !== 'object' || Object.keys(images).length === 0) throw new Error(`${name} names no image`)
  for (const [r, i] of Object.entries(images)) {
    if (typeof i?.imageId !== 'string' || !/^ami-[0-9a-f]+$/.test(i.imageId) || typeof i.rootSnapshotId !== 'string' || !/^snap-[0-9a-f]+$/.test(i.rootSnapshotId)) throw new Error(`${name}: region ${r} has no AMI and root snapshot`)
  }
  const sha256 = hashFile(manifest)
  const sums = fs.readFileSync(`${manifest}.sha256`, 'utf8').trim()
  if (sums !== `${sha256}  ${name}`) throw new Error(`${name}.sha256 does not name this file's bytes (sha256 ${sha256})`)
  if (!verifyTemplateSig(templateVersion, sha256, fs.readFileSync(`${manifest}.sig`, 'utf8'), keys)) throw new Error(`${name}.sig is not a signature of this product's release key over this manifest`)
  return { v: 1, templateVersion, manifest: name, sha256 }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

export interface PublishAmiResult { status: 'published' | 'there'; uploaded: string[]; image: TeamImage }

export async function publishAmi(o: { version: string; manifest: string; store: FeedStore; keys?: readonly string[]; dryRun?: boolean; log?: (l: string) => void }): Promise<PublishAmiResult> {
  const log = o.log ?? console.log
  const image = checkManifest(o.version, o.manifest, o.keys)
  const dir = `server/${o.version}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ami-'))
  try {
    const pointerFile = path.join(tmp, POINTER)
    fs.writeFileSync(pointerFile, JSON.stringify(image) + '\n')
    const files: [key: string, file: string, type: string][] = [
      [`${dir}/${image.manifest}`, o.manifest, 'application/json'],
      [`${dir}/${image.manifest}.sha256`, `${o.manifest}.sha256`, 'text/plain; charset=utf-8'],
      [`${dir}/${image.manifest}.sig`, `${o.manifest}.sig`, 'text/plain; charset=utf-8'],
      [`${dir}/${POINTER}`, pointerFile, 'application/json'],
    ]
    // one image per release: a pointer to another template stops the run before anything goes up
    const had = await o.store.get(`${dir}/${POINTER}`)
    if (had && !same(had, fs.readFileSync(pointerFile))) {
      throw new Error(`${dir}/${POINTER} names another image already (${Buffer.from(had).toString('utf8').trim()}): one image per release`)
    }
    const todo: typeof files = []
    for (const f of files) {
      const there = await o.store.get(f[0])
      if (there === null) todo.push(f)
      else if (!same(there, fs.readFileSync(f[1]))) throw new Error(`${f[0]} is on the feed with other bytes: it is never replaced`)
    }
    if (todo.length === 0) { log(`${dir}: image ${image.templateVersion} is on the feed already`); return { status: 'there', uploaded: [], image } }
    if (o.dryRun) { log(`dry run: would upload ${todo.map((f) => f[0]).join(', ')}`); return { status: 'published', uploaded: [], image } }
    // the pointer last: the CP never sees it before the manifest it names
    for (const [key, file, type] of todo) { await o.store.put(key, file, type); log(`uploaded ${key}`) }
    for (const [key, file] of files) {
      const back = await o.store.get(key)
      if (!back || !same(back, fs.readFileSync(file))) throw new Error(`${key}: the feed does not answer with the uploaded bytes`)
    }
    log(`${dir}: image ${image.templateVersion} published (${image.manifest}, sha256 ${image.sha256})`)
    return { status: 'published', uploaded: todo.map((f) => f[0]), image }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

export async function main(argv: string[]): Promise<PublishAmiResult> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const version = arg('--version'); const manifest = arg('--manifest'); const out = arg('--out')
  if (!version || !manifest) throw new Error('usage: publish-ami.ts --version X --manifest teamax-<templateVersion>.v2.ami.json [--out DIR [--feed URL] [--trust k,…]] [--dry-run]')
  const feed = arg('--feed') ?? RELEASE_CHANNEL.feed
  const store = out ? dirStore(out, feed) : await cloudflareStore(RELEASE_CHANNEL.feed)
  const trust = arg('--trust')
  return publishAmi({ version, manifest, store, keys: trust ? trust.split(',') : undefined, dryRun: argv.includes('--dry-run') })
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`publish-ami: ${(e as Error).message}`); process.exit(1) })
}
