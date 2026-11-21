// The demo's Higgsfield (demo/fakes/index.ts): the Higgsfield MCP connection (shared/src/service-catalog.ts) answered in
// this process through the connections/net.ts answer hook. A small tool list: generate_image, generate_video,
// job_display, show_generations, balance. A banner's words are not changed here: that is the server's own
// change_banner_text (banners.ts, tools/demo-banner.ts), since nothing goes to Higgsfield for it (owner, 11-22).
// generate_image answers at once with a canned picture picked by the words of
// the prompt from the content folder's higgsfield/ pictures (their file names are the keywords: "yuzu-ginger-window.jpg"),
// no picture when none matches, a built-in one when the folder has none; the picture comes inline (connections/media.ts
// keeps it for save_connector_file) and at a download address only this fake answers (tools/download.ts). A video is refused. No credits are ever used.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { RemoteTool } from '../../integrations/connections/mcp'
import type { NetRequest } from '../../integrations/connections/net'
import type { FakeState, Generation } from './state'
import { answerMcp, str, text, type FakeTool, type McpResult } from './mcp'

/** the hosts of the Higgsfield MCP connection this fake answers */
export const HIGGSFIELD_HOSTS = new Set(['mcp.higgsfield.ai'])
/** where a generated picture can be downloaded: a name that never resolves, answered by the fake only */
export const MEDIA_HOST = 'higgsfield-media.demo.invalid'
export const PICTURES_DIR = 'higgsfield'
export const VIDEO_REFUSED = 'Video isn\'t available in the demo'
/** Said in every picture's result, where the AI reads it as it answers (QA TC-6792: the system prompt alone did not make
 * it say so): one short sentence, the photo's origin. */
export const PREPARED_PHOTO = "This photo is one of the demo's prepared photos: no new photo was made."
/** what the AI does with a picture next (QA TC-6791: the banner showed nowhere and was saved only when asked again):
 * saved into the team folder and named as a Markdown image, which is how a picture appears in the chat */
export const SAVE_NEXT = 'Save it now with save_connector_file (the mcp-file handle below) into the project\'s folder, then show it in the answer as a Markdown image.'
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

/** The picture whose name shares the most words with the prompt (the first on a tie), or null when none shares a word.
 * Before 11-22 no match gave the first picture: asked for a scene the demo does not have, the visitor got the same
 * prepared photo twice and two copies of it in their files (QA A4). */
export function pickPicture(pictures: readonly Picture[], prompt: string): Picture | null {
  const want = new Set(words(prompt))
  let best: Picture | null = null, score = 0
  for (const p of pictures) {
    const s = p.words.filter((w) => want.has(w)).length
    if (s > score) { best = p; score = s }
  }
  return best
}

/** a picture in a few readable words: its name's Latin words ("yuzu ginger tea pouch iced glass") */
const sceneWords = (p: Picture) => p.words.filter((w) => /^[a-z]+$/.test(w)).slice(0, 8).join(' ') || p.name
/** what generate_image says when no prepared photo matches: nothing was made, so nothing is saved */
export function noPictureText(prompt: string, pictures: readonly Picture[]): string {
  return `No prepared photo matches '${prompt.replace(/\s+/g, ' ').slice(0, 200)}'. Nothing was made. Prepared scenes: ${pictures.map(sceneWords).join('; ')}. For a banner on one of them, use change_banner_text with scene.`
}
/** what generate_image says when the closest photo is the one it gave last time: nothing new, nothing to save again */
export function samePictureText(prompt: string, job: string, pictures: readonly Picture[]): string {
  return `The closest prepared photo for '${prompt.replace(/\s+/g, ' ').slice(0, 200)}' is the one already given as job ${job}. Nothing new was made; do not save it again. Prepared scenes: ${pictures.map(sceneWords).join('; ')}.`
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

/** The fake's tool list (what tools/list answers). Also what the snapshot's Higgsfield connection keeps as its saved
 * tools (routes/demo-builder.ts, integrations.tools_json): with none saved the AI had no image tool (QA TC-5559). */
export const HIGGSFIELD_TOOLS = [
  { name: 'generate_image', title: 'Generate image', readOnly: false, description: 'Generate an image from a text prompt. In the demo it picks the closest of the demo\'s prepared photos (no new photo is made). Returns the finished job with the picture: save it with save_connector_file right away and show it in the answer. The picture has no words in it. Use it for a new background, photo or scene; to change a banner\'s words use the built-in change_banner_text instead (it runs on this server, nothing is sent to Higgsfield).',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'what the picture shows' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] }, model: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['prompt'] } },
  { name: 'generate_video', title: 'Generate video', readOnly: false, description: 'Generate a video from a text prompt.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'integer' } }, required: ['prompt'] } },
  { name: 'job_display', title: 'Get job', readOnly: true, description: 'Show one generation job by its id: status and results.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
  { name: 'show_generations', title: 'List generations', readOnly: true, description: 'List your recent generations, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'balance', title: 'Balance', readOnly: true, description: 'Your credit balance.',
    inputSchema: { type: 'object', properties: {} } },
] as const satisfies readonly Omit<FakeTool, 'call'>[]
type HiggsfieldToolName = (typeof HIGGSFIELD_TOOLS)[number]['name']

/** The fake's tools as a connection saves them (connections/mcp.ts RemoteTool, the shape of integrations.tools_json). */
export function higgsfieldSavedTools(): RemoteTool[] {
  return HIGGSFIELD_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly, inputSchema: structuredClone(t.inputSchema) as Record<string, unknown> }))
}

