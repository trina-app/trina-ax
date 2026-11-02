// Release packs are reproducible: signing one build again gives the same bytes (publish-server.ts never replaces a file
// on the feed, so a publish that stopped half way can only go on with identical files). What a server unpacks stays what
// it was: compared here with the packer as it was before (legacyPack), through this repository's readers and system tar.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { walkTree } from '../../server/src/system/manifest'
import { packBundle, packTimeMs, signManifest, writeManifest } from '../../server/src/system/bundle'
import { gzipCompress, readFileChunks, writeAtomic, zstdCompress, zstdDecompress } from '../../server/src/system/streams'
import { extractTar, readTar, tarStream, type TarEntryInput } from '../../server/src/system/tar'
import { verifyBundleDir } from '../../server/src/system/update'
import { kitName, packLinuxKit } from '../../scripts/build-bundle'
import { signLinuxBuild } from '../../scripts/release/release-ci'
import { publicKeyOfPem } from '../../scripts/release/sign'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-repro-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const PEM = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const PUB = publicKeyOfPem(PEM)
const VERSION = '0.3.0'
const LONG = `server/${'deep/'.repeat(30)}file.js` // over the 100 bytes of a ustar name
const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const OLD = new Date('2031-01-02T03:04:05Z')

function fakeElf(): Buffer {
  const h = Buffer.alloc(64)
  h.writeUInt32BE(0x7f454c46, 0)
  h[4] = 2
  h[5] = 1
  h.writeUInt16LE(0x3e, 18)
  return h
}

/** A version folder with what a release holds: programs, root's files (some not executable), scripts, odd names, nothing. */
async function versionFolder(app: string, o: { main?: string } = {}) {
  const put = (rel: string, data: string | Uint8Array, mode: number) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true })
    fs.writeFileSync(path.join(app, rel), data, { mode })
    fs.chmodSync(path.join(app, rel), mode)
  }
  put('bin/bun', crypto.createHash('sha512').update('bun').digest(), 0o755)
  put('native/mycel-safeops', fakeElf(), 0o755)
  put('root/mycel-ctl', fakeElf(), 0o755)
  put('root/mycel-launcher', '#!/bin/sh\n', 0o755)
  put('root/safe-fs.sh', '# sourced, never run\n', 0o644)
  put('root/systemd/server.service.in', '[Service]\n', 0o644)
  put('server/src/main.js', o.main ?? '// the server\n', 0o644)
  put('server/empty', '', 0o644)
  put('web/assets/한글 이름.js', 'x', 0o644)
  put(LONG, 'long', 0o644)
  fs.mkdirSync(path.join(app, 'fonts'), { recursive: true }) // an empty folder
  await writeManifest(app, VERSION)
}

/** An unsigned kit folder, like the workflow's artifact holds it. */
async function buildFolder(dir: string) {
  await versionFolder(path.join(dir, 'app', VERSION))
  fs.writeFileSync(path.join(dir, 'VERSION'), VERSION + '\n')
  fs.writeFileSync(path.join(dir, 'product.env'), 'RELEASE_FEED=https://feed.test\n')
  fs.writeFileSync(path.join(dir, 'install-linux.sh'), '#!/bin/sh\necho install\n', { mode: 0o755 })
}

function walk(root: string, f: (p: string) => void) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) walk(p, f)
    f(p)
  }
}

/** Another copy of a folder, as another run has it: every time on disk different. */
function copyWithOtherTimes(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true })
  walk(to, (p) => fs.utimesSync(p, OLD, OLD))
  fs.utimesSync(to, OLD, OLD)
}

/** The tree as a server sees it: type, permissions and content of every path, links included. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  walk(root, (p) => {
    const st = fs.lstatSync(p), rel = path.relative(root, p).normalize('NFC')
    out[rel] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? `dir ${(st.mode & 0o7777).toString(8)}` : `file ${(st.mode & 0o7777).toString(8)} ${sha256(fs.readFileSync(p))}`
  })
  return out
}

/** The entries of a pack, in order, without their times; the times apart. */
async function entries(src: AsyncIterable<Uint8Array>) {
  const list: string[] = []
  const times = new Set<number>()
  await readTar(src, async (e, body) => {
    const h = crypto.createHash('sha256')
    for await (const c of body) h.update(c)
    list.push(`${e.type} ${e.name} ${e.size} ${e.mode.toString(8)} ${h.digest('hex')}`)
    times.add(e.mtimeMs)
  })
  return { list, times }
}
const zst = (f: string) => zstdDecompress(readFileChunks(f))
const gz = (f: string) => Readable.from(readFileChunks(f)).pipe(zlib.createGunzip()) as unknown as AsyncIterable<Uint8Array>

