// The Proxmox twin of the new-team AMI (scripts/image/snapshot-to-qcow2.ts) on the feed, beside the AMI manifest of its
// release, so the control plane installs it on its Proxmox hosts (trina-cloud src/fleet/template-sync.ts, FS-11).
//
//   bun scripts/release/publish-qcow2.ts manifest --version X --qcow2 dist/image/teamax-<tv>.qcow2 --snapshot <region>=snap-…
//       writes teamax-<tv>.qcow2.json from the qcow2, its .sha256 and its .sig (the workflow signed it before)
//   bun scripts/release/publish-qcow2.ts publish --version X --manifest dist/image/teamax-<tv>.qcow2.json
//       [--out FEED_DIR [--feed URL] [--trust <public key>,…]] [--dry-run]
//
// On the feed (server/<version>/, the Worker serves them; .json and .sig are never cached):
//   teamax-<tv>.qcow2 (+ .sha256, .sig)   the image; .sig = base64 Ed25519 of the release key over
//                                         "ax-template-v1\n<tv>\n<sha256 of the qcow2>" (what hostd installTemplate checks)
//   teamax-<tv>.qcow2.json                {"v":1,"kind":"qcow2","templateVersion","kitVersion","architecture":"x86_64",
//                                          "file","size","sha256","sig","source":{"region","snapshotId"},"builtAt"},
//                                         uploaded last. Its trust is the "sig" inside: it binds the version and the
//                                         image's sha256, so the json needs no signature of its own. The CP makes the URL
//                                         from the folder and "file" (never from a URL in the file).
// The template version is the AMI's (the same bytes), so team-image.json is not changed: the CP looks for
// teamax-<templateVersion>.qcow2.json itself. One qcow2 per template; a file on the feed is never replaced by other bytes.
import fs from 'node:fs'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { verifyTemplateSig } from './publish-ami'
import { cloudflareStore, dirStore, type FeedStore } from './publish-server'
import { RELEASE_VERSION_RE } from './release-ci'
import { hashFile } from './sign'

export const QCOW_RE = /^teamax-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-d13-\d{8})\.qcow2$/
export const qcowManifestName = (tv: string) => `teamax-${tv}.qcow2.json`

export interface QcowManifest {
  v: 1; kind: 'qcow2'; templateVersion: string; kitVersion: string; architecture: 'x86_64'
  file: string; size: number; sha256: string; sig: string
  source: { region: string; snapshotId: string }
  builtAt: string
}

/** the qcow2, its .sha256 and its .sig, checked as hostd checks them; the template version from the file name */
function checkImage(version: string, qcow2: string, keys: readonly string[]): { templateVersion: string; sha256: string; sig: string; size: number } {
  if (!RELEASE_VERSION_RE.test(version)) throw new Error(`--version ${version} is not a release version`)
  const name = path.basename(qcow2)
  const m = QCOW_RE.exec(name)
  if (!m) throw new Error(`${name} is not a template image name (teamax-<templateVersion>.qcow2)`)
  const templateVersion = m[1]!
  if (!templateVersion.startsWith(`${version}-d13-`)) throw new Error(`${name} is template ${templateVersion}, not one of release ${version}`)
  const sha256 = hashFile(qcow2)
  if (fs.readFileSync(`${qcow2}.sha256`, 'utf8').trim() !== `${sha256}  ${name}`) throw new Error(`${name}.sha256 does not name this file's bytes (sha256 ${sha256})`)
  const sig = fs.readFileSync(`${qcow2}.sig`, 'utf8').trim()
  if (!verifyTemplateSig(templateVersion, sha256, sig, keys)) throw new Error(`${name}.sig is not a signature of this product's release key over this image`)
  return { templateVersion, sha256, sig, size: fs.statSync(qcow2).size }
}

