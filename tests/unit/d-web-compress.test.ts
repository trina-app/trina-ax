// Component D, static files of the web build: the build's compressed copies (web/scripts/compress-dist.ts) sent as they
// are when the browser takes them, with Vary; an ETag and 304 on every file; the notice folder never compressed.
// docs/DECISIONS.md "First load: compressed files, one language, formatting on demand".
import { beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { acceptedEncodings, COMPRESSIBLE, serveWeb } from '../../server/src/routes/web-static'
import { compressDist, compressTargets, COPY_MIN_BYTES } from '../../web/scripts/compress-dist'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'd-web-compress')
const DIST = path.join(BASE, 'dist')
const big = (s: string) => s.repeat(Math.ceil((COPY_MIN_BYTES * 4) / s.length))
const JS = big('export const words = "the same words again and again";\n')
const HTML = `<!doctype html><title>Team AX</title><div id="root"></div>${big('<!-- filler -->')}`

function write(p: string, s: string | Uint8Array) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
}

const get = (p: string, headers: Record<string, string> = {}) => serveWeb(new Request(`http://127.0.0.1:1${p}`, { headers }), { dist: DIST, dev: false, devPort: 0 })!
const body = async (r: Response) => Buffer.from(await r.arrayBuffer())

beforeAll(async () => {
  fs.rmSync(BASE, { recursive: true, force: true })
  write(path.join(DIST, 'index.html'), HTML)
  write(path.join(DIST, 'assets', 'index-abc123.js'), JS)
  write(path.join(DIST, 'assets', 'tiny-abc123.js'), 'export {}')
  write(path.join(DIST, 'assets', 'photo-abc123.png'), new Uint8Array(4096).fill(7))
  write(path.join(DIST, 'sw.js'), JS)
  write(path.join(DIST, 'licenses', 'manifest.json'), big('{"a":1}'))
  await compressDist(DIST)
})

describe('compress-dist', () => {
  test('copies of the text files, not of small files, images or the notice folder', () => {
    expect(compressTargets(DIST)).toEqual(['assets/index-abc123.js', 'index.html', 'sw.js'])
    for (const f of ['assets/index-abc123.js', 'index.html', 'sw.js']) {
      expect(zlib.brotliDecompressSync(fs.readFileSync(path.join(DIST, f + '.br'))).toString()).toBe(fs.readFileSync(path.join(DIST, f), 'utf8'))
      expect(zlib.gunzipSync(fs.readFileSync(path.join(DIST, f + '.gz'))).toString()).toBe(fs.readFileSync(path.join(DIST, f), 'utf8'))
    }
    expect(fs.existsSync(path.join(DIST, 'assets', 'tiny-abc123.js.br'))).toBe(false)
    expect(fs.existsSync(path.join(DIST, 'assets', 'photo-abc123.png.br'))).toBe(false)
    expect(fs.existsSync(path.join(DIST, 'licenses', 'manifest.json.br'))).toBe(false)
  })
  test('the server and the build name the same files', () => {
    expect(COMPRESSIBLE.test('a.js') && COMPRESSIBLE.test('a.css') && COMPRESSIBLE.test('a.svg') && COMPRESSIBLE.test('a.webmanifest')).toBe(true)
    expect(COMPRESSIBLE.test('a.png') || COMPRESSIBLE.test('a.woff2') || COMPRESSIBLE.test('a.js.br')).toBe(false)
  })
})

describe('Accept-Encoding', () => {
  test('Brotli first, then gzip; q=0 refuses; * stands for the others', () => {
    expect(acceptedEncodings('gzip, deflate, br, zstd')).toEqual(['br', 'gzip'])
    expect(acceptedEncodings('gzip, deflate')).toEqual(['gzip'])
    expect(acceptedEncodings('br;q=0, gzip;q=0.5')).toEqual(['gzip'])
    expect(acceptedEncodings('*')).toEqual(['br', 'gzip'])
    expect(acceptedEncodings('*;q=0, identity')).toEqual([])
    expect(acceptedEncodings('x-gzip')).toEqual(['gzip'])
    expect(acceptedEncodings(null)).toEqual([])
    expect(acceptedEncodings('identity')).toEqual([])
  })
})

describe('serving', () => {
  test('a hashed file: the Brotli copy, its own type, immutable, Vary', async () => {
    const r = get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate, br' })
    expect(r.headers.get('content-encoding')).toBe('br')
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(r.headers.get('vary')).toBe('Accept-Encoding')
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(zlib.brotliDecompressSync(await body(r)).toString()).toBe(JS)
  })
  test('over plain http (no br): gzip; nothing taken: the file as it is, still with Vary', async () => {
    const g = get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate' })
    expect(g.headers.get('content-encoding')).toBe('gzip')
    expect(zlib.gunzipSync(await body(g)).toString()).toBe(JS)
    const raw = get('/assets/index-abc123.js')
    expect(raw.headers.get('content-encoding')).toBeNull()
    expect(raw.headers.get('vary')).toBe('Accept-Encoding')
    expect((await body(raw)).toString()).toBe(JS)
  })
  test('the app shell: compressed, no-cache, an ETag per coding and 304 when it matches', async () => {
    const br = get('/some/page', { 'accept-encoding': 'br' })
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(br.headers.get('cache-control')).toBe('no-cache')
    expect(br.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(br.headers.get('last-modified')).toBeTruthy()
    const tagBr = br.headers.get('etag')!
    const tagRaw = get('/').headers.get('etag')!
    expect(tagBr).not.toBe(tagRaw)
    const again = get('/', { 'accept-encoding': 'br', 'if-none-match': tagBr })
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(tagBr)
    expect((await body(again)).length).toBe(0)
    // a validator of the other coding is not this representation
    expect(get('/', { 'accept-encoding': 'br', 'if-none-match': tagRaw }).status).toBe(200)
  })
  test('sw.js and other no-cache files revalidate to 304', () => {
    const first = get('/sw.js', { 'accept-encoding': 'gzip' })
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(first.headers.get('service-worker-allowed')).toBe('/')
    expect(get('/sw.js', { 'accept-encoding': 'gzip', 'if-none-match': first.headers.get('etag')! }).status).toBe(304)
  })
  test('the notice folder is never sent compressed, even with a copy beside it', async () => {
    write(path.join(DIST, 'licenses', 'manifest.json.gz'), zlib.gzipSync('{"other":true}'))
    const r = get('/licenses/manifest.json', { 'accept-encoding': 'gzip' })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect((await body(r)).toString()).toBe(fs.readFileSync(path.join(DIST, 'licenses', 'manifest.json'), 'utf8'))
  })
  test('an image is sent as it is, with no Vary', () => {
    const r = get('/assets/photo-abc123.png', { 'accept-encoding': 'br, gzip' })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('vary')).toBeNull()
  })
})