/** packBundle as it was until 0.2.19: the times on disk */
async function legacyPack(dir: string, out: string) {
  const { files, dirs } = await walkTree(dir)
  const list: TarEntryInput[] = [
    ...dirs.map((d) => ({ name: d.rel, type: 'dir' as const, mode: d.mode, mtimeMs: d.mtimeMs })),
    ...files.map((f) => ({ name: f.rel, type: 'file' as const, source: f.abs, mode: f.mode })),
  ]
  return writeAtomic(zstdCompress(tarStream(list), 19), out, 0o644)
}

/** How many zstd frames a file holds (RFC 8878). */
function zstdFrames(b: Buffer): number {
  let off = 0, frames = 0
  while (off < b.length) {
    expect(b.readUInt32LE(off)).toBe(0xfd2fb528)
    const fhd = b[off + 4]!
    const fcs = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dict = fhd & 3
    let p = off + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dict]! + (fcs === 0 ? single : [0, 2, 4, 8][fcs]!)
    for (;;) {
      const h = b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)
      p += 3 + (((h >> 1) & 3) === 1 ? 1 : h >> 3)
      if (h & 1) break
    }
    off = p + (checksum ? 4 : 0)
    frames++
  }
  return frames
}

const collect = async (src: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = []
  for await (const c of src) parts.push(c)
  return Buffer.concat(parts)
}

describe('compressed streams do not depend on timing', () => {
  // the end of the source against the compressor: the chunk before the last crosses a zstd block (128 KB), so it is still
  // being compressed when the last chunk and the end arrive, unless the source pauses. A pipe let the end overtake the last
  // chunk there, and zstd wrote a second, empty frame: the same data, nine more bytes
  const hex = Buffer.from(crypto.randomBytes(70_000).toString('hex'))
  const fill = hex.subarray(0, 127 * 1024), cross = hex.subarray(127 * 1024, 131 * 1024), tiny = new Uint8Array(1024)
  const atOnce = async function* () { yield fill; yield cross; yield tiny }
  const afterPause = async function* () { yield fill; yield cross; await Bun.sleep(400); yield tiny }

  test('zstd: one frame and the same bytes, whether the source ends at once or after a pause', async () => {
    const a = await collect(zstdCompress(atOnce(), 19)), b = await collect(zstdCompress(afterPause(), 19))
    expect(zstdFrames(a)).toBe(1)
    expect(zstdFrames(b)).toBe(1)
    expect(a.equals(b)).toBe(true)
    expect(Buffer.from(zlib.zstdDecompressSync(a)).equals(Buffer.concat([fill, cross, tiny]))).toBe(true)
  }, 20_000)

  test('gzip: the same bytes too', async () => {
    expect((await collect(gzipCompress(atOnce()))).equals(await collect(gzipCompress(afterPause())))).toBe(true)
  })

  test('a pack is one frame', async () => {
    const a = path.join(T, 'f1', VERSION)
    await versionFolder(a)
    await packBundle(a, path.join(T, 'f1', 'a.tar.zst'))
    expect(zstdFrames(fs.readFileSync(path.join(T, 'f1', 'a.tar.zst')))).toBe(1)
  })

  test('the walker sees two frames where there are two', () => {
    const one = zlib.zstdCompressSync(Buffer.from('x'))
    expect(zstdFrames(Buffer.concat([one, one]))).toBe(2)
  })
})

