// make_file's .hwpx, the parts outside the writer (files/hwpx-write.ts, which runs only in the office worker):
// - the worker request: pandoc's JSON tree and an optional template, framed on the worker's stdin;
// - the read-back check: the lines a document should read back as (from pandoc's tree, walked here on its own, not
//   with the writer's code) against what hwp.ts reads from the written file. A file that does not read back as the
//   document is not saved.
// Nothing here parses a document: the tree is pandoc's JSON, already parsed by make_file. For edit_hwp (stages 2 and 3)
// the server compares lines hwp.ts read in the worker, and the containers: two zip central directories (names, CRCs,
// sizes) for a .hwpx; for a .hwp the two compound files' directories and stream bytes (files/cfb.ts, sector chains
// only: nothing is expanded and no record is read).
import { CfbError, cfbMismatch, readCfb } from './cfb'
import { zipDirectory, type ZipDirEntry } from './zip-write'
import type { HwpLayout, HwpPictureNote } from './hwp-picture'

/** worker mode that writes a .hwpx (office-worker.ts) */
export const HWPX_WRITE_MODE = 'hwpx-write'
/** The text of one document, in characters: larger ones are refused (hwp.ts reads at most 8M characters back). */
export const HWPX_TEXT_MAX = 6_000_000
/** a template .hwpx (a team's, under skills/) */
export const HWPX_TEMPLATE_MAX = 20 * 1024 * 1024

/** stdin of the worker: 4 bytes (big-endian) for the length of the JSON tree, the tree, then the template's bytes */
export function encodeHwpxRequest(astJson: string, template?: Uint8Array): Uint8Array {
  const json = Buffer.from(astJson, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(json.length, 0)
  return new Uint8Array(Buffer.concat([head, json, Buffer.from(template ?? new Uint8Array())]))
}

export function decodeHwpxRequest(b: Uint8Array): { astJson: string; template: Uint8Array | null } {
  if (b.length < 4) throw new Error('bad request')
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false)
  if (4 + n > b.length) throw new Error('bad request')
  const rest = b.subarray(4 + n)
  return { astJson: new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(4, 4 + n)), template: rest.length ? rest : null }
}

/** Characters XML 1.0 cannot hold (and tabs, which the writer turns into spaces): dropped from text on both sides. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
export const cleanText = (s: string) => s.replace(NOT_XML, '').replace(/[\t\r]/g, ' ')

interface Node { t?: unknown; c?: unknown }
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v)
const QUOTES: Record<string, [string, string]> = { DoubleQuote: ['“', '”'], SingleQuote: ['‘', '’'] }

/** The text of inlines: `flat` (a heading) joins hard line breaks with a space, as hwp.ts does for headings. Only the
 * inlines the writer supports have text here; it refuses the rest before this is asked. */
function inlineText(inlines: unknown, flat: boolean): string {
  let s = ''
  const stack: unknown[] = [inlines]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') { s += v; continue }
    if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]); continue }
    if (!isNode(v)) continue
    switch (v.t) {
      case 'Str': s += String(v.c ?? ''); break
      case 'Space': case 'SoftBreak': s += ' '; break
      case 'LineBreak': s += flat ? ' ' : '\n'; break
      case 'Strong': case 'Emph': stack.push(v.c); break
      case 'Quoted': {
        const [kind, inner] = (v.c as [Node, unknown]) ?? []
        const q = QUOTES[String(kind?.t)] ?? ['"', '"']
        stack.push(q[1], inner, q[0])
        break
      }
    }
  }
  return s
}

const line = (heading: number, text: string) => (heading ? `${'#'.repeat(heading)} ${text}` : `| ${text}`)
const norm = (s: string) => cleanText(s).replace(/\s+/g, ' ').trim()

/** The lines a document of pandoc's tree reads back as: one per paragraph, `# text` for a heading of that level,
 * `| text` for any other paragraph (a list item or a table cell too, in reading order); empty ones left out. */
