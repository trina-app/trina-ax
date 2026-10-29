// HEIC / HEIF preview (QA R2-FMT-10): the server converts a phone photo to JPEG for the file panel
// (server/src/files/heic-preview.ts, GET /api/files/preview), and the AI reads the same photo through OCR.
// The fixture tests/fixtures/ocr/photo.heic is tiled (512x512 grid, like a phone photo) and 2126x426 px: a converter
// that returns only the first tile gives 512x512, so the size check catches it.
// Real conversion: heif-dec when it is installed, else (macOS) mycel-ocr built here with swiftc. Without either the
// real-conversion tests are skipped; the fallback tests always run.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { which } from '../../server/src/config'
import { extractText } from '../../server/src/files/extract'
import { HeicPreviews, heicToJpeg, heicTools, noPreviewError, PREVIEW_INPUT_MAX, PREVIEW_PER_USER_MAX, PREVIEW_PER_USER_WAIT_MAX, PREVIEW_QUEUE_MAX, PREVIEW_RUNS_MAX, PREVIEW_WAIT_MS, previewKey, type HeicTools } from '../../server/src/files/heic-preview'
import { hashFile } from '../../server/src/team-files/place'
import { ToolError } from '../../server/src/policy/errors'
import { runIsolated } from '../../server/src/tools/isolate'
import { imageSize } from '../../server/src/uploads/image'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(180_000)

const FIXTURE = path.join(import.meta.dir, '..', 'fixtures', 'ocr', 'photo.heic')
const NONE: HeicTools = { heifDec: null, imageIo: null }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-preview-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** mycel-ocr with the --jpeg mode, built from native/ocr/main.swift (macOS with swiftc only). */
function buildImageIo(): string | null {
  if (process.platform !== 'darwin' || !which('swiftc')) return null
  const out = path.join(tmp, 'bin', 'mycel-ocr')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const r = Bun.spawnSync([which('swiftc')!, '-O', '-o', out, path.join(import.meta.dir, '..', '..', 'native', 'ocr', 'main.swift')])
  return r.exitCode === 0 && fs.existsSync(out) ? out : null
}

const heifDec = which('heif-dec') ?? which('heif-convert')
const imageIo = buildImageIo()
const real: HeicTools | null = heifDec || imageIo ? { heifDec, imageIo } : null
if (!real) console.warn('heic-preview.test: no heif-dec / heif-convert and no swiftc (macOS): the real-conversion tests are skipped')

