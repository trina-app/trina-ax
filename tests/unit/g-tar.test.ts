// Component G: streaming tar / zstd / age used by backups, archives and exports.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ageDecrypt, ageEncrypt, isAgeFile, readFileChunks, WrongPasswordError, writeAtomic, zstdCompress, zstdDecompress } from '../../server/src/system/streams'
import { checkArchiveName, extractTar, readTar, tarStream, type TarEntryInput } from '../../server/src/system/tar'
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
