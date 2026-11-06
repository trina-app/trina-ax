// save_url (server/src/tools/save-url.ts): files from the web, or a connection's inline file, into the team folder.
// Local test servers stand in for public sites (testAllow lets 127.0.0.1 count as public); the image check, the disk
// and the person's cards are test stand-ins. No live model, MCP or network calls.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeNet from 'node:net'
import { checkReadable, readMigrations } from '../../server/src/db'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { ToolError } from '../../server/src/policy/errors'
import { putMedia } from '../../server/src/integrations/connections/media'
import { inputMarks, isEcho, MARK_INPUT_CHARS, MAX_INPUT_URLS, recordSent, rememberConnectionUrls, textOf, urlMarks } from '../../server/src/tools/connection-urls'
import { diskReserve, saveUrl, type SaveUrlOptions } from '../../server/src/tools/save-url'
import { sniffKind, withExtension, KINDS } from '../../server/src/tools/sniff'
import { LINK_BUDGET, rememberUrls, type TurnPerson } from '../../server/src/tools/url-gate'
import { noteEgressIp } from '../../server/src/tools/egress'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

const CDN = 'cdn.higgsfield.test'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000040000000308020000', 'hex'), crypto.randomBytes(2000)])
const MP4 = Buffer.concat([Buffer.from('0000001c667479706973366d00000200', 'hex').subarray(0, 8), Buffer.from('isom\0\0\x02\0isomiso2mp41'), crypto.randomBytes(3000)])
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')
const BIG = Buffer.concat([PNG.subarray(0, 64), Buffer.alloc(300_000, 7)])
// what video and voice services also return (fal, Replicate, ElevenLabs): MOV, Ogg Opus / Vorbis, FLAC, AAC (ADTS)
const MOV = Buffer.concat([Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0qt  '), crypto.randomBytes(2000)])
const OPUS = Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(20), Buffer.from('\x01\x13OpusHead'), crypto.randomBytes(2000)])
const VORBIS = Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(20), Buffer.from('\x01\x1e\x01vorbis'), crypto.randomBytes(2000)])
const FLAC = Buffer.concat([Buffer.from('fLaC\0\0\0\x22'), crypto.randomBytes(2000)])
const AAC = Buffer.concat([Buffer.from('fff150802e7ffc', 'hex'), crypto.randomBytes(2000)])

let A: CApp
let cdn: ReturnType<typeof Bun.serve>
let requests: string[] = []
const port = () => (cdn as { port: number }).port
const at = (p: string, host = CDN) => `http://${host}:${port()}${p}`

beforeAll(async () => {
  A = await makeCApp('save-url')
  // the office's exit address is known (else every address asks: tools/egress.ts)
  noteEgressIp(A.ctx, '198.51.100.20')
  cdn = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const u = new URL(req.url)
      requests.push(u.pathname)
      switch (u.pathname) {
        case '/hero.png': return new Response(PNG, { headers: { 'content-type': 'text/html' } })
        case '/hero.jpg': return new Response(PNG, { headers: { 'content-type': 'image/jpeg' } })
        case '/broken.png': return new Response(Buffer.concat([PNG.subarray(0, 64), Buffer.from('BROKEN')]), { headers: { 'content-type': 'image/png' } })
        case '/logo.svg': return new Response('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/png' } })
        case '/page': return new Response('<!doctype html><html><body>hi</body></html>', { headers: { 'content-type': 'image/png' } })
        case '/a.zip': return new Response(Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(100)]), { headers: { 'content-type': 'image/png' } })
        case '/report': return new Response(PDF, { headers: { 'content-type': 'application/octet-stream' } })
        case '/clip': return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
        case '/big.png': return new Response(BIG, { headers: { 'content-type': 'image/png' } })
        case '/stream.png': return new Response(new ReadableStream({ async start(c) { for (let i = 0; i < BIG.length; i += 50_000) { c.enqueue(BIG.subarray(i, i + 50_000)); await Bun.sleep(5) } c.close() } }), { headers: { 'content-type': 'image/png' } })
        case '/to-meta': return Response.redirect('http://169.254.169.254/latest/meta-data/iam/', 302)
        case '/to-lan': return Response.redirect(`http://lan.example:${port()}/hero.png`, 302)
        case '/to-hero': return Response.redirect(at('/hero.png'), 302)
        case '/clip.mp4': return new Response(MOV, { headers: { 'content-type': 'video/mp4' } })
        case '/voice': return new Response(OPUS, { headers: { 'content-type': 'application/octet-stream' } })
        case '/voice.mp3': return new Response(VORBIS, { headers: { 'content-type': 'audio/mpeg' } })
        case '/song.wav': return new Response(FLAC, { headers: { 'content-type': 'audio/wav' } })
        case '/speech.m4a': return new Response(AAC, { headers: { 'content-type': 'audio/mp4' } })
        // a link shortener's address (made by a connection): it redirects to the long address it was given
        case '/s/abc': return Response.redirect(at('/hero.jpg?leak=ceo-salary-is-250000'), 302)
        // the same path on another scheme / with a query, as http -> https and CDN redirects do
        case '/self/hero.png': return u.search ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : Response.redirect(at('/self/hero.png?signed=1'), 302)
        default: return new Response('no', { status: 404 })
      }
    },
  })
})
afterAll(async () => { cdn?.stop(true); await A?.close() })