const extOf = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg')
/** the old tool's name: a saved tool list from before 11-22 may still offer it */
export const MAKE_BANNER_MOVED = "make_banner isn't a Higgsfield tool: a banner's words are changed with the built-in change_banner_text, which runs on this server (nothing is sent to Higgsfield)."
/** Higgsfield's own pictures: never a banner the server's change_banner_text drew (banners.ts) */
const ownJob = (g: Generation) => !g.banner

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
    const g = id ? this.state.get().generations.find((x) => x.id === id && ownJob(x)) : undefined
    if (!g) return null
    const b = this.bytesOf(g)
    return { bytes: b.bytes, contentType: b.mime }
  }

  private generate(a: Record<string, any>): McpResult {
    const prompt = str(a.prompt, 4000)
    if (prompt.length < 3) return text('Describe the picture in a few words (prompt).', true)
    // the content folder's pictures: one must match (else nothing is made, no job is kept, nothing gets saved); none at
    // all (the built-in data): the built-in picture
    const pick = pickPicture(this.pictures, prompt)
    if (this.pictures.length && !pick) return text(noPictureText(prompt, this.pictures), true)
    // the same prepared photo as the last one Higgsfield gave: no second copy (QA A4: the AI asked again and the visitor
    // got the same photo twice, saved twice)
    const lastOwn = [...this.state.get().generations].reverse().find(ownJob)
    if (pick && lastOwn?.picture === pick.name) return text(samePictureText(prompt, lastOwn.id, this.pictures), true)
    const g: Generation = { id: this.state.nextId('job'), prompt, model: str(a.model, 100) || 'demo-image', picture: pick?.name ?? 'built-in', mime: pick?.mime ?? 'image/png', createdAt: new Date().toISOString() }
    this.state.update((d) => { d.generations.push(g) })
    const b = this.bytesOf(g)
    return { content: [{ type: 'text', text: JSON.stringify({ ...this.view(g), photo: PREPARED_PHOTO, next: SAVE_NEXT }) }, ...(b.bytes.length <= INLINE_MAX ? [{ type: 'image' as const, data: b.bytes.toString('base64'), mimeType: b.mime }] : [])] }
  }

  private readonly calls: Record<HiggsfieldToolName, FakeTool['call']> = {
    generate_image: (a) => this.generate(a),
    generate_video: () => text(`${VIDEO_REFUSED}. Pictures work: use generate_image.`, true),
    job_display: (a) => { const g = this.state.get().generations.find((x) => x.id === str(a.job_id, 64) && ownJob(x)); return g ? text(JSON.stringify(this.view(g))) : text(`No job ${str(a.job_id, 64)}.`, true) },
    show_generations: (a) => { const n = Math.max(1, Math.min(50, Number(a.limit) || 10)); return text(JSON.stringify({ generations: this.state.get().generations.filter(ownJob).reverse().slice(0, n).map((g) => this.view(g)) })) },
    balance: () => text(JSON.stringify({ credits: 1000, plan: 'demo', note: 'Generations in the demo use no credits.' })),
  }
  readonly tools: FakeTool[] = HIGGSFIELD_TOOLS.map((t) => ({ ...t, call: this.calls[t.name] }))

  /** one request to a Higgsfield address: the MCP endpoint, a token refresh, anything else 404 */
  async answer(url: URL, r: NetRequest): Promise<{ status: number; headers?: Record<string, string>; body?: string | Buffer }> {
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return answerMcp('higgsfield', this.tools, r, { unavailable: (t) => (t === 'make_banner' ? MAKE_BANNER_MOVED : `${t} isn't available in the demo. generate_image, job_display, show_generations and balance work here.`) })
    if (r.method === 'POST' && /\/token$/.test(url.pathname)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: `demo-hf-${this.state.nextId('t')}`, token_type: 'Bearer', expires_in: 31_536_000 }) }
    }
    return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not in the demo"}' }
  }
}
