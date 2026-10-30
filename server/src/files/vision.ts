// What the AI sees when it reads an image or a PDF page, like Claude Code's own Read: the pixels, as an MCP image
// block (files/service.ts readImage / readPdf). docs/DECISIONS.md "AI sees images and PDF pages (feat/vision-read)".
//
// - Images (png, jpg, gif, webp, heic, tiff, bmp) and PDF pages without a text layer go to the model as one new JPEG
//   each: decoded and rebuilt from pixels by the Go normalizer `mycel-safeops vision` (native/internal/safeops/
//   vision.go): longest side 1568 px, at most 1 MiB, transparency on white, EXIF orientation applied, no metadata
//   (EXIF, GPS, XMP, ICC, comments) copied. HEIC is first decoded by heif-dec or macOS ImageIO (heic-preview.ts).
// - PDF pages: the text layer comes from pdftotext (or PDFKit, `mycel-ocr --layer`, on a Mac without poppler);
//   pages are drawn by pdftoppm (Linux) or PDFKit (`mycel-ocr --page`, macOS) and normalized the same way.
// - Every converter runs in the converter isolation (tools/isolate.ts: bwrap + converter cgroup on Linux,
//   sandbox-exec on macOS) with time, memory and output limits, input on stdin, and at most VISION_PARALLEL at once.
// - No OCR here. The team's switch (Team settings, `aiVision`, default on) and the engine decide whether pixels go
//   out at all (visionBlock); the caller keeps the read scope and re-checks access before delivery.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { getTeamSettings } from '../admin/settings'
import { ToolError } from '../policy/errors'
import { runIsolated } from '../tools/isolate'
import { ext } from './extract'
import { heicToJpeg, heicTools, isHeic, type HeicTools } from './heic-preview'

export const VISION_IMAGE_EXT: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'])
export const isVisionImage = (name: string) => VISION_IMAGE_EXT.has(ext(name))

/** the longest side the model gets (Anthropic's recommended size; larger is only scaled down again upstream) */
export const VISION_SIDE_MAX = 1568
/** one image block at most (the normalizer steps the JPEG quality down to fit) */
export const VISION_OUTPUT_MAX = 1024 ** 2
/** the largest image file read for the model (a 48 MP phone JPEG is about 20 MB) */
export const VISION_INPUT_MAX = 32 * 1024 ** 2
/** images and bytes of image blocks one turn may send: every image stays in the conversation the engine sends again
 * with each request (the model proxy and the providers take at most 32 MB per request) */
export const VISION_TURN_IMAGES = 40
export const VISION_TURN_BYTES = 10 * 1024 ** 2
/** PDF pages per read call, and the most pages a read may give without `pages` (Claude Code's Read contract) */
export const PDF_PAGES_PER_READ = 20
export const PDF_PAGES_WITHOUT_RANGE = 10
/** One tool result as the engine takes it. Claude Code cuts an MCP result over MAX_MCP_OUTPUT_TOKENS (25,000 by default):
 * it leaves out the images past the limit and tells the AI the output was truncated. A PDF read stops adding page images
 * below that and names the pages to read in another call (review of feat/vision-read). */
export const READ_OUTPUT_TOKENS = 24_000
/** an image block: about width x height / 750 tokens (Anthropic's estimate), from the JPEG's frame header */
export function imageTokens(jpeg: Uint8Array): number {
  for (let p = 2; p + 9 < jpeg.length;) {
    if (jpeg[p] !== 0xff) break
    const m = jpeg[p + 1]!
    if (m >= 0xc0 && m <= 0xc3) return Math.ceil((((jpeg[p + 5]! << 8) | jpeg[p + 6]!) * ((jpeg[p + 7]! << 8) | jpeg[p + 8]!)) / 750)
    p += 2 + ((jpeg[p + 2]! << 8) | jpeg[p + 3]!)
  }
  return Math.ceil((VISION_SIDE_MAX * VISION_SIDE_MAX) / 750)
}
/** text: about 4 characters a token in English; Korean, Japanese and other non-ASCII text counted a token a character */
export function textTokens(s: string): number {
  let other = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) other++
  return Math.ceil((s.length - other) / 4) + other
}

