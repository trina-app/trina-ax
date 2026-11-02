// The Linux server feed (scripts/release/publish-server.ts, docs/RELEASE-CI.md): signing a CI build
// (release-ci.ts sign-linux), writing the feed, its rules (never back, never a different file, needsRoot), and end to
// end: a temporary key signs a kit, `publish-server --out` writes the feed, it is served over https on 127.0.0.1, and an
// installed server's UpdateManager (with the temporary key) checks it, downloads the bundle and stages it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReleaseFeed as ProtocolReleaseFeed } from '../../shared/src/cloud-protocol/release'
import { productEnv } from '../../shared/src/product'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { silentLogger } from '../../server/src/log'
import { writeManifest } from '../../server/src/system/bundle'
import { ReleaseFeed, UpdateManager, releaseNeedsRoot, verifyBundleDir, verifySignature } from '../../server/src/system/update'
import { kitName } from '../../scripts/build-bundle'
import { signLinuxBuild } from '../../scripts/release/release-ci'
import type { Bucket } from '../../scripts/release/cloudflare'
import { cloudflareStore, dirStore, publishServer, rootSinceOf, type LinuxArch, type PublishServerOptions } from '../../scripts/release/publish-server'
import { CONFIRM_READS, publicKeyOfPem } from '../../scripts/release/sign'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-server-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const newPem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const PEM = newPem()
const PUB = publicKeyOfPem(PEM)
const ARCHS: LinuxArch[] = ['amd64', 'arm64']
const read = (f: string) => fs.readFileSync(f, 'utf8')

/** the first bytes of a 64-bit little-endian ELF program of `arch` (what elfArch reads) */
function fakeElf(arch: LinuxArch, extra = ''): Buffer {
  const h = Buffer.alloc(64)
  h.writeUInt32BE(0x7f454c46, 0)
  h[4] = 2
  h[5] = 1
  h.writeUInt16LE(arch === 'amd64' ? 0x3e : 0xb7, 18)
  return Buffer.concat([h, Buffer.from(`fake mycel-ctl ${extra}`)])
}

/** An unsigned Linux build folder like `build-bundle.ts --os linux --out` leaves it (and the workflow's artifact holds). */
async function unsignedBuild(dir: string, version: string, arch: LinuxArch, o: { root?: string; feed?: string; server?: string; safeops?: string } = {}) {
  fs.rmSync(dir, { recursive: true, force: true })
  const app = path.join(dir, 'app', version)
  for (const d of ['root/systemd', 'bin', 'native', 'server/src', 'server/migrations']) fs.mkdirSync(path.join(app, d), { recursive: true })
  // the 1A program root keeps its own copy of (build-bundle.ts LINUX_ROOT_COPIES)
  fs.writeFileSync(path.join(app, 'native', 'mycel-safeops'), fakeElf(arch, `safeops ${o.safeops ?? ''}`), { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'root', 'mycel-ctl'), fakeElf(arch, o.root ?? ''), { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'root', 'systemd', 'server.service.in'), '[Service]\n', { mode: 0o644 })
  fs.writeFileSync(path.join(app, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'server', 'src', 'main.js'), `// server ${version} ${o.server ?? ''}\n`, { mode: 0o644 })
  fs.writeFileSync(path.join(app, 'server', 'migrations', '001_a.sql'), '-- min_compatible_reader: 2\n', { mode: 0o644 })
  for (const p of [app, ...['root', 'root/systemd', 'bin', 'native', 'server', 'server/src', 'server/migrations'].map((d) => path.join(app, d))]) fs.chmodSync(p, 0o755)
  await writeManifest(app, version)
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n')
  fs.writeFileSync(path.join(dir, 'product.env'), productEnv({ RELEASE_FEED: o.feed ?? RELEASE_CHANNEL.feed }))
  fs.writeFileSync(path.join(dir, 'install-linux.sh'), '#!/bin/sh\necho install\n', { mode: 0o755 })
}

/** Both archs signed (release-ci.ts sign-linux) into one folder, as the publish job has them. */
async function signedBuilds(name: string, version: string, o: { root?: string; feed?: string; server?: string; safeops?: string; pem?: string } = {}) {
  const out = path.join(T, name, 'server')
  fs.mkdirSync(out, { recursive: true })
  for (const arch of ARCHS) {
    const dir = path.join(T, name, `linux-${arch}`)
    await unsignedBuild(dir, version, arch, o)
    const r = await signLinuxBuild({ dir, arch, pem: o.pem ?? PEM, keys: [PUB] })
    expect(r.keyId).toMatch(/^[0-9a-f]{16}$/)
    for (const f of [r.archive, r.kit]) fs.renameSync(f, path.join(out, path.basename(f)))
  }
  return out
}

const FEED = 'https://127.0.0.1:45999'
function opts(dir: string, feedDir: string, over: Partial<PublishServerOptions> = {}): PublishServerOptions {
  return {
    channel: 'beta', version: '0.3.0', dir, archs: ARCHS, minFrom: null, needsRoot: 'auto', notes: 'n', feed: FEED, keys: [PUB], pem: PEM,
    store: dirStore(feedDir, FEED), log: () => {}, retry: { wait: async () => {}, log: () => {} }, ...over,
  }
}