describe.skipIf(!real)('HEIC to JPEG with a real converter', () => {
  test('every tile, full size, a JPEG', async () => {
    const out = await heicToJpeg(fs.readFileSync(FIXTURE), real!)
    expect(out).not.toBeNull()
    expect([...out!.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(imageSize(out!)).toEqual({ width: 2126, height: 426 })
  })
  test.skipIf(!heifDec)('heif-dec alone', async () => {
    expect(imageSize((await heicToJpeg(fs.readFileSync(FIXTURE), { heifDec, imageIo: null }))!)).toEqual({ width: 2126, height: 426 })
  })
  test.skipIf(!imageIo)('mycel-ocr --jpeg alone (macOS ImageIO in the sandbox)', async () => {
    expect(imageSize((await heicToJpeg(fs.readFileSync(FIXTURE), { heifDec: null, imageIo }))!)).toEqual({ width: 2126, height: 426 })
  })
  test('cached by content: a second preview needs no converter', async () => {
    const dir = path.join(tmp, 'cache-real')
    const file = path.join(tmp, 'IMG_0001.HEIC')
    fs.copyFileSync(FIXTURE, file)
    const first = await new HeicPreviews(dir, real!).jpeg(file)
    expect(first).not.toBeNull()
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).length).toBe(1)
    const again = await new HeicPreviews(dir, NONE).jpeg(file)
    expect(again?.etag).toBe(first!.etag)
    expect(again!.bytes.equals(first!.bytes)).toBe(true)
  })
  test('a damaged HEIC: an error, not a broken image', async () => {
    const bad = new Uint8Array(Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic broken', 'latin1'))
    await expect(heicToJpeg(bad, real!)).rejects.toThrow('could not make a preview')
  })
})

/** Apple Vision in the converter sandbox fails on some machines for every image (not only HEIC): probe with a PNG. */
async function visionWorks(): Promise<boolean> {
  if (process.platform !== 'darwin' || !imageIo) return false
  try {
    return (await extractText('page.png', fs.readFileSync(path.join(path.dirname(FIXTURE), 'page.png')), { pandoc: null, pdftotext: null, ocr: imageIo })).includes('Invoice')
  } catch { return false }
}
const vision = await visionWorks()
if (process.platform === 'darwin' && imageIo && !vision) console.warn('heic-preview.test: Apple Vision fails in the sandbox on this machine (a PNG too): the HEIC OCR test is skipped')

describe.skipIf(!vision)('the AI reads a HEIC photo (OCR)', () => {
  test('mycel-ocr reads the tiled photo', async () => {
    const text = await extractText('IMG_0001.HEIC', fs.readFileSync(FIXTURE), { pandoc: null, pdftotext: null, ocr: imageIo })
    expect(text).toContain('Invoice')
  })
})

describe('fallback', () => {
  test('no converter: null (the web shows the "cannot preview" panel)', async () => {
    expect(await heicToJpeg(fs.readFileSync(FIXTURE), NONE)).toBeNull()
    const file = path.join(tmp, 'none.heic')
    fs.copyFileSync(FIXTURE, file)
    expect(await new HeicPreviews(path.join(tmp, 'cache-none'), NONE).jpeg(file)).toBeNull()
  })
  test('a converter that writes no JPEG (an old mycel-ocr without --jpeg): an error, never its text as an image', async () => {
    await expect(heicToJpeg(fs.readFileSync(FIXTURE), { heifDec: null, imageIo: '/bin/echo' })).rejects.toThrow('no JPEG mode')
  })
  test('a file over the input limit is refused before a converter runs', async () => {
    const big = path.join(tmp, 'big.heic')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, PREVIEW_INPUT_MAX + 1)
    const e = await new HeicPreviews(path.join(tmp, 'cache-big'), { heifDec: '/bin/false', imageIo: null }).jpeg(big).catch((x) => x)
    expect(e).toBeInstanceOf(ToolError)
    expect(e.code).toBe('too_large')
  })
  test('a converter killed by a limit: no second converter runs after it', async () => {
    // a converter that writes without end: the stdout limit kills it in milliseconds. Before the fix the second
    // converter (here /bin/echo) ran as well and its error replaced the first one. BSD yes ignores the heif-dec
    // options; GNU yes refuses -q, so Linux uses a small script that also ignores its arguments.
    const endless = path.join(tmp, 'endless.sh')
    fs.writeFileSync(endless, '#!/bin/sh\nwhile :; do echo y; done\n', { mode: 0o755 })
    const heifDec = process.platform === 'darwin' ? '/usr/bin/yes' : endless
    const e = await heicToJpeg(fs.readFileSync(FIXTURE), { heifDec, imageIo: '/bin/echo' }).catch((x) => x)
    expect(e).toBeInstanceOf(ToolError)
    expect(e.message).toContain('heif-dec')
    expect(e.message).not.toContain('no JPEG mode')
  })
  test('only the input limit is "too large" (HTTP 413); a failed conversion is "cannot preview", whatever its text', () => {
    expect(noPreviewError(new ToolError('could not make a preview of the photo (heif-dec: image too large)', 'preview_failed'))).toBe(true)
    expect(noPreviewError(new ToolError('the converter failed: Security limit exceeded, too large'))).toBe(true)
    expect(noPreviewError(new ToolError('too large to preview (over 50 MB)', 'too_large'))).toBe(false)
    expect(noPreviewError(new ToolError('not found', 'not_found'))).toBe(false)
    expect(noPreviewError(new Error('other'))).toBe(false)
  })
  test('the cache keeps at most its byte limit (least recently used go first)', () => {
    const dir = path.join(tmp, 'cache-prune')
    fs.mkdirSync(dir)
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `${i}.jpg`)
      fs.writeFileSync(p, Buffer.alloc(100))
      fs.utimesSync(p, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
    }
    new HeicPreviews(dir, NONE, 250).prune()
    expect(fs.readdirSync(dir).sort()).toEqual(['2.jpg', '3.jpg'])
  })
})

