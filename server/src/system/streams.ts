// Stream plumbing for backups, archives and exports: zstd (node:zlib, no CLI needed — stock macOS has none), age
// passphrase encryption (age-encryption, streaming; the age CLI needs a TTY for -p), and atomic file output.
// Everything is pull-based, so a slow disk slows the producer instead of filling memory.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { Decrypter, Encrypter } from 'age-encryption'
import { PRODUCT } from '@mycel/shared'

export type Bytes = AsyncIterable<Uint8Array>

function asUint8(c: unknown): Uint8Array {
  if (c instanceof Uint8Array) return c
  if (typeof c === 'string') return Buffer.from(c)
  return new Uint8Array(c as ArrayBuffer)
}

async function* fromNode(r: NodeJS.ReadableStream): AsyncGenerator<Uint8Array> {
  for await (const c of r as AsyncIterable<unknown>) yield asUint8(c)
}

/** src -> transform; when the consumer stops early (error, break) the source generator is closed too, so files it
 * has open (tarStream) are released instead of waiting forever in a suspended generator. */
function through(src: Bytes, z: NodeJS.ReadWriteStream & { destroy(e?: Error): void }): Bytes {
  const input = Readable.from(src)
  input.on('error', (e) => z.destroy(e))
  ;(z as unknown as NodeJS.EventEmitter).on('close', () => { if (!input.destroyed) input.destroy() })
  return fromNode(input.pipe(z))
}

export function zstdCompress(src: Bytes, level = 3): Bytes {
  return through(src, zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }))
}

export function zstdDecompress(src: Bytes): Bytes {
  return through(src, zlib.createZstdDecompress())
}

function toWebStream(src: Bytes): ReadableStream<Uint8Array> {
  const it = src[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const r = await it.next()
      if (r.done) ctl.close()
      else ctl.enqueue(r.value)
    },
    async cancel(reason) { await it.return?.(reason) },
  }, { highWaterMark: 4 })
}

async function* fromWeb(s: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const r = s.getReader()
  try {
    for (;;) {
      const { done, value } = await r.read()
      if (done) return
      yield value
    }
  } finally {
    r.releaseLock()
  }
}

/** age (https://age-encryption.org) with a passphrase (scrypt). Readable by `age -d`. */
export async function* ageEncrypt(src: Bytes, passphrase: string): AsyncGenerator<Uint8Array> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  yield* fromWeb(await e.encrypt(toWebStream(src)))
}

export class WrongPasswordError extends Error { name = 'WrongPasswordError' }

/** Decrypt an age stream. Every 64 KB chunk is authenticated; a tampered or truncated file throws part-way, so
 * callers must write into a temporary place and only use the result when the stream finished without error. */
export async function* ageDecrypt(src: Bytes, passphrase: string): AsyncGenerator<Uint8Array> {
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let out: ReadableStream<Uint8Array>
  try {
    out = await d.decrypt(toWebStream(src))
  } catch (e) {
    const m = String((e as Error).message ?? e)
    if (/passphrase|no identity|identity matched|incorrect|failed to decrypt/i.test(m)) throw new WrongPasswordError('wrong password or not an age file')
    throw e
  }
  yield* fromWeb(out)
}

/** First bytes of an age file ("age-encryption.org/v1"). */
export async function isAgeFile(file: string): Promise<boolean> {
  const fh = await fsp.open(file, 'r')
  try {
    const b = Buffer.alloc(21)
    await fh.read(b, 0, 21, 0)
    return b.toString('latin1') === 'age-encryption.org/v1'
  } finally {
    await fh.close()
  }
}

export async function* readFileChunks(file: string, chunk = 1 << 20): AsyncGenerator<Uint8Array> {
  for await (const c of fs.createReadStream(file, { highWaterMark: chunk })) yield asUint8(c)
}

/**
 * Write a stream to `file` atomically: into a hidden temp file next to it (server temp prefix, never visible to
 * file tools or the file screen), fsync, rename. On error the partial file is
 * removed and nothing appears at `file`. Returns size and sha256 of what was written.
 */
export async function writeAtomic(src: Bytes | Iterable<Uint8Array>, file: string, mode = 0o600): Promise<{ size: number; sha256: string }> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `${PRODUCT.tmpPrefix}${path.basename(file)}.partial`)
  const fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode)
  const h = crypto.createHash('sha256')
  let size = 0
  try {
    for await (const c of src) {
      h.update(c)
      size += c.byteLength
      let off = 0
      while (off < c.byteLength) off += (await fh.write(c, off)).bytesWritten
    }
    await fh.sync()
    await fh.close()
    await fsp.rename(tmp, file)
  } catch (e) {
    await fh.close().catch(() => {})
    await fsp.rm(tmp, { force: true })
    throw e
  }
  return { size, sha256: h.digest('hex') }
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const c of readFileChunks(file)) h.update(c)
  return h.digest('hex')
}

/** Count bytes flowing through (progress reporting). */
export async function* counted(src: Bytes, onBytes: (n: number) => void): AsyncGenerator<Uint8Array> {
  for await (const c of src) { onBytes(c.byteLength); yield c }
}