const LOOKUP = async (h: string) => {
  if (h === CDN || h === 'files.example') return [{ address: '127.0.0.1', family: 4 }]
  if (h === 'lan.example') return [{ address: '10.0.0.8', family: 4 }]
  throw new Error('ENOTFOUND')
}
/** a disk of `total` with `free` bytes free (a function: may change while a download runs) */
const disk = (free: () => number, total = 500 * 1024 ** 3) => () => ({ bsize: 4096, blocks: total / 4096, bfree: free() / 4096, bavail: free() / 4096 })
/** the image check: refuses what says BROKEN, or what the test marks as missing / too many pixels */
const normalize = async (b: Uint8Array) => { if (Buffer.from(b).includes('BROKEN')) throw new ToolError('image conversion refused', 'vision_damaged') }
const OPTS: SaveUrlOptions = { lookup: LOOKUP, testAllow: (ip) => ip === '127.0.0.1', connectTimeoutMs: 3000, idleTimeoutMs: 3000, statfs: disk(() => 200 * 1024 ** 3), normalize }

interface Cards { asked: string[]; answer: boolean; widen: string[]; widenRefusal: string | null; atCard?: () => void }
function setup(user: Person = 'alice', o: { unattended?: boolean; locale?: 'ko' | 'en' } = {}) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const cards: Cards = { asked: [], answer: true, widen: [], widenRefusal: null }
  const person: TurnPerson = { locale: o.locale ?? 'en', async confirm(q) { cards.asked.push(q); cards.atCard?.(); return cards.answer }, *turnUrls() {}, unattended: o.unattended }
  const t: ToolCtx = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), person, signal: new AbortController().signal, confirmWidening: async (target) => { cards.widen.push(target); return cards.widenRefusal } }
  const allow = (...urls: string[]) => rememberUrls(A.ctx.db, chat, urls, 'allowed')
  const run = (url: string, save_as?: string, extra: SaveUrlOptions = {}) => saveUrl(A.ctx, { url, ...(save_as !== undefined ? { save_as } : {}) }, t, { ...OPTS, ...extra })
  return { chat, turnId, cards, t, allow, run }
}
const read = (rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')))
const has = (rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))
const workLeft = () => { try { return fs.readdirSync(path.join(A.data, 'work')).filter((n) => n.startsWith('save-url-')) } catch { return [] } }

