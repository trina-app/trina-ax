// Publish a Linux server release to this product's feed (RELEASE_CHANNEL, shared/src/release-channel.ts;
// docs/INSTALL-LINUX.md "업데이트", docs/RELEASE-CI.md). The release workflow runs it; the owner can too.
//
//   bun scripts/release/publish-server.ts --channel beta|stable --dir DIR [--version X] [--archs amd64,arm64]
//       [--min-from V] [--needs-root auto|yes|no] [--notes "…" | --notes-file F] [--if-newer] [--dry-run]
//       [--out FEED_DIR [--feed https://127.0.0.1:PORT] [--trust <public key>,…]]
//
// DIR holds the signed build of every arch (release-ci.ts sign-linux): <version>-linux-<arch>.tar.zst (what an
// installed server downloads) and <kit>-<version>-linux-<arch>.tar.gz (the install kit). On the feed:
//   server/<version>/<those files>                        never replaced by a different file
//   server/<version>/manifest-linux-<arch>.json (+ .sig)  the bundle's signed file list: the next release compares its
//                                                         root/ files with it (needsRoot)
//   server/<version>/release.json (+ .sig)                this version's ReleaseFeed (`mycel-ctl update --version`)
//   server/<channel>.json (+ .sig)                        the channel head: the same bytes, uploaded last
// 1. every bundle is checked like an installed server checks it (manifest signed with a key this build trusts, every
//    file as listed, mycel-ctl of that arch), and the kit must carry the same signed manifest and this product's feed
// 2. never back: the channel's head must not be newer (--if-newer: then do nothing); the same version only re-uploads
//    identical files, and a file already on the feed is never replaced by a different one (publish a new version)
// 3. uploads the version's files, its release.json, then the head
// 4. reads the head back through the feed exactly as UpdateManager.checkFeed does, and every bundle and kit URL must
//    answer with the published bytes
// needsRoot (auto): whether any root/ file (launcher, sandbox helper, units) or a program root keeps its own copy of
// (build-bundle.ts LINUX_ROOT_COPIES: mycel-safeops, pandoc) differs from the releases at the heads of both channels,
// compared through their manifest-linux-<arch>.json; unknown counts as "differs". Root releases are
// applied by the root update timer (`mycel-ctl update`), the others by the server itself.
// The release key: TEAMAX_RELEASE_KEY or ~/.config/<keyDir>/release-key.pem (keygen.ts); the Cloudflare token:
// CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env (cloudflare.ts). Neither is printed.
// --out writes the feed into a folder (tests; --feed names where it will be served, --trust the temporary keys it is
// signed for); --dry-run checks and signs, uploads nothing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { BundleManifest } from '../../shared/src/install'
import { ReleaseFeed as ProtocolReleaseFeed, releaseChannelPath, releaseManifestPath } from '../../shared/src/cloud-protocol/release'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { silentLogger } from '../../server/src/log'
import { readFileChunks, zstdDecompress } from '../../server/src/system/streams'
import { extractTar, readTar } from '../../server/src/system/tar'
import { bundleReaderLevel, compareVersions, ReleaseFeed, UpdateManager, verifyBundleDir } from '../../server/src/system/update'
import { elfArch, kitName, LINUX_ROOT_COPIES } from '../build-bundle'
import { RELEASE_VERSION_RE, type Channel } from './release-ci'
import { checkSigningKey, hashFile, remoteHash, signDetached, verifyDetached } from './sign'

export type LinuxArch = 'amd64' | 'arm64'
type RootFiles = Record<string, { sha256: string; size: number; mode: number }>
/** the files whose change needs root: root/, and the programs root keeps its own copy of for safe operations 1A */
export const rootManaged = (k: string) => k.startsWith('root/') || (LINUX_ROOT_COPIES as readonly string[]).includes(k)

const utf8 = (b: Uint8Array) => Buffer.from(b).toString('utf8')
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

/** Where the feed lives: a folder (--out, tests) or the R2 bucket behind the feed's Worker. */
export interface FeedStore {
  /** a small object's bytes, or null */
  get(key: string): Promise<Uint8Array | null>
  /** sha256 and size of an object, or null */
  stat(key: string): Promise<{ sha256: string; size: number } | null>
  put(key: string, file: string, contentType: string): Promise<void>
  /** fetch for <feed>/<key>, the way an installation reads the feed */
  fetch: typeof fetch
}