export function hwpxExpectedLines(ast: unknown): string[] {
  const out: string[] = []
  const push = (heading: number, text: string) => {
    for (const part of heading ? [text] : text.split('\n')) {
      const t = norm(part)
      if (t) out.push(line(heading, t))
    }
  }
  const blocks = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const b of list) {
      if (!isNode(b)) continue
      const c = b.c as any
      switch (b.t) {
        case 'Header': push(Math.min(6, Number(c?.[0]) || 1), inlineText(c?.[2], true)); break
        case 'Para': case 'Plain': push(0, inlineText(c, false)); break
        case 'BulletList': for (const item of c ?? []) blocks(item); break
        case 'OrderedList': for (const item of c?.[1] ?? []) blocks(item); break
        case 'Table': {
          const rows: unknown[] = [...(c?.[3]?.[1] ?? [])]
          for (const body of c?.[4] ?? []) rows.push(...(body?.[2] ?? []), ...(body?.[3] ?? []))
          rows.push(...(c?.[5]?.[1] ?? []))
          for (const row of rows as any[]) for (const cell of row?.[1] ?? []) blocks(cell?.[4])
          break
        }
      }
    }
  }
  blocks(isNode(ast) ? (ast as { blocks?: unknown }).blocks : [])
  return out
}

/** The same lines from hwp.ts's text of a .hwpx (`# text` only where hwp.ts marked a heading paragraph: it puts a space
 * in front of a body line that starts with `#`). */
export function hwpxReadLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const h = /^(#{1,6}) (.*)$/.exec(raw)
    const t = norm(h ? h[2]! : raw)
    if (t) out.push(line(h ? h[1]!.length : 0, t))
  }
  return out
}

/** null when the two agree, else where they first differ (for the tool error) */
export function firstDifference(want: string[], got: string[]): string | null {
  const clip = (s: string | undefined) => (s === undefined ? '(nothing)' : JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s))
  const n = Math.max(want.length, got.length)
  for (let i = 0; i < n; i++) {
    if (want[i] !== got[i]) return `paragraph ${i + 1}: expected ${clip(want[i])}, read ${clip(got[i])}`
  }
  return null
}

// ---------------------------------------------------------------- edit_hwp (stage 2: an existing .hwpx changed; stage 3: a .hwp)
/** worker mode that changes an existing .hwpx (files/hwpx-edit.ts) */
export const HWPX_EDIT_MODE = 'hwpx-edit'
/** worker mode that changes an existing .hwp (files/hwp-edit.ts) */
export const HWP_EDIT_MODE = 'hwp-edit'
/** A document edit_hwp changes: larger ones are refused (the worker's answer, the new file, must stay below its
 * output cap of 64 MB). */
export const HWP_EDIT_MAX = 40 * 1024 * 1024

/** One change of edit_hwp, as the tool's input gives it (shared/src/tools.ts EditHwpInput). */
export type HwpChange =
  | { find: string; replace: string; occurrence?: number; all?: boolean }
  | { cell: { next_to?: string; direction?: 'right' | 'below'; occurrence?: number; table?: number; row?: number; col?: number }; value: string }
  | { add_rows: { table?: number; table_with?: string; after_row?: number; copy_row?: number; rows: string[][] } }
  | HwpImageChange
/** An image change: `image` is the picture's path in the team folder (the server reads it; the worker gets its bytes). */
export interface HwpImageChange {
  image: string; at?: string; place?: 'over' | 'after' | 'before'; cell?: { next_to: string; direction?: 'right' | 'below' }
  occurrence?: number; width_mm?: number; height_mm?: number; layer?: 'behind' | 'front'
}
export const isImageChange = (c: HwpChange): c is HwpImageChange => 'image' in c

/** worker modes that run a document's checks again on a file the editor made (files/hwpx-edit.ts, files/hwp-edit.ts) */
export const HWPX_VERIFY_MODE = 'hwpx-verify'
export const HWP_VERIFY_MODE = 'hwp-verify'

/** Where edit_hwp saves a new file: `output` without a trailing "/", with the source's extension (.hwp or .hwpx) added
 * unless it ends in .hwp or .hwpx (as make_file names its output). The result keeps the source's format: the tool
 * refuses an output in the other one. The tool and the chat's confirmation card both use this. */
export function hwpOutputPath(output: string, source: string): string {
  const o = output.replace(/\/+$/, '')
  return /\.hwpx?$/i.test(o) ? o : `${o}.${/\.hwp$/i.test(source) ? 'hwp' : 'hwpx'}`
}

/** What the read-back needs from the worker: where the lines of the old document change. `at` and `remove` count lines
 * of the old document as hwpxReadLines gives them; edits come in order, `insert` the new lines at that place, and
 * `changes` the changes (0-based) the edit comes from. */