/** a page with fewer non-space characters than this has no usable text layer (a scan): the same test as extract.ts */
export const SCANNED_PAGE_CHARS = 20
/** text of a pages read (all pages together) */
export const PDF_TEXT_MAX = 200_000

const CONVERT_TIMEOUT_MS = 30_000
const CONVERT_RSS_MIB = 1024
/** conversions at the same time on this server; more wait (VISION_QUEUE_MAX at most, then 'busy') */
export const VISION_PARALLEL = 3
const VISION_QUEUE_MAX = 32

/** Why no pixels go to the model for this call; null: they do. */
export type VisionBlock = 'off' | 'engine' | 'connection'

/** The team's switch "Send images and PDF pages to the AI" (Team settings; default on). */
export function visionOn(db: Database): boolean {
  return getTeamSettings(db).aiVision
}

/**
 * Whether this call may send pixels: the team switch, and an engine that takes images. The API engine (OpenAI-
 * compatible chat, engine/api-agent.ts) passes only text to its model; a call without a chat turn comes from a
 * connection whose answer is text only (the remote MCP connector).
 */
export function visionBlock(db: Database, turnId: string | null): VisionBlock | null {
  if (!visionOn(db)) return 'off'
  if (!turnId) return 'connection'
  const t = db.query('SELECT engine FROM turns WHERE id = ?').get(turnId) as { engine: string } | null
  if (!t) return 'connection'
  return t.engine === 'api' ? 'engine' : null
}

export interface VisionTools {
  /** mycel-safeops (the vision normalizer) */
  normalizer: string | null
  heic: HeicTools
  pdftotext: string | null
  pdftoppm: string | null
  /** macOS: mycel-ocr (PDFKit text layer and page drawing) */
  pdfkit: string | null
}

/** The converters of this server. `nativeBin` holds mycel-safeops; `ocr` is mycel-ocr (macOS) or null. */
export function visionTools(o: { nativeBin: string; pdftotext: string | null; ocr: string | null; which: (n: string) => string | null }): VisionTools {
  const normalizer = path.join(o.nativeBin, 'mycel-safeops')
  return {
    normalizer: fs.existsSync(normalizer) ? normalizer : null,
    heic: heicTools(),
    pdftotext: o.pdftotext,
    pdftoppm: o.which('pdftoppm'),
    pdfkit: process.platform === 'darwin' ? o.ocr : null,
  }
}

// ---------------- conversion slots ----------------
let running = 0
const waiting: (() => void)[] = []

/** At most VISION_PARALLEL conversions at once; a finished one hands its slot to the next waiting call. */
async function slot<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (running >= VISION_PARALLEL) {
    if (waiting.length >= VISION_QUEUE_MAX) throw new ToolError('too many image conversions', 'vision_busy')
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal?.removeEventListener('abort', onAbort); resolve() }
      const onAbort = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); reject(signal!.reason) }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.push(go)
    })
  } else running++
  try { return await f() } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/** conversions running and waiting (tests) */
export const visionStats = () => ({ running, waiting: waiting.length })

// ---------------- images ----------------
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/** The normalizer's fixed refusal lines (stderr) -> error codes the read maps to a note. */
const REFUSALS: [string, string][] = [
  ['vision: pixel limit', 'vision_too_large'], ['vision: byte limit', 'vision_too_large'],
  ['vision: unsupported format', 'vision_unsupported'], ['vision: corrupt image', 'vision_damaged'], ['vision: output limit', 'vision_heavy'],
]

