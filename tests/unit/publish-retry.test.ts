// Reads and uploads of the release feed (scripts/release/sign.ts, publish.ts, cloudflare.ts): a failed or cut read is
// tried again, "other content" is read again before it counts, a 404 only counts when the bucket agrees, and none of it
// can open a way to replace a published file or move a channel back. Fake fetches, a feed in memory and local sockets
// only; publish-server.test.ts has the same rules through publishServer.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { OFFICE_PRODUCT, signRelease, type OfficeRelease } from '../../server/src/office/release'
import { BUCKET, CfError, Cloudflare, openBucket, type Bucket } from '../../scripts/release/cloudflare'
import { cloudflareStore } from '../../scripts/release/publish-server'
import { alreadyPublished, publishToFeed, type Artifact } from '../../scripts/release/publish'
import { ABSENT_READS, CONFIRM_READS, compareRemote, feedReader, publicKeyOfPem, remoteBytes, remoteHash, remoteSize, RETRY_TRIES, steadyFetch, thereAnyway, TransientError, type RemoteFile } from '../../scripts/release/sign'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-retry-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const FILE = Buffer.from('the published file '.repeat(1000))
const hashOf = (b: Uint8Array): RemoteFile => ({ sha256: crypto.createHash('sha256').update(b).digest('hex'), size: b.byteLength })
const WANT = hashOf(FILE)
const URL_ = 'https://feed.test/server/0.3.0/a.tar.zst'

/** waits recorded, none waited for */
function quiet() {
  const waits: number[] = []
  return { waits, wait: async (ms: number) => { waits.push(ms) }, log: () => {} }
}

const whole = () => new Response(FILE, { headers: { 'content-length': String(FILE.length) } })
/** the body ends early, and the answer says how long it should have been */
const short = () => new Response(FILE.subarray(0, 100), { headers: { 'content-length': String(FILE.length) } })
const status = (s: number) => () => new Response('no', { status: s })
/** the stream breaks part of the way through */
const cut = () => new Response(new ReadableStream({
  start(c) { c.enqueue(FILE.subarray(0, 50)) },
  pull(c) { c.error(new Error('connection reset')) },
}))
const offline = (): Response => { throw new TypeError('network is down') }

/** a fetch that gives these answers in turn (the last one for ever) and keeps the addresses it was asked */
function fakeFetch(...answers: (() => Response)[]) {
  const urls: string[] = []
  const fetch = (async (u: string) => { urls.push(u); return answers[Math.min(urls.length, answers.length) - 1]!() }) as unknown as typeof globalThis.fetch
  return { fetch, urls }
}

