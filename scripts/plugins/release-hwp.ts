// Release step for the HWP Preview plugin (docs/PLUGINS.md "릴리스에서 고정 digest를 더하는 방법"): build the four
// official packages from the pinned rhwp archives, pin them with their download addresses on the release feed in
// resources/plugins/catalog.json, and print how to upload them. It uploads nothing unless asked.
//
//   bun scripts/plugins/release-hwp.ts            download and check the pinned rhwp archives (resources/hwp/manifest.json),
//                                                 build dist/plugins/app.trina.hwp-preview/<version>/*.trinaplugin
//                                                 (unsigned, every target must be in resources/hwp/clearance.json), write
//                                                 the pins into the list, print the files, R2 keys and upload commands
//   bun scripts/plugins/release-hwp.ts --check    the same build; exit 1 unless the list already pins exactly these files
//   bun scripts/plugins/release-hwp.ts --upload   owner/operator: put the built files into the feed's R2 bucket (token as
//                                                 for scripts/release/publish.ts), then read each back through the feed
//                                                 and compare its SHA-256. Refused unless the list pins exactly these
//                                                 files and the feed's Worker already serves plugins/.
//
// The package bytes never go into resources/plugins or a default release bundle. Builds are deterministic (sorted tar,
// fixed headers, a fixed product floor), so the same commit gives the same files and pins; the archive SHA-256 also
// depends on the zlib in this Bun, so upload the files this run built (`--upload` refuses anything else).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import hwpPins from '../../resources/hwp/manifest.json'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { stageHwp, type HwpTarget } from '../hwp-bundle'
import { buildHwpPlugin, clearedTargets, HWP_PLUGIN_VERSION } from './build-hwp'
import { downloadKey, pinCatalog, type PinResult } from './pin-catalog'

const REPO = path.resolve(import.meta.dir, '../..')
const HWP_PLUGIN_ID = 'app.trina.hwp-preview'
export const HWP_TARGETS = Object.keys(hwpPins.targets).sort() as HwpTarget[]
/** Where servers download official packages: <feed>/plugins/<id>/<version>/<file> (scripts/release/worker.js). */
export const PLUGIN_FEED_BASE = `${RELEASE_CHANNEL.feed}/plugins`
const OUT = path.join(REPO, 'dist/plugins', HWP_PLUGIN_ID, HWP_PLUGIN_VERSION)
const CATALOG = path.join(REPO, 'resources/plugins/catalog.json')
const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

/** Build the four packages (unsigned) into `out`; every target must be cleared. */
export async function buildHwpRelease(o: { repo?: string; out?: string; provision?: boolean } = {}): Promise<{ file: string; bytes: Buffer }[]> {
  const repo = o.repo ?? REPO, out = o.out ?? OUT
  const missing = HWP_TARGETS.filter((t) => !clearedTargets(repo).includes(t))
  if (missing.length) throw new Error(`HWP redistribution is not cleared for ${missing.join(', ')} (resources/hwp/clearance.json)`)
  if (o.provision !== false) await stageHwp(repo, repo, HWP_TARGETS)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const files: { file: string; bytes: Buffer }[] = []
  for (const target of HWP_TARGETS) {
    const { bytes, fileName } = await buildHwpPlugin({ target, keyPem: null, repo, provision: false })
    const file = path.join(out, fileName)
    fs.writeFileSync(file, bytes)
    files.push({ file, bytes })
  }
  return files
}

/** The list with these files pinned and their feed addresses recorded. */
export function pinHwpRelease(catalogText: string, files: { file: string; bytes: Uint8Array }[], repo = REPO): PinResult {
  return pinCatalog(catalogText, files, { cleared: clearedTargets(repo), testKeyId: null, downloadBase: PLUGIN_FEED_BASE })
}

async function upload(files: { file: string; bytes: Buffer }[]) {
  const root = await fetch(`${RELEASE_CHANNEL.feed}/`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch((e) => `(${(e as Error).message})`)
  if (!root.includes('plugins/')) throw new Error(`${RELEASE_CHANNEL.feed}/ does not serve plugins/ yet (it says ${JSON.stringify(root.trim().slice(0, 60))}): deploy scripts/release/worker.js first with \`bun scripts/release/hosting.ts setup\``)
  const { Cloudflare } = await import('../release/cloudflare')
  const cf = new Cloudflare()
  const { account } = await cf.accountAndZone()
  for (const f of files) {
    const key = downloadKey(HWP_PLUGIN_ID, HWP_PLUGIN_VERSION, f.file)
    await cf.putObject(account, key, f.file, 'application/octet-stream')
    const back = new Uint8Array(await (await fetch(`${RELEASE_CHANNEL.feed}/${key}?t=${Date.now()}`, { signal: AbortSignal.timeout(120_000) })).arrayBuffer())
    if (sha256(back) !== sha256(f.bytes)) throw new Error(`${key}: the feed serves other bytes than were uploaded`)
    console.log(`uploaded and read back ${RELEASE_CHANNEL.feed}/${key}`)
  }
}

if (import.meta.main) {
  const check = process.argv.includes('--check'), up = process.argv.includes('--upload')
  const files = up
    ? HWP_TARGETS.map((t) => path.join(OUT, `${HWP_PLUGIN_ID}-${HWP_PLUGIN_VERSION}-${t}.trinaplugin`)).map((file) => ({ file, bytes: fs.readFileSync(file) }))
    : await buildHwpRelease()
  const r = pinHwpRelease(fs.readFileSync(CATALOG, 'utf8'), files)
  for (const p of r.pins) console.log(`${path.basename(p.file)}  ${p.pin.download!.size} bytes  sha256 ${p.pin.download!.sha256}  manifest ${p.pin.manifestSha256}`)
  if (check || up) {
    if (r.changed) { console.error('resources/plugins/catalog.json does not pin exactly these files (run without --check and commit the list)'); process.exit(1) }
    if (check) console.log('the official list pins exactly these files')
    if (up) await upload(files)
  } else {
    if (r.changed) { fs.writeFileSync(CATALOG, r.text); console.log(`wrote ${path.relative(REPO, CATALOG)}: review the pins like a key change and commit them`) }
    else console.log('the official list already pins these files')
    console.log(`\nPublish (owner/operator), after the release that ships this list is ready:
  1. the feed's Worker must serve plugins/ (once): bun scripts/release/hosting.ts setup
  2. upload and read back:                        bun scripts/plugins/release-hwp.ts --upload
     or by hand (bucket ${RELEASE_CHANNEL.hosting.bucket}, content type application/octet-stream, never overwrite with other bytes):`)
    for (const f of files) console.log(`       bunx wrangler r2 object put ${RELEASE_CHANNEL.hosting.bucket}/${downloadKey(HWP_PLUGIN_ID, HWP_PLUGIN_VERSION, f.file)} --file ${path.relative(REPO, f.file)} --content-type application/octet-stream --remote`)
    console.log(`  3. check: curl -sI ${PLUGIN_FEED_BASE}/${HWP_PLUGIN_ID}/${HWP_PLUGIN_VERSION}/${path.basename(files[0]!.file)}`)
  }
}
