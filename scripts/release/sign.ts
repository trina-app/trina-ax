// Release signing, hashing and reading the feed, shared by the release scripts (release-ci.ts, publish-server.ts,
// publish.ts, plugins/release-hwp.ts). Light on purpose: node built-ins and the release channel only, so the release
// workflow's first job can check the tag and the key without installing the repository's packages.
//
// A detached signature file is the format of a bundle's manifest.sig and the server feed's .sig: {"keyId", "sig"},
// Ed25519 over the exact bytes, keyId = the first 16 hex digits of sha256(raw public key) (server/src/system/update.ts
// verifySignature reads it).
import crypto from 'node:crypto'
import fs from 'node:fs'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

/** sha256(raw 32-byte public key), first 16 hex digits (server/src/system/update.ts keyId) */
export const keyIdOfRaw = (raw: Uint8Array) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)

export class KeyError extends Error { name = 'KeyError' }

/** The private key of a PEM text, refusing anything that is not an Ed25519 private key. The message never carries the
 * text (it may be a secret pasted into the wrong place). */
function privateKey(pem: string): crypto.KeyObject {
  let k: crypto.KeyObject
  try { k = crypto.createPrivateKey(pem) } catch { throw new KeyError('the release key is not a private key in PEM form') }
  if (k.asymmetricKeyType !== 'ed25519') throw new KeyError(`the release key is ${k.asymmetricKeyType ?? 'unknown'}, not Ed25519`)
  return k
}

/** raw base64 Ed25519 public key of a PEM private key (what RELEASE_CHANNEL.keys lists) */
export function publicKeyOfPem(pem: string): string {
  const der = crypto.createPublicKey(privateKey(pem)).export({ format: 'der', type: 'spki' }) as Buffer
  return der.subarray(der.length - 32).toString('base64')
}

/**
 * The signing key must be one this product's builds trust (RELEASE_CHANNEL.keys): a key of another product (a fork's
 * secret pasted into this repository, or the other way round) would sign releases no installation accepts, or worse,
 * releases another product's installations accept. Returns the key id (public, safe to print).
 */
export function checkSigningKey(pem: string, keys: readonly string[] = RELEASE_CHANNEL.keys): string {
  const pub = publicKeyOfPem(pem)
  const id = keyIdOfRaw(Buffer.from(pub, 'base64'))
  if (!keys.includes(pub)) {
    const known = keys.map((k) => keyIdOfRaw(Buffer.from(k, 'base64'))).join(', ')
    throw new KeyError(`the release key (key id ${id}) is not one of this product's release keys (${known}; shared/src/release-channel.ts)`)
  }
  return id
}

/** Detached signature file ({keyId, sig} JSON + newline) over `data`. Ed25519 is deterministic: the same key and bytes
 * always give the same file. */
export function signDetached(data: Uint8Array, pem: string): string {
  const k = privateKey(pem)
  const id = keyIdOfRaw(Buffer.from(publicKeyOfPem(pem), 'base64'))
  return JSON.stringify({ keyId: id, sig: crypto.sign(null, data, k).toString('base64') }) + '\n'
}

/** Check a detached signature file against `keys` (the same rule as update.ts verifySignature). */
export function verifyDetached(data: Uint8Array, sigText: string, keys: readonly string[]): boolean {
  let s: { keyId?: unknown; sig?: unknown }
  try { s = JSON.parse(sigText) } catch { return false }
  if (typeof s.keyId !== 'string' || typeof s.sig !== 'string') return false
  for (const k of keys) {
    const raw = Buffer.from(k, 'base64')
    if (raw.length !== 32 || keyIdOfRaw(raw) !== s.keyId) continue
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    return crypto.verify(null, data, pub, Buffer.from(s.sig, 'base64'))
  }
  return false
}

/** Read a PEM file that must be readable only by its owner (the workflow writes it with umask 077). */
export function readKeyFile(file: string): string {
  const st = fs.statSync(file)
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new KeyError(`${file} must be a file readable only by you (chmod 600)`)
  return fs.readFileSync(file, 'utf8')
}

/** sha256 (or another digest) of a file, read in pieces */
export function hashFile(file: string, algo = 'sha256', enc: 'hex' | 'base64' = 'hex'): string {
  const h = crypto.createHash(algo)
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(4 << 20)
  try { for (let pos = 0; ;) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n } } finally { fs.closeSync(fd) }
  return h.digest(enc)
}

/** sha256 and size of a file: what the feed holds, or what a local file should find there */
export interface RemoteFile { sha256: string; size: number }