/** A feed in a folder; its fetch answers <feed>/<key> from the folder (GET and HEAD). */
export function dirStore(root: string, feed: string): FeedStore {
  const file = (key: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`bad feed key ${key}`)
    return path.join(root, key)
  }
  const fetchFromDir = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const base = feed.replace(/\/+$/, '') + '/'
    if (!url.startsWith(base)) return new Response('not on this feed\n', { status: 404 })
    let f: string
    try { f = file(decodeURIComponent(url.slice(base.length).split('?')[0]!)) } catch { return new Response('Not found\n', { status: 404 }) }
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('Not found\n', { status: 404 })
    const headers = { 'content-length': String(fs.statSync(f).size) }
    return new Response(init?.method === 'HEAD' ? null : Bun.file(f), { headers })
  }) as typeof fetch
  return {
    async get(key) { const f = file(key); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null },
    async stat(key) { const f = file(key); return fs.existsSync(f) ? { sha256: hashFile(f), size: fs.statSync(f).size } : null },
    async put(key, src) {
      const f = file(key)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const tmp = `${f}.tmp-${process.pid}`
      try { fs.copyFileSync(src, tmp); fs.renameSync(tmp, f) } finally { fs.rmSync(tmp, { force: true }) }
    },
    fetch: fetchFromDir,
  }
}