describe('saving', () => {
  test('a PNG served as text/html is saved as what its bytes are, with an audit trail', async () => {
    const s = setup()
    s.allow(at('/hero.png'))
    const r = await s.run(at('/hero.png'), 'shared/landing/images/hero.png')
    expect(r.structured).toMatchObject({ path: 'shared/landing/images/hero.png', size: PNG.length, type: 'image/png', sha256: crypto.createHash('sha256').update(PNG).digest('hex') })
    expect(read('shared/landing/images/hero.png').equals(PNG)).toBe(true)
    expect(r.text).toContain('PNG, 4×3')
    expect(r.text).toContain('"images/hero.png"') // how to reference it from a page in shared/landing
    expect(r.summary).toContain(`from ${at('/hero.png')}`)
    expect(r.summary).toContain(r.structured.sha256 as string)
    const ev = A.ctx.db.query("SELECT action, detail FROM file_events WHERE path = 'shared/landing/images/hero.png'").get() as { action: string; detail: string }
    expect(ev.action).toBe('create')
    expect(JSON.parse(ev.detail)).toMatchObject({ tool: 'save_url', url: at('/hero.png'), type: 'image/png' })
    expect(s.cards.widen).toEqual(['shared/landing/images/hero.png'])
    expect(s.cards.asked).toEqual([])
    // the download does not count against the turn's write budget (a loop guard for text writes)
    expect(s.t.files.bytesWritten).toBe(0)
    expect(s.t.files.filesWritten.has('shared/landing/images/hero.png')).toBe(true)
    expect(workLeft()).toEqual([])
  })
  test('the extension follows the bytes (and the AI is told); a folder keeps the address\'s name; the default folder is the person\'s', async () => {
    const s = setup()
    s.allow(at('/hero.jpg'), at('/hero.png'), at('/report'), at('/clip'))
    const a = await s.run(at('/hero.jpg'), 'shared/x/cover.jpg')
    expect(a.structured.path).toBe('shared/x/cover.png')
    expect(a.text).toContain('extension .png')
    const b = await s.run(at('/hero.jpg'), 'shared/x/')
    expect(b.structured.path).toBe('shared/x/hero.png')
    const c = await s.run(at('/hero.png'))
    expect(c.structured.path).toBe('users/alice/images/hero.png')
    const d = await s.run(at('/report'))
    expect(d.structured).toMatchObject({ path: 'users/alice/downloads/report.pdf', type: 'application/pdf' })
    const e = await s.run(at('/clip'), 'shared/videos/')
    expect(e.structured).toMatchObject({ path: 'shared/videos/clip.mp4', type: 'video/mp4' })
  })
  test('MOV, Ogg (Opus, Vorbis), FLAC and AAC files are taken and named by their bytes', async () => {
    const s = setup()
    s.allow(at('/clip.mp4'), at('/voice'), at('/voice.mp3'), at('/song.wav'), at('/speech.m4a'))
    const mov = await s.run(at('/clip.mp4'), 'shared/media/clip.mp4')
    expect(mov.structured).toMatchObject({ path: 'shared/media/clip.mov', type: 'video/quicktime' })
    expect(mov.text).toContain('extension .mov')
    expect((await s.run(at('/voice'))).structured).toMatchObject({ path: 'users/alice/downloads/voice.opus', type: 'audio/ogg' })
    expect((await s.run(at('/voice.mp3'), 'shared/media/')).structured).toMatchObject({ path: 'shared/media/voice.ogg', type: 'audio/ogg' })
    expect((await s.run(at('/song.wav'), 'shared/media/')).structured).toMatchObject({ path: 'shared/media/song.flac', type: 'audio/flac' })
    expect((await s.run(at('/speech.m4a'), 'shared/media/')).structured).toMatchObject({ path: 'shared/media/speech.aac', type: 'audio/aac' })
    expect(read('shared/media/clip.mov').equals(MOV)).toBe(true)
    expect(read('users/alice/downloads/voice.opus').equals(OPUS)).toBe(true)
  })
  test('SVG, HTML and archives are refused by their bytes, whatever the site says; nothing is left behind', async () => {
    const s = setup()
    s.allow(at('/logo.svg'), at('/page'), at('/a.zip'))
    for (const [p, what] of [['/logo.svg', 'an SVG image'], ['/page', 'an HTML page'], ['/a.zip', 'a ZIP archive']] as const) {
      const e = await s.run(at(p), `shared/refused${p}.png`).catch((x) => x)
      expect(e).toBeInstanceOf(ToolError)
      expect(e.message).toContain(`This file is ${what}`)
      expect(e.message).toContain('the source said image/png')
      expect(has(`shared/refused${p}.png`)).toBe(false)
    }
    expect(workLeft()).toEqual([])
  })
  test('an image that only starts like one fails the decode check; without the image check images are refused', async () => {
    const s = setup()
    s.allow(at('/broken.png'), at('/hero.png'))
    await expect(s.run(at('/broken.png'), 'shared/b.png')).rejects.toThrow(/could not be decoded/)
    expect(has('shared/b.png')).toBe(false)
    await expect(s.run(at('/hero.png'), 'shared/c.png', { normalize: async () => { throw new ToolError('missing', 'vision_unavailable') } })).rejects.toThrow(/image check \(mycel-safeops\) is not installed/)
    const r = await s.run(at('/hero.png'), 'shared/d.png', { normalize: async () => { throw new ToolError('pixels', 'vision_too_large') } })
    expect(r.text).toContain('too many pixels')
  })
  test('the same path again: a conflict copy unless the AI read it in this turn, then a new version', async () => {
    const s = setup()
    s.allow(at('/hero.png'))
    await s.run(at('/hero.png'), 'shared/v/hero.png')
    const s2 = setup()
    s2.allow(at('/hero.png'))
    const again = await s2.run(at('/hero.png'), 'shared/v/hero.png')
    expect(again.structured.conflictCopyOf).toBe('shared/v/hero.png')
    expect(again.text).toContain('saved as a copy')
    const s3 = setup()
    s3.allow(at('/hero.png'))
    s3.t.files.readHashes.set('shared/v/hero.png', crypto.createHash('sha256').update(PNG).digest('hex'))
    const update = await s3.run(at('/hero.png'), 'shared/v/hero.png')
    expect(update.structured.path).toBe('shared/v/hero.png')
    expect(update.structured.conflictCopyOf).toBeUndefined()
    // the copy is listed in the original's history; the save over the read file made a version
    expect((A.ctx.db.query("SELECT kind FROM file_versions WHERE path = 'shared/v/hero.png' ORDER BY version").all() as { kind: string }[]).map((r) => r.kind)).toEqual(['conflict_copy', 'edit'])
  })
})