/** One image file's bytes -> the JPEG the model sees. Throws ToolError vision_* (never converter text). */
export async function normalizeForModel(bytes: Uint8Array, tools: VisionTools, signal?: AbortSignal): Promise<Buffer> {
  if (!tools.normalizer) throw new ToolError('the image normalizer (mycel-safeops) is missing', 'vision_unavailable')
  if (bytes.byteLength > VISION_INPUT_MAX) throw new ToolError('image over the input limit', 'vision_too_large')
  const r = await slot(() => runIsolated({
    cmd: tools.normalizer!, args: ['vision'], stdin: bytes, timeoutMs: CONVERT_TIMEOUT_MS, maxRssMiB: CONVERT_RSS_MIB,
    maxStdout: VISION_OUTPUT_MAX + 1, signal, env: { GOMAXPROCS: '2' },
  }), signal)
  signal?.throwIfAborted()
  if (r.killed === 'aborted') signal?.throwIfAborted()
  if (r.killed) throw new ToolError(`image conversion stopped (${r.killed})`, 'vision_heavy')
  if (r.code !== 0) {
    const line = r.stderr.trim().split('\n')[0] ?? ''
    throw new ToolError(`image conversion refused (${line.slice(0, 60) || 'exit ' + r.code})`, REFUSALS.find(([s]) => line === s)?.[1] ?? 'vision_damaged')
  }
  if (!isJpeg(r.stdout) || r.stdout.length > VISION_OUTPUT_MAX) throw new ToolError('the image normalizer gave no JPEG', 'vision_damaged')
  return r.stdout
}

/** An image file (by its name's extension) -> the model's JPEG; HEIC is decoded first (heif-dec / ImageIO). */
export async function modelImage(name: string, bytes: Uint8Array, tools: VisionTools, signal?: AbortSignal): Promise<Buffer> {
  if (bytes.byteLength > VISION_INPUT_MAX) throw new ToolError('image over the input limit', 'vision_too_large')
  if (!isHeic(name)) return normalizeForModel(bytes, tools, signal)
  if (!tools.normalizer) throw new ToolError('the image normalizer (mycel-safeops) is missing', 'vision_unavailable')
  let decoded: Buffer | null
  try { decoded = await slot(() => heicToJpeg(bytes, tools.heic, signal), signal) } catch (e) {
    signal?.throwIfAborted()
    throw new ToolError('the HEIC photo could not be decoded', e instanceof ToolError && /stopped/.test(e.message) ? 'vision_heavy' : 'vision_damaged')
  }
  if (!decoded) throw new ToolError('no HEIC decoder on this server', 'vision_unavailable')
  return normalizeForModel(decoded, tools, signal)
}

// ---------------- PDFs ----------------
/** The text layer of every page (pdftotext's form feeds; PDFKit on a Mac without poppler). No OCR. */
export async function pdfLayer(bytes: Uint8Array, tools: VisionTools, signal?: AbortSignal): Promise<string[]> {
  let text: string
  if (tools.pdftotext) text = await convert(tools.pdftotext, ['-layout', '-enc', 'UTF-8', '-', '-'], bytes, 'pdftotext', signal)
  else if (tools.pdfkit) text = await convert(tools.pdfkit, ['--layer'], bytes, 'PDFKit', signal)
  else throw new ToolError('pdftotext is not installed on the server')
  const pages = text.split('\f')
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === '') pages.pop()
  return pages
}

/** the raw layer text (pdftotext output): what the search index holds for this PDF on a server without OCR */
export const layerText = (pages: string[]) => pages.map((p) => p + '\f').join('')

export const isScannedPage = (text: string) => text.replace(/\s/g, '').length < SCANNED_PAGE_CHARS

/** One page (1-based) -> the model's JPEG: drawn by PDFKit (macOS) or pdftoppm, then normalized. */
export async function pdfPageImage(bytes: Uint8Array, page: number, tools: VisionTools, signal?: AbortSignal): Promise<Buffer> {
  if (!tools.normalizer) throw new ToolError('the image normalizer (mycel-safeops) is missing', 'vision_unavailable')
  return normalizeForModel(await pdfPagePng(bytes, page, tools, signal), tools, signal)
}