describe('the stream around a compressor', () => {
  const eventually = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10); expect(ok()).toBe(true) }

  test('a consumer that stops early closes the source, so the files it holds are released', async () => {
    let closed = false
    const src = async function* () { try { for (;;) yield crypto.randomBytes(1 << 16) } finally { closed = true } }
    for await (const c of zstdCompress(src(), 1)) { expect(c.byteLength).toBeGreaterThan(0); break }
    await eventually(() => closed)
  })

  test('a source that fails fails the consumer with its error, and is closed', async () => {
    let closed = false
    const src = async function* () { try { yield new Uint8Array(10); throw new Error('the source broke') } finally { closed = true } }
    await expect(collect(zstdCompress(src()))).rejects.toThrow('the source broke')
    await eventually(() => closed)
  })

  test('input the compressor refuses fails the consumer and closes the source; it does not hang', async () => {
    let closed = false
    const src = async function* () { try { for (;;) yield crypto.randomBytes(1 << 12) } finally { closed = true } }
    await expect(collect(zstdDecompress(src()))).rejects.toThrow()
    await eventually(() => closed)
  })

  test('nothing is read before the consumer starts', async () => {
    let started = false
    const src = async function* () { started = true; yield new Uint8Array(1) }
    const out = zstdCompress(src())
    await Bun.sleep(20)
    expect(started).toBe(false)
    expect((await collect(out)).length).toBeGreaterThan(0)
  })

  test('an empty source is an empty stream, not a hang', async () => {
    const src = async function* (): AsyncGenerator<Uint8Array> {}
    expect((await collect(zstdDecompress(zstdCompress(src())))).length).toBe(0)
  })
})

describe('packBundle is reproducible', () => {
  test('the same folder with other times on disk, packed twice: the same sha256', async () => {
    const a = path.join(T, 'p1', VERSION), b = path.join(T, 'p1', 'copy')
    await versionFolder(a)
    await signManifest(a, PEM)
    copyWithOtherTimes(a, b)
    await signManifest(b, PEM) // signing again writes manifest.sig now
    const x = await packBundle(a, path.join(T, 'p1', 'a.tar.zst'))
    const y = await packBundle(b, path.join(T, 'p1', 'b.tar.zst'))
    expect(y).toEqual(x)
    expect(sha256(fs.readFileSync(path.join(T, 'p1', 'a.tar.zst')))).toBe(x.sha256)
    expect(fs.readFileSync(path.join(T, 'p1', 'a.tar.zst')).equals(fs.readFileSync(path.join(T, 'p1', 'b.tar.zst')))).toBe(true)
  })

  test('another content, or another build of it, is another pack', async () => {
    const a = path.join(T, 'p2', 'a'), b = path.join(T, 'p2', 'b')
    await versionFolder(a)
    await versionFolder(b, { main: '// another server\n' })
    const x = await packBundle(a, path.join(T, 'p2', 'a.tar.zst'))
    expect(await packBundle(b, path.join(T, 'p2', 'b.tar.zst'))).not.toEqual(x)
    await Bun.sleep(1100)
    await writeManifest(a, VERSION) // a rebuild: the same files, a new manifest
    expect(await packBundle(a, path.join(T, 'p2', 'a2.tar.zst'))).not.toEqual(x)
  })

  test('every entry has the time of the build, a real one (GNU tar warns about a very old time)', async () => {
    const a = path.join(T, 'p3', VERSION)
    await versionFolder(a)
    await signManifest(a, PEM)
    await packBundle(a, path.join(T, 'p3', 'a.tar.zst'))
    const createdAt = JSON.parse(fs.readFileSync(path.join(a, 'manifest.json'), 'utf8')).createdAt as string
    const { times } = await entries(zst(path.join(T, 'p3', 'a.tar.zst')))
    expect([...times]).toEqual([Math.floor(Date.parse(createdAt) / 1000) * 1000])
    expect([...times][0]!).toBeGreaterThan(Date.parse('2026-01-01'))
  })

  test('without a readable time there is no pack', async () => {
    const a = path.join(T, 'p4')
    fs.mkdirSync(a)
    await expect(packTimeMs(a)).rejects.toThrow()
    fs.writeFileSync(path.join(a, 'manifest.json'), JSON.stringify({ format: 1, version: VERSION, createdAt: 'yesterday', files: {} }))
    await expect(packTimeMs(a)).rejects.toThrow(/is not a time/)
    await expect(packBundle(a, path.join(T, 'p4.tar.zst'))).rejects.toThrow(/is not a time/)
    expect(fs.existsSync(path.join(T, 'p4.tar.zst'))).toBe(false)
  })

  test('the umask at signing does not reach the pack', async () => {
    const a = path.join(T, 'p5', VERSION)
    await versionFolder(a)
    const old = process.umask(0o077)
    try { await signManifest(a, PEM) } finally { process.umask(old) }
    expect(fs.statSync(path.join(a, 'manifest.sig')).mode & 0o777).toBe(0o644)
  })

  test.skipIf(process.getuid?.() !== 0)('the owner on disk does not reach the pack (root only: needs chown)', async () => {
    const a = path.join(T, 'p6', 'a'), b = path.join(T, 'p6', 'b')
    await versionFolder(a)
    fs.cpSync(a, b, { recursive: true })
    walk(b, (p) => fs.chownSync(p, 65534, 65534))
    expect(await packBundle(b, path.join(T, 'p6', 'b.tar.zst'))).toEqual(await packBundle(a, path.join(T, 'p6', 'a.tar.zst')))
  })
})

