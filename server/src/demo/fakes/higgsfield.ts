// The demo's Higgsfield (demo/fakes/index.ts): the Higgsfield MCP connection (shared/src/service-catalog.ts) answered in
// this process through the connections/net.ts answer hook. A small tool list: generate_image, generate_video,
// job_display, show_generations, balance. A banner's words are not changed here: that is the server's own
// change_banner_text (banners.ts, tools/demo-banner.ts), since nothing goes to Higgsfield for it (owner, 11-22).
// generate_image answers at once with a canned picture picked by the words of
// the prompt from the content folder's higgsfield/ pictures (their file names are the keywords: "yuzu-ginger-window.jpg",
// plus the words of their scene in the banner kit, every demo language: banner.ts, kit.json), no picture when none matches, a built-in one when the folder has none; the picture comes inline (connections/media.ts
// keeps it for save_connector_file) and at a download address only this fake answers (tools/download.ts). A video is refused. No credits are ever used.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { RemoteTool } from '../../integrations/connections/mcp'
import type { NetRequest } from '../../integrations/connections/net'
import type { FakeState, Generation } from './state'
import { answerMcp, str, text, type FakeTool, type McpResult } from './mcp'
import { loadBannerKit, type BannerKitFile } from './banner'
import { demoChat } from './scope'

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
 * saved into the team folder, where the chat shows it under save_connector_file's step by itself (never retyped as a
 * Markdown image: a retyped banner path showed one size twice, replay 11-22) */
export const SAVE_NEXT = 'Save it now with save_connector_file (the mcp-file handle below) into the project\'s folder; the chat then shows it. Never repeat it as a Markdown image.'
/** a canned picture larger than this is not sent inline (it still downloads) */
const INLINE_MAX = 4 * 1024 * 1024
const PICTURE_MAX = 20 * 1024 * 1024
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** `words`: its file name's; `keywords`: its scene's in the banner kit (kit.json scenes[].picture), every demo language;
 * `scene`: that scene's id (its name in the no-match line: SCENE_NAMES) */
interface Picture { name: string; words: string[]; keywords?: string[]; scene?: string; mime: string; read: () => Buffer }

/** the canned pictures of the content folder (higgsfield/*.png|jpg|jpeg|webp), each with its scene's words from the
 * banner kit when the kit names it */
export function loadPictures(content: string | null, kit: BannerKitFile | null = loadBannerKit(content)): Picture[] {
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
    const scene = kit?.scenes.find((s) => s.picture?.normalize('NFC') === name.normalize('NFC'))
    const keywords = scene ? [...new Set(scene.words.map((w) => w.toLowerCase().normalize('NFC').trim()).filter((w) => w.length > 1))] : undefined
    out.push({ name, mime, words: words(path.basename(name, path.extname(name))), ...(keywords?.length ? { keywords } : {}), ...(scene ? { scene: scene.id } : {}), read: () => fs.readFileSync(file) })
  }
  return out
}

const tokens = (s: string) => s.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const words = (s: string) => tokens(s).filter((w) => w.length > 1)
/** Japanese and Chinese: no spaces between words, so such a word is found inside the prompt (Korean has spaces, and a
 * one-syllable Korean word found inside others would match nearly anything) */
const unspaced = (w: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)

/**
 * Words that never pick a scene (demo re-test 11-22: "snowy café at night" got a photo that shared one common word with
 * the AI's English prompt): the product itself (every scene shows it), counts without their object ("two", "dos"),
 * people and sharing ("friends", "together"), "product", colours and little words, in every demo language. A count
 * with its object is a phrase of its scene ("two glasses", "dos vasos", "dua gelas") and still counts.
 */
export const NOT_SCENE_WORDS: ReadonlySet<string> = new Set([
  // little words
  'a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'at', 'for', 'by', 'to', 'from', 'into', 'over', 'under', 'near', 'some', 'its', 'our', 'very',
  'un', 'una', 'unos', 'unas', 'el', 'la', 'los', 'las', 'de', 'del', 'con', 'y', 'en', 'para', 'por', 'junto', 'al', 'entre',
  'di', 'dan', 'yang', 'untuk', 'dengan', 'sebuah', 'pada', 'dari', 'ke', 'dekat', 'hari',
  // counts alone
  'one', 'two', 'three', 'single', 'uno', 'dos', 'tres', 'satu', 'dua', 'tiga',
  // what any picture is
  'photo', 'photos', 'picture', 'image', 'shot', 'background', 'scene', 'new', 'banner', 'ad', 'style', 'realistic', 'high', 'quality',
  'foto', 'imagen', 'fondo', 'escena', 'gambar', 'latar', 'adegan', '사진', '배경', '장면', '이미지', '写真', '画像', '背景', '照片', '图片', '场景',
  // the product, in every scene
  'yuzu', 'ginger', 'tea', 'iced', 'ice', 'cold', 'brew', 'drink', 'drinks', 'beverage', 'launch',
  'té', 'jengibre', 'helado', 'helada', 'frío', 'fría', 'bebida', 'teh', 'jahe', 'dingin', 'minuman', 'es',
  '유자', '진저', '아이스', '콜드브루', '음료', '柚子', 'ゆず', 'ユズ', '生姜', 'ジンジャー', 'アイス', 'ティー', '姜茶', '冰饮', '饮料',
  // people, sharing, partners
  'friends', 'friend', 'together', 'share', 'sharing', 'partner', 'partners', 'people', 'person',
  'amigos', 'amigas', 'juntos', 'compartir', 'socios', 'teman', 'bersama', 'berbagi', 'mitra',
  '함께', '같이', '나눠', '친구', '파트너', '友達', '一緒', 'パートナー', '取引先', '朋友', '一起', '分享', '合作',
  // "product"
  'product', 'products', 'producto', 'productos', 'produk', '제품', '商品', '製品', '产品',
  // colours and moods
  'white', 'black', 'green', 'yellow', 'orange', 'red', 'blue', 'cream', 'warm', 'bright', 'soft', 'cozy', 'cosy', 'fresh', 'natural', 'light',
  'blanco', 'verde', 'amarillo', 'cálido', 'putih', 'hijau', 'kuning', 'hangat',
])