describe('before anything is fetched', () => {
  test('skills/, a folder the person cannot write, and a declined wider-audience card fetch nothing', async () => {
    const s = setup()
    s.allow(at('/hero.png'))
    requests = []
    await expect(s.run(at('/hero.png'), 'skills/hero.png')).rejects.toThrow(/skills\//)
    await expect(s.run(at('/hero.png'), 'groups/finance/hero.png')).rejects.toThrow()
    s.cards.widenRefusal = 'The user did not allow saving to shared/w/hero.png'
    await expect(s.run(at('/hero.png'), 'shared/w/hero.png')).rejects.toThrow(/did not allow/)
    expect(requests).toEqual([])
    expect(has('shared/w/hero.png')).toBe(false)
  })
  test('without the turn\'s wider-audience check only the person\'s own folder (fail closed), still before any request', async () => {
    const s = setup()
    s.allow(at('/hero.png'))
    delete s.t.confirmWidening
    requests = []
    await expect(s.run(at('/hero.png'), 'shared/nobody/hero.png')).rejects.toThrow(/only save into your own folder/)
    expect(requests).toEqual([])
    expect((await s.run(at('/hero.png'), 'users/alice/own/hero.png')).structured.path).toBe('users/alice/own/hero.png')
  })
  test('an address the conversation never showed asks on the card; declined = no request', async () => {
    const s = setup()
    s.cards.answer = false
    requests = []
    await expect(s.run(at('/hero.png'), 'shared/u/hero.png')).rejects.toThrow(/did not allow opening this address/)
    expect(s.cards.asked[0]).toContain('did not appear in this conversation')
    expect(requests).toEqual([])
  })
  test('redirects into private, LAN or metadata addresses are refused on their hop', async () => {
    const s = setup()
    s.allow(at('/to-meta'), at('/to-lan'), at('/to-hero'))
    await expect(s.run(at('/to-meta'), 'shared/r/m.png')).rejects.toThrow(/private, local or reserved/)
    await expect(s.run(at('/to-lan'), 'shared/r/l.png')).rejects.toThrow(/private, local or reserved/)
    const ok = await s.run(at('/to-hero'), 'shared/r/ok.png')
    expect(ok.structured.url).toBe(at('/hero.png'))
    expect(ok.summary).toContain(`(asked for ${at('/to-hero')})`)
  })
})

describe('size: no limit, a card over the line, the disk as the only hard stop', () => {
  test('over the line by Content-Length: the person sees the size and the free disk; declined = nothing saved', async () => {
    const s = setup('alice', { locale: 'ko' })
    s.allow(at('/big.png'))
    s.cards.answer = false
    await expect(s.run(at('/big.png'), 'shared/big/a.png', { askAbove: 100_000 })).rejects.toThrow(/chose not to download/)
    expect(s.cards.asked[0]).toContain('이 파일은 293 KB예요. 서버 디스크 여유는 200.0 GB예요. 받을까요?')
    expect(has('shared/big/a.png')).toBe(false)
    s.cards.answer = true
    const r = await s.run(at('/big.png'), 'shared/big/a.png', { askAbove: 100_000 })
    expect(r.structured.size).toBe(BIG.length)
    expect(r.summary).toContain('large file confirmed by the user')
  })
  test('unknown length: the download stops at the line, asks, and goes on after "Download"', async () => {
    const s = setup()
    s.allow(at('/stream.png'))
    let atCard = -1
    s.cards.atCard = () => {
      const dir = workLeft()[0]!
      atCard = fs.statSync(path.join(A.data, 'work', dir, 'body')).size
    }
    const r = await s.run(at('/stream.png'), 'shared/big/b.png', { askAbove: 120_000 })
    expect(s.cards.asked[0]).toContain('has passed 1 GB')
    expect(atCard).toBe(120_000) // nothing past the line before the answer
    expect(r.structured.size).toBe(BIG.length)
    expect(read('shared/big/b.png').equals(BIG)).toBe(true)
  })
  test('a scheduled run skips a file over the line, with a note', async () => {
    const s = setup('alice', { unattended: true })
    s.allow(at('/big.png'))
    await expect(s.run(at('/big.png'), 'shared/big/c.png', { askAbove: 100_000 })).rejects.toThrow(/scheduled run.*skipped/)
    expect(s.cards.asked).toEqual([])
  })
  test('the disk reserve: 10% of the disk, at least 5 GiB, at most 20 GiB', () => {
    expect(diskReserve(20 * 1024 ** 3)).toBe(5 * 1024 ** 3)
    expect(diskReserve(100 * 1024 ** 3)).toBe(10 * 1024 ** 3)
    expect(diskReserve(2048 * 1024 ** 3)).toBe(20 * 1024 ** 3)
  })
  test('a download that would leave less than the reserve is refused up front, with words for the person', async () => {
    const s = setup('alice', { locale: 'ko' })
    s.allow(at('/big.png'))
    const e = await s.run(at('/big.png'), 'shared/disk/a.png', { statfs: disk(() => 5 * 1024 ** 3 + 100_000, 40 * 1024 ** 3) }).catch((x) => x)
    expect(e.message).toContain('too little free space')
    expect(e.message).toContain('서버 디스크 여유가 5.0 GB밖에 없어요. 이 파일(293 KB)을 받으면 디스크에 꼭 남겨 둬야 하는 5.0 GB보다 적게 남아서 받지 않았어요.')
    expect(has('shared/disk/a.png')).toBe(false)
    expect(workLeft()).toEqual([])
  })
  test('and while it streams: stopped, the partial file deleted', async () => {
    const s = setup('alice', { locale: 'ko' })
    s.allow(at('/stream.png'))
    let calls = 0
    const e = await s.run(at('/stream.png'), 'shared/disk/b.png', { roomStep: 60_000, statfs: disk(() => (++calls <= 2 ? 50 * 1024 ** 3 : 4 * 1024 ** 3), 40 * 1024 ** 3) }).catch((x) => x)
    expect(e.message).toContain('받는 중에 서버 디스크 여유가 4.0 GB로 줄었어요')
    expect(has('shared/disk/b.png')).toBe(false)
    expect(workLeft()).toEqual([])
  })
})

describe('a body of unknown length that ends at the connection close', () => {
  test('a non-image is saved with a note that completeness could not be verified', async () => {
    // a raw server that sends a PDF with no Content-Length and no chunked framing, then closes
    const body = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n'), PDF])
    const raw = nodeNet.createServer((sock) => { sock.on('error', () => {}); sock.on('data', () => sock.end(body)) })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://files.example:${(raw.address() as nodeNet.AddressInfo).port}/report`
      const s = setup()
      s.allow(url)
      const r = await s.run(url, 'shared/openended/report.pdf')
      expect(r.structured).toMatchObject({ path: 'shared/openended/report.pdf', type: 'application/pdf' })
      expect(r.text).toContain("did not send the file's length")
      expect(read('shared/openended/report.pdf').equals(PDF)).toBe(true)
    } finally { raw.close() }
  })
})

