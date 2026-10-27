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
import { ReleaseFeed, UpdateManager, verifyBundleDir, verifySignature } from '../../server/src/system/update'
import { kitName } from '../../scripts/build-bundle'
import { signLinuxBuild } from '../../scripts/release/release-ci'
import { dirStore, publishServer, type LinuxArch, type PublishServerOptions } from '../../scripts/release/publish-server'
import { publicKeyOfPem } from '../../scripts/release/sign'

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
async function unsignedBuild(dir: string, version: string, arch: LinuxArch, o: { root?: string; feed?: string; server?: string } = {}) {
  fs.rmSync(dir, { recursive: true, force: true })
  const app = path.join(dir, 'app', version)
  for (const d of ['root/systemd', 'bin', 'server/src', 'server/migrations']) fs.mkdirSync(path.join(app, d), { recursive: true })
  fs.writeFileSync(path.join(app, 'root', 'mycel-ctl'), fakeElf(arch, o.root ?? ''), { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'root', 'systemd', 'server.service.in'), '[Service]\n', { mode: 0o644 })
  fs.writeFileSync(path.join(app, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'server', 'src', 'main.js'), `// server ${version} ${o.server ?? ''}\n`, { mode: 0o644 })
  fs.writeFileSync(path.join(app, 'server', 'migrations', '001_a.sql'), '-- min_compatible_reader: 2\n', { mode: 0o644 })
  for (const p of [app, ...['root', 'root/systemd', 'bin', 'server', 'server/src', 'server/migrations'].map((d) => path.join(app, d))]) fs.chmodSync(p, 0o755)
  await writeManifest(app, version)
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n')
  fs.writeFileSync(path.join(dir, 'product.env'), productEnv({ RELEASE_FEED: o.feed ?? RELEASE_CHANNEL.feed }))
  fs.writeFileSync(path.join(dir, 'install-linux.sh'), '#!/bin/sh\necho install\n', { mode: 0o755 })
}

/** Both archs signed (release-ci.ts sign-linux) into one folder, as the publish job has them. */
async function signedBuilds(name: string, version: string, o: { root?: string; feed?: string; server?: string; pem?: string } = {}) {
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
    store: dirStore(feedDir, FEED), log: () => {}, ...over,
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

  test('needsRoot: off when no root/ file changed since the heads of both channels, on when one did', async () => {
    const feed = path.join(T, 'feed-e')
    await publishServer(opts(b030, feed, { channel: 'stable' }))
    const same = await signedBuilds('b031-same', '0.3.1', { server: 'new app' })
    expect((await publishServer(opts(same, feed, { channel: 'stable', version: '0.3.1' }))).needsRoot).toBe(false)
    const changed = await signedBuilds('b032-root', '0.3.2', { root: 'new launcher' })
    expect((await publishServer(opts(changed, feed, { channel: 'stable', version: '0.3.2' }))).needsRoot).toBe(true)
    // beta at 0.3.2 (root changed there), stable at 0.3.1: 0.3.3 with 0.3.2's root still changes stable's root
    await publishServer(opts(changed, feed, { channel: 'beta', version: '0.3.2' }))
    const f2 = path.join(T, 'feed-e2')
    await publishServer(opts(b030, f2, { channel: 'stable' }))
    await publishServer(opts(changed, f2, { channel: 'beta', version: '0.3.2' }))
    const b033 = await signedBuilds('b033', '0.3.3', { root: 'new launcher', server: '0.3.3' })
    expect((await publishServer(opts(b033, f2, { channel: 'beta', version: '0.3.3' }))).needsRoot).toBe(true)
    // forced either way
    const b034 = await signedBuilds('b034', '0.3.4', { root: 'new launcher', server: '0.3.4' })
    expect((await publishServer(opts(b034, f2, { channel: 'beta', version: '0.3.4', needsRoot: false }))).needsRoot).toBe(false)
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