/** The release scripts' waiting and logging, replaced in tests. How long they keep trying is fixed below. */
export interface RetryOptions { wait?: (ms: number) => Promise<void>; log?: (line: string) => void }

/** Tries of one read or upload, and the wait before the second try, doubled each time: 30 seconds in all. */
export const RETRY_TRIES = 5
const RETRY_WAIT_MS = 2_000
/** Reads of a file before "other content" is believed (compareRemote), and the wait between them. */
export const CONFIRM_READS = 3
const CONFIRM_WAIT_MS = 5_000
/** 404s that count as "not there" when there is no bucket to ask (ReadOptions.notFound). Nothing may be uploaded on them. */
export const ABSENT_READS = 3
const READ_TIMEOUT_MS = 30 * 60_000
const HEAD_TIMEOUT_MS = 30_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A failure that says nothing about the feed: worth another try. Any other error stops at once. */
export class TransientError extends Error { name = 'TransientError' }

/** HTTP answers a server gives while it is in trouble, not about the request */
export const transientStatus = (status: number) => status >= 500 || status === 408 || status === 429

/** `once` until it stops failing with a TransientError, at most RETRY_TRIES times; then its last error. */
export async function retrying<T>(once: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await once() } catch (e) {
      if (!(e instanceof TransientError) || n >= RETRY_TRIES) throw e
      const ms = RETRY_WAIT_MS * 2 ** (n - 1)
      ;(o.log ?? console.warn)(`${e.message}: trying again in ${ms / 1000} s (${n} of ${RETRY_TRIES - 1})`)
      await (o.wait ?? sleep)(ms)
    }
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How the release scripts read the feed. */
export interface ReadOptions extends RetryOptions {
  fetch?: typeof fetch
  /**
   * What a 404 means. It decides whether a file goes up or a check is skipped, and it is only the answer of a Worker behind
   * a CDN, so it needs a second opinion: true = really not there, false = it is there, read again. Without this, ABSENT_READS
   * 404s some seconds apart count as not there: enough for a run that uploads nothing, not for one that does (feedReader).
   */
  notFound?: () => Promise<boolean>
}

/** For a file that must be there because it was just uploaded: a 404 is read again like a 502. */
export const thereAnyway = async () => false

interface Sink<T> { add(chunk: Uint8Array): void; done(size: number): T }
const hashing = (): Sink<RemoteFile> => {
  const h = crypto.createHash('sha256')
  return { add: (c) => { h.update(c) }, done: (size) => ({ sha256: h.digest('hex'), size }) }
}
const collecting = (): Sink<Uint8Array> => {
  const parts: Uint8Array[] = []
  return { add: (c) => { parts.push(c) }, done: () => new Uint8Array(Buffer.concat(parts)) }
}