describe('kept MCP media: caps across chats', () => {
  // 500-byte items that sniff as PNG; a fresh data dir so other tests' kept media do not count
  const item = () => Buffer.concat([PNG.subarray(0, 64), crypto.randomBytes(436)])
  const bin = (dir: string, m: { chatId: string; id: string }) => fs.existsSync(path.join(dir, 'connection-media', m.chatId, `${m.id}.bin`))
  test('past the per-person cap the oldest across that person\'s chats go first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-user-'))
    const put = (chat: string, user: string) => { Bun.sleepSync(3); return putMedia(dir, { chatId: chat, userId: user, integrationId: 'x', bytes: item(), declared: 'image/png' }, { user: 1200 })! }
    const a = put('capa', 'alice'), b = put('capb', 'alice'), c = put('capc', 'alice')
    // bob's item in between is not touched by alice's per-person cap
    const bob = put('capd', 'bob')
    expect(bin(dir, a)).toBe(false) // 3 × 500 > 1200: the oldest of alice's went
    expect(bin(dir, b) && bin(dir, c) && bin(dir, bob)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  test('past the server-wide cap the oldest across everyone go first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-total-'))
    const put = (chat: string, user: string) => { Bun.sleepSync(3); return putMedia(dir, { chatId: chat, userId: user, integrationId: 'x', bytes: item(), declared: 'image/png' }, { total: 1200 })! }
    const a = put('tota', 'alice'), b = put('totb', 'bob'), c = put('totc', 'carol')
    expect(bin(dir, a)).toBe(false) // 3 × 500 > 1200: the oldest overall went, whoever's it was
    expect(bin(dir, b) && bin(dir, c)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('mcp-file handles', () => {
  test('saved without the network, only in their chat and only by their person', async () => {
    const s = setup()
    const meta = putMedia(A.data, { chatId: s.chat, userId: 'alice', integrationId: 'x', bytes: PNG, declared: 'image/png' })!
    requests = []
    const r = await s.run(`mcp-file:${meta.id}`, 'shared/mcp/hero.png')
    expect(r.structured).toMatchObject({ path: 'shared/mcp/hero.png', type: 'image/png', sha256: meta.sha256 })
    expect(requests).toEqual([])
    // again (the item stays for other saves)
    expect((await s.run(`mcp-file:${meta.id}`, 'shared/mcp/hero-2.png')).structured.path).toBe('shared/mcp/hero-2.png')
    // another chat of the same person, and another person's turn in the same chat
    const other = setup()
    await expect(other.run(`mcp-file:${meta.id}`, 'shared/mcp/x.png')).rejects.toThrow(/no file mcp-file:/)
    const bobTurn = A.turn('bob', s.chat)
    const bt: ToolCtx = { ...s.t, user: A.ctx.files.principal('bob'), turnId: bobTurn, files: new TurnFiles() }
    await expect(saveUrl(A.ctx, { url: `mcp-file:${meta.id}`, save_as: 'shared/mcp/y.png' }, bt, OPTS)).rejects.toThrow(/no file mcp-file:/)
    await expect(s.run('mcp-file:../../etc/passwd', 'shared/mcp/z.png')).rejects.toThrow(/no file/)
  })
  test('an inline file of a refused type stays refused', async () => {
    const s = setup()
    const meta = putMedia(A.data, { chatId: s.chat, userId: 'alice', integrationId: 'x', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), declared: 'image/png' })!
    await expect(s.run(`mcp-file:${meta.id}`, 'shared/mcp/s.png')).rejects.toThrow(/an SVG image/)
  })
})

describe('type sniffing', () => {
  test('by the first bytes', () => {
    expect(sniffKind(PNG)?.name).toBe('png')
    expect(sniffKind(Buffer.from('ffd8ffe000104a464946', 'hex'))?.name).toBe('jpeg')
    expect(sniffKind(Buffer.from('GIF89a\x01\x00'))?.name).toBe('gif')
    expect(sniffKind(Buffer.from('RIFF\x10\0\0\0WEBPVP8 '))?.name).toBe('webp')
    expect(sniffKind(Buffer.from('RIFF\x10\0\0\0WAVEfmt '))?.name).toBe('wav')
    expect(sniffKind(PDF)?.name).toBe('pdf')
    expect(sniffKind(MP4)?.name).toBe('mp4')
    expect(sniffKind(Buffer.from('\0\0\0\x18ftypM4A \0\0\0\0M4A isom'))?.name).toBe('m4a')
    expect(sniffKind(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'))).toBeNull()
    // MOV (QuickTime): the qt brand, major or compatible, or an older file that starts with its movie / media atom
    expect(sniffKind(Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0qt  '))?.name).toBe('mov')
    expect(sniffKind(Buffer.from('\0\0\0\x14ftypXXXX\0\0\0\0qt  '))?.name).toBe('mov')
    expect(sniffKind(Buffer.from('\0\0\x01\x00moov\0\0\0\x6cmvhd'))?.name).toBe('mov')
    expect(sniffKind(Buffer.from('\0\0\0\x08wide\x01\x23\x45\x67mdat'))?.name).toBe('mov')
    expect(sniffKind(Buffer.from('<!--mdat--><html><script>alert(1)</script></html>'))).toBeNull() // text, not an atom size
    expect(sniffKind(Buffer.from('\0\0\0\x08wide\0\0\0\x08free'))).toBeNull()
    // Ogg (Vorbis or anything else: .ogg; Opus: .opus), FLAC, AAC in ADTS (layer 0; MP3 is layer III)
    const ogg = (codec: string) => Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(20), Buffer.from('\x01\x13'), Buffer.from(codec), Buffer.alloc(16)])
    expect(ogg('OpusHead').subarray(28, 36).toString()).toBe('OpusHead')
    expect(sniffKind(ogg('OpusHead'))?.name).toBe('opus')
    expect(sniffKind(ogg('\x01vorbis\0'))?.name).toBe('ogg')
    expect(sniffKind(Buffer.from('fLaC\0\0\0\x22\x10\0\x10\0'))?.name).toBe('flac')
    expect(sniffKind(Buffer.from('fff150802e7ffc', 'hex'))?.name).toBe('aac')
    expect(sniffKind(Buffer.from('fff950802e7ffc', 'hex'))?.name).toBe('aac') // MPEG-2 ADTS
    expect(sniffKind(Buffer.from('fff17c802e7ffc', 'hex'))).toBeNull() // sample-rate index 15: no ADTS
    expect(sniffKind(Buffer.from('fff3508000001f', 'hex'))?.name).toBe('mp3') // layer bits 01 = Layer III: MP3, not AAC
    expect(sniffKind(Buffer.from('fff15080001ffc', 'hex'))).toBeNull() // a frame shorter than its own header
    expect(sniffKind(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('\x42\x82\x84webm')]))?.name).toBe('webm')
    expect(sniffKind(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('\x42\x82\x88matroska')]))).toBeNull()
    expect(sniffKind(Buffer.from('ID3\x04\0'))?.name).toBe('mp3')
    expect(sniffKind(Buffer.from('fffb9064', 'hex'))?.name).toBe('mp3')
    expect(sniffKind(Buffer.from('fff15080', 'hex'))).toBeNull() // AAC ADTS, not MP3
    expect(sniffKind(Buffer.from('<svg/>'))).toBeNull()
  })
  test('extensions', () => {
    expect(withExtension('hero.jpg', KINDS.png)).toEqual({ name: 'hero.png', changed: true })
    expect(withExtension('hero.jpeg', KINDS.jpeg)).toEqual({ name: 'hero.jpeg', changed: false })
    expect(withExtension('report', KINDS.pdf)).toEqual({ name: 'report.pdf', changed: true })
    expect(withExtension('v1.2 final', KINDS.mp4)).toEqual({ name: 'v1.2 final.mp4', changed: true })
    expect(withExtension('clip.mp4', KINDS.mov)).toEqual({ name: 'clip.mov', changed: true })
    expect(withExtension('clip.qt', KINDS.mov)).toEqual({ name: 'clip.qt', changed: false })
    expect(withExtension('voice.ogg', KINDS.opus)).toEqual({ name: 'voice.ogg', changed: false })
    expect(withExtension('voice', KINDS.opus)).toEqual({ name: 'voice.opus', changed: true })
    expect(withExtension('voice.opus', KINDS.ogg)).toEqual({ name: 'voice.ogg', changed: true })
    expect(withExtension('song.mp3', KINDS.flac)).toEqual({ name: 'song.flac', changed: true })
    expect(withExtension('speech.m4a', KINDS.aac)).toEqual({ name: 'speech.aac', changed: true })
    // a corrected name never ends in a type a browser would run
    for (const k of Object.values(KINDS)) for (const n of ['x.html', 'x.svg', 'x.htm', 'x.xml', 'x.png.html', 'x.html ']) expect(withExtension(n, k).name.endsWith('.' + k.ext) || withExtension(n, k).name.endsWith('.ogg') || withExtension(n, k).name.endsWith('.qt')).toBe(true)
  })
})