describe('reading a file of the feed', () => {
  test('a short answer (Content-Length more than arrived) is read again, not hashed', async () => {
    const f = fakeFetch(short, whole)
    const q = quiet()
    expect(await remoteHash(URL_, { ...f, ...q })).toEqual(WANT)
    expect(f.urls.length).toBe(2)
    expect(q.waits.length).toBe(1)
  })

  test('a body that only ever arrives short throws after the last try: no hash, and not "absent"', async () => {
    const f = fakeFetch(short)
    await expect(remoteHash(URL_, { ...f, ...quiet() })).rejects.toBeInstanceOf(TransientError)
    expect(f.urls.length).toBe(RETRY_TRIES)
  })

  test('bytes are checked like a hash: a short small file is never handed over', async () => {
    const f = fakeFetch(short, whole)
    expect(Buffer.from((await remoteBytes(URL_, { ...f, ...quiet() }))!).equals(FILE)).toBe(true)
    expect(f.urls.length).toBe(2)
    const always = fakeFetch(short)
    await expect(remoteBytes(URL_, { ...always, ...quiet() })).rejects.toThrow(/100 of \d+ bytes/)
  })

  test('a 502 then a good answer', async () => {
    const f = fakeFetch(status(502), status(503), whole)
    expect(await remoteHash(URL_, { ...f, ...quiet() })).toEqual(WANT)
    expect(f.urls.length).toBe(3)
  })

  test('5xx for good throws after the last try', async () => {
    const f = fakeFetch(status(502))
    const q = quiet()
    await expect(remoteHash(URL_, { ...f, ...q })).rejects.toThrow(/HTTP 502/)
    expect(f.urls.length).toBe(RETRY_TRIES)
    expect(q.waits).toEqual([2000, 4000, 8000, 16000])
  })

  test('a stream that breaks and a network error are read again', async () => {
    const a = fakeFetch(cut, whole)
    expect(await remoteHash(URL_, { ...a, ...quiet() })).toEqual(WANT)
    expect(a.urls.length).toBe(2)
    const b = fakeFetch(offline, whole)
    expect(await remoteHash(URL_, { ...b, ...quiet() })).toEqual(WANT)
    expect(b.urls.length).toBe(2)
  })

  test('another 4xx stops at once', async () => {
    const f = fakeFetch(status(403))
    await expect(remoteHash(URL_, { ...f, ...quiet() })).rejects.toThrow(/HTTP 403/)
    expect(f.urls.length).toBe(1)
  })

  test('a function gives every try its own address', async () => {
    let n = 0
    const f = fakeFetch(status(502), short, whole)
    await remoteHash(() => `${URL_}?t=${++n}`, { ...f, ...quiet() })
    expect(f.urls).toEqual([`${URL_}?t=1`, `${URL_}?t=2`, `${URL_}?t=3`])
  })

  test('Content-Length of a compressed answer counts the wire, not the file', async () => {
    const gz = zlib.gzipSync(FILE)
    const f = fakeFetch(() => new Response(FILE, { headers: { 'content-encoding': 'gzip', 'content-length': String(gz.length) } }))
    expect(await remoteHash(URL_, { ...f, ...quiet() })).toEqual(WANT)
    expect(f.urls.length).toBe(1)
  })

  test('over a real socket: a connection closed part of the way is read again; a compressed answer passes', async () => {
    let n = 0
    const gz = zlib.gzipSync(FILE)
    const server = net.createServer((s) => {
      s.once('data', (d) => {
        n++
        if (d.toString().startsWith('GET /gz')) { s.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\nConnection: close\r\n\r\n`); s.end(gz) }
        else if (n === 1) { s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${FILE.length}\r\nConnection: close\r\n\r\n`); s.end(FILE.subarray(0, 100)) }
        else { s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${FILE.length}\r\nConnection: close\r\n\r\n`); s.end(FILE) }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
      expect(await remoteHash(`${origin}/a`, quiet())).toEqual(WANT)
      expect(n).toBe(2)
      expect(await remoteHash(`${origin}/gz`, quiet())).toEqual(WANT)
    } finally {
      server.close()
    }
  })

  test('remoteSize: tried like a read, a 404 included (the file was just uploaded), and never made up', async () => {
    const answer = () => new Response(null, { headers: { 'content-length': '7' } })
    const f = fakeFetch(status(502), status(404), () => new Response(null), answer)
    const q = quiet()
    expect(await remoteSize(URL_, { ...f, ...q })).toBe(7)
    expect(f.urls.length).toBe(4)
    await expect(remoteSize(URL_, { ...fakeFetch(status(403)), ...q })).rejects.toThrow(/HTTP 403/)
    await expect(remoteSize(URL_, { ...fakeFetch(status(404)), ...q })).rejects.toBeInstanceOf(TransientError)
  })

  test('steadyFetch: a file that must be there is read until it answers, for code that gives up at once', async () => {
    const f = fakeFetch(status(502), status(404), short, whole)
    const r = await steadyFetch(f.fetch, quiet())(URL_, { redirect: 'error' })
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer()).equals(FILE)).toBe(true)
    expect(f.urls.length).toBe(4)
    await expect(steadyFetch(fakeFetch(status(404)).fetch, quiet())(URL_)).rejects.toBeInstanceOf(TransientError)
  })
})

describe('what a 404 means', () => {
  test('with nobody to ask: only after ABSENT_READS reads, whatever came between', async () => {
    const f = fakeFetch(status(404))
    const q = quiet()
    expect(await remoteHash(URL_, { ...f, ...q })).toBeNull()
    expect(f.urls.length).toBe(ABSENT_READS)
    expect(q.waits).toEqual([2000, 4000])
    // the one answer that used to count as "not there", and a 502 in front of it, both found the file
    const there = fakeFetch(status(404), whole)
    expect(await remoteHash(URL_, { ...there, ...quiet() })).toEqual(WANT)
    const after502 = fakeFetch(status(502), status(404), whole)
    expect(await remoteHash(URL_, { ...after502, ...quiet() })).toEqual(WANT)
    const mixed = fakeFetch(status(502), status(404), status(404), status(404))
    expect(await remoteHash(URL_, { ...mixed, ...quiet() })).toBeNull()
  })

  test('when asked: yes is an answer at once; no is read again and in the end an error, never "not there"', async () => {
    const yes = fakeFetch(status(404))
    let asked = 0
    expect(await remoteHash(URL_, { ...yes, ...quiet(), notFound: async () => { asked++; return true } })).toBeNull()
    expect([yes.urls.length, asked]).toEqual([1, 1])
    const seen = fakeFetch(status(404), status(404), whole)
    expect(await remoteHash(URL_, { ...seen, ...quiet(), notFound: thereAnyway })).toEqual(WANT)
    const never = fakeFetch(status(404))
    await expect(remoteHash(URL_, { ...never, ...quiet(), notFound: thereAnyway })).rejects.toThrow(/HTTP 404, but the file is there/)
    expect(never.urls.length).toBe(RETRY_TRIES)
  })

  test('asking fails: the read stops, it does not fall back on the 404', async () => {
    const f = fakeFetch(status(404))
    await expect(remoteHash(URL_, { ...f, ...quiet(), notFound: async () => { throw new CfError('list: HTTP 403 ') } })).rejects.toBeInstanceOf(CfError)
    expect(f.urls.length).toBe(1)
    const trouble = fakeFetch(status(404))
    await expect(remoteHash(URL_, { ...trouble, ...quiet(), notFound: async () => { throw new TransientError('list: HTTP 502') } })).rejects.toBeInstanceOf(TransientError)
    expect(trouble.urls.length).toBe(RETRY_TRIES)
  })

  test('feedReader asks the bucket about the key that answered 404', async () => {
    const asked: string[] = []
    const f = fakeFetch(status(404), whole)
    const read = feedReader('https://feed.test/', { ...f, ...quiet(), holds: async (k) => { asked.push(k); return true } })
    expect(await read.hash('server/0.3.0/a.tar.zst')).toEqual(WANT)
    expect(asked).toEqual(['server/0.3.0/a.tar.zst'])
    expect(f.urls.every((u) => /^https:\/\/feed\.test\/server\/0\.3\.0\/a\.tar\.zst\?t=\d+$/.test(u))).toBe(true)
  })
})

describe('compareRemote', () => {
  const OTHER = hashOf(Buffer.from('other content'))
  const reader = (...reads: (RemoteFile | null | Error)[]) => {
    let n = 0
    const read = async () => {
      const r = reads[Math.min(n++, reads.length - 1)]!
      if (r instanceof Error) throw r
      return r
    }
    return { read, count: () => n }
  }

  test('what a read says is not there is absent; same at once when it matches', async () => {
    const a = reader(null, WANT)
    expect(await compareRemote('x', a.read, WANT, quiet())).toBe('absent')
    expect(a.count()).toBe(1)
    const b = reader(WANT)
    expect(await compareRemote('x', b.read, WANT, quiet())).toBe('same')
    expect(b.count()).toBe(1)
  })

  test('other bytes on one read, then the right ones: same', async () => {
    const r = reader(OTHER, WANT)
    const q = quiet()
    expect(await compareRemote('x', r.read, WANT, q)).toBe('same')
    expect(r.count()).toBe(2)
    expect(q.waits).toEqual([5000])
  })

  test('other bytes on every read: different, after CONFIRM_READS reads', async () => {
    const r = reader(OTHER)
    expect(await compareRemote('x', r.read, WANT, quiet())).toBe('different')
    expect(r.count()).toBe(CONFIRM_READS)
  })

  test('the right hash with another size is different too', async () => {
    const r = reader({ sha256: WANT.sha256, size: WANT.size + 1 })
    expect(await compareRemote('x', r.read, WANT, quiet())).toBe('different')
  })

  test('a file seen with other bytes that then is not there never becomes absent (an upload would replace it)', async () => {
    const r = reader(OTHER, null, null)
    expect(await compareRemote('x', r.read, WANT, quiet())).toBe('different')
    expect(r.count()).toBe(CONFIRM_READS)
  })

  test('a read that fails for good on the way throws: nothing is known', async () => {
    const r = reader(OTHER, new TransientError('still 502'))
    await expect(compareRemote('x', r.read, WANT, quiet())).rejects.toThrow('still 502')
  })
})

// ---------------- the office feed, the whole way through publish.ts ----------------

type Fault = number | 'neterror' | 'short' | 'wrong'

/** A feed and the bucket behind it, in memory. A key's faults answer its next reads through the feed, one each; the bucket
 * always tells the truth. */
function memoryFeed(objects: Record<string, string | Uint8Array> = {}, origin = 'https://feed.test') {
  const bucket = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)]))
  const faults = new Map<string, Fault[]>()
  const reads: string[] = [], puts: string[] = [], asked: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    reads.push(`${method} ${url}`)
    const key = decodeURIComponent(new URL(url).pathname.slice(1))
    if (key === '') return new Response('Updates: office/, server/, plugins/\n')
    const v = bucket.get(key)
    const fault = faults.get(key)?.shift()
    if (fault === 'neterror') throw new TypeError('The socket connection was closed unexpectedly')
    if (typeof fault === 'number') return new Response('fault', { status: fault })
    if (fault === 'short') return new Response(v!.subarray(0, 10), { headers: { 'content-length': String(v!.length) } })
    if (fault === 'wrong') return new Response(Buffer.alloc(v!.length), { headers: { 'content-length': String(v!.length) } })
    if (!v) return new Response('Not found\n', { status: 404 })
    return new Response(method === 'HEAD' ? null : new Uint8Array(v), { headers: { 'content-length': String(v.length) } })
  }) as typeof globalThis.fetch
  const holds = async (key: string) => { asked.push(key); return bucket.has(key) }
  const put = async (key: string, file: string) => { puts.push(key); bucket.set(key, fs.readFileSync(file)) }
  const the: Bucket = { holds, put }
  return { origin, bucket, faults, reads, puts, asked, fetch, the, fail: (key: string, ...f: Fault[]) => faults.set(key, f) }
}

const OFFICE_PEM = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const OFFICE_KEYS = [publicKeyOfPem(OFFICE_PEM)]
const ORIGIN = 'https://feed.test'

function officeBuild(version: string, channel: 'stable' | 'beta', body = `office ${version}`) {
  const file = path.join(T, `office-${crypto.randomBytes(4).toString('hex')}.zip`)
  fs.writeFileSync(file, body)
  const name = `office-${version}.zip`
  const meta = { file: name, url: `${ORIGIN}/office/${version}/${name}`, ...hashOf(Buffer.from(body)) }
  const arts: Artifact[] = [{ key: `office/${version}/${name}`, file, type: 'application/zip', meta }]
  const release: OfficeRelease = { format: 1, product: OFFICE_PRODUCT, channel, version, minFrom: '0.2.0-0', publishedAt: '2026-10-01T00:00:00.000Z', notes: '', office: [{ ...meta, arch: 'universal' }], windows: null }
  return { arts, release, signed: signRelease(release, OFFICE_PEM), body }
}

function run(feed: ReturnType<typeof memoryFeed>, b: ReturnType<typeof officeBuild>, over: { ifNewer?: boolean; dryRun?: boolean; bucket?: Bucket | null } = {}) {
  return publishToFeed({ feed: feed.origin, ...b, ifNewer: false, dryRun: false, keys: OFFICE_KEYS, bucket: feed.the, fetch: feed.fetch, retry: quiet(), log: () => {}, ...over })
}

/** beta at 0.3.0-beta.1, and a stable 0.2.20 that offers itself to beta with --if-newer */
function betaAhead() {
  const ahead = officeBuild('0.3.0-beta.1', 'beta')
  const feed = memoryFeed({ 'office/beta.json': ahead.signed, [ahead.arts[0]!.key]: ahead.body })
  return { feed, older: officeBuild('0.2.20', 'beta'), head: Buffer.from(ahead.signed) }
}

/** 0.2.20 published on beta: its manifest is kept for good, the head and the zip are there */
function published() {
  const first = officeBuild('0.2.20', 'beta')
  const feed = memoryFeed({ 'office/beta.json': first.signed, 'office/0.2.20/beta.json': first.signed, [first.arts[0]!.key]: first.body })
  const rerun = { ...first, release: { ...first.release, publishedAt: '2026-11-01T00:00:00.000Z' } }
  return { feed, kept: Buffer.from(first.signed), rerun: { ...rerun, signed: signRelease(rerun.release, OFFICE_PEM) } }
}

describe('publish.ts: what is already on the feed', () => {
  const art = (over: Partial<RemoteFile> = {}): Artifact => ({ key: 'office/0.3.0/a.zip', file: '/nonexistent', type: 'application/zip', meta: { file: 'a.zip', url: `${ORIGIN}/office/0.3.0/a.zip`, ...WANT, ...over } })
  const reader = (f: ReturnType<typeof fakeFetch>, holds = async () => false) => feedReader(ORIGIN, { ...f, ...quiet(), holds })

  test('a short read, then the same file: skipped, no error', async () => {
    const a = art()
    expect([...await alreadyPublished([a], reader(fakeFetch(short, whole)), quiet())]).toEqual([a])
  })

  test('one wrong read of the whole length, then the same file: skipped, no error (the 0.2.19 publish)', async () => {
    const a = art()
    const wrong = Buffer.from(FILE)
    wrong[7] = 0
    const f = fakeFetch(() => new Response(wrong, { headers: { 'content-length': String(wrong.length) } }), whole)
    expect([...await alreadyPublished([a], reader(f), quiet())]).toEqual([a])
  })

  test('really other content is refused as before, after reading it again', async () => {
    const other = Buffer.from('a rebuilt zip of the same version')
    const f = fakeFetch(() => new Response(other))
    await expect(alreadyPublished([art()], reader(f), quiet())).rejects.toThrow(/is already published with other content: publish a new version instead/)
    expect(f.urls.length).toBe(CONFIRM_READS)
  })

  test('not on the feed, and the bucket agrees: to be uploaded', async () => {
    expect((await alreadyPublished([art()], reader(fakeFetch(status(404))), quiet())).size).toBe(0)
  })

  test('a 404 the bucket does not agree with is not "to be uploaded": the file is read again', async () => {
    const a = art()
    expect([...await alreadyPublished([a], reader(fakeFetch(status(404), whole), async () => true), quiet())]).toEqual([a])
  })

  test('a feed that cannot be read stops the publish: nothing goes up on a guess', async () => {
    const f = fakeFetch(status(502))
    await expect(alreadyPublished([art()], reader(f), quiet())).rejects.toBeInstanceOf(TransientError)
    expect(f.urls.length).toBe(RETRY_TRIES)
  })

  test('every read has ?t=, a new one each time (past the CDN copy)', async () => {
    const f = fakeFetch(status(502), short, () => new Response('other'), whole)
    await alreadyPublished([art()], feedReader(ORIGIN, { ...f, wait: () => Bun.sleep(2), log: () => {} }), { wait: () => Bun.sleep(2), log: () => {} })
    expect(f.urls.length).toBe(4)
    for (const u of f.urls) expect(u).toMatch(/^https:\/\/feed\.test\/office\/0\.3\.0\/a\.zip\?t=\d+$/)
    expect(new Set(f.urls).size).toBe(4)
  })
})

describe('publish.ts: the channel head and the kept manifest', () => {
  test('a first publish: zip, the version manifest, the head last', async () => {
    const feed = memoryFeed()
    const b = officeBuild('0.2.20', 'beta')
    expect(await run(feed, b)).toBe('published')
    expect(feed.puts).toEqual([b.arts[0]!.key, 'office/0.2.20/beta.json', 'office/beta.json'])
  })

  // the head was at 0.3.0-beta.1 and became 0.2.20, exit 0: `.catch(() => null)` read a network error as "no head"
  test('a network error on the head does not skip "never back": read again, the head stays', async () => {
    const { feed, older, head } = betaAhead()
    feed.fail('office/beta.json', 'neterror')
    expect(await run(feed, older, { ifNewer: true })).toBe('head-stays')
    expect(feed.bucket.get('office/beta.json')!.equals(head)).toBe(true)
  })

  test('a head that stays unreadable stops the run before anything goes up', async () => {
    const { feed, older, head } = betaAhead()
    feed.fail('office/beta.json', ...Array<Fault>(RETRY_TRIES).fill('neterror'))
    await expect(run(feed, older, { ifNewer: true })).rejects.toBeInstanceOf(TransientError)
    expect(feed.puts).toEqual([])
    expect(feed.bucket.get('office/beta.json')!.equals(head)).toBe(true)
  })

  test('a 502 and a short answer on the head are read again; without --if-newer the older version is refused', async () => {
    for (const fault of [502, 'short'] as const) {
      const { feed, older } = betaAhead()
      feed.fail('office/beta.json', fault)
      await expect(run(feed, older)).rejects.toThrow(/beta is at 0\.3\.0-beta\.1; 0\.2\.20 is older/)
      expect(feed.puts).toEqual([])
    }
  })

  test('a 404 on the head does not skip "never back": the bucket holds it, so it is read again', async () => {
    const { feed, older, head } = betaAhead()
    feed.fail('office/beta.json', 404, 404)
    expect(await run(feed, older, { ifNewer: true })).toBe('head-stays')
    expect(feed.bucket.get('office/beta.json')!.equals(head)).toBe(true)
    expect(feed.asked).toContain('office/beta.json')
  })

  test('a feed that keeps saying 404 for a head the bucket holds stops the run', async () => {
    const { feed, older } = betaAhead()
    feed.fail('office/beta.json', ...Array<Fault>(RETRY_TRIES).fill(404))
    await expect(run(feed, older, { ifNewer: true })).rejects.toThrow(/HTTP 404, but the file is there/)
    expect(feed.puts).toEqual([])
  })

  test('one 404 on the version manifest does not replace what is kept for good', async () => {
    const { feed, kept, rerun } = published()
    feed.fail('office/0.2.20/beta.json', 404)
    expect(await run(feed, rerun)).toBe('published')
    expect(feed.puts).toEqual(['office/beta.json'])
    expect(feed.bucket.get('office/0.2.20/beta.json')!.equals(kept)).toBe(true)
  })

  test('a 502 and a network error on the version manifest are read again', async () => {
    for (const fault of [502, 'neterror'] as const) {
      const { feed, kept, rerun } = published()
      feed.fail('office/0.2.20/beta.json', fault)
      expect(await run(feed, rerun)).toBe('published')
      expect(feed.bucket.get('office/0.2.20/beta.json')!.equals(kept)).toBe(true)
    }
  })

  test('a 404 on a published zip does not send other bytes over it', async () => {
    const { feed, rerun } = published()
    const rebuilt = officeBuild('0.2.20', 'beta', 'a rebuild of the same version')
    const zip = rerun.arts[0]!.key
    const before = feed.bucket.get(zip)!
    feed.fail(zip, 404)
    await expect(run(feed, { ...rebuilt, arts: [{ ...rebuilt.arts[0]!, key: zip }] })).rejects.toThrow(/already published with other content/)
    expect(feed.puts).toEqual([])
    expect(feed.bucket.get(zip)!.equals(before)).toBe(true)
  })

  test('the bucket cannot be asked: nothing goes up', async () => {
    const feed = memoryFeed()
    const denied: Bucket = { ...feed.the, holds: async () => { throw new CfError('list: HTTP 403 ', 403) } }
    await expect(run(feed, officeBuild('0.2.20', 'beta'), { bucket: denied })).rejects.toBeInstanceOf(CfError)
    expect(feed.puts).toEqual([])
  })

  test('reads after the upload are read again: the HEAD of the zip (with its own ?t=), the head of the channel', async () => {
    const feed = memoryFeed()
    const b = officeBuild('0.2.20', 'beta')
    const put = feed.the.put
    const the: Bucket = { ...feed.the, put: async (k, f, t) => { await put(k, f, t); if (k === 'office/beta.json') feed.fail(k, 502, 404, 'short') } }
    expect(await run(feed, b, { bucket: the })).toBe('published')
    const heads = feed.reads.filter((r) => r.startsWith('HEAD '))
    expect(heads.length).toBe(1)
    expect(heads[0]).toMatch(/\?t=\d+$/)
  })

  test('nothing can be uploaded without the bucket; a dry run can go without it, and three 404s are its answer', async () => {
    const feed = memoryFeed()
    const b = officeBuild('0.2.20', 'beta')
    await expect(run(feed, b, { bucket: null })).rejects.toThrow(/uploading needs the bucket/)
    expect(feed.reads).toEqual([])
    expect(await run(feed, b, { bucket: null, dryRun: true })).toBe('dry-run')
    expect(feed.puts).toEqual([])
    expect(feed.reads.filter((r) => r.includes('office/beta.json')).length).toBe(ABSENT_READS)
  })

  test('a dry run with the bucket asks it, so a token can be tried before a release', async () => {
    const feed = memoryFeed()
    expect(await run(feed, officeBuild('0.2.20', 'beta'), { dryRun: true })).toBe('dry-run')
    expect(feed.puts).toEqual([])
    expect(feed.asked).toContain('office/beta.json')
  })
})

describe('cloudflareStore', () => {
  const store = (feed: ReturnType<typeof memoryFeed>) => cloudflareStore(feed.origin, { bucket: feed.the, fetch: feed.fetch, retry: quiet() })

  test('get: a 502, a network error and a short answer are read again, each with its own ?t=', async () => {
    const feed = memoryFeed({ 'server/beta.json': FILE })
    feed.fail('server/beta.json', 502, 'neterror', 'short')
    const s = await cloudflareStore(feed.origin, { bucket: feed.the, fetch: feed.fetch, retry: { wait: () => Bun.sleep(2), log: () => {} } })
    expect(Buffer.from((await s.get('server/beta.json'))!).equals(FILE)).toBe(true)
    const urls = feed.reads.filter((r) => r.includes('server/beta.json'))
    expect(urls.length).toBe(4)
    expect(new Set(urls).size).toBe(4)
    for (const u of urls) expect(u).toMatch(/\?t=\d+$/)
  })

  test('get and stat: null only when the bucket agrees', async () => {
    const feed = memoryFeed({ 'server/beta.json': FILE })
    const s = await store(feed)
    expect(await s.get('server/none.json')).toBeNull()
    expect(await s.stat('server/none.json')).toBeNull()
    feed.fail('server/beta.json', 404)
    expect(Buffer.from((await s.get('server/beta.json'))!).equals(FILE)).toBe(true)
    feed.fail('server/beta.json', 404)
    expect(await s.stat('server/beta.json')).toEqual(WANT)
    feed.fail('server/beta.json', ...Array<Fault>(RETRY_TRIES).fill(404))
    await expect(s.get('server/beta.json')).rejects.toThrow(/HTTP 404, but the file is there/)
  })

  test('stat: a 502 is read again; a read that fails for good throws, it is not "absent"', async () => {
    const feed = memoryFeed({ 'server/a.bin': FILE })
    const s = await store(feed)
    feed.fail('server/a.bin', 502)
    expect(await s.stat('server/a.bin')).toEqual(WANT)
    feed.fail('server/a.bin', ...Array<Fault>(RETRY_TRIES).fill(502))
    await expect(s.stat('server/a.bin')).rejects.toThrow(/HTTP 502/)
  })

  test('the feed\'s first page: a 502 is read again; an old Worker and a dead feed are told apart', async () => {
    const good = fakeFetch(status(502), () => new Response('Updates: office/, server/, plugins/\n'))
    await expect(cloudflareStore(ORIGIN, { bucket: memoryFeed().the, fetch: good.fetch, retry: quiet() })).resolves.toBeDefined()
    expect(good.urls.length).toBe(2)
    await expect(cloudflareStore(ORIGIN, { bucket: memoryFeed().the, fetch: fakeFetch(() => new Response('Office updates\n')).fetch, retry: quiet() })).rejects.toThrow(/does not serve server\/ yet/)
    await expect(cloudflareStore(ORIGIN, { bucket: memoryFeed().the, fetch: fakeFetch(status(502)).fetch, retry: quiet() })).rejects.toThrow(/HTTP 502/)
  })

  test('uploads go to the bucket', async () => {
    const feed = memoryFeed()
    const file = path.join(T, 'store-put.bin')
    fs.writeFileSync(file, 'bytes')
    await (await store(feed)).put('server/x.bin', file, 'application/octet-stream')
    expect(feed.puts).toEqual(['server/x.bin'])
  })
})

describe('the Cloudflare API', () => {
  const file = path.join(T, 'upload.bin')
  fs.writeFileSync(file, 'the bytes')
  const ok = () => Response.json({ success: true, result: {} })
  const failed = (s: number) => () => Response.json({ success: false, errors: [{ code: 10001, message: 'bad gateway' }] }, { status: s })
  const listed = (keys: string[], more = false) => () => Response.json({ success: true, errors: [], messages: [], result: keys.map((key) => ({ key, size: 1, etag: 'e' })), result_info: { is_truncated: more, per_page: 1000 } })

  class FakeCloudflare extends Cloudflare {
    calls: { method: string; path: string; body: string; signal?: AbortSignal }[] = []
    constructor(private answers: (() => Response)[]) { super('test-token') }
    override async raw(method: string, p: string, body?: BodyInit, _headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
      this.calls.push({ method, path: p, body: body ? await (body as Blob).text() : '', signal })
      return this.answers[Math.min(this.calls.length, this.answers.length) - 1]!()
    }
  }
  const put = (cf: Cloudflare, o = quiet(), f = file) => cf.putObject('acct', 'server/0.3.0/a b.bin', f, 'application/octet-stream', o)

  test('putObject: a 502 is tried again with the whole file, to the same key, with a time limit', async () => {
    const cf = new FakeCloudflare([failed(502), failed(503), ok])
    const q = quiet()
    await put(cf, q)
    expect(cf.calls.map((c) => c.body)).toEqual(['the bytes', 'the bytes', 'the bytes'])
    expect(new Set(cf.calls.map((c) => c.path))).toEqual(new Set(['/accounts/acct/r2/buckets/' + BUCKET + '/objects/server/0.3.0/a%20b.bin']))
    expect(cf.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
    expect(q.waits).toEqual([2000, 4000])
  })

  test('putObject: a network error is tried again', async () => {
    const cf = new FakeCloudflare([offline, ok])
    await put(cf)
    expect(cf.calls.length).toBe(2)
  })

  test('putObject: 502 for good stops after the last try and says so', async () => {
    const cf = new FakeCloudflare([failed(502)])
    await expect(put(cf)).rejects.toThrow(/^upload server\/0\.3\.0\/a b\.bin: HTTP 502 10001 bad gateway$/)
    expect(cf.calls.length).toBe(RETRY_TRIES)
  })

  test('putObject: a refused upload is not tried again', async () => {
    for (const answer of [failed(403), () => Response.json({ success: false, errors: [] })]) {
      const cf = new FakeCloudflare([answer])
      await expect(put(cf)).rejects.toBeInstanceOf(CfError)
      expect(cf.calls.length).toBe(1)
    }
  })

  test('putObject: a local file that is not there stops at once, it is no trouble of the network', async () => {
    const cf = new FakeCloudflare([ok])
    const q = quiet()
    await expect(put(cf, q, path.join(T, 'nothing.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cf.calls.length).toBe(0)
    expect(q.waits).toEqual([])
  })

  const key = 'server/0.3.0/release.json'

  test('hasObject: lists by prefix; only the exact key counts', async () => {
    const yes = new FakeCloudflare([listed([key, `${key}.sig`])])
    expect(await yes.hasObject('acct', key)).toBe(true)
    expect(yes.calls[0]!.method).toBe('GET')
    const u = new URL(`https://api.test${yes.calls[0]!.path}`)
    expect(u.pathname).toBe(`/accounts/acct/r2/buckets/${BUCKET}/objects`)
    expect(u.searchParams.get('prefix')).toBe(key)
    expect(yes.calls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(await new FakeCloudflare([listed([`${key}.sig`])]).hasObject('acct', key)).toBe(false)
    expect(await new FakeCloudflare([listed([])]).hasObject('acct', key)).toBe(false)
  })

  test('hasObject: only a list that was really answered can say "not there"', async () => {
    const no = (a: () => Response) => new FakeCloudflare([a]).hasObject('acct', key)
    // a missing bucket, a token without the right, an answer that is no list: never "not there"
    await expect(no(() => Response.json({ success: false, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }] }, { status: 404 }))).rejects.toBeInstanceOf(CfError)
    await expect(no(failed(403))).rejects.toBeInstanceOf(CfError)
    await expect(no(() => Response.json({ success: true }))).rejects.toBeInstanceOf(CfError)
    await expect(no(() => Response.json({ success: false, result: [] }))).rejects.toBeInstanceOf(CfError)
    await expect(no(listed([], true))).rejects.toThrow(/cut off/)
  })

  test('hasObject: a server in trouble is transient, for the read around it to try again', async () => {
    await expect(new FakeCloudflare([failed(502)]).hasObject('acct', key)).rejects.toBeInstanceOf(TransientError)
    await expect(new FakeCloudflare([offline]).hasObject('acct', key)).rejects.toBeInstanceOf(TransientError)
    await expect(new FakeCloudflare([() => new Response('<html>')]).hasObject('acct', key)).rejects.toBeInstanceOf(TransientError)
    const read = feedReader(ORIGIN, { ...fakeFetch(status(404)), ...quiet(), holds: (k) => new FakeCloudflare([failed(502)]).hasObject('acct', k) })
    await expect(read.bytes(key)).rejects.toThrow(/list server\/0\.3\.0\/release\.json: HTTP 502/)
  })

  test('accountAndZone: a 502 and a network error are tried again, a refusal is not', async () => {
    const zones = () => Response.json({ success: true, result: [{ id: 'z', account: { id: 'a' } }] })
    const cf = new FakeCloudflare([failed(502), offline, zones])
    expect(await cf.accountAndZone(quiet())).toEqual({ account: 'a', zone: 'z' })
    expect(cf.calls.length).toBe(3)
    const denied = new FakeCloudflare([failed(403)])
    await expect(denied.accountAndZone(quiet())).rejects.toBeInstanceOf(CfError)
    expect(denied.calls.length).toBe(1)
  })

  test('openBucket: holds and put are the API\'s, for that account', async () => {
    const zones = () => Response.json({ success: true, result: [{ id: 'z', account: { id: 'acct' } }] })
    const cf = new FakeCloudflare([zones, listed([key]), ok])
    const b = await openBucket(cf, quiet())
    expect(await b.holds(key)).toBe(true)
    await b.put(key, file, 'application/json')
    expect(cf.calls.slice(1).every((c) => c.path.startsWith('/accounts/acct/r2/buckets/'))).toBe(true)
  })
})
