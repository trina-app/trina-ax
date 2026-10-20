// Component G: streaming tar / zstd / age used by backups, archives and exports.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ageDecrypt, ageEncrypt, isAgeFile, readFileChunks, WrongPasswordError, writeAtomic, zstdCompress, zstdDecompress } from '../../server/src/system/streams'
import { checkArchiveName, extractTar, readTar, tarHeaders, tarStream, USTAR_MAX_SIZE, type TarEntryInput } from '../../server/src/system/tar'
import { PRODUCT } from '@mycel/shared'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-tar')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

async function collect(src: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const c of src) parts.push(c)
  return Buffer.concat(parts)
}

function sampleTree(root: string) {
  fs.mkdirSync(path.join(root, '한글 폴더', 'NFD-가'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
  fs.writeFileSync(path.join(root, '한글 폴더', '회의록.md'), '내용 '.repeat(3000))
  fs.writeFileSync(path.join(root, 'x'.repeat(180) + '.bin'), Buffer.alloc(2_500_000, 7)) // > one 1 MB read
  fs.mkdirSync(path.join(root, 'empty-dir'))
}
const entriesOf = (root: string): TarEntryInput[] => [
  { name: 'a.txt', type: 'file', source: path.join(root, 'a.txt') },
  { name: 'empty.txt', type: 'file', source: path.join(root, 'empty.txt') },
  { name: '한글 폴더', type: 'dir' },
  { name: '한글 폴더/NFD-가', type: 'dir' },
  { name: '한글 폴더/회의록.md', type: 'file', source: path.join(root, '한글 폴더', '회의록.md') },
  { name: 'x'.repeat(180) + '.bin', type: 'file', source: path.join(root, 'x'.repeat(180) + '.bin') },
  { name: 'empty-dir', type: 'dir' },
  { name: 'generated.json', type: 'file', data: Buffer.from('{"ok":true}') },
]

describe('tar', () => {
  const src = path.join(W, 'src')
  sampleTree(src)

  test('round trip keeps names (UTF-8, long), contents, empty files, folders and millisecond mtimes', async () => {
    const out = path.join(W, 'rt')
    fs.mkdirSync(out)
    const n = await extractTar(tarStream(entriesOf(src)), out)
    expect(n).toBe(8)
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('hello')
    expect(fs.statSync(path.join(out, 'empty.txt')).size).toBe(0)
    expect(fs.readFileSync(path.join(out, '한글 폴더', '회의록.md')).equals(fs.readFileSync(path.join(src, '한글 폴더', '회의록.md')))).toBe(true)
    expect(fs.statSync(path.join(out, 'x'.repeat(180) + '.bin')).size).toBe(2_500_000)
    expect(fs.existsSync(path.join(out, '한글 폴더', 'NFD-가'))).toBe(true)
    expect(fs.statSync(path.join(out, 'empty-dir')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(out, 'generated.json'), 'utf8')).toBe('{"ok":true}')
    expect(Math.floor(fs.statSync(path.join(out, 'a.txt')).mtimeMs)).toBe(Math.floor(fs.statSync(path.join(src, 'a.txt')).mtimeMs))
  })

  test('the system tar reads our archives (PAX headers)', async () => {
    const file = path.join(W, 'sys.tar')
    await writeAtomic(tarStream(entriesOf(src)), file)
    const p = Bun.spawnSync(['tar', '-tf', file])
    expect(p.exitCode).toBe(0)
    const names = p.stdout.toString().trim().split('\n').map((s) => s.replace(/\/$/, '').normalize('NFC'))
    expect(names).toContain('한글 폴더/회의록.md'.normalize('NFC'))
    expect(names).toContain('x'.repeat(180) + '.bin')
  })

  test('unsafe paths and unsupported entry types are refused', async () => {
    expect(() => checkArchiveName('../etc/passwd')).toThrow()
    expect(() => checkArchiveName('/abs')).toThrow()
    expect(() => checkArchiveName('a/../../b')).toThrow()
    // hand-made archive with a "../x" name and a symlink entry
    const h = (name: string, type: string, size = 0) => {
      const b = Buffer.alloc(512)
      b.write(name, 0)
      b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116)
      b.write(size.toString(8).padStart(11, '0') + '\0', 124); b.write('00000000000\0', 136)
      b.fill(0x20, 148, 156); b.write(type, 156); b.write('ustar\0', 257); b.write('00', 263)
      let sum = 0
      for (const x of b) sum += x
      b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
      return b
    }
    const bad = [Buffer.concat([h('../escape', '0', 1), Buffer.alloc(512, 0x41), Buffer.alloc(1024)]), Buffer.concat([h('link', '2'), Buffer.alloc(1024)])]
    for (const arc of bad) {
      const dest = path.join(W, 'bad-' + Math.random().toString(36).slice(2))
      fs.mkdirSync(dest)
      await expect(extractTar([arc].values() as unknown as AsyncIterable<Uint8Array>, dest)).rejects.toThrow()
      expect(fs.existsSync(path.join(W, 'escape'))).toBe(false)
    }
  })

  test('a truncated archive is an error, not a silent partial result', async () => {
    const full = await collect(tarStream(entriesOf(src)))
    const cut = full.subarray(0, 600_000)
    await expect(readTar((async function* () { yield cut })(), async () => {})).rejects.toThrow(/truncated/)
  })

  test('a file that shrinks while it is archived is zero-filled and reported', async () => {
    const f = path.join(W, 'shrinks.bin')
    fs.writeFileSync(f, Buffer.alloc(3_000_000, 1))
    const written: { name: string; changedWhileReading: boolean }[] = []
    let n = 0
    const out = await collect((async function* () {
      for await (const c of tarStream([{ name: 'shrinks.bin', type: 'file', source: f }], (w) => written.push(w))) {
        if (++n === 3) fs.truncateSync(f, 10) // after the first 1 MB piece
        yield c
      }
    })())
    expect(written[0]!.changedWhileReading).toBe(true)
    let size = -1
    await readTar((async function* () { yield out })(), async (e) => { size = e.size })
    expect(size).toBe(3_000_000)
  })
})

describe('zstd + age', () => {
  const src = path.join(W, 'src2')
  sampleTree(src)

  test('encrypted archive round trip; the age CLI format; wrong password refused', async () => {
    const file = path.join(W, 'arc.tar.zst.age')
    await writeAtomic(ageEncrypt(zstdCompress(tarStream(entriesOf(src))), 'correct horse 한글'), file)
    expect(await isAgeFile(file)).toBe(true)
    const out = path.join(W, 'age-out')
    fs.mkdirSync(out)
    await extractTar(zstdDecompress(ageDecrypt(readFileChunks(file), 'correct horse 한글')), out)
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('hello')
    const out2 = path.join(W, 'age-out2')
    fs.mkdirSync(out2)
    await expect(extractTar(zstdDecompress(ageDecrypt(readFileChunks(file), 'wrong')), out2)).rejects.toBeInstanceOf(WrongPasswordError)
    expect(fs.readdirSync(out2)).toEqual([])
  }, 30_000)

  test('a tampered encrypted file fails part-way (callers extract into a temp folder)', async () => {
    const file = path.join(W, 'tamper.age')
    await writeAtomic(ageEncrypt(zstdCompress(tarStream(entriesOf(src)), 1), 'pw-123456'), file)
    const b = fs.readFileSync(file)
    b[Math.floor(b.length * 0.7)] ^= 0xff
    fs.writeFileSync(file, b)
    const out = path.join(W, 'tamper-out')
    fs.mkdirSync(out)
    await expect(extractTar(zstdDecompress(ageDecrypt(readFileChunks(file), 'pw-123456')), out)).rejects.toThrow()
  }, 30_000)

  test('writeAtomic leaves nothing behind when the source fails', async () => {
    const file = path.join(W, 'never.bin')
    await expect(writeAtomic((async function* () { yield Buffer.from('x'); throw new Error('boom') })(), file)).rejects.toThrow('boom')
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(W).some((n) => n.startsWith(PRODUCT.tmpPrefix))).toBe(false)
  })
})