describe('sign-linux twice on one build (a re-run of the publish job)', () => {
  test('the same update archive and the same kit, whatever the time and the times on disk', async () => {
    const built = path.join(T, 's1', 'built')
    await buildFolder(built)
    const first = path.join(T, 's1', 'first'), second = path.join(T, 's1', 'second')
    fs.cpSync(built, first, { recursive: true })
    copyWithOtherTimes(built, second)
    const a = await signLinuxBuild({ dir: first, arch: 'amd64', pem: PEM, keys: [PUB] })
    await Bun.sleep(5)
    const b = await signLinuxBuild({ dir: second, arch: 'amd64', pem: PEM, keys: [PUB] })
    expect(b.archiveSha256).toBe(a.archiveSha256)
    expect(b.kitSha256).toBe(a.kitSha256)
    // and in the same folder, as an owner may do by hand
    await Bun.sleep(5)
    const c = await signLinuxBuild({ dir: first, arch: 'amd64', pem: PEM, keys: [PUB] })
    expect(c.archiveSha256).toBe(a.archiveSha256)
    expect(c.kitSha256).toBe(a.kitSha256)
  })

  test('the kit has one time too, also on the folders it makes up itself', async () => {
    const dir = path.join(T, 's2', 'build')
    await buildFolder(dir)
    const r = await signLinuxBuild({ dir, arch: 'amd64', pem: PEM, keys: [PUB] })
    const { list, times } = await entries(gz(r.kit))
    expect(times.size).toBe(1)
    expect([...times][0]).toBe(await packTimeMs(path.join(dir, 'app', VERSION)))
    expect(list.some((l) => l.startsWith(`dir ${kitName(VERSION, 'amd64')}/app/${VERSION} `))).toBe(true)
  })
})