describe('sign-linux (release-ci.ts)', () => {
  test('signs the version folder, packs the update archive and the kit; the wrong arch or key is refused', async () => {
    const dir = path.join(T, 'sign', 'linux-amd64')
    await unsignedBuild(dir, '0.3.0', 'amd64')
    await expect(signLinuxBuild({ dir, arch: 'arm64', pem: PEM, keys: [PUB] })).rejects.toThrow(/not a linux-arm64 program/)
    await expect(signLinuxBuild({ dir, arch: 'amd64', pem: newPem(), keys: [PUB] })).rejects.toThrow(/not one of this product's release keys/)
    expect(fs.existsSync(path.join(dir, 'app', '0.3.0', 'manifest.sig'))).toBe(false)
    const r = await signLinuxBuild({ dir, arch: 'amd64', pem: PEM, keys: [PUB] })
    expect(path.basename(r.archive)).toBe('0.3.0-linux-amd64.tar.zst')
    expect(path.basename(r.kit)).toBe(`${kitName('0.3.0', 'amd64')}.tar.gz`)
    await expect(verifyBundleDir(path.join(dir, 'app', '0.3.0'), { keys: [PUB], allowUnsigned: false })).resolves.toMatchObject({ version: '0.3.0' })
    // a file changed after the build (a broken artifact) fails the signing, it is not signed over
    fs.appendFileSync(path.join(dir, 'app', '0.3.0', 'server', 'src', 'main.js'), 'evil\n')
    await expect(signLinuxBuild({ dir, arch: 'amd64', pem: PEM, keys: [PUB] })).rejects.toThrow(/changed since release/)
  })
})

describe('publish-server', () => {
  let b030: string
  beforeAll(async () => { b030 = await signedBuilds('b030', '0.3.0') })

  test('writes the version files, release.json and the head; a second run changes nothing', async () => {
    const feed = path.join(T, 'feed-a')
    const r = await publishServer(opts(b030, feed))
    expect(r).toMatchObject({ status: 'published', channel: 'beta', version: '0.3.0', previous: null, needsRoot: true })
    for (const a of ARCHS) {
      for (const f of [`0.3.0-linux-${a}.tar.zst`, `${kitName('0.3.0', a)}.tar.gz`, `manifest-linux-${a}.json`, `manifest-linux-${a}.json.sig`]) expect(fs.existsSync(path.join(feed, 'server', '0.3.0', f)), f).toBe(true)
    }
    const head = fs.readFileSync(path.join(feed, 'server', 'beta.json'))
    expect(head.equals(fs.readFileSync(path.join(feed, 'server', '0.3.0', 'release.json')))).toBe(true)
    expect(verifySignature(head, read(path.join(feed, 'server', 'beta.json.sig')), [PUB])).toBe(true)
    const rel = ReleaseFeed.parse(JSON.parse(head.toString()))
    expect(ProtocolReleaseFeed.parse(JSON.parse(head.toString()))).toBeTruthy()
    expect(rel).toMatchObject({ version: '0.3.0', minFrom: null, needsRoot: true, notes: 'n' })
    expect(JSON.parse(head.toString()).minReaderRequired).toBe(2)
    expect(rel.bundles.map((b) => [b.os, b.arch, b.url])).toEqual(ARCHS.map((a) => ['linux', a, `${FEED}/server/0.3.0/0.3.0-linux-${a}.tar.zst`]))
    expect(fs.existsSync(path.join(feed, 'server', 'stable.json'))).toBe(false)
    const again = await publishServer(opts(b030, feed))
    expect(again).toMatchObject({ status: 'unchanged', uploaded: [] })
  })

  test('never back; --if-newer leaves a newer channel alone', async () => {
    const feed = path.join(T, 'feed-b')
    const b031 = await signedBuilds('b031', '0.3.1')
    await publishServer(opts(b031, feed, { version: '0.3.1' }))
    await expect(publishServer(opts(b030, feed))).rejects.toThrow(/beta is at 0\.3\.1; 0\.3\.0 is older/)
    expect(await publishServer(opts(b030, feed, { ifNewer: true }))).toMatchObject({ status: 'skipped', previous: '0.3.1' })
    expect(fs.existsSync(path.join(feed, 'server', '0.3.0'))).toBe(false)
    expect(ReleaseFeed.parse(JSON.parse(read(path.join(feed, 'server', 'beta.json')))).version).toBe('0.3.1')
  })

  test('a file already on the feed is never replaced by a different one (a rebuild of the same version)', async () => {
    const feed = path.join(T, 'feed-c')
    await publishServer(opts(b030, feed))
    const before = fs.readFileSync(path.join(feed, 'server', '0.3.0', '0.3.0-linux-amd64.tar.zst'))
    const rebuilt = await signedBuilds('b030-rebuilt', '0.3.0', { server: 'rebuilt' })
    await expect(publishServer(opts(rebuilt, feed))).rejects.toThrow(/already published with other files: publish a new version instead/)
    // the same with release.json gone (a run that stopped before it): the files themselves are compared
    fs.rmSync(path.join(feed, 'server', '0.3.0', 'release.json'))
    fs.rmSync(path.join(feed, 'server', '0.3.0', 'release.json.sig'))
    await expect(publishServer(opts(rebuilt, feed, { channel: 'stable' }))).rejects.toThrow(/already published with other content/)
    expect(fs.readFileSync(path.join(feed, 'server', '0.3.0', '0.3.0-linux-amd64.tar.zst')).equals(before)).toBe(true)
    expect(fs.existsSync(path.join(feed, 'server', 'stable.json'))).toBe(false)
  })

  test('the same version for the other channel reuses release.json as first published', async () => {
    const feed = path.join(T, 'feed-d')
    await publishServer(opts(b030, feed, { channel: 'stable', notes: 'first' }))
    const rel = fs.readFileSync(path.join(feed, 'server', '0.3.0', 'release.json'))
    const r = await publishServer(opts(b030, feed, { channel: 'beta', notes: 'second', ifNewer: true }))
    expect(r.status).toBe('published')
    expect(r.uploaded).toEqual(['server/beta.json', 'server/beta.json.sig'])
    expect(fs.readFileSync(path.join(feed, 'server', 'beta.json')).equals(rel)).toBe(true)
  })

  // rootChanged is what needsRoot was before the rule for 0.2.18 and older (below): a rootSince newer than 0.2.18 keeps
  // needsRoot true for them, so these releases (0.3.x) all have it
  test('root files changed: no when no root/ file changed since the heads of both channels, yes when one did', async () => {
    const feed = path.join(T, 'feed-e')
    await publishServer(opts(b030, feed, { channel: 'stable' }))
    const same = await signedBuilds('b031-same', '0.3.1', { server: 'new app' })
    expect(await publishServer(opts(same, feed, { channel: 'stable', version: '0.3.1' }))).toMatchObject({ rootChanged: false, needsRoot: true, rootSince: '0.3.0' })
    const changed = await signedBuilds('b032-root', '0.3.2', { root: 'new launcher' })
    expect(await publishServer(opts(changed, feed, { channel: 'stable', version: '0.3.2' }))).toMatchObject({ rootChanged: true, needsRoot: true, rootSince: '0.3.2' })
    // beta at 0.3.2 (root changed there), stable at 0.3.1: 0.3.3 with 0.3.2's root still changes stable's root
    await publishServer(opts(changed, feed, { channel: 'beta', version: '0.3.2' }))
    const f2 = path.join(T, 'feed-e2')
    await publishServer(opts(b030, f2, { channel: 'stable' }))
    await publishServer(opts(changed, f2, { channel: 'beta', version: '0.3.2' }))
    const b033 = await signedBuilds('b033', '0.3.3', { root: 'new launcher', server: '0.3.3' })
    expect((await publishServer(opts(b033, f2, { channel: 'beta', version: '0.3.3' }))).rootChanged).toBe(true)
    // forced: `--needs-root no` turns the rule for 0.2.18 and older off too (it says so)
    const b034 = await signedBuilds('b034', '0.3.4', { root: 'new launcher', server: '0.3.4' })
    const lines: string[] = []
    expect(await publishServer(opts(b034, f2, { channel: 'beta', version: '0.3.4', needsRoot: false, log: (l) => lines.push(l) }))).toMatchObject({ rootChanged: false, needsRoot: false, rootSince: '0.3.3' })
    expect(lines.join('\n')).toContain('warning: --needs-root no: a server on 0.2.18 or older')
    // only a program root keeps its own copy of (safe operations 1A) changed: root must install it, the app cannot
    const f3 = path.join(T, 'feed-e3')
    await publishServer(opts(b030, f3, { channel: 'stable' }))
    const safeops = await signedBuilds('b031-safeops', '0.3.1', { server: 'new app', safeops: 'new' })
    expect((await publishServer(opts(safeops, f3, { channel: 'stable', version: '0.3.1' }))).rootChanged).toBe(true)
  }, 60_000)

  test('rootSince: the oldest release with these root files, so a server that skipped a root release still gets it (update audit P4)', async () => {
    const feed = path.join(T, 'feed-rs')
    expect(await publishServer(opts(b030, feed, { channel: 'stable' }))).toMatchObject({ needsRoot: true, rootSince: '0.3.0' })
    const a031 = await signedBuilds('rs-031', '0.3.1', { server: 'new app' })
    expect(await publishServer(opts(a031, feed, { channel: 'stable', version: '0.3.1' }))).toMatchObject({ rootChanged: false, rootSince: '0.3.0' })
    const a032 = await signedBuilds('rs-032', '0.3.2', { server: 'newer app' })
    expect(await publishServer(opts(a032, feed, { channel: 'stable', version: '0.3.2' }))).toMatchObject({ rootChanged: false, rootSince: '0.3.0' })
    const r033 = await signedBuilds('rs-033', '0.3.3', { root: 'new launcher' })
    expect(await publishServer(opts(r033, feed, { channel: 'stable', version: '0.3.3' }))).toMatchObject({ rootChanged: true, needsRoot: true, rootSince: '0.3.3' })
    const a034 = await signedBuilds('rs-034', '0.3.4', { root: 'new launcher', server: '0.3.4' })
    expect(await publishServer(opts(a034, feed, { channel: 'stable', version: '0.3.4' }))).toMatchObject({ rootChanged: false, needsRoot: true, rootSince: '0.3.3' })
    // the signed release.json carries it for both readers, and a server that skipped 0.3.3 needs root for 0.3.4
    const rel = ReleaseFeed.parse(JSON.parse(fs.readFileSync(path.join(feed, 'server', '0.3.4', 'release.json'), 'utf8')))
    expect(rel).toMatchObject({ needsRoot: true, rootSince: '0.3.3' })
    expect(ProtocolReleaseFeed.parse(rel).rootSince).toBe('0.3.3')
    expect(releaseNeedsRoot(rel, '0.3.2')).toBe(true)
    expect(releaseNeedsRoot(rel, '0.3.3')).toBe(false)
  })

  // 0.2.19 review S3: servers on 0.2.14-0.2.18 ignore rootSince and take a release by itself when needsRoot is false
  // (v0.2.18 server/src/system/update-job.ts and mycel-ctl read only needsRoot). An app-only 0.2.20 with needsRoot false
  // would put the 0.2.20 app on a 0.2.18 server's root files, which then refuses every later release. So needsRoot
  // stays true while rootSince is newer than 0.2.18; servers of 0.2.19 and later decide by rootSince alone.
  test('needsRoot stays true for servers on 0.2.18 or older while rootSince is newer (0.2.19 review S3)', async () => {
    const feed = path.join(T, 'feed-s3')
    const b0218 = await signedBuilds('s3-0218', '0.2.18')
    await publishServer(opts(b0218, feed, { channel: 'stable', version: '0.2.18' }))
    const b0219 = await signedBuilds('s3-0219', '0.2.19', { root: 'launcher 0.2.19' })
    expect(await publishServer(opts(b0219, feed, { channel: 'stable', version: '0.2.19' }))).toMatchObject({ rootChanged: true, needsRoot: true, rootSince: '0.2.19' })
    const lines: string[] = []
    const a0220 = await signedBuilds('s3-0220', '0.2.20', { root: 'launcher 0.2.19', server: 'app 0.2.20' })
    expect(await publishServer(opts(a0220, feed, { channel: 'stable', version: '0.2.20', log: (l) => lines.push(l) }))).toMatchObject({ rootChanged: false, needsRoot: true, rootSince: '0.2.19' })
    expect(lines.join('\n')).toContain('needsRoot true for servers on 0.2.18 or older (they ignore rootSince 0.2.19)')
    const rel = ReleaseFeed.parse(JSON.parse(fs.readFileSync(path.join(feed, 'server', '0.2.20', 'release.json'), 'utf8')))
    // a 0.2.18 server reads needsRoot: it refuses the release, and its root timer installs root files and app together
    expect(rel.needsRoot).toBe(true)
    // a 0.2.19 server with 0.2.19's root files takes it by itself (Update now, its own updater); one with older root files does not
    expect(releaseNeedsRoot(rel, '0.2.19')).toBe(false)
    expect(releaseNeedsRoot(rel, '0.2.18')).toBe(true)
    expect(releaseNeedsRoot(rel, null)).toBe(true)
  })

  test('rootSinceOf: heads from before rootSince, two channels, a forced needsRoot', () => {
    expect(rootSinceOf('0.2.19', true, [{ version: '0.2.18', needsRoot: false, rootSince: '0.2.10' }])).toBe('0.2.19')
    expect(rootSinceOf('0.2.19', false, [])).toBe('0.2.19')
    // every release from 0.2.4 to 0.2.18 needed root: a head without rootSince is its own
    expect(rootSinceOf('0.2.19', false, [{ version: '0.2.18', needsRoot: true }])).toBe('0.2.18')
    // a head that did not need root and has no rootSince: unknown, so this version (later than the truth is safe)
    expect(rootSinceOf('0.2.19', false, [{ version: '0.2.18', needsRoot: false }])).toBe('0.2.19')
    // both heads share the root files: the newer of their rootSince
    expect(rootSinceOf('0.2.19', false, [{ version: '0.2.18', needsRoot: false, rootSince: '0.2.16' }, { version: '0.2.19-beta.1', needsRoot: true }])).toBe('0.2.19-beta.1')
  })

  test('a head cut off before its signature (a stopped run) is recognised; a changed head is not', async () => {
    const feed = path.join(T, 'feed-f')
    await publishServer(opts(b030, feed))
    fs.writeFileSync(path.join(feed, 'server', 'beta.json.sig'), '{"keyId":"0000000000000000","sig":"AAAA"}\n')
    const r = await publishServer(opts(b030, feed))
    expect(r.uploaded).toEqual(['server/beta.json', 'server/beta.json.sig'])
    expect(verifySignature(fs.readFileSync(path.join(feed, 'server', 'beta.json')), read(path.join(feed, 'server', 'beta.json.sig')), [PUB])).toBe(true)
    fs.writeFileSync(path.join(feed, 'server', 'beta.json'), read(path.join(feed, 'server', 'beta.json')).replace('"notes": "n"', '"notes": "x"'))
    await expect(publishServer(opts(b030, feed))).rejects.toThrow(/does not verify with this product's release keys/)
  })

  test('refused before anything is written: a key that is not trusted, a bundle signed by another key, a kit of another feed, a missing arch', async () => {
    const feed = path.join(T, 'feed-g')
    await expect(publishServer(opts(b030, feed, { pem: newPem() }))).rejects.toThrow(/not one of this product's release keys/)
    const other = newPem()
    const foreign = path.join(T, 'foreign', 'server')
    fs.mkdirSync(foreign, { recursive: true })
    for (const arch of ARCHS) {
      const dir = path.join(T, 'foreign', `linux-${arch}`)
      await unsignedBuild(dir, '0.3.0', arch)
      const r = await signLinuxBuild({ dir, arch, pem: other, keys: [publicKeyOfPem(other)] })
      for (const f of [r.archive, r.kit]) fs.renameSync(f, path.join(foreign, path.basename(f)))
    }
    await expect(publishServer(opts(foreign, feed))).rejects.toThrow(/signature does not verify/)
    const elsewhere = await signedBuilds('elsewhere', '0.3.0', { feed: 'https://updates.example.com' })
    await expect(publishServer(opts(elsewhere, feed))).rejects.toThrow(/names the feed "https:\/\/updates\.example\.com", not this product's/)
    const partial = path.join(T, 'partial')
    fs.cpSync(b030, partial, { recursive: true })
    fs.rmSync(path.join(partial, '0.3.0-linux-arm64.tar.zst'))
    await expect(publishServer(opts(partial, feed))).rejects.toThrow(/0\.3\.0-linux-arm64\.tar\.zst missing/)
    await expect(publishServer(opts(b030, feed, { version: '0.3.1' }))).rejects.toThrow(/missing/)
    await expect(publishServer(opts(b030, feed, { minFrom: '0.4.0' }))).rejects.toThrow(/min-from/)
    expect(fs.existsSync(feed)).toBe(false)
  })

  test('--dry-run checks and signs, writes nothing', async () => {
    const feed = path.join(T, 'feed-h')
    expect((await publishServer(opts(b030, feed, { dryRun: true }))).status).toBe('dry-run')
    expect(fs.existsSync(feed)).toBe(false)
  })
})

describe('a publish that fails half way, a wrong read', () => {
  type Fault = number | 'neterror' | 'short' | 'wrong' | (() => Response)

  /**
   * The real store (cloudflareStore) over a feed in a folder. Reads go through its fetch, where a key's faults answer them
   * one by one, and a 404 is checked against the folder as the bucket: so the store's own `get` and `stat` can be misled
   * the way the feed can mislead them, and nothing is skipped by replacing them.
   */
  async function watched(feedDir: string, o: { failUpload?: number; faults?: Record<string, Fault[]>; onPut?: (key: string, faults: Record<string, Fault[]>) => void } = {}) {
    const dir = dirStore(feedDir, FEED)
    const faults = o.faults ?? {}
    const put: string[] = []
    const reads = new Map<string, number>()
    const feedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const key = decodeURIComponent(String(input).slice(FEED.length + 1).split('?')[0]!)
      if (key === '') return new Response('Updates: office/, server/, plugins/\n')
      if (init?.method !== 'HEAD') reads.set(key, (reads.get(key) ?? 0) + 1)
      const fault = faults[key]?.shift()
      if (fault === undefined) return dir.fetch(input, init)
      if (typeof fault === 'function') return fault()
      if (fault === 'neterror') throw new TypeError('The socket connection was closed unexpectedly')
      if (typeof fault === 'number') return new Response('fault', { status: fault })
      const real = await (await dir.fetch(input, init)).arrayBuffer()
      const length = { 'content-length': String(real.byteLength) }
      return new Response(fault === 'short' ? new Uint8Array(10) : new Uint8Array(real.byteLength), { headers: length })
    }) as typeof fetch
    const bucket: Bucket = {
      holds: async (key) => fs.existsSync(path.join(feedDir, key)),
      async put(key, file, type) {
        if (put.length === o.failUpload) throw new Error(`upload ${key}: HTTP 502 `)
        put.push(key)
        await dir.put(key, file, type)
        o.onPut?.(key, faults)
      },
    }
    return { store: await cloudflareStore(FEED, { bucket, fetch: feedFetch, retry: { wait: async () => {}, log: () => {} } }), put, reads }
  }
  const BUNDLE = 'server/0.3.0/0.3.0-linux-amd64.tar.zst'
  const REL = 'server/0.3.0/release.json'
  const headVersion = (feed: string) => ReleaseFeed.parse(JSON.parse(read(path.join(feed, 'server', 'beta.json')))).version
  const forever = (f: Fault, n = 30) => Array<Fault>(n).fill(f)

  // the 0.2.19 publish: a 502 left five files on the feed, and the job run again signed the build again. The same bytes
  // now, so it goes on from there, with nothing to delete by hand.
  test('signing the build again gives the files already on the feed: the publish goes on where it stopped', async () => {
    const version = '0.3.0'
    const runs = ['run-1', 'run-2'].map((r) => path.join(T, 'resume', r, 'server'))
    for (const out of runs) fs.mkdirSync(out, { recursive: true })
    for (const arch of ARCHS) {
      const built = path.join(T, 'resume', `built-${arch}`)
      await unsignedBuild(built, version, arch)
      for (const out of runs) {
        // each run unpacks the workflow's artifact again: other times on disk, and signing is at another moment
        const dir = path.join(path.dirname(out), `linux-${arch}`)
        fs.cpSync(built, dir, { recursive: true })
        await Bun.sleep(5)
        const r = await signLinuxBuild({ dir, arch, pem: PEM, keys: [PUB] })
        for (const f of [r.archive, r.kit]) fs.renameSync(f, path.join(out, path.basename(f)))
      }
    }
    const feed = path.join(T, 'feed-resume')
    const first = await watched(feed, { failUpload: 5 })
    await expect(publishServer(opts(runs[0]!, feed, { store: first.store }))).rejects.toThrow(/HTTP 502/)
    expect(first.put.length).toBe(5)
    expect(fs.existsSync(path.join(feed, 'server', 'beta.json'))).toBe(false)

    const second = await watched(feed)
    const r = await publishServer(opts(runs[1]!, feed, { store: second.store }))
    expect(r.status).toBe('published')
    expect(second.put).toEqual(r.uploaded)
    expect(second.put.some((k) => first.put.includes(k))).toBe(false)
    expect(second.put.length).toBe(7) // 8 build files and manifests, release.json + .sig, the head + .sig: 12 in all
    expect(await publishServer(opts(runs[1]!, feed))).toMatchObject({ status: 'unchanged', uploaded: [] })
  }, 60_000)

  test('a file that reads wrong once is read again: nothing is refused, nothing goes up', async () => {
    const feed = path.join(T, 'feed-wrong-read')
    const b = await signedBuilds('wrong-read', '0.3.0')
    await publishServer(opts(b, feed))
    const w = await watched(feed, { faults: { [BUNDLE]: ['wrong'] } })
    expect(await publishServer(opts(b, feed, { store: w.store }))).toMatchObject({ status: 'unchanged', uploaded: [] })
    expect(w.put).toEqual([])
  })

  test('really other content stays refused after the re-reads, and the file on the feed stays', async () => {
    const feed = path.join(T, 'feed-really-other')
    const b = await signedBuilds('really-other', '0.3.0')
    await publishServer(opts(b, feed))
    fs.rmSync(path.join(feed, REL)) // past the check of release.json: the files are compared
    fs.rmSync(path.join(feed, `${REL}.sig`))
    fs.appendFileSync(path.join(feed, BUNDLE), 'x')
    const before = fs.readFileSync(path.join(feed, BUNDLE))
    const w = await watched(feed)
    await expect(publishServer(opts(b, feed, { store: w.store }))).rejects.toThrow(/0\.3\.0-linux-amd64\.tar\.zst is already published with other content: publish a new version instead/)
    expect(w.reads.get(BUNDLE)).toBe(CONFIRM_READS)
    expect(w.put).toEqual([])
    expect(fs.readFileSync(path.join(feed, BUNDLE)).equals(before)).toBe(true)
  })

  test('a file seen with other content that really is gone a moment later is not uploaded over', async () => {
    const feed = path.join(T, 'feed-gone')
    const b = await signedBuilds('gone', '0.3.0')
    await publishServer(opts(b, feed))
    fs.rmSync(path.join(feed, REL))
    fs.rmSync(path.join(feed, `${REL}.sig`))
    const gone = () => { fs.rmSync(path.join(feed, BUNDLE), { force: true }); return new Response('Not found\n', { status: 404 }) }
    const w = await watched(feed, { faults: { [BUNDLE]: ['wrong', gone, gone] } })
    await expect(publishServer(opts(b, feed, { store: w.store }))).rejects.toThrow(/already published with other content/)
    expect(w.put).toEqual([])
  })

  test('a 404 on the head does not skip "never back": the channel stays', async () => {
    const feed = path.join(T, 'feed-head-404')
    const newer = await signedBuilds('head-404-new', '0.3.0')
    const older = await signedBuilds('head-404-old', '0.2.20')
    await publishServer(opts(newer, feed))
    const w = await watched(feed, { faults: { 'server/beta.json': [404] } })
    expect(await publishServer(opts(older, feed, { version: '0.2.20', ifNewer: true, store: w.store }))).toMatchObject({ status: 'skipped', previous: '0.3.0' })
    expect(headVersion(feed)).toBe('0.3.0')
    expect(w.put).toEqual([])
    const refused = await watched(feed, { faults: { 'server/beta.json': [502, 'neterror'] } })
    await expect(publishServer(opts(older, feed, { version: '0.2.20', store: refused.store }))).rejects.toThrow(/beta is at 0\.3\.0; 0\.2\.20 is older/)
  })

  test('a head that stays unreadable stops the run, it is not "no head yet"', async () => {
    const feed = path.join(T, 'feed-head-dead')
    const newer = await signedBuilds('head-dead-new', '0.3.0')
    const older = await signedBuilds('head-dead-old', '0.2.20')
    await publishServer(opts(newer, feed))
    for (const f of [502, 'neterror', 404] as const) {
      const w = await watched(feed, { faults: { 'server/beta.json': forever(f) } })
      await expect(publishServer(opts(older, feed, { version: '0.2.20', ifNewer: true, store: w.store }))).rejects.toThrow()
      expect(w.put).toEqual([])
    }
    expect(headVersion(feed)).toBe('0.3.0')
  })

  test('a 404 on a published file sends no other bytes over it (a stopped run, then a rebuild)', async () => {
    const feed = path.join(T, 'feed-stopped')
    const first = await signedBuilds('stopped-1', '0.3.0', { server: 'first build' })
    const stopped = await watched(feed, { failUpload: 2 })
    await expect(publishServer(opts(first, feed, { store: stopped.store }))).rejects.toThrow(/HTTP 502/)
    const before = fs.readFileSync(path.join(feed, BUNDLE))
    const rebuilt = await signedBuilds('stopped-2', '0.3.0', { server: 'second build' })
    const w = await watched(feed, { faults: { [BUNDLE]: [404] } })
    await expect(publishServer(opts(rebuilt, feed, { store: w.store }))).rejects.toThrow(/already published with other content/)
    expect(w.put).toEqual([])
    expect(fs.readFileSync(path.join(feed, BUNDLE)).equals(before)).toBe(true)
  })

  test('a re-run reads through one 404 or 502 on release.json and its .sig, and keeps them', async () => {
    const feed = path.join(T, 'feed-rel-reads')
    const b = await signedBuilds('rel-reads', '0.3.0')
    await publishServer(opts(b, feed))
    const before = fs.readFileSync(path.join(feed, REL))
    for (const f of [404, 502, 'short'] as const) {
      for (const key of [REL, `${REL}.sig`]) {
        const w = await watched(feed, { faults: { [key]: [f] } })
        expect(await publishServer(opts(b, feed, { store: w.store }))).toMatchObject({ status: 'unchanged', uploaded: [] })
      }
    }
    expect(fs.readFileSync(path.join(feed, REL)).equals(before)).toBe(true)
  })

  test('a short read of a manifest is not taken for the file', async () => {
    const feed = path.join(T, 'feed-short-head')
    const b = await signedBuilds('short-head', '0.3.0')
    await publishServer(opts(b, feed))
    const w = await watched(feed, { faults: { 'server/beta.json': ['short'], [REL]: ['short'] } })
    expect(await publishServer(opts(b, feed, { store: w.store }))).toMatchObject({ status: 'unchanged' })
  })

  describe('the state between release.json and its .sig (docs/RELEASE-CI.md 6)', () => {
    async function publishedFeed(name: string) {
      const feed = path.join(T, name)
      const b = await signedBuilds(name, '0.3.0')
      const stopped = await watched(feed, { failUpload: 10 }) // all but the head: 4 files per arch, then release.json + .sig
      await expect(publishServer(opts(b, feed, { store: stopped.store }))).rejects.toThrow(/HTTP 502/)
      expect(fs.existsSync(path.join(feed, 'server', 'beta.json'))).toBe(false)
      return { feed, b }
    }

    test('release.json without its .sig says so; deleting it, as the message says, lets the run go on', async () => {
      const { feed, b } = await publishedFeed('rel-no-sig')
      fs.rmSync(path.join(feed, `${REL}.sig`))
      await expect(publishServer(opts(b, feed))).rejects.toThrow(/release\.json is on the feed without server\/0\.3\.0\/release\.json\.sig \(a run stopped between the two\): check it, delete it/)
      fs.rmSync(path.join(feed, REL))
      expect((await publishServer(opts(b, feed))).status).toBe('published')
    })

    test('a .sig without release.json says so; deleting it lets the run go on', async () => {
      const { feed, b } = await publishedFeed('sig-no-rel')
      fs.rmSync(path.join(feed, REL))
      await expect(publishServer(opts(b, feed))).rejects.toThrow(/release\.json\.sig is on the feed without server\/0\.3\.0\/release\.json: delete the \.sig/)
      fs.rmSync(path.join(feed, `${REL}.sig`))
      expect((await publishServer(opts(b, feed))).status).toBe('published')
    })

    test('a signature that does not verify is another message, with no way on by deleting: nothing is signed over', async () => {
      const { feed, b } = await publishedFeed('rel-bad-sig')
      fs.appendFileSync(path.join(feed, REL), ' ')
      await expect(publishServer(opts(b, feed))).rejects.toThrow(/release\.json\.sig does not verify server\/0\.3\.0\/release\.json with this product's release keys: someone changed one of them/)
    })

    test('a read that fails for good is neither of them: it names the read', async () => {
      const { feed, b } = await publishedFeed('rel-dead-read')
      const w = await watched(feed, { faults: { [`${REL}.sig`]: forever(502) } })
      await expect(publishServer(opts(b, feed, { store: w.store }))).rejects.toThrow(/release\.json\.sig\?t=\d+: HTTP 502/)
    })
  })

  test('the read back after the upload: a cut answer is read again, one that stays wrong fails the run', async () => {
    const b = await signedBuilds('read-back', '0.3.0')
    // on the feed after the upload, so the bad answers meet the read back and not the check before it
    const after = (fault: Fault[]) => (key: string, faults: Record<string, Fault[]>) => { if (key === BUNDLE) faults[BUNDLE] = fault }
    const feed = path.join(T, 'feed-read-back')
    const w = await watched(feed, { onPut: after(['short']) })
    expect((await publishServer(opts(b, feed, { store: w.store }))).status).toBe('published')
    const bad = path.join(T, 'feed-read-back-2')
    const stuck = await watched(bad, { onPut: after(forever('short')) })
    await expect(publishServer(opts(b, bad, { store: stuck.store }))).rejects.toThrow(/10 of \d+ bytes/)
  })

  test('the read back: a 404 on a file just uploaded is read again, and so are a 502 and a cut on the head', async () => {
    const b = await signedBuilds('read-back-2', '0.3.0')
    const feed = path.join(T, 'feed-read-back-3')
    const w = await watched(feed, {
      onPut: (key, faults) => {
        if (key === BUNDLE) faults[BUNDLE] = [404, 502]
        if (key === 'server/beta.json.sig') { faults['server/beta.json'] = [502, 'neterror']; faults['server/beta.json.sig'] = [404, 'short'] }
      },
    })
    expect((await publishServer(opts(b, feed, { store: w.store }))).status).toBe('published')
  })
})

// ---------------- end to end: kit -> local feed over https -> an installed server's updater ----------------

function tlsCert(dir: string): { cert: string; key: string } {
  fs.mkdirSync(dir, { recursive: true })
  const p = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`openssl: ${p.stderr.toString()}`)
  return { cert: read(path.join(dir, 'cert.pem')), key: read(path.join(dir, 'key.pem')) }
}

describe('end to end: signed kit, publish-server --out, https on 127.0.0.1, UpdateManager', () => {
  test('the updater of an installed server checks the feed with the test key, downloads the bundle and stages it', async () => {
    const builds = await signedBuilds('e2e', '0.3.0')
    const feedDir = path.join(T, 'e2e-feed')
    fs.mkdirSync(feedDir, { recursive: true })
    const tls = tlsCert(path.join(T, 'tls'))
    const served: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls,
      fetch(req) {
        const key = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
        served.push(key)
        const f = path.join(feedDir, key)
        if (key.split('/').includes('..') || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('Not found\n', { status: 404 })
        return new Response(Bun.file(f))
      },
    })
    try {
      const feed = `https://127.0.0.1:${server.port}`
      // the command line, as an owner would run it: the temporary key in TEAMAX_RELEASE_KEY, trusted with --trust
      const keyFile = path.join(T, 'e2e-key.pem')
      fs.writeFileSync(keyFile, PEM, { mode: 0o600 })
      const cli = Bun.spawnSync(['bun', path.join(ROOT, 'scripts/release/publish-server.ts'), '--channel', 'beta', '--version', '0.3.0', '--dir', builds,
        '--notes', '새 버전', '--out', feedDir, '--feed', feed, '--trust', PUB], { env: { ...process.env, TEAMAX_RELEASE_KEY: keyFile }, stdout: 'pipe', stderr: 'pipe' })
      expect(cli.stderr.toString()).toBe('')
      expect(cli.exitCode).toBe(0)
      expect(cli.stdout.toString()).toContain(`published: ${feed}/server/beta.json → 0.3.0`)
      expect(cli.stdout.toString()).not.toContain('PRIVATE KEY')

      const ca = tls.cert
      const tlsFetch = ((url: string, init?: RequestInit) => fetch(url, { ...init, tls: { ca } } as RequestInit)) as typeof fetch
      const app = path.join(T, 'e2e-install', 'app')
      fs.mkdirSync(path.join(app, 'versions', '0.2.2'), { recursive: true })
      fs.symlinkSync('versions/0.2.2', path.join(app, 'current'))
      const mgr = (keys: readonly string[]) => new UpdateManager({ appDir: app, dataDir: path.join(T, 'e2e-install', 'data'), version: '0.2.2', channel: 'beta', feedUrl: `${feed}/server/beta.json`, log: silentLogger, keys, allowUnsigned: false, fetch: tlsFetch })
      // this product's real keys do not trust a feed signed with the test key
      expect(await mgr(RELEASE_CHANNEL.keys).checkFeed()).toBeNull()
      const u = mgr([PUB])
      const f = await u.checkFeed()
      expect(f).toMatchObject({ version: '0.3.0', notes: '새 버전', needsRoot: true })
      expect(u.status()).toMatchObject({ current: '0.2.2', available: { version: '0.3.0' }, needsRoot: true })
      // the feed names Linux bundles; on a Mac the test hands the same signed entry to this machine's os name
      const here = process.platform === 'linux' ? f! : { ...f!, bundles: f!.bundles.map((b) => ({ ...b, os: process.platform })) }
      const m = await u.download(here)
      expect(m.version).toBe('0.3.0')
      const staged = path.join(app, 'versions', '0.3.0')
      expect(fs.existsSync(path.join(staged, 'manifest.sig'))).toBe(true)
      await expect(verifyBundleDir(staged, { keys: [PUB], allowUnsigned: false })).resolves.toMatchObject({ version: '0.3.0' })
      expect(u.stagedVersions()).toContain('0.3.0')
      // mycel-ctl update --version reads <feed>/server/<version>/release.json(.sig): the same bytes, verified
      const rel = new Uint8Array(await (await tlsFetch(`${feed}/server/0.3.0/release.json`)).arrayBuffer())
      expect(verifySignature(rel, await (await tlsFetch(`${feed}/server/0.3.0/release.json.sig`)).text(), [PUB])).toBe(true)
      // a new install downloads the kit (docs/INSTALL-LINUX.md 3)
      const kit = await tlsFetch(`${feed}/server/0.3.0/${kitName('0.3.0', 'amd64')}.tar.gz`)
      expect(kit.status).toBe(200)
      expect(served).toContain('server/beta.json.sig')
    } finally {
      server.stop(true)
    }
  })

  test('--feed and --trust are only for a local --out feed', () => {
    const run = (...a: string[]) => Bun.spawnSync(['bun', path.join(ROOT, 'scripts/release/publish-server.ts'), '--channel', 'beta', '--dir', T, ...a], { stdout: 'pipe', stderr: 'pipe' })
    expect(run('--feed', 'https://127.0.0.1:4443').stderr.toString()).toContain('--feed is only for --out')
    expect(run('--out', T, '--feed', 'https://evil.example').stderr.toString()).toContain('--feed is only for --out')
    expect(run('--trust', PUB).stderr.toString()).toContain('--trust is only for --out')
  })
})