describe('addresses from connections (learned links) and the echo check', () => {
  let integrationId = ''
  beforeAll(() => {
    integrationId = crypto.randomUUID()
    const now = new Date().toISOString()
    A.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, write_policy, status, tools_json, version, created_at, updated_at) VALUES (?, 'personal', 'alice', 'alice', 'mcp', 'Images', 'images', 'https://mcp.example/mcp', 'none', 'ask', 'connected', '[]', 1, ?, ?)").run(integrationId, now, now)
  })
  test('an address a connection the person can use returned opens without a card, within the link budget', async () => {
    const s = setup()
    const T = LINK_BUDGET.turn
    const urls = Array.from({ length: T + 1 }, (_, i) => at(`/hero.png?v=${i}`))
    rememberConnectionUrls(A.ctx.db, s.chat, urls, { integrationId, userId: 'alice', turnId: s.turnId })
    for (let i = 0; i < T; i++) await s.run(urls[i]!, `shared/conn/${i}.png`)
    expect(s.cards.asked).toEqual([])
    // the next one in this answer: the person decides
    s.cards.answer = false
    await expect(s.run(urls[T]!, `shared/conn/${T}.png`)).rejects.toThrow(/did not allow/)
    expect(s.cards.asked[0]).toContain(`as many addresses from web pages and search results without asking as it may (${T} per answer`)
    // opening one of the first ones again is free
    s.cards.asked = []
    await s.run(urls[0]!, 'shared/conn/0b.png')
    expect(s.cards.asked).toEqual([])
  })
  test('an echo of what the AI sent is always a card (the address, its query, a random-looking part)', async () => {
    const s = setup()
    const secret = 'k3Jq9ZtWm2Rv8XpL4sYd'
    recordSent(A.ctx.db, s.chat, { prompt: 'a hero image', reference: at('/hero.png?ref=1') })
    recordSent(A.ctx.db, s.chat, { note: `token ${secret}7Hq` })
    const echoed = [at('/hero.png?ref=1'), at(`/x/${secret.slice(0, 20)}abc/hero.png`)]
    // the same host and path with another query is an echo too (the service only changed the query)
    echoed.push(at('/hero.png?fresh=1'))
    rememberConnectionUrls(A.ctx.db, s.chat, [...echoed, at('/hero.jpg?fresh=1')], { integrationId, userId: 'alice', turnId: s.turnId })
    s.cards.answer = false
    for (const u of echoed) await expect(s.run(u, 'shared/echo/e.png')).rejects.toThrow(/did not allow/)
    expect(s.cards.asked).toHaveLength(3)
    for (const q of s.cards.asked) expect(q).toContain('matches what the AI had sent to a tool earlier')
    s.cards.asked = []
    s.cards.answer = true
    await s.run(at('/hero.jpg?fresh=1'), 'shared/echo/fresh.png')
    expect(s.cards.asked).toEqual([])
  })
  test('the marks: the address, its query on another host, a 20-character window; the services\' own addresses leave none', () => {
    const marks = (t: string, known: string[] = []) => new Set(inputMarks(t, (u) => known.includes(u)).map((b) => b.toString('hex')))
    const hit = (m: Set<string>, url: string) => urlMarks(url)?.some((b) => m.has(b.toString('hex'))) ?? true
    const m = marks('{"image_url":"https://attacker.example/c?d=SECRETDATA123"}')
    expect(hit(m, 'https://attacker.example/c?d=SECRETDATA123')).toBe(true)
    expect(hit(m, 'https://cdn.service.example/x?d=SECRETDATA123')).toBe(true)
    expect(hit(m, 'https://cdn.service.example/x?d=other')).toBe(false)
    const w = marks('{"prompt":"remember 9fK2mQ7xL4pR8sT1vW3yZ6aB please"}')
    expect(hit(w, 'https://cdn.service.example/u/xx9fK2mQ7xL4pR8sT1vW3yZ6aBxx.png')).toBe(true)
    expect(hit(w, 'https://cdn.service.example/u/hero.png')).toBe(false)
    // an image-to-image call with the last result's address: the next result is not taken for an echo
    const last = 'https://cdn.service.example/user_2xKq7Pz9Lm4Nq8Rt5Vw1/a.png'
    const k = marks(JSON.stringify({ image_url: last }), [last])
    expect(hit(k, 'https://cdn.service.example/user_2xKq7Pz9Lm4Nq8Rt5Vw1/b.png')).toBe(false)
    expect(hit(marks(JSON.stringify({ image_url: last })), 'https://cdn.service.example/user_2xKq7Pz9Lm4Nq8Rt5Vw1/b.png')).toBe(true)
  })
  test('a random-looking part moved into a host (lowercased) or re-cased is still an echo', () => {
    // the AI sends an opaque secret as bare text (not a URL); the service returns it re-cased. The window mark folds
    // case, so a part moved into a host (the URL parser lowercases hosts) or otherwise re-cased still matches.
    const secret = 'A1B2C3D4E5F6G7H8J9K0'
    const m = new Set(inputMarks(JSON.stringify({ note: `please keep ${secret} for me` })).map((b) => b.toString('hex')))
    const hit = (url: string) => urlMarks(url)?.some((b) => m.has(b.toString('hex'))) ?? true
    expect(hit(`https://${secret.toLowerCase()}.attacker.test/x.png`)).toBe(true) // moved into a subdomain (forced lowercase)
    expect(hit(`https://cdn.svc.test/p/${secret.toLowerCase()}zz.png`)).toBe(true) // re-cased in a path segment
    expect(hit('https://cdn.svc.test/p/unrelated-12ab34cd56.png')).toBe(false) // an unrelated part is not an echo
  })
  test('the echo check reads the whole input and fails closed when it cannot (padding, many addresses, changed forms)', () => {
    const marksOf = (input: unknown) => { const t = textOf(input); return new Set((t === null ? inputMarks('x'.repeat(MARK_INPUT_CHARS + 1)) : inputMarks(t)).map((b) => b.toString('hex'))) }
    const hit = (m: Set<string>, url: string) => urlMarks(url)?.some((b) => m.has(b.toString('hex'))) ?? true
    // words, not random-looking: only the address-level marks can catch this one
    const evil = 'https://attacker.example/c/ceo-salary-is-250000-and-merger-with-acme'
    expect(hit(marksOf({ q: evil }), evil)).toBe(true)
    // before: past 64 KB, or after 500 other addresses, an input left no marks
    expect(hit(marksOf({ q: 'x '.repeat(40_000) + evil }), evil)).toBe(true)
    expect(hit(marksOf({ q: Array.from({ length: 600 }, (_, i) => `https://a.example/${i}`).join(' ') + ' ' + evil }), evil)).toBe(true)
    // the service added a query, wrapped it in its own redirect, changed its case or its slashes
    expect(hit(marksOf({ q: evil }), evil + '?utm_source=svc')).toBe(true)
    expect(hit(marksOf({ q: evil }), 'https://svc.example/out?to=' + encodeURIComponent(evil) + '&utm=1')).toBe(true)
    expect(hit(marksOf({ q: evil }), 'https://ATTACKER.example/C/CEO-SALARY-IS-250000-AND-MERGER-WITH-ACME')).toBe(true)
    expect(hit(marksOf({ q: 'https://attacker.example/a\\b/ceo-salary-250000' }), 'https://attacker.example/a\\b/ceo-salary-250000')).toBe(true)
    // a stray "%" does not stop the %-decoded form
    expect(hit(marksOf({ q: '100% ' + encodeURIComponent(evil) }), evil)).toBe(true)
    // an unrelated address is still not an echo
    expect(hit(marksOf({ q: evil }), 'https://cdn.example/img/abc.png')).toBe(false)
    // too much to mark completely: the whole chat counts as sent (every address that comes back asks)
    expect(textOf({ q: 'x'.repeat(MARK_INPUT_CHARS + 10) })).toBeNull()
    expect(textOf(JSON.parse('['.repeat(80) + ']'.repeat(80)))).toBeNull()
    expect(inputMarks(Array.from({ length: MAX_INPUT_URLS + 1 }, (_, i) => `https://a.example/${i}`).join(' '))).toHaveLength(1)
    const s = setup()
    recordSent(A.ctx.db, s.chat, { q: 'x'.repeat(MARK_INPUT_CHARS + 10) })
    expect(isEcho(A.ctx.db, s.chat, 'https://cdn.example/anything.png')).toBe(true)
  })
  test('a redirect to an address that echoes what the AI sent asks first, however the first address was opened', async () => {
    // the AI gave a link shortener (a connection) the long address with data in it; the short one came back as the
    // service's own address, and redirects to the long one
    const s = setup()
    const long = at('/hero.jpg?leak=ceo-salary-is-250000')
    recordSent(A.ctx.db, s.chat, { long_url: long })
    rememberConnectionUrls(A.ctx.db, s.chat, [at('/s/abc')], { integrationId, userId: 'alice', turnId: s.turnId })
    expect(isEcho(A.ctx.db, s.chat, at('/s/abc'))).toBe(false)
    requests = []
    s.cards.answer = false
    await expect(s.run(at('/s/abc'), 'shared/redir/a.png')).rejects.toThrow(/did not allow following the redirect/)
    expect(s.cards.asked).toHaveLength(1)
    expect(s.cards.asked[0]).toContain('redirects to another one')
    expect(s.cards.asked[0]).toContain(long)
    // declined: the long address was never asked for
    expect(requests).toEqual(['/s/abc'])
    expect(has('shared/redir/a.png')).toBe(false)
    s.cards.answer = true
    const ok = await s.run(at('/s/abc'), 'shared/redir/b.png')
    expect(ok.summary).toContain('(redirect confirmed by the user)')
    // a redirect that echoes nothing asks nothing
    s.cards.asked = []
    s.allow(at('/to-hero'))
    await s.run(at('/to-hero'), 'shared/redir/c.png')
    expect(s.cards.asked).toEqual([])
    // nor one to the asked-for address's own path: save_url's own input (recorded like every tool input) is no echo
    s.allow(at('/self/hero.png'))
    recordSent(A.ctx.db, s.chat, { url: at('/self/hero.png'), save_as: 'shared/redir/d.png' })
    await s.run(at('/self/hero.png'), 'shared/redir/d.png')
    expect(s.cards.asked).toEqual([])
    // nobody to ask: not followed
    const u = setup('alice', { unattended: true })
    recordSent(A.ctx.db, u.chat, { long_url: long })
    rememberConnectionUrls(A.ctx.db, u.chat, [at('/s/abc')], { integrationId, userId: 'alice', turnId: u.turnId })
    await expect(u.run(at('/s/abc'), 'users/alice/redir.png')).rejects.toThrow(/redirected to one that matches what the AI had sent/)
  })
  test('an echo is decided when the address comes back: marks left later do not change it', () => {
    const s = setup()
    const u = 'https://cdn.service.example/later/q.png?sig=abcdefgh123'
    rememberConnectionUrls(A.ctx.db, s.chat, [u], { integrationId, userId: 'alice', turnId: s.turnId })
    recordSent(A.ctx.db, s.chat, { again: u })
    expect(isEcho(A.ctx.db, s.chat, u)).toBe(false) // known (the service's own) leaves no mark
    expect((A.ctx.db.query('SELECT echo FROM chat_connection_urls WHERE chat_id = ? AND url = ?').get(s.chat, u) as { echo: number }).echo).toBe(0)
  })
  test('another person\'s connection, or one that was removed: a card', async () => {
    const s = setup('erin')
    rememberConnectionUrls(A.ctx.db, s.chat, [at('/hero.png?who=erin')], { integrationId, userId: 'erin', turnId: s.turnId })
    s.cards.answer = false
    await expect(s.run(at('/hero.png?who=erin'), 'shared/conn/erin.png')).rejects.toThrow(/did not allow/)
    expect(s.cards.asked[0]).toContain('did not appear in this conversation')
  })
  test('scheduled runs: an echo cannot be confirmed, so it is not opened', async () => {
    const s = setup('alice', { unattended: true })
    recordSent(A.ctx.db, s.chat, { u: at('/hero.png?sched=1') })
    rememberConnectionUrls(A.ctx.db, s.chat, [at('/hero.png?sched=1')], { integrationId, userId: 'alice', turnId: s.turnId })
    await expect(s.run(at('/hero.png?sched=1'), 'shared/conn/sched.png')).rejects.toThrow(/came back from a connected service, but the AI had sent/)
  })
})

describe('database', () => {
  test('migration 325 adds tables only and needs no newer reader: 0.2.16 (reader level 4) still opens the database', () => {
    const m = readMigrations().find((x) => x.version === 325)!
    expect(m.name).toBe('325_c_connection_urls.sql')
    expect(m.minCompatibleReader).toBe(1)
    expect(m.sql).not.toMatch(/DROP|RENAME|ALTER TABLE chat_seen_urls/i)
    expect(() => checkReadable(A.ctx.db, 4)).not.toThrow()
  })
})