/** One page drawn as a PNG, longest side VISION_SIDE_MAX (also the input of the macOS OCR fallback). */
export async function pdfPagePng(bytes: Uint8Array, page: number, tools: VisionTools, signal?: AbortSignal): Promise<Buffer> {
  const [cmd, args, name] = tools.pdfkit
    ? [tools.pdfkit, ['--page', String(page), '--px', String(VISION_SIDE_MAX)], 'PDFKit']
    : tools.pdftoppm
      ? [tools.pdftoppm, ['-f', String(page), '-l', String(page), '-scale-to', String(VISION_SIDE_MAX), '-png', '-singlefile', '-'], 'pdftoppm']
      : [null, [], '']
  if (!cmd) throw new ToolError('no PDF page renderer (pdftoppm) on this server', 'vision_unavailable')
  const r = await slot(() => runIsolated({ cmd, args, stdin: bytes, timeoutMs: CONVERT_TIMEOUT_MS, maxRssMiB: CONVERT_RSS_MIB, maxStdout: 64 * 1024 ** 2, signal }), signal)
  if (r.killed === 'aborted') signal?.throwIfAborted()
  if (r.killed) throw new ToolError(`${name}: stopped (${r.killed})`, 'vision_heavy')
  const png = r.stdout
  if (r.code !== 0 || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new ToolError(`${name} could not draw page ${page}`, 'vision_damaged')
  return png
}

async function convert(cmd: string, args: string[], input: Uint8Array, name: string, signal?: AbortSignal): Promise<string> {
  const r = await runIsolated({ cmd, args, stdin: input, timeoutMs: 20_000, signal, maxStdout: 32 * 1024 * 1024, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
  if (r.killed === 'aborted') signal?.throwIfAborted()
  if (r.killed === 'timeout') throw new ToolError(`could not convert the file to text (${name}: took too long)`)
  if (r.code !== 0) throw new ToolError(`could not convert the file to text (${name}: ${r.stderr.trim().slice(0, 200) || 'exit ' + r.code})`)
  return r.stdout.toString('utf8')
}

/**
 * Claude Code's `pages` value: "3", "1-5", or a list "1-3,7". Pages are 1-based, at most PDF_PAGES_PER_READ per call.
 * Errors say what to do instead (the AI reads them).
 */
export function parsePages(spec: string, count: number): number[] {
  const s = spec.replace(/\s+/g, '')
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(s)) throw new ToolError(`pages must look like "3", "1-5" or "1-3,7" (pages start at 1); got "${spec.slice(0, 40)}"`, 'bad_pages')
  const out: number[] = []
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number) as [number, number | undefined]
    const end = b ?? a
    if (a < 1 || end < a) throw new ToolError(`pages "${part}" is not a range of pages (pages start at 1)`, 'bad_pages')
    if (a > count) throw new ToolError(`page ${a} is past the end: this PDF has ${count} page${count === 1 ? '' : 's'}`, 'bad_pages')
    // a range that runs past the end stops at the last page, like a text read past the end of its lines
    for (let p = a; p <= Math.min(end, count); p++) {
      if (!out.includes(p)) out.push(p)
      if (out.length > PDF_PAGES_PER_READ) throw new ToolError(`at most ${PDF_PAGES_PER_READ} pages per read; read the others in another call (for example pages: "${a}-${a + PDF_PAGES_PER_READ - 1}")`, 'too_many_pages')
    }
  }
  return out
}

/** "1-3, 7" for the notes */
export function pageList(pages: number[]): string {
  const out: string[] = []
  for (let i = 0; i < pages.length; i++) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++
    out.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]))
    i = j
  }
  return out.join(', ')
}