/**
 * Elements no prepared photo has (demo re-test 11-22: "snowy café at night" got the café photo): a prompt that names one
 * gets no picture, unless a picture's own words name it. Latin and Korean as whole words (Korean with its usual
 * endings), Japanese and Chinese found inside the prompt.
 */
const ABSENT_WORDS: ReadonlySet<string> = new Set([
  'snow', 'snowy', 'snowing', 'snowfall', 'snowflakes', 'night', 'nighttime', 'midnight', 'evening', 'dusk', 'sunset', 'rain', 'rainy', 'raining', 'storm',
  'beach', 'ocean', 'sea', 'mountain', 'mountains', 'forest', 'christmas', 'winter', 'cabin', 'street', 'neon',
  'nieve', 'nevado', 'nevada', 'nevando', 'noche', 'nocturno', 'nocturna', 'lluvia', 'lluvioso', 'playa', 'mar', 'montaña', 'bosque', 'navidad', 'invierno', 'atardecer',
  'salju', 'bersalju', 'malam', 'hujan', 'pantai', 'laut', 'gunung', 'hutan', 'natal', 'senja',
])
const ABSENT_KO = /^(?:눈|밤|비|겨울|해변|바다|산|숲|크리스마스|야경|야간|한밤중?|저녁|설경|노을|눈오는|눈내리는|눈덮인|비오는|밤하늘|밤거리)(?:이|가|의|을|를|에|에서|과|와|속|길|빛|도|은|는|중|하늘|거리|풍경)?$/
const ABSENT_CJK = ['雪', '夜', '夕方', '夕暮れ', '雨', '海', '浜辺', 'ビーチ', '山', '森', 'クリスマス', '冬', '晚上', '傍晚', '圣诞', '聖誕']

/** the prompt names something no prepared photo has (snow, night, a beach …) */
export function namesAbsent(pictures: readonly Picture[], prompt: string): boolean {
  const all = new Set(pictures.flatMap((p) => [...p.words, ...(p.keywords ?? [])]))
  if (tokens(prompt).some((w) => !all.has(w) && (ABSENT_WORDS.has(w) || ABSENT_KO.test(w)))) return true
  const whole = prompt.normalize('NFC').toLowerCase()
  return ABSENT_CJK.some((c) => whole.includes(c) && ![...all].some((w) => w.includes(c)))
}

/**
 * The picture whose scene the prompt names, or null. Only scene-defining words count: a word of a picture's name or
 * its scene's words that no other picture has, never one of NOT_SCENE_WORDS; a phrase ("two glasses", "dua gelas")
 * counts its words. At least one must match, and a prompt that names something no photo has (namesAbsent: snow, night
 * …) gets nothing. The first picture wins a tie. Before the demo re-test of 11-22 any shared word was enough ("snowy
 * café at night" got the café photo), and before QA A4 no match gave the first picture.
 */
export function pickPicture(pictures: readonly Picture[], prompt: string): Picture | null {
  if (!pictures.length || namesAbsent(pictures, prompt)) return null
  const list = tokens(prompt)
  const want = new Set(list)
  // Korean writes "두 잔" and "두잔": both count
  for (let i = 0; i + 1 < list.length; i++) want.add(list[i]! + list[i + 1]!)
  const spaced = ` ${list.join(' ')} `
  const whole = prompt.normalize('NFC').toLowerCase()
  const sets = pictures.map((p) => new Set([...p.words, ...(p.keywords ?? [])].filter((w) => !NOT_SCENE_WORDS.has(w))))
  const df = new Map<string, number>()
  for (const s of sets) for (const w of s) df.set(w, (df.get(w) ?? 0) + 1)
  const hit = (w: string) => (w.includes(' ') ? spaced.includes(` ${tokens(w).join(' ')} `) : want.has(w) || (unspaced(w) && whole.includes(w)))
  let best: Picture | null = null, score = 0
  pictures.forEach((p, i) => {
    const s = [...sets[i]!].filter((w) => df.get(w) === 1 && hit(w)).reduce((n, w) => n + tokens(w).length, 0)
    if (s > score) { best = p; score = s }
  })
  return best
}