describe('what a server gets has not changed', () => {
  test('the same entries in the same order as the packer before, and the same tree unpacked; verifyBundleDir passes', async () => {
    const a = path.join(T, 'c1', VERSION)
    await versionFolder(a)
    await signManifest(a, PEM)
    const now = path.join(T, 'c1', 'now.tar.zst'), before = path.join(T, 'c1', 'before.tar.zst')
    await packBundle(a, now)
    await legacyPack(a, before)
    expect((await entries(zst(now))).list).toEqual((await entries(zst(before))).list)

    const out = (n: string) => { const d = path.join(T, 'c1', n); fs.mkdirSync(d); return d }
    const x = out('x'), y = out('y')
    await extractTar(zst(now), x)
    await extractTar(zst(before), y)
    expect(tree(x)).toEqual(tree(y))
    await expect(verifyBundleDir(x, { keys: [PUB], allowUnsigned: false })).resolves.toMatchObject({ version: VERSION })

    // the permissions that matter, spelled out
    const t = tree(x)
    expect(t['root/mycel-ctl']).toStartWith('file 755 ')
    expect(t['root/mycel-launcher']).toStartWith('file 755 ')
    expect(t['root/safe-fs.sh']).toStartWith('file 644 ')
    expect(t['bin/bun']).toStartWith('file 755 ')
    expect(t['native/mycel-safeops']).toStartWith('file 755 ')
    expect(t['manifest.sig']).toStartWith('file 644 ')
    expect(t['fonts']).toBe('dir 755')
    expect(t['web/assets/한글 이름.js']).toBeDefined()
    expect(t[LONG]).toBeDefined()
  })

  test('a link in the folder stays out, as it did; a signed build cannot hold one at all', async () => {
    const a = path.join(T, 'c2', VERSION)
    await versionFolder(a)
    fs.symlinkSync('bin/bun', path.join(a, 'link'))
    const now = path.join(T, 'c2', 'now.tar.zst'), before = path.join(T, 'c2', 'before.tar.zst')
    await packBundle(a, now)
    await legacyPack(a, before)
    const list = (await entries(zst(now))).list
    expect(list).toEqual((await entries(zst(before))).list)
    expect(list.some((l) => l.includes(' link '))).toBe(false)
    await expect(verifyBundleDir(a, { keys: [], allowUnsigned: true })).rejects.toThrow(/symlink in bundle: link/)
  })

  test('the system tar (bsdtar on a Mac, GNU tar on Linux) opens the kit without a word, with the same tree', async () => {
    const dir = path.join(T, 'c3', 'build')
    await buildFolder(dir)
    const r = await signLinuxBuild({ dir, arch: 'amd64', pem: PEM, keys: [PUB] })
    const out = path.join(T, 'c3', 'out')
    fs.mkdirSync(out)
    const p = Bun.spawnSync(['tar', '-xzf', r.kit, '-C', out], { stdout: 'pipe', stderr: 'pipe' })
    expect(p.stderr.toString()).toBe('')
    expect(p.exitCode).toBe(0)
    const top = path.join(out, kitName(VERSION, 'amd64'))
    expect(tree(path.join(top, 'app', VERSION))).toEqual(tree(path.join(dir, 'app', VERSION)))
    // a kit is opened on Linux; bsdtar on a Mac writes the Korean name decomposed, which the manifest does not list
    if (process.platform === 'linux') await expect(verifyBundleDir(path.join(top, 'app', VERSION), { keys: [PUB], allowUnsigned: false })).resolves.toMatchObject({ version: VERSION })
    expect(fs.statSync(path.join(top, 'install-linux.sh')).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(top, 'VERSION')).mode & 0o777).toBe(0o644)
  })

  test.skipIf(!Bun.which('zstd'))('the zstd program and the system tar open the update archive (mycel-ctl uses that zstd)', async () => {
    const a = path.join(T, 'c4', VERSION)
    await versionFolder(a)
    await signManifest(a, PEM)
    const pack = path.join(T, 'c4', 'a.tar.zst'), plain = path.join(T, 'c4', 'a.tar'), out = path.join(T, 'c4', 'out')
    await packBundle(a, pack)
    expect(Bun.spawnSync(['zstd', '-q', '-d', pack, '-o', plain]).exitCode).toBe(0)
    fs.mkdirSync(out)
    const p = Bun.spawnSync(['tar', '-xf', plain, '-C', out], { stdout: 'pipe', stderr: 'pipe' })
    expect(p.stderr.toString()).toBe('')
    expect(p.exitCode).toBe(0)
    expect(tree(out)).toEqual(tree(a))
  })

  test('the install kit of a build folder without an installer yet still packs', async () => {
    const dir = path.join(T, 'c5', 'build')
    await buildFolder(dir)
    fs.rmSync(path.join(dir, 'install-linux.sh'))
    const kit = await packLinuxKit(dir, VERSION, 'amd64')
    expect((await entries(gz(kit.file))).list.some((l) => l.includes('install-linux.sh'))).toBe(false)
  })
})

describe('tarStream times (backups read them back)', () => {
  test('a file keeps its own time unless the entry names one', async () => {
    const f = path.join(T, 't1.txt')
    fs.writeFileSync(f, 'x')
    fs.utimesSync(f, OLD, OLD)
    const seen: number[] = []
    await readTar(tarStream([{ name: 'own', type: 'file', source: f }, { name: 'named', type: 'file', source: f, mtimeMs: 5_000_000 }]), async (e) => { seen.push(e.mtimeMs) })
    expect(seen).toEqual([OLD.getTime(), 5_000_000])
  })
})