describe('tar review fixes', () => {
  /** one raw 512-byte header block (ustar) with a valid checksum */
  function rawHeader(name: string, size: number, type: string): Uint8Array {
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136)
    h.fill(0x20, 148, 156); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return h
  }
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512)
  async function* chunks(...parts: Uint8Array[]) { for (const p of parts) yield p }

  test('files over 8 GiB carry their exact size in the PAX header (the ustar field tops out)', () => {
    const big = USTAR_MAX_SIZE + 12345
    const blocks = tarHeaders('video.mov', big, 0o644, Date.now(), 'file')
    const pax = Buffer.from(blocks[1]!).toString('utf8')
    expect(pax).toContain(` size=${big}\n`)
    expect(Buffer.from(tarHeaders('small', 10, 0o644, Date.now(), 'file')[1]!).toString('utf8')).not.toContain('size=')
  })

  test('the reader uses the PAX size over the ustar field', async () => {
    const pax = Buffer.from('10 size=5\n', 'utf8')
    const body = Buffer.from('hello')
    const archive = [rawHeader('PaxHeader/x', pax.length, 'x'), pax, pad(pax.length), rawHeader('x.txt', 0, '0'), body, pad(5), Buffer.alloc(1024)]
    const got: { name: string; size: number; data: string }[] = []
    await readTar(chunks(...archive), async (e, b) => { got.push({ name: e.name, size: e.size, data: (await collect(b)).toString() }) })
    expect(got).toEqual([{ name: 'x.txt', size: 5, data: 'hello' }])
  })

  test('a global PAX header with a huge size is refused, not buffered', async () => {
    // zstd turns gigabytes of zeros into a few bytes: the old reader read the whole "header" into memory
    const archive = zstdCompress(chunks(rawHeader('pax_global_header', 2 ** 32, 'g'), Buffer.alloc(4 << 20)))
    const before = process.memoryUsage().rss
    await expect(readTar(zstdDecompress(archive), async () => {})).rejects.toThrow(/too large/)
    expect(process.memoryUsage().rss - before).toBeLessThan(512 << 20)
  })

  test('a folder entry with a body is refused', async () => {
    await expect(readTar(chunks(rawHeader('d/', 5, '5'), Buffer.from('abcde'), pad(5), Buffer.alloc(1024)), async () => {})).rejects.toThrow(/folder entry/)
  })

  test('when the consumer stops early, the source generator is closed (open files released)', async () => {
    let closed = false
    async function* src() { try { for (let i = 0; i < 1000; i++) yield crypto.getRandomValues(new Uint8Array(64 * 1024)) } finally { closed = true } }
    for await (const _ of zstdCompress(src())) break
    for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(10)
    expect(closed).toBe(true)
  })

  test('extract with replace: a folder becomes a file and a file becomes a folder', async () => {
    const dest = path.join(W, 'replace')
    fs.mkdirSync(path.join(dest, 'was-dir', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'was-dir', 'sub', 'f'), 'x')
    fs.writeFileSync(path.join(dest, 'was-file'), 'y')
    const tar = tarStream([
      { name: 'was-dir', type: 'file', data: Buffer.from('now a file') },
      { name: 'was-file/inner.txt', type: 'file', data: Buffer.from('now inside a folder') },
    ])
    await extractTar(tar, dest, { replace: true })
    expect(fs.readFileSync(path.join(dest, 'was-dir'), 'utf8')).toBe('now a file')
    expect(fs.readFileSync(path.join(dest, 'was-file', 'inner.txt'), 'utf8')).toBe('now inside a folder')
  })
})