/** The real feed: reads through the feed's Worker (what installations see), writes into the R2 bucket. */
export async function cloudflareStore(feed: string): Promise<FeedStore> {
  // a Worker deployed before server/ was served answers 404 for every server/ path: stop before uploading anything
  const root = await fetch(`${feed}/`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch((e) => `(${(e as Error).message})`)
  if (!root.includes('server/')) throw new Error(`${feed}/ does not serve server/ yet (it says ${JSON.stringify(root.trim().slice(0, 60))}): deploy scripts/release/worker.js first with \`bun scripts/release/hosting.ts setup\``)
  const { Cloudflare } = await import('./cloudflare')
  const cf = new Cloudflare()
  const { account } = await cf.accountAndZone()
  const url = (key: string) => `${feed}/${key}?t=${Date.now()}`
  return {
    async get(key) {
      const r = await fetch(url(key), { signal: AbortSignal.timeout(30_000) })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${feed}/${key}: HTTP ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    },
    stat: (key) => remoteHash(url(key)),
    put: (key, file, type) => cf.putObject(account, key, file, type),
    fetch,
  }
}

const gunzip = (src: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => {
  const z = zlib.createGunzip()
  const input = Readable.from(src)
  input.on('error', (e) => z.destroy(e))
  return input.pipe(z) as unknown as AsyncIterable<Uint8Array>
}

export interface ServerBuild {
  arch: LinuxArch
  bundle: { file: string; name: string; sha256: string; size: number }
  kit: { file: string; name: string; sha256: string; size: number }
  manifest: Uint8Array
  manifestSig: Uint8Array
  root: RootFiles
  readerLevel: number
}

/** One arch's signed build in `dir`, checked: the update archive as an installed server checks it, the kit as the same
 * signed version folder with this product's feed. */
export async function checkBuild(dir: string, version: string, arch: LinuxArch, keys: readonly string[], productFeed: string = RELEASE_CHANNEL.feed): Promise<ServerBuild> {
  const bundleName = `${version}-linux-${arch}.tar.zst`
  const top = kitName(version, arch)
  const kitFileName = `${top}.tar.gz`
  const bundleFile = path.join(dir, bundleName), kitFile = path.join(dir, kitFileName)
  for (const f of [bundleFile, kitFile]) if (!fs.existsSync(f)) throw new Error(`${f} missing (release-ci.ts sign-linux makes it)`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-server-'))
  let manifest: Uint8Array, manifestSig: Uint8Array, root: RootFiles, readerLevel: number
  try {
    await extractTar(zstdDecompress(readFileChunks(bundleFile)), tmp)
    const m = await verifyBundleDir(tmp, { keys, allowUnsigned: false })
    if (m.version !== version) throw new Error(`${bundleName} holds version ${m.version}`)
    const ctl = path.join(tmp, 'root', 'mycel-ctl')
    if (!fs.existsSync(ctl) || elfArch(ctl) !== arch) throw new Error(`${bundleName}: root/mycel-ctl is not a linux-${arch} program`)
    manifest = new Uint8Array(fs.readFileSync(path.join(tmp, 'manifest.json')))
    manifestSig = new Uint8Array(fs.readFileSync(path.join(tmp, 'manifest.sig')))
    root = Object.fromEntries(Object.entries(m.files).filter(([k]) => rootManaged(k)))
    readerLevel = bundleReaderLevel(tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  const want = new Map<string, Uint8Array | null>([`${top}/VERSION`, `${top}/product.env`, `${top}/app/${version}/manifest.json`, `${top}/app/${version}/manifest.sig`].map((k) => [k, null]))
  await readTar(gunzip(readFileChunks(kitFile)), async (e, body) => {
    if (e.name !== top && !e.name.startsWith(top + '/')) throw new Error(`${kitFileName}: ${e.name} is outside ${top}/`)
    if (e.type !== 'file' || !want.has(e.name)) return
    if (e.size > 1 << 20) throw new Error(`${kitFileName}: ${e.name} is too large`)
    const parts: Uint8Array[] = []
    for await (const c of body) parts.push(c)
    want.set(e.name, new Uint8Array(Buffer.concat(parts)))
  })
  const got = (k: string) => want.get(`${top}/${k}`) ?? null
  if (utf8(got('VERSION') ?? new Uint8Array()).trim() !== version) throw new Error(`${kitFileName}: VERSION is not ${version}`)
  const feedLine = /^RELEASE_FEED=(.*)$/m.exec(utf8(got('product.env') ?? new Uint8Array()))?.[1]
  if (feedLine !== productFeed) throw new Error(`${kitFileName}: product.env names the feed ${JSON.stringify(feedLine ?? null)}, not this product's ${productFeed}`)
  if (!same(got(`app/${version}/manifest.json`), manifest) || !same(got(`app/${version}/manifest.sig`), manifestSig)) throw new Error(`${kitFileName} and ${bundleName} are not the same signed build`)
  return {
    arch,
    bundle: { file: bundleFile, name: bundleName, sha256: hashFile(bundleFile), size: fs.statSync(bundleFile).size },
    kit: { file: kitFile, name: kitFileName, sha256: hashFile(kitFile), size: fs.statSync(kitFile).size },
    manifest, manifestSig, root, readerLevel,
  }
}

interface Head { bytes: Uint8Array; sig: Uint8Array | null; feed: ReleaseFeed }

/** A channel head on the feed, verified; null when the channel has none yet. */
export async function readHead(store: FeedStore, channel: Channel, keys: readonly string[]): Promise<Head | null> {
  const key = releaseChannelPath(channel)
  const bytes = await store.get(key)
  if (!bytes) return null
  const sig = await store.get(key + '.sig')
  let feed: ReleaseFeed
  try { feed = ReleaseFeed.parse(JSON.parse(utf8(bytes))) } catch { throw new Error(`${key} on the feed is not a release feed: look at it by hand`) }
  let ok = !!sig && verifyDetached(bytes, utf8(sig), keys)
  if (!ok && RELEASE_VERSION_RE.test(feed.version)) {
    // a run that stopped between the head and its signature: the head is a copy of its version's release.json
    const rel = await store.get(releaseManifestPath(feed.version)), relSig = await store.get(releaseManifestPath(feed.version) + '.sig')
    ok = same(rel, bytes) && !!relSig && verifyDetached(bytes, utf8(relSig), keys)
  }
  if (!ok) throw new Error(`${key} on the feed does not verify with this product's release keys: look at it by hand`)
  return { bytes, sig, feed }
}

const sameRoot = (a: RootFiles, b: RootFiles) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k]!.sha256 === b[k]!.sha256 && a[k]!.size === b[k]!.size && a[k]!.mode === b[k]!.mode)
}

/** Do this release's root/ files differ from those of the given versions (the channel heads)? Unknown = yes. */
export async function rootChanged(store: FeedStore, keys: readonly string[], builds: ServerBuild[], versions: string[]): Promise<boolean> {
  if (!versions.length) return true // the first release of the feed: nothing to compare with
  for (const v of new Set(versions)) {
    for (const b of builds) {
      const key = `server/${v}/manifest-linux-${b.arch}.json`
      const m = await store.get(key), s = await store.get(key + '.sig')
      if (!m || !s || !verifyDetached(m, utf8(s), keys)) return true
      let prev: BundleManifest
      try { prev = BundleManifest.parse(JSON.parse(utf8(m))) } catch { return true }
      if (!sameRoot(Object.fromEntries(Object.entries(prev.files).filter(([k]) => rootManaged(k))), b.root)) return true
    }
  }
  return false
}

/** Read the channel head back through the feed exactly as an installed server does, and every file it names. */
export async function verifyFeed(o: { feed: string; channel: Channel; version: string; keys: readonly string[]; fetch: typeof fetch; builds: ServerBuild[] }): Promise<void> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-server-check-'))
  try {
    const um = new UpdateManager({ appDir: null, dataDir: data, version: '0.0.0', channel: o.channel, feedUrl: `${o.feed}/${releaseChannelPath(o.channel)}`, log: silentLogger, keys: o.keys, fetch: o.fetch })
    const f = await um.checkFeed()
    if (!f) {
      let why = 'unknown'
      try { why = (JSON.parse(fs.readFileSync(path.join(data, 'update-check.json'), 'utf8')) as { error: string }).error } catch {}
      throw new Error(`the feed's ${o.channel} head does not pass an installed server's check: ${why}`)
    }
    if (f.version !== o.version) throw new Error(`the feed's ${o.channel} head is ${f.version}, not ${o.version}`)
    for (const b of o.builds) {
      const e = f.bundles.find((x) => x.os === 'linux' && x.arch === b.arch)
      if (!e || e.sha256 !== b.bundle.sha256 || e.size !== b.bundle.size) throw new Error(`the ${o.channel} head does not name the linux-${b.arch} bundle that was published`)
      for (const [url, want] of [[e.url, b.bundle], [`${o.feed}/server/${o.version}/${b.kit.name}`, b.kit]] as const) {
        const got = await remoteHash(url, o.fetch)
        if (!got || got.sha256 !== want.sha256 || got.size !== want.size) throw new Error(`${url} does not answer with the published file`)
      }
    }
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
}

export interface PublishServerOptions {
  channel: Channel
  version: string
  dir: string
  archs: LinuxArch[]
  minFrom: string | null
  needsRoot: 'auto' | boolean
  notes: string
  /** do nothing (no error) when the channel is already at a newer version (a stable release offered to beta) */
  ifNewer?: boolean
  dryRun?: boolean
  /** https origin the feed is read from (RELEASE_CHANNEL.feed; a local address for --out) */
  feed: string
  /** the release keys installations trust (RELEASE_CHANNEL.keys; a temporary key in tests) */
  keys: readonly string[]
  /** the private key (PEM) */
  pem: string
  store: FeedStore
  /** the kits' product.env must name this feed (RELEASE_CHANNEL.feed) */
  productFeed?: string
  now?: () => Date
  log?: (s: string) => void
}

export interface PublishServerResult {
  status: 'published' | 'unchanged' | 'skipped' | 'dry-run'
  channel: Channel
  version: string
  /** what the channel was at before */
  previous: string | null
  needsRoot: boolean | null
  uploaded: string[]
}

export async function publishServer(o: PublishServerOptions): Promise<PublishServerResult> {
  const log = o.log ?? ((s: string) => console.log(s))
  if (o.channel !== 'stable' && o.channel !== 'beta') throw new Error('channel must be stable or beta')
  if (!RELEASE_VERSION_RE.test(o.version)) throw new Error(`version ${o.version} is not like 1.2.3 or 1.2.3-beta.1`)
  if (o.minFrom !== null && (!RELEASE_VERSION_RE.test(o.minFrom) || compareVersions(o.minFrom, o.version) > 0)) throw new Error(`--min-from ${o.minFrom} must be a version not newer than ${o.version}`)
  if (!o.archs.length || new Set(o.archs).size !== o.archs.length || o.archs.some((a) => a !== 'amd64' && a !== 'arm64')) throw new Error('archs: amd64 and/or arm64, each once')
  const feed = o.feed.replace(/\/+$/, '')
  const keyId = checkSigningKey(o.pem, o.keys)

  // 1. the builds
  const builds: ServerBuild[] = []
  for (const arch of o.archs) builds.push(await checkBuild(o.dir, o.version, arch, o.keys, o.productFeed))
  log(`linux ${o.version}: ${builds.map((b) => `${b.arch} (${(b.bundle.size / 1048576).toFixed(1)} MB update, ${(b.kit.size / 1048576).toFixed(1)} MB kit)`).join(', ')}; signed with key ${keyId}`)

  // 2. never back
  const head = await readHead(o.store, o.channel, o.keys)
  if (head && compareVersions(o.version, head.feed.version) < 0) {
    if (o.ifNewer) { log(`${o.channel} is at ${head.feed.version}, newer than ${o.version}: left as it is`); return { status: 'skipped', channel: o.channel, version: o.version, previous: head.feed.version, needsRoot: null, uploaded: [] } }
    throw new Error(`${o.channel} is at ${head.feed.version}; ${o.version} is older (servers never go back)`)
  }
  const bundles = builds.map((b) => ({ os: 'linux', arch: b.arch, url: `${feed}/server/${o.version}/${b.bundle.name}`, sha256: b.bundle.sha256, size: b.bundle.size }))

  // this version's release.json: as first published (a second run, or the other channel), or a new one
  const relKey = releaseManifestPath(o.version)
  let rel = await o.store.get(relKey)
  let relSig: string
  if (rel) {
    const s = await o.store.get(relKey + '.sig')
    if (!s || !verifyDetached(rel, utf8(s), o.keys)) throw new Error(`${relKey} is on the feed, but its signature is missing or does not verify: look at it by hand`)
    const prev = ReleaseFeed.parse(JSON.parse(utf8(rel)))
    const match = prev.version === o.version && prev.bundles.length === bundles.length && bundles.every((b) => prev.bundles.some((p) => p.os === b.os && p.arch === b.arch && p.url === b.url && p.sha256 === b.sha256 && p.size === b.size))
    if (!match) throw new Error(`${relKey} is already published with other files: publish a new version instead`)
    relSig = utf8(s)
    log(`${relKey} is already there (published ${prev.publishedAt}): kept as it is`)
  } else {
    let needsRoot = o.needsRoot
    if (needsRoot === 'auto') {
      // the releases the installations of either channel run now
      const other = await readHead(o.store, o.channel === 'stable' ? 'beta' : 'stable', o.keys).catch(() => undefined)
      needsRoot = other === undefined ? true : await rootChanged(o.store, o.keys, builds, [head, other].filter((h): h is Head => !!h).map((h) => h.feed.version))
    }
    const r = {
      version: o.version, minFrom: o.minFrom, urgent: false, needsRoot, notes: o.notes, publishedAt: (o.now?.() ?? new Date()).toISOString(), bundles,
      minReaderRequired: Math.max(...builds.map((b) => b.readerLevel)),
    }
    ReleaseFeed.parse(r)
    ProtocolReleaseFeed.parse(r)
    rel = new Uint8Array(Buffer.from(JSON.stringify(r, null, 1) + '\n'))
    relSig = signDetached(rel, o.pem)
  }
  const release = ReleaseFeed.parse(JSON.parse(utf8(rel)))
  if (!verifyDetached(rel, relSig, o.keys)) throw new Error('the signed release does not verify with the trusted keys') // never expected

  // 3. what goes up, in order: the files, the manifests, release.json, the head last
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-server-up-'))
  try {
    const small = (name: string, bytes: Uint8Array | string) => { const f = path.join(tmp, name); fs.writeFileSync(f, bytes); return f }
    type Up = { key: string; file: string; type: string }
    const ups: Up[] = []
    for (const b of builds) {
      ups.push({ key: `server/${o.version}/${b.bundle.name}`, file: b.bundle.file, type: 'application/zstd' })
      ups.push({ key: `server/${o.version}/${b.kit.name}`, file: b.kit.file, type: 'application/gzip' })
      ups.push({ key: `server/${o.version}/manifest-linux-${b.arch}.json`, file: small(`manifest-${b.arch}.json`, b.manifest), type: 'application/json' })
      ups.push({ key: `server/${o.version}/manifest-linux-${b.arch}.json.sig`, file: small(`manifest-${b.arch}.json.sig`, b.manifestSig), type: 'application/json' })
    }
    ups.push({ key: relKey, file: small('release.json', rel), type: 'application/json' })
    ups.push({ key: relKey + '.sig', file: small('release.json.sig', relSig), type: 'application/json' })
    const todo: Up[] = []
    for (const u of ups) {
      const have = await o.store.stat(u.key)
      if (!have) { todo.push(u); continue }
      if (have.sha256 !== hashFile(u.file) || have.size !== fs.statSync(u.file).size) throw new Error(`${u.key} is already published with other content: publish a new version instead`)
    }
    const headKey = releaseChannelPath(o.channel)
    const headDone = !!head && same(head.bytes, rel) && !!head.sig && utf8(head.sig) === relSig
    if (headDone && !todo.length) {
      log(`${o.channel} is already at ${o.version} with these files`)
      if (!o.dryRun) await verifyFeed({ feed, channel: o.channel, version: o.version, keys: o.keys, fetch: o.store.fetch, builds })
      return { status: o.dryRun ? 'dry-run' : 'unchanged', channel: o.channel, version: o.version, previous: head?.feed.version ?? null, needsRoot: release.needsRoot, uploaded: [] }
    }
    if (!headDone) {
      todo.push({ key: headKey, file: small('head.json', rel), type: 'application/json' })
      todo.push({ key: headKey + '.sig', file: small('head.json.sig', relSig), type: 'application/json' })
    }
    log(`${o.channel}: ${head?.feed.version ?? '(none)'} -> ${o.version}, needsRoot ${release.needsRoot}`)
    if (o.dryRun) { log(`dry run: would upload ${todo.map((u) => u.key).join(', ')}`); return { status: 'dry-run', channel: o.channel, version: o.version, previous: head?.feed.version ?? null, needsRoot: release.needsRoot, uploaded: [] } }
    for (const u of todo) { log(`↑ ${u.key}`); await o.store.put(u.key, u.file, u.type) }

    // 4. read back as an installation does
    await verifyFeed({ feed, channel: o.channel, version: o.version, keys: o.keys, fetch: o.store.fetch, builds })
    log(`published: ${feed}/${headKey} → ${o.version}`)
    return { status: 'published', channel: o.channel, version: o.version, previous: head?.feed.version ?? null, needsRoot: release.needsRoot, uploaded: todo.map((u) => u.key) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function args(argv: string[]) {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    if (i < 0) return undefined
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
    return v
  }
  return { val, has: (name: string) => argv.includes(name) }
}

export async function main(argv: string[]): Promise<PublishServerResult> {
  const { val, has } = args(argv)
  const channel = val('--channel') as Channel | undefined
  if (channel !== 'stable' && channel !== 'beta') throw new Error('--channel stable|beta is required')
  const dir = val('--dir')
  if (!dir) throw new Error('--dir DIR (the signed builds) is required')
  const { packageVersion } = await import('./release-ci')
  const version = val('--version') ?? packageVersion()
  const archs = (val('--archs') ?? 'amd64,arm64').split(',').map((s) => s.trim()) as LinuxArch[]
  const nr = val('--needs-root') ?? 'auto'
  if (!['auto', 'yes', 'no'].includes(nr)) throw new Error('--needs-root auto|yes|no')
  const notes = val('--notes-file') ? fs.readFileSync(val('--notes-file')!, 'utf8') : val('--notes') ?? ''
  const out = val('--out')
  const feed = val('--feed') ?? RELEASE_CHANNEL.feed
  if (feed !== RELEASE_CHANNEL.feed && (!out || !/^https?:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(feed))) throw new Error('--feed is only for --out with a feed on this computer (https://127.0.0.1:<port>)')
  const trust = val('--trust')
  if (trust && !out) throw new Error('--trust is only for --out (a local test feed)')
  const keys = trust ? trust.split(',').map((s) => s.trim()) : RELEASE_CHANNEL.keys
  const { readReleaseKey } = await import('./keygen')
  return publishServer({
    channel, version, dir: path.resolve(dir), archs, minFrom: val('--min-from') ?? null, needsRoot: nr === 'auto' ? 'auto' : nr === 'yes', notes,
    ifNewer: has('--if-newer'), dryRun: has('--dry-run'), feed, keys, pem: readReleaseKey(),
    store: out ? dirStore(path.resolve(out), feed) : await cloudflareStore(feed),
  })
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`publish-server: ${(e as Error).message}`); process.exit(1) })
}