export function writeManifest(o: { version: string; qcow2: string; snapshot: string; keys?: readonly string[]; now?: Date }): string {
  const img = checkImage(o.version, o.qcow2, o.keys ?? RELEASE_CHANNEL.keys)
  const s = /^([a-z]{2}(?:-[a-z]+)+-\d)=(snap-[0-9a-f]+)$/.exec(o.snapshot)
  if (!s) throw new Error(`--snapshot ${o.snapshot} is not <region>=snap-…`)
  const m: QcowManifest = { v: 1, kind: 'qcow2', templateVersion: img.templateVersion, kitVersion: o.version, architecture: 'x86_64',
    file: path.basename(o.qcow2), size: img.size, sha256: img.sha256, sig: img.sig, source: { region: s[1]!, snapshotId: s[2]! },
    builtAt: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  const out = path.join(path.dirname(o.qcow2), qcowManifestName(img.templateVersion))
  fs.writeFileSync(out, JSON.stringify(m) + '\n')
  return out
}

/** the manifest and the image beside it, checked against each other */
export function checkQcowManifest(version: string, manifest: string, keys: readonly string[] = RELEASE_CHANNEL.keys): QcowManifest {
  const name = path.basename(manifest)
  let j: Partial<QcowManifest>
  try { j = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch { throw new Error(`${name} is not JSON`) }
  if (j.v !== 1 || j.kind !== 'qcow2' || j.architecture !== 'x86_64') throw new Error(`${name}: not a v1 x86_64 qcow2 manifest`)
  if (typeof j.templateVersion !== 'string' || name !== qcowManifestName(j.templateVersion)) throw new Error(`${name} says templateVersion ${String(j.templateVersion)}`)
  if (j.file !== `teamax-${j.templateVersion}.qcow2`) throw new Error(`${name} names file ${String(j.file)}`)
  if (j.kitVersion !== version) throw new Error(`${name} has kit ${String(j.kitVersion)}, not ${version}`)
  const img = checkImage(version, path.join(path.dirname(manifest), j.file), keys)
  if (img.templateVersion !== j.templateVersion || img.sha256 !== j.sha256 || img.sig !== j.sig || img.size !== j.size) throw new Error(`${name} does not describe ${j.file} (sha256, sig or size)`)
  return j as QcowManifest
}

export interface PublishQcowResult { status: 'published' | 'there'; uploaded: string[]; manifest: QcowManifest }

export async function publishQcow(o: { version: string; manifest: string; store: FeedStore & { putLarge?: FeedStore['put'] }; keys?: readonly string[]; dryRun?: boolean; log?: (l: string) => void }): Promise<PublishQcowResult> {
  const log = o.log ?? console.log
  const m = checkQcowManifest(o.version, o.manifest, o.keys)
  const dir = `server/${o.version}`
  const src = path.dirname(o.manifest)
  const qcow = path.join(src, m.file)
  const mkey = `${dir}/${qcowManifestName(m.templateVersion)}`
  // one qcow2 per template: a manifest of other bytes stops the run before anything goes up
  const had = await o.store.get(mkey)
  if (had) {
    let there: Partial<QcowManifest> = {}
    try { there = JSON.parse(Buffer.from(had).toString('utf8')) } catch { /* below */ }
    if (there.sha256 !== m.sha256) throw new Error(`${mkey} is on the feed for another image (sha256 ${String(there.sha256)}): one qcow2 per template`)
    log(`${mkey}: on the feed already`)
    return { status: 'there', uploaded: [], manifest: m }
  }
  const small: [key: string, file: string, type: string][] = [
    [`${dir}/${m.file}.sha256`, `${qcow}.sha256`, 'text/plain; charset=utf-8'],
    [`${dir}/${m.file}.sig`, `${qcow}.sig`, 'text/plain; charset=utf-8'],
  ]
  const todo: string[] = []
  // the image: an earlier run may have put it up before it stopped (stat reads it back through the feed: only then)
  const big = await o.store.stat(`${dir}/${m.file}`)
  if (big && (big.sha256 !== m.sha256 || big.size !== m.size)) throw new Error(`${dir}/${m.file} is on the feed with other bytes: it is never replaced`)
  if (!big) todo.push(`${dir}/${m.file}`)
  for (const [key, file] of small) {
    const there = await o.store.get(key)
    if (there === null) todo.push(key)
    else if (Buffer.compare(Buffer.from(there), fs.readFileSync(file)) !== 0) throw new Error(`${key} is on the feed with other bytes: it is never replaced`)
  }
  todo.push(mkey)
  if (o.dryRun) { log(`dry run: would upload ${todo.join(', ')}`); return { status: 'published', uploaded: [], manifest: m } }
  // the image first, the manifest last: the CP never sees a manifest before its image
  if (!big) { await (o.store.putLarge ?? o.store.put)(`${dir}/${m.file}`, qcow, 'application/octet-stream'); log(`uploaded ${dir}/${m.file}`) }
  for (const [key, file, type] of small) if (todo.includes(key)) { await o.store.put(key, file, type); log(`uploaded ${key}`) }
  const back = await o.store.stat(`${dir}/${m.file}`)
  if (!back || back.sha256 !== m.sha256) throw new Error(`${dir}/${m.file}: the feed does not answer with the uploaded bytes`)
  await o.store.put(mkey, o.manifest, 'application/json')
  const mb = await o.store.get(mkey)
  if (!mb || Buffer.compare(Buffer.from(mb), fs.readFileSync(o.manifest)) !== 0) throw new Error(`${mkey}: the feed does not answer with the uploaded bytes`)
  log(`${dir}: qcow2 ${m.templateVersion} published (${m.file}, ${m.size} bytes, sha256 ${m.sha256})`)
  return { status: 'published', uploaded: todo, manifest: m }
}

export async function main(argv: string[]): Promise<unknown> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const cmd = argv[0], version = arg('--version')
  const trust = arg('--trust')
  const keys = trust ? trust.split(',') : undefined
  if (cmd === 'manifest') {
    const qcow2 = arg('--qcow2'), snapshot = arg('--snapshot')
    if (!version || !qcow2 || !snapshot) throw new Error('usage: publish-qcow2.ts manifest --version X --qcow2 FILE --snapshot <region>=snap-…')
    const out = writeManifest({ version, qcow2, snapshot, keys })
    console.log(out)
    return out
  }
  if (cmd === 'publish') {
    const manifest = arg('--manifest'), out = arg('--out')
    if (!version || !manifest) throw new Error('usage: publish-qcow2.ts publish --version X --manifest teamax-<tv>.qcow2.json [--out DIR [--feed URL] [--trust k,…]] [--dry-run]')
    let store: FeedStore & { putLarge?: FeedStore['put'] }
    if (out) store = dirStore(out, arg('--feed') ?? RELEASE_CHANNEL.feed)
    else {
      const { putLarge, r2Target } = await import('./r2-s3')
      const s3 = await r2Target()
      store = { ...(await cloudflareStore(RELEASE_CHANNEL.feed)), putLarge: (key, file, type) => putLarge(s3, key, file, type) }
    }
    return publishQcow({ version, manifest, store, keys, dryRun: argv.includes('--dry-run') })
  }
  throw new Error('usage: publish-qcow2.ts manifest|publish …')
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`publish-qcow2: ${(e as Error).message}`); process.exit(1) })
}