export interface LineEdit { at: number; remove: number; insert: string[]; changes: number[] }
/** The worker's report on a change it made: which change, where (for the AI), the text before and after. */
export interface HwpEditNote { change: number; where: string; before: string; after: string; /** other changes in the same paragraph */ also?: number[] }
export interface HwpEditReport { lineEdits: LineEdit[]; notes: HwpEditNote[]; placeholders: string[]; pictures?: HwpPictureNote[] }

/** What an edit with image changes sends along: the page layout and each image change's picture (by change index). */
export interface HwpEditExtra { layout: HwpLayout; images: { change: number; bytes: Uint8Array }[] }
/** stdin of the worker's edit mode: 4 bytes (big-endian) for the length of the JSON, the JSON, then the bytes. Without
 * images the JSON is the changes and the bytes the document; with images it is { changes, layout, images: [[change,
 * length], ...] } and the bytes are the images in that order, then the document. */
export function encodeHwpEditRequest(changes: HwpChange[], doc: Uint8Array, extra?: HwpEditExtra): Uint8Array {
  if (!extra?.images.length) return encodeHwpxRequest(JSON.stringify(changes), doc)
  const json = JSON.stringify({ changes, layout: extra.layout, images: extra.images.map((x) => [x.change, x.bytes.length]) })
  return encodeHwpxRequest(json, new Uint8Array(Buffer.concat([...extra.images.map((x) => Buffer.from(x.bytes)), Buffer.from(doc)])))
}
export function decodeHwpEditRequest(b: Uint8Array): { changes: unknown; doc: Uint8Array; layout: unknown; images: Map<number, Uint8Array> } {
  const r = decodeHwpxRequest(b)
  if (!r.template) throw new Error('bad request')
  const v = JSON.parse(r.astJson) as unknown
  if (Array.isArray(v)) return { changes: v, doc: r.template, layout: null, images: new Map() }
  const o = v as { changes?: unknown; layout?: unknown; images?: unknown }
  if (!o || typeof o !== 'object' || !Array.isArray(o.images)) throw new Error('bad request')
  const images = new Map<number, Uint8Array>()
  let at = 0
  for (const x of o.images as unknown[]) {
    if (!Array.isArray(x) || !Number.isInteger(x[0]) || !Number.isInteger(x[1]) || x[1] < 0 || at + x[1] > r.template.length || images.has(x[0])) throw new Error('bad request')
    images.set(x[0], r.template.subarray(at, at + x[1]))
    at += x[1]
  }
  return { changes: o.changes, doc: r.template.subarray(at), layout: o.layout, images }
}
/** stdout of the worker's edit mode: the report's JSON framed the same way, then the new file */
export const encodeHwpEditResult = (report: HwpEditReport, file: Uint8Array) => encodeHwpxRequest(JSON.stringify(report), file)
export function decodeHwpEditResult(b: Uint8Array): { report: HwpEditReport; file: Uint8Array } {
  const r = decodeHwpxRequest(b)
  if (!r.template) throw new Error('bad result')
  const report = JSON.parse(r.astJson) as HwpEditReport
  if (!Array.isArray(report?.lineEdits) || !Array.isArray(report.notes) || !Array.isArray(report.placeholders) || (report.pictures !== undefined && !Array.isArray(report.pictures))) throw new Error('bad result')
  return { report, file: r.template }
}

/** The lines a paragraph reads back as (hwpxReadLines of hwp.ts's text): a heading paragraph (`heading` 1-6) is one
 * line, any other one line per hard line break; empty lines are left out. */
export function hwpxParagraphLines(text: string, heading: number): string[] {
  if (heading && norm(text)) return [line(heading, norm(text))]
  return text.split('\n').map(norm).filter((t) => t).map((t) => line(0, t))
}

/** `old` with the edits applied, or null when they do not fit it (out of order, or past its end). */
export function applyLineEdits(old: string[], edits: LineEdit[]): string[] | null {
  const out: string[] = []
  let pos = 0
  for (const e of edits) {
    if (!Number.isInteger(e.at) || !Number.isInteger(e.remove) || e.remove < 0 || e.at < pos || e.at + e.remove > old.length || !Array.isArray(e.insert)) return null
    out.push(...old.slice(pos, e.at), ...e.insert)
    pos = e.at + e.remove
  }
  out.push(...old.slice(pos))
  return out
}