/** a picture in a few readable words: its name's Latin words ("yuzu ginger tea pouch iced glass") */
const sceneWords = (p: Picture) => p.words.filter((w) => /^[a-z]+$/.test(w)).slice(0, 8).join(' ') || p.name
type Lang = BannerKitFile['lang']
/** each prepared scene by name in the demo's language (scripts/demo/steepling/banner/kit.ts) */
const SCENE_NAMES: Record<string, Record<Lang, string>> = {
  'one-cup': { ko: '창가의 한 잔', en: 'one glass by a frosted window', ja: '窓辺のグラス一杯', zh: '窗边的一杯', es: 'un vaso junto a la ventana', id: 'satu gelas di dekat jendela' },
  'two-cups': { ko: '두 잔', en: 'two glasses', ja: 'グラス二杯', zh: '两杯', es: 'dos vasos', id: 'dua gelas' },
  pouch: { ko: '파우치 클로즈업', en: 'the pouch up close', ja: 'パウチのクローズアップ', zh: '茶包特写', es: 'la bolsa de cerca', id: 'kemasan dari dekat' },
  cafe: { ko: '카페 테이블', en: 'a café table', ja: 'カフェのテーブル', zh: '咖啡馆的桌子', es: 'una mesa de cafetería', id: 'meja kafe' },
}
const NO_SCENE: Record<Lang, (scenes: string) => string> = {
  ko: (s) => `데모에는 그 장면 사진이 없어요. 준비된 장면: ${s}.`,
  en: (s) => `The demo has no photo of that scene. Prepared scenes: ${s}.`,
  ja: (s) => `デモにはその場面の写真がありません。用意してある場面：${s}。`,
  zh: (s) => `演示中没有这个场景的照片。已准备的场景：${s}。`,
  es: (s) => `La demo no tiene una foto de esa escena. Escenas preparadas: ${s}.`,
  id: (s) => `Demo ini tidak punya foto adegan itu. Adegan yang tersedia: ${s}.`,
}
/** The one line the person gets when no prepared photo matches, in the demo's language, naming the prepared scenes. */
export function noSceneLine(pictures: readonly Picture[], lang: Lang = 'en'): string {
  const sep = lang === 'ja' || lang === 'zh' ? '、' : ', '
  return NO_SCENE[lang]([...new Set(pictures.map((p) => (p.scene && SCENE_NAMES[p.scene]?.[lang]) || sceneWords(p)))].join(sep))
}
/** What generate_image says when no prepared photo matches: nothing was made, and one line for the AI to pass on as it
 * is (demo re-test 11-22: the answer ran several lines) */
export function noPictureText(pictures: readonly Picture[], lang: Lang = 'en'): string {
  return `Nothing was made: no prepared photo shows this scene. Reply to the user with exactly this one line and nothing else, and do not call generate_image again for it: ${noSceneLine(pictures, lang)}`
}
/** what generate_image says when the closest photo is the one it gave last time in this chat: nothing new, nothing to
 * save again */
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
  { name: 'generate_image', title: 'Generate image', readOnly: false, description: 'Generate an image from a text prompt. In the demo it gives the one of the demo\'s prepared photos that shows the scene the prompt names (no new photo is made), or none when none of them shows it. Returns the finished job with the picture: save it with save_connector_file right away (the chat then shows it; no Markdown image). The picture has no words in it. Use it for a new background, photo or scene; to change a banner\'s words use the built-in change_banner_text instead (it runs on this server, nothing is sent to Higgsfield).',
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
  /** lang: the demo's language (its banner kit's), for the line said when no photo matches */
  constructor(private pictures: Picture[], private state: FakeState, private lang: BannerKitFile['lang'] = 'en') {}

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
    if (this.pictures.length && !pick) return text(noPictureText(this.pictures, this.lang), true)
    // the same prepared photo as the last one Higgsfield gave in this chat: no second copy (QA A4: the AI asked again
    // and the visitor got the same photo twice, saved twice). Another chat or project asking for it gets it: that is a
    // new request (review of #293). No chat known: never refused.
    const chat = demoChat()
    const lastOwn = chat ? [...this.state.get().generations].reverse().find((g) => ownJob(g) && g.chat === chat) : undefined
    if (pick && lastOwn?.picture === pick.name) return text(samePictureText(prompt, lastOwn.id, this.pictures), true)
    const g: Generation = { id: this.state.nextId('job'), prompt, model: str(a.model, 100) || 'demo-image', picture: pick?.name ?? 'built-in', mime: pick?.mime ?? 'image/png', createdAt: new Date().toISOString(), ...(chat ? { chat } : {}) }
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