/** A fake converter: each call waits until the test settles it. */
function fakeConverter() {
  const calls: { bytes: Uint8Array; signal?: AbortSignal; resolve: (b: Buffer) => void; reject: (e: unknown) => void }[] = []
  const convert = (bytes: Uint8Array, _t: HeicTools, signal?: AbortSignal) => new Promise<Buffer | null>((resolve, reject) => {
    calls.push({ bytes, signal, resolve, reject })
    signal?.addEventListener('abort', () => reject(new Error('converter stopped')), { once: true })
  })
  return { calls, convert }
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
let seq = 0
function photo(content?: string): string {
  const p = path.join(tmp, 'q', `p${seq++}.heic`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content ?? `heic-${seq}-${Math.random()}`)
  return p
}
/** the settled outcome of p, or 'pending' when it does not settle within ms */
const settle = <T>(p: Promise<T>, ms = 300) =>
  Promise.race([p.then((v) => ({ ok: v }), (e) => ({ err: e })), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])
const tick = () => new Promise((r) => setTimeout(r, 20))

describe('conversion queue (QA review: memory, starvation)', () => {
  test('the queue has a limit: over it, "busy" at once (not a long wait)', async () => {
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q1'), NONE, undefined, f.convert)
    const held = Array.from({ length: PREVIEW_RUNS_MAX + PREVIEW_QUEUE_MAX }, (_, i) => pv.jpeg(photo(), { user: `u${i}` }).catch(() => null))
    await tick()
    expect(f.calls.length).toBe(PREVIEW_RUNS_MAX)
    const over = await settle(pv.jpeg(photo(), { user: 'late' }))
    expect(over).not.toBe('pending')
    expect((over as { err: ToolError }).err?.code).toBe('busy')
    // the waiting requests hold no file bytes: only the running conversions have read their file
    expect(pv.stats()).toEqual({ running: PREVIEW_RUNS_MAX, waiting: PREVIEW_QUEUE_MAX })
    for (let i = 0; i < 20 && f.calls.some((c) => c); i++) { for (const c of f.calls.splice(0)) c.resolve(JPEG); await tick() }
    await Promise.all(held)
  })
  test('one person runs one conversion and has at most one more waiting; more: "busy" at once', async () => {
    expect(PREVIEW_PER_USER_MAX).toBe(1)
    expect(PREVIEW_PER_USER_MAX).toBeLessThan(PREVIEW_RUNS_MAX)
    expect(PREVIEW_PER_USER_WAIT_MAX).toBe(1)
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q2'), NONE, undefined, f.convert)
    const held = Array.from({ length: 2 }, () => pv.jpeg(photo(), { user: 'mallory' }).catch(() => null))
    await tick()
    // a free run is left, but it is not for mallory: her second file waits
    expect(pv.stats()).toEqual({ running: 1, waiting: 1 })
    const over = await settle(pv.jpeg(photo(), { user: 'mallory' }))
    expect((over as { err: ToolError }).err?.code).toBe('busy')
    // another person is not blocked: the free run is hers at once
    const other = pv.jpeg(photo(), { user: 'alice' })
    await tick()
    expect(f.calls.length).toBe(2)
    for (let i = 0; i < 20 && pv.stats().running + pv.stats().waiting > 0; i++) { for (const c of f.calls.splice(0)) c.resolve(JPEG); await tick() }
    expect((await other)?.bytes.equals(JPEG)).toBe(true)
    await Promise.all(held)
  })
  test('fairness: one person with many different files cannot keep another person waiting longer than one conversion', async () => {
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q7'), NONE, undefined, f.convert)
    // bob and mallory hold both runs; mallory has one more file waiting and sends more
    const bob = pv.jpeg(photo('bob'), { user: 'bob' })
    const mallory = Array.from({ length: 6 }, (_, i) => pv.jpeg(photo(`mallory ${i}`), { user: 'mallory' }).catch((e) => e))
    await tick()
    expect(pv.stats()).toEqual({ running: 2, waiting: 1 })
    const alice = pv.jpeg(photo('alice'), { user: 'alice' })
    await tick()
    expect(pv.stats()).toEqual({ running: 2, waiting: 2 })
    // mallory's conversion ends (one conversion time): the free run goes to alice, not to mallory's next file
    const isMallory = (c: { bytes: Uint8Array }) => Buffer.from(c.bytes).toString().startsWith('mallory ')
    expect(f.calls.filter(isMallory).length).toBe(1)
    f.calls.find(isMallory)!.resolve(JPEG)
    await tick()
    expect(f.calls.some((c) => Buffer.from(c.bytes).toString() === 'alice')).toBe(true)
    expect(f.calls.filter(isMallory).length).toBe(1)
    // the requests past mallory's limits got "busy" at once (which ones depends on the hashing order)
    const outs = await Promise.all(mallory.map((p) => settle(p, 50)))
    expect(outs.filter((o) => o !== 'pending' && (o as { ok: { code?: string } }).ok?.code === 'busy').length).toBe(4)
    for (let i = 0; i < 20 && pv.stats().running + pv.stats().waiting > 0; i++) { for (const c of f.calls.splice(0)) c.resolve(JPEG); await tick() }
    expect((await alice)?.bytes.equals(JPEG)).toBe(true)
    expect((await bob)?.bytes.equals(JPEG)).toBe(true)
    await Promise.all(mallory)
  })
  test('a request that waits longer than the wait limit gets "busy" (try again), not an endless wait; "busy" is not remembered', async () => {
    expect(PREVIEW_WAIT_MS).toBe(15_000)
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q8'), NONE, undefined, f.convert, 100)
    const a = pv.jpeg(photo(), { user: 'a' })
    const b = pv.jpeg(photo(), { user: 'b' })
    // the content hash is async: wait until a and b hold both runs, so the late request is the one that waits
    for (let i = 0; i < 50 && pv.stats().running < 2; i++) await tick()
    const late = photo()
    const started = Date.now()
    const out = await settle(pv.jpeg(late, { user: 'c' }), 2000)
    expect((out as { err: ToolError }).err?.code).toBe('busy')
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(pv.stats()).toEqual({ running: 2, waiting: 0 })
    // a later try of the same photo converts it (the busy answer is not in the failure cache)
    for (const c of f.calls.splice(0)) c.resolve(JPEG)
    await Promise.all([a, b])
    const again = pv.jpeg(late, { user: 'c' })
    await tick()
    expect(f.calls.length).toBe(1)
    f.calls[0]!.resolve(JPEG)
    expect((await again)?.bytes.equals(JPEG)).toBe(true)
  })
  test('a converter that throws an error that is not a ToolError: "preview_failed", remembered like other failures', async () => {
    let runs = 0
    const pv = new HeicPreviews(path.join(tmp, 'cache-q9'), NONE, undefined, async () => { runs++; throw new Error('spawn ENOENT') })
    const bad = photo()
    for (let i = 0; i < 3; i++) {
      const e = await pv.jpeg(bad, { user: 'u' }).catch((x) => x)
      expect(e).toBeInstanceOf(ToolError)
      expect(e.code).toBe('preview_failed')
      expect(noPreviewError(e)).toBe(true)
    }
    expect(runs).toBe(1)
  })
  test('a request that goes away leaves the queue; a conversion nobody waits for stops', async () => {
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q3'), NONE, undefined, f.convert)
    const a = new AbortController(), b = new AbortController(), w = new AbortController()
    const ra = pv.jpeg(photo('photo of a'), { user: 'a', signal: a.signal }).catch((e) => e)
    const rb = pv.jpeg(photo('photo of b'), { user: 'b', signal: b.signal }).catch((e) => e)
    // the content hash is async: wait until a and b hold both runs before w comes
    for (let i = 0; i < 50 && pv.stats().running < 2; i++) await tick()
    const rw = pv.jpeg(photo(), { user: 'w', signal: w.signal })
    await tick()
    expect(pv.stats()).toEqual({ running: 2, waiting: 1 })
    w.abort()
    const out = await settle(rw)
    expect((out as { err: ToolError }).err?.code).toBe('aborted')
    expect(pv.stats()).toEqual({ running: 2, waiting: 0 })
    // the only caller of a running conversion goes away: the converter gets the stop signal and the slot is free
    a.abort()
    await tick()
    expect(f.calls.find((c) => Buffer.from(c.bytes).toString() === 'photo of a')!.signal?.aborted).toBe(true)
    expect(pv.stats()).toEqual({ running: 1, waiting: 0 })
    b.abort()
    await Promise.all([ra, rb])
  })
  test('a shared conversion goes on when one of its callers goes away', async () => {
    const f = fakeConverter()
    const pv = new HeicPreviews(path.join(tmp, 'cache-q4'), NONE, undefined, f.convert)
    const same = photo('same bytes')
    const copy = photo('same bytes')
    const gone = new AbortController()
    const r1 = pv.jpeg(same, { user: 'a', signal: gone.signal }).catch((e) => e)
    const r2 = pv.jpeg(copy, { user: 'b' })
    await tick()
    expect(f.calls.length).toBe(1)
    gone.abort()
    await tick()
    expect(f.calls[0]!.signal?.aborted).toBe(false)
    f.calls[0]!.resolve(JPEG)
    expect((await r2)?.bytes.equals(JPEG)).toBe(true)
    expect((await r1).code).toBe('aborted')
  })
  test('a failed conversion is remembered for a while (a bad photo does not use the converter again and again)', async () => {
    let runs = 0
    const pv = new HeicPreviews(path.join(tmp, 'cache-q5'), NONE, undefined, async () => { runs++; throw new ToolError('could not make a preview of the photo (heif-dec: timeout)', 'preview_failed') })
    const bad = photo()
    for (let i = 0; i < 3; i++) {
      const e = await pv.jpeg(bad, { user: 'u' }).catch((x) => x)
      expect(e).toBeInstanceOf(ToolError)
      expect(e.code).toBe('preview_failed')
    }
    expect(runs).toBe(1)
  })
  test('the converter gets the file bytes; a cache hit runs no converter', async () => {
    const f = fakeConverter()
    const dir = path.join(tmp, 'cache-q6')
    const pv = new HeicPreviews(dir, NONE, undefined, f.convert)
    const p = photo('photo bytes')
    const r = pv.jpeg(p)
    await tick()
    expect(Buffer.from(f.calls[0]!.bytes).toString()).toBe('photo bytes')
    f.calls[0]!.resolve(JPEG)
    const first = await r
    expect(first?.etag).toBe(previewKey(await hashFile(p)))
    expect(fs.existsSync(path.join(dir, first!.etag + '.jpg'))).toBe(true)
    const again = await pv.jpeg(p)
    expect(again?.etag).toBe(first!.etag)
    expect(f.calls.length).toBe(1)
  })
})

describe('runIsolated work-folder limit', () => {
  test('a converter that fills its work folder is stopped', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-disk-'))
    try {
      const r = await runIsolated({
        cmd: '/bin/bash', args: ['-c', 'while :; do printf "%01024d" 0 >> fill; done'], workDir: work, timeoutMs: 10_000, maxWorkBytes: 2 * 1024 * 1024,
      })
      expect(r.killed).toBe('disk')
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  })
})

describe('GET /api/files/preview', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('heic-preview') })
  afterAll(async () => { await A.close() })
  const q = (p: string) => '/api/files/preview?' + new URLSearchParams({ path: p }).toString()

  test('a HEIC photo: the JPEG when this machine has a converter, else 503 no_preview', async () => {
    fs.mkdirSync(path.join(A.team, 'shared', 'photos'), { recursive: true })
    fs.copyFileSync(FIXTURE, path.join(A.team, 'shared', 'photos', 'IMG_0001.HEIC'))
    const res = await A.req(q('shared/photos/IMG_0001.HEIC'), { as: 'alice' })
    // the outcome on this machine (an old mycel-ocr build without --jpeg converts nothing: 503 as well)
    const here = await heicToJpeg(fs.readFileSync(FIXTURE), heicTools()).catch(() => null)
    if (here) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
      expect(imageSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 2126, height: 426 })
    } else {
      expect(res.status).toBe(503)
      expect((await res.json()).error.params).toEqual({ reason: 'no_preview' })
    }
  })
  test('other formats: 503 no_preview; hidden or missing files: 404; a session is needed', async () => {
    const md = await A.req(q('shared/glossary.md'), { as: 'alice' })
    expect(md.status).toBe(503)
    expect((await md.json()).error.params).toEqual({ reason: 'no_preview' })
    expect((await A.req(q('shared/photos/missing.heic'), { as: 'alice' })).status).toBe(404)
    expect((await A.req(q('groups/finance/x.heic'), { as: 'alice' })).status).toBe(404)
    expect((await A.req(q('shared/photos/IMG_0001.HEIC'))).status).toBe(401)
  })
  test('the cache never shows a photo to somebody who cannot read it; links are refused', async () => {
    // the same bytes at a readable path and in groups/finance (alice cannot read it). The cache entry for them is
    // planted, so this works on a machine with no converter too.
    const bytes = Buffer.concat([fs.readFileSync(FIXTURE), Buffer.from('finance')])
    fs.mkdirSync(path.join(A.team, 'shared', 'photos'), { recursive: true })
    fs.writeFileSync(path.join(A.team, 'groups', 'finance', 'secret.heic'), bytes)
    fs.writeFileSync(path.join(A.team, 'shared', 'photos', 'same.heic'), bytes)
    const key = previewKey(await hashFile(path.join(A.team, 'shared', 'photos', 'same.heic')))
    const planted = Buffer.concat([JPEG, Buffer.from('planted')])
    fs.mkdirSync(path.join(A.data, 'previewcache'), { recursive: true })
    fs.writeFileSync(path.join(A.data, 'previewcache', key + '.jpg'), planted)
    // the cache is hit for the readable copy (the planted bytes come back) ...
    const ok = await A.req(q('shared/photos/same.heic'), { as: 'alice' })
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer()).equals(planted)).toBe(true)
    // ... but not for the hidden one: the authorization check comes first
    const hidden = await A.req(q('groups/finance/secret.heic'), { as: 'alice' })
    expect(hidden.status).toBe(404)
    expect(hidden.headers.get('content-type')).not.toBe('image/jpeg')
    // a symbolic link from a readable folder to the hidden photo: refused like the download endpoint refuses it
    fs.symlinkSync(path.join(A.team, 'groups', 'finance', 'secret.heic'), path.join(A.team, 'shared', 'photos', 'link.heic'))
    const viaLink = await A.req(q('shared/photos/link.heic'), { as: 'alice' })
    expect(viaLink.status).not.toBe(200)
    expect(viaLink.headers.get('content-type')).not.toBe('image/jpeg')
    expect(viaLink.status).toBe((await A.req('/api/files/download?' + new URLSearchParams({ path: 'shared/photos/link.heic' }), { as: 'alice' })).status)
  })
})
