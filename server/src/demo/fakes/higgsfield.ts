// The demo's Higgsfield (demo/fakes/index.ts): the Higgsfield MCP connection (shared/src/service-catalog.ts) answered in
// this process through the connections/net.ts answer hook. A small tool list: generate_image, generate_video,
// job_display, show_generations, balance. generate_image answers at once with a canned picture picked by the words of
// the prompt from the content folder's higgsfield/ pictures (their file names are the keywords: "yuzu-ginger-window.jpg"),
// else a built-in one; the picture comes inline (connections/media.ts keeps it for save_connector_file) and at a
// download address only this fake answers (tools/download.ts). A video is refused. No credits are ever used.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { NetRequest } from '../../integrations/connections/net'
import type { FakeState, Generation } from './state'
import { answerMcp, str, text, type FakeTool, type McpResult } from './mcp'

/** the hosts of the Higgsfield MCP connection this fake answers */
export const HIGGSFIELD_HOSTS = new Set(['mcp.higgsfield.ai'])
/** where a generated picture can be downloaded: a name that never resolves, answered by the fake only */
export const MEDIA_HOST = 'higgsfield-media.demo.invalid'
export const PICTURES_DIR = 'higgsfield'
export const VIDEO_REFUSED = 'Video isn\'t available in the demo'
/** a canned picture larger than this is not sent inline (it still downloads) */
const INLINE_MAX = 4 * 1024 * 1024
const PICTURE_MAX = 20 * 1024 * 1024
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

interface Picture { name: string; words: string[]; mime: string; read: () => Buffer }

/** the canned pictures of the content folder (higgsfield/*.png|jpg|jpeg|webp) */
export function loadPictures(content: string | null): Picture[] {
  if (!content) return []
  const dir = path.join(content, PICTURES_DIR)
  let names: string[] = []
  try { names = fs.readdirSync(dir).sort() } catch { return [] }
  const out: Picture[] = []
  for (const name of names) {
    const mime = MIME[path.extname(name).toLowerCase()]
    if (!mime || name.startsWith('.')) continue
    const file = path.join(dir, name)
    try { if (!fs.statSync(file).isFile() || fs.statSync(file).size > PICTURE_MAX) continue } catch { continue }
    out.push({ name, mime, words: words(path.basename(name, path.extname(name))), read: () => fs.readFileSync(file) })
  }
  return out
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)

/** the picture whose name shares the most words with the prompt (the first on a tie or no match), or null */
export function pickPicture(pictures: readonly Picture[], prompt: string): Picture | null {
  if (!pictures.length) return null
  const want = new Set(words(prompt))
  let best = pictures[0]!, score = -1
  for (const p of pictures) {
    const s = p.words.filter((w) => want.has(w)).length
    if (s > score) { best = p; score = s }
  }
  return best
}

// ---- the built-in picture: a small soft gradient PNG, made once ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(b: Buffer) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
let builtIn: Buffer | null = null
/** 480×270, deep green to warm cream (the default when the content folder has no pictures) */
export function builtInPicture(): Buffer {
  if (builtIn) return builtIn
  const w = 480, h = 270
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round(24 + t * (245 - 24)); raw[o + 1] = Math.round(84 + t * (236 - 84)); raw[o + 2] = Math.round(56 + t * (214 - 56))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  builtIn = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return builtIn
}

const extOf = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg')

export class FakeHiggsfield {
  constructor(private pictures: Picture[], private state: FakeState) {}

  private bytesOf(g: Generation): { bytes: Buffer; mime: string } {
    const p = this.pictures.find((x) => x.name === g.picture)
    if (p) { try { return { bytes: p.read(), mime: p.mime } } catch { /* gone: the built-in one */ } }
    return { bytes: builtInPicture(), mime: 'image/png' }
  }
  urlOf(g: Generation) { return `https://${MEDIA_HOST}/${g.id}.${extOf(g.mime)}` }
  private view(g: Generation) { return { job_id: g.id, status: 'completed', type: 'image', model: g.model, prompt: g.prompt, created_at: g.createdAt, results: [{ type: 'image', url: this.urlOf(g) }] } }

  /** a download address of a generated picture (tools/download.ts), or null when it is not one */
  download(url: string): { bytes: Buffer; contentType: string } | null {
    let u: URL
    try { u = new URL(url) } catch { return null }
    if (u.hostname !== MEDIA_HOST) return null
    const id = /^\/([A-Za-z0-9_-]{1,64})\.(png|jpg|webp)$/.exec(u.pathname)?.[1]
    const g = id ? this.state.get().generations.find((x) => x.id === id) : undefined
    if (!g) return null
    const b = this.bytesOf(g)
    return { bytes: b.bytes, contentType: b.mime }
  }

  private generate(a: Record<string, any>): McpResult {
    const prompt = str(a.prompt, 4000)
    if (prompt.length < 3) return text('Describe the picture in a few words (prompt).', true)
    const pick = pickPicture(this.pictures, prompt)
    const g: Generation = { id: this.state.nextId('job'), prompt, model: str(a.model, 100) || 'demo-image', picture: pick?.name ?? 'built-in', mime: pick?.mime ?? 'image/png', createdAt: new Date().toISOString() }
    this.state.update((d) => { d.generations.push(g) })
    const b = this.bytesOf(g)
    return { content: [{ type: 'text', text: JSON.stringify(this.view(g)) }, ...(b.bytes.length <= INLINE_MAX ? [{ type: 'image' as const, data: b.bytes.toString('base64'), mimeType: b.mime }] : [])] }
  }

  readonly tools: FakeTool[] = [
    { name: 'generate_image', title: 'Generate image', readOnly: false, description: 'Generate an image from a text prompt. Returns the finished job with the picture.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'what the picture shows' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] }, model: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['prompt'] },
      call: (a) => this.generate(a) },
    { name: 'generate_video', title: 'Generate video', readOnly: false, description: 'Generate a video from a text prompt.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'integer' } }, required: ['prompt'] },
      call: () => text(`${VIDEO_REFUSED}. Pictures work: use generate_image.`, true) },
    { name: 'job_display', title: 'Get job', readOnly: true, description: 'Show one generation job by its id: status and results.',
      inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
      call: (a) => { const g = this.state.get().generations.find((x) => x.id === str(a.job_id, 64)); return g ? text(JSON.stringify(this.view(g))) : text(`No job ${str(a.job_id, 64)}.`, true) } },
    { name: 'show_generations', title: 'List generations', readOnly: true, description: 'List your recent generations, newest first.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
      call: (a) => { const n = Math.max(1, Math.min(50, Number(a.limit) || 10)); return text(JSON.stringify({ generations: [...this.state.get().generations].reverse().slice(0, n).map((g) => this.view(g)) })) } },
    { name: 'balance', title: 'Balance', readOnly: true, description: 'Your credit balance.',
      inputSchema: { type: 'object', properties: {} },
      call: () => text(JSON.stringify({ credits: 1000, plan: 'demo', note: 'Generations in the demo use no credits.' })) },
  ]

  /** one request to a Higgsfield address: the MCP endpoint, a token refresh, anything else 404 */
  async answer(url: URL, r: NetRequest): Promise<{ status: number; headers?: Record<string, string>; body?: string | Buffer }> {
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return answerMcp('higgsfield', this.tools, r, { unavailable: (t) => `${t} isn't available in the demo. generate_image, job_display, show_generations and balance work here.` })
    if (r.method === 'POST' && /\/token$/.test(url.pathname)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: `demo-hf-${this.state.nextId('t')}`, token_type: 'Bearer', expires_in: 31_536_000 }) }
    }
    return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not in the demo"}' }
  }
}