/** A line's text without its `# ` / `| ` mark and without any white space (lines are compared without it). */
const bare = (s: string) => s.replace(/^(#{1,6}|\|) /, '').replace(/\s+/g, '')
/** a change's text as the editor writes it (cleanText), compared the same way */
const bareText = (s: string) => cleanText(s).replace(/\s+/g, '')
/** the longest text, in characters, whose replacements are checked one by one (a longer paragraph is refused) */
const CHECK_CHARS = 200_000

/** Whether `to` is `from` with some non-overlapping occurrences of each pair's text replaced by its new text (null:
 * too large to check). A search over (place in from, place in to), each visited once. */
function replacedFrom(from: string, to: string, pairs: [string, string][]): boolean | null {
  if (from.length > CHECK_CHARS || to.length > CHECK_CHARS) return null
  const seen = new Set<number>()
  const stack: [number, number][] = [[0, 0]]
  while (stack.length) {
    const [r, i] = stack.pop()!
    if (r === from.length && i === to.length) return true
    const key = r * (to.length + 1) + i
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > 4 * CHECK_CHARS) return null
    if (r < from.length && i < to.length && from[r] === to[i]) stack.push([r + 1, i + 1])
    // a text of white space only (nothing once white space is aside) may have been replaced anywhere
    for (const [f, p] of pairs) if (from.startsWith(f, r) && to.startsWith(p, i) && (f || p)) stack.push([r + f.length, i + p.length])
  }
  return false
}

/**
 * The read-back of edit_hwp, run by the server on what hwp.ts reads in the worker (as read and grep read them):
 * the new file's lines must be the old file's with the worker's line edits applied, so every paragraph the changes do
 * not touch reads exactly as before; and every line edit must be what the changes it names make: for replacements,
 * the lines removed with some of those texts replaced (white space aside); for a filled cell or added rows, nothing
 * removed and exactly their text put in. Every change must show in an edit. Returns why not, or null.
 */
export function hwpEditMismatch(changes: HwpChange[], old: string[], got: string[], report: HwpEditReport): string | null {
  const want = applyLineEdits(old, report.lineEdits)
  if (!want) return 'the changes do not fit the document as it reads'
  const diff = firstDifference(want, got)
  if (diff) return diff
  const shown = new Set<number>()
  for (const [k, e] of report.lineEdits.entries()) {
    if (!Array.isArray(e.changes) || !e.changes.length || e.changes.some((c) => !Number.isInteger(c) || !changes[c])) return `edit ${k + 1} does not name the changes it comes from`
    for (const c of e.changes) shown.add(c)
    const removed = old.slice(e.at, e.at + e.remove).map(bare).join('')
    const added = e.insert.map(bare).join('')
    const made = e.changes.map((c) => changes[c]!)
    if (made.some(isImageChange)) return `edit ${k + 1}: an image change changed text`
    const n = `change ${e.changes[0]! + 1}`
    const one = made[0]!
    if (!('find' in one) || made.some((c) => !('find' in c))) {
      if (made.length !== 1) return `${n}: other changes are in the same place`
      if (removed) return `${n}: text was removed where ${'cell' in one ? 'an empty cell was filled' : 'rows were added'}`
      const text = 'value' in one ? bareText(one.value) : 'add_rows' in one ? one.add_rows.rows.flat().map(bareText).join('') : ''
      if (added !== text) return `${n}: its new text does not read back`
      continue
    }
    const ok = replacedFrom(removed, added, made.map((c) => 'find' in c ? [bareText(c.find), bareText(c.replace)] as [string, string] : ['', '']))
    if (ok === null) return `${n}: the paragraph is too long to check`
    if (!ok) return `${n}: the paragraph does not read as its old text with the replacement`
  }
  // an image change adds no text: it shows as one picture of the report (whose part the container check compares)
  const pics = report.pictures ?? []
  for (const [i, c] of changes.entries()) {
    if (isImageChange(c)) {
      if (shown.has(i)) return `change ${i + 1}: a picture changed text`
      if (pics.filter((p) => p.change === i).length !== 1) return `change ${i + 1}: its picture does not show in the document`
    } else if (!shown.has(i)) return `change ${i + 1}: it does not show in the document`
  }
  if (pics.some((p) => !Number.isInteger(p?.change) || !changes[p.change] || !isImageChange(changes[p.change]!))) return 'a picture does not come from an image change'
  return null
}

/**
 * The new file's parts against the old file's, from the two central directories only (the server expands and parses
 * neither): the same parts in the same order, each with the same CRC, sizes and method, but the sections the changes
 * are in; with pictures (`added`: their parts) also Contents/content.hpf, and exactly those parts after the old ones,
 * stored or deflated. A part added, dropped or changed elsewhere is refused. Returns why not, or null.
 */
export function hwpxPartsMismatch(oldFile: Uint8Array, newFile: Uint8Array, added: string[] = []): string | null {
  let a: ZipDirEntry[], b: ZipDirEntry[]
  try { a = zipDirectory(oldFile); b = zipDirectory(newFile) } catch (e) { return `a zip directory could not be read (${String((e as Error).message).slice(0, 80)})` }
  if (b.length !== a.length + added.length || a.some((x, i) => x.name !== b[i]!.name)) return 'the new file does not have the same parts as the old one'
  for (const [k, name] of added.entries()) {
    const y = b[a.length + k]!
    if (y.name !== name || !/^BinData\/image\d+\.(png|jpg)$/.test(name) || a.some((x) => x.name.toLowerCase() === name.toLowerCase())) return `the new file has ${JSON.stringify(y.name)}, which the change does not add`
    if (y.method !== 0 && y.method !== 8) return `${y.name} has another compression`
  }
  for (const [i, x] of a.entries()) {
    const y = b[i]!
    const changeable = /^Contents\/section\d+\.xml$/i.test(x.name) || (added.length > 0 && /^Contents\/content\.hpf$/i.test(x.name))
    if (changeable) { if (y.method !== 0 && y.method !== 8) return `${x.name} has another compression`; continue }
    if (x.crc !== y.crc || x.usize !== y.usize || x.csize !== y.csize || x.method !== y.method) return `${x.name} is not the same as before`
  }
  return null
}
/** A .hwp's stream paths edit_hwp may change: the body sections. */
export const isHwpSection = (path: string) => /^BodyText\/Section\d+$/.test(path)

/**
 * The new .hwp's container against the old one's, read in the server with files/cfb.ts (sector chains and the
 * directory; nothing expanded, no record read): the same header, the same directory entries byte for byte but a
 * stream's place and size, and every stream the same bytes but the body sections; with pictures (`added`: their
 * streams) also DocInfo, and exactly those streams (and a BinData storage when there was none) new, each one hung where
 * an empty tree pointer was. Returns why not, or null.
 */
export function hwpPartsMismatch(oldFile: Uint8Array, newFile: Uint8Array, added: string[] = []): string | null {
  try {
    const a = readCfb(oldFile), b = readCfb(newFile)
    if (added.some((p) => !/^BinData\/BIN[0-9A-F]{4}\.(png|jpg)$/.test(p) || !b.streams.has(p) || a.streams.has(p))) return 'the new file does not have the pictures the change adds'
    const storage = !a.entries.some((e) => e.type === 1 && e.path === 'BinData')
    return cfbMismatch(a, b, (p) => isHwpSection(p) || (added.length > 0 && p === 'DocInfo'), (p) => added.includes(p) || (added.length > 0 && storage && p === 'BinData'))
  } catch (e) {
    return `a compound file could not be read (${String(e instanceof CfbError ? e.message : 'damaged').slice(0, 80)})`
  }
}

/** The fresh worker's check of a file with new pictures: the old and the new file (verify modes, files/hwp-edit.ts and
 * files/hwpx-edit.ts), framed as a request: {"verify":"pictures","old":<length>}, then the old file, then the new. */
export const encodeVerifyPictures = (oldFile: Uint8Array, newFile: Uint8Array) =>
  encodeHwpxRequest(JSON.stringify({ verify: 'pictures', old: oldFile.length }), new Uint8Array(Buffer.concat([Buffer.from(oldFile), Buffer.from(newFile)])))
/** A verify mode's input: a bare file (zip or compound file), or the framed old and new file of encodeVerifyPictures. */
export function decodeVerifyInput(input: Uint8Array): { file: Uint8Array; old?: Uint8Array } {
  const magic = input.length >= 4 && ((input[0] === 0x50 && input[1] === 0x4b) || (input[0] === 0xd0 && input[1] === 0xcf))
  if (magic) return { file: input }
  const r = decodeHwpxRequest(input)
  const o = JSON.parse(r.astJson) as { verify?: unknown; old?: unknown }
  if (o?.verify !== 'pictures' || !Number.isInteger(o.old) || !r.template || (o.old as number) > r.template.length) throw new Error('bad request')
  return { old: r.template.subarray(0, o.old as number), file: r.template.subarray(o.old as number) }
}