/** One GET into `sink`; null on 404, TransientError when the answer cannot be the whole file. */
async function getOnce<T>(url: string, f: typeof fetch, sink: Sink<T>, init?: RequestInit): Promise<T | null> {
  let r: Response
  try { r = await f(url, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }) } catch (e) { throw new TransientError(`${url}: ${reason(e)}`) }
  if (r.status === 404) { await r.body?.cancel().catch(() => {}); return null }
  if (transientStatus(r.status)) { await r.body?.cancel().catch(() => {}); throw new TransientError(`${url}: HTTP ${r.status}`) }
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`)
  let size = 0
  try {
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) { sink.add(c); size += c.byteLength }
  } catch (e) { throw new TransientError(`${url}: stopped after ${size} bytes: ${reason(e)}`) }
  // Content-Length counts the bytes on the wire: of a compressed answer (Cloudflare compresses text) fetch hands over more
  const length = r.headers.get('content-encoding') ? null : r.headers.get('content-length')
  if (length !== null && Number(length) !== size) throw new TransientError(`${url}: ${size} of ${length} bytes`)
  return sink.done(size)
}

/**
 * Every read of the feed comes here. A network error, a server in trouble and a body of the wrong length are read again
 * (retrying), so an answer is always a whole file; when they go on the call throws, it never says the file is absent. A
 * 404 counts as ReadOptions.notFound says. Give `url` as a function to get a new address on every try (feedReader).
 */
async function readUrl<T>(url: string | (() => string), o: ReadOptions, sink: () => Sink<T>, init?: RequestInit): Promise<T | null> {
  const address = typeof url === 'string' ? () => url : url
  let notFounds = 0
  return retrying(async () => {
    const at = address()
    const got = await getOnce(at, o.fetch ?? fetch, sink(), init)
    if (got !== null) return got
    if (o.notFound ? await o.notFound() : ++notFounds >= ABSENT_READS) return null
    throw new TransientError(`${at}: HTTP 404${o.notFound ? ', but the file is there' : ''}`)
  }, o)
}

/** sha256 and size of what a URL answers; null when it is not there (readUrl). Streams: release files are large. */
export const remoteHash = (url: string | (() => string), o: ReadOptions = {}) => readUrl(url, o, hashing)

/** The bytes a URL answers, a small file; null when it is not there (readUrl). */
export const remoteBytes = (url: string | (() => string), o: ReadOptions = {}, init?: RequestInit) => readUrl(url, o, collecting, init)

/** Content-Length of a file that must be there; tried like a read, a 404 included. */
export async function remoteSize(url: string | (() => string), o: ReadOptions = {}): Promise<number> {
  const address = typeof url === 'string' ? () => url : url
  return retrying(async () => {
    const at = address()
    let r: Response
    try { r = await (o.fetch ?? fetch)(at, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) }) } catch (e) { throw new TransientError(`${at}: ${reason(e)}`) }
    await r.body?.cancel().catch(() => {})
    if (r.status === 404 || transientStatus(r.status)) throw new TransientError(`${at}: HTTP ${r.status}`)
    if (!r.ok) throw new Error(`${at}: HTTP ${r.status}`)
    const length = Number(r.headers.get('content-length') ?? NaN)
    if (!Number.isSafeInteger(length)) throw new TransientError(`${at}: no Content-Length`)
    return length
  }, o)
}

/**
 * The feed's files by key, as the publish scripts read them: every try has its own ?t=, which goes past the CDN's copy.
 * `holds` asks the bucket itself whether a key is there (cloudflare.ts Bucket), so a 404 only counts when the bucket agrees.
 * Without it (a dry run) a 404 only counts after ABSENT_READS reads: a run that uploads must give it.
 */
export function feedReader(origin: string, o: ReadOptions & { holds?: (key: string) => Promise<boolean> } = {}) {
  const base = origin.replace(/\/+$/, '')
  const url = (key: string) => () => `${base}/${key}?t=${Date.now()}`
  const options = (key: string): ReadOptions => (o.holds ? { ...o, notFound: async () => !(await o.holds!(key)) } : o)
  return {
    bytes: (key: string) => remoteBytes(url(key), options(key)),
    hash: (key: string) => remoteHash(url(key), options(key)),
    /** the bytes of a file just uploaded */
    back: async (key: string) => (await remoteBytes(url(key), { ...o, notFound: thereAnyway }))!,
    /** the length of a file just uploaded */
    size: (key: string) => remoteSize(url(key), o),
  }
}

/**
 * A fetch for code that reads small files once and gives up (UpdateManager.checkFeed): it answers with the whole file after
 * the tries of a read, a 404 included. For files that must be there.
 */
export function steadyFetch(f: typeof fetch, o: RetryOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new Response(new Uint8Array((await remoteBytes(url, { ...o, fetch: f, notFound: thereAnyway }, init))!))
  }) as typeof fetch
}

/**
 * Whether `read` (remoteHash, or a store's stat) finds `want` there. Other bytes are read again before they count: one wrong
 * read must not end a release, and only a right read can show the right sha256.
 *   absent     the first read says it is not there, which a read only says after asking (ReadOptions.notFound): the only
 *              answer a caller may upload on
 *   same       some read showed exactly `want`
 *   different  every read showed something else; "not there" after the first read is that too (a file seen a moment ago is
 *              not free to be replaced). Callers refuse, as they always did.
 * A read that fails for good throws: nothing is known, so nothing may be uploaded.
 */
export async function compareRemote(what: string, read: () => Promise<RemoteFile | null>, want: RemoteFile, o: RetryOptions = {}): Promise<'absent' | 'same' | 'different'> {
  let got = await read()
  if (!got) return 'absent'
  for (let n = 1; ; n++) {
    if (got && got.sha256 === want.sha256 && got.size === want.size) return 'same'
    if (n >= CONFIRM_READS) return 'different'
    ;(o.log ?? console.warn)(`${what}: ${got ? `${got.size} bytes, sha256 ${got.sha256}` : 'HTTP 404'}, not the expected ${want.size} bytes, sha256 ${want.sha256}: reading it again in ${CONFIRM_WAIT_MS / 1000} s`)
    await (o.wait ?? sleep)(CONFIRM_WAIT_MS)
    got = await read()
  }
}
