// The six file tools (list/glob/grep/read/write/edit) plus the human-side operations that share their rules.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { ENGINE_BUILTIN_ALLOWED, EditInput, GlobInput, GrepInput, ListInput, ReadInput, WriteInput } from '@mycel/shared'
import { isLegacyKorean, isUtf8 } from '@mycel/shared/text-encoding'
import type { ServerConfig } from '../config'
import { teamDefaultLocale, teamTimeZone } from '../admin/settings'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { authorize, type Authorized, type FsCtx } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment, hiddenEntry } from '../policy/names'
import { detectCaseInsensitive } from '../policy/resolve'
import { ext, extractText, isOffice } from './extract'
import { globFiles, grepFiles, OfficeCache } from './search'
import { atomicWrite, conflictCopyName, fileEvent, moveToTrash, readRegular, recordConflictCopy, saveVersion, sha256 } from './store'
import { newId } from '../db'
import { consumeSkillApproval, editedText, requireSkillApproval } from '../skills/guard'
import { readMaxBytes } from '../system/limits'
import { assertStorageRoomForAI } from '../system/storage'
import type { McpContent } from '../turns'
import { Quarantine } from '../safe-ops/quarantine'
import { recoverWorkflows } from '../safe-ops/workflow'
import { recoverPublications } from '../safe-ops/publication'
import { safeText, safeErrorText } from '../safe-ops/strings'
import { which } from '../config'
import { imageTokens, isScannedPage, isVisionImage, layerText, modelImage, pageList, parsePages, pdfLayer, pdfPageImage, pdfPagePng, PDF_PAGES_PER_READ,
  PDF_PAGES_WITHOUT_RANGE, PDF_TEXT_MAX, READ_OUTPUT_TOKENS, textTokens, VISION_INPUT_MAX, VISION_TURN_BYTES, VISION_TURN_IMAGES, visionBlock,
  visionTools, type VisionBlock, type VisionTools } from './vision'
import { visionText } from './vision-text'

void ENGINE_BUILTIN_ALLOWED

/** Per-turn memory the server keeps about files (design: "서버가 턴마다 파일별로 마지막 read 때의 해시를 기억"). */
/**
 * The AI edit / write tools work on UTF-8 text. A text file in a legacy encoding (for example CP949 / EUC-KR or
 * Windows-1252) would lose all its non-ASCII characters, so these tools refuse it and do not convert it silently.
 * The AI can write a new UTF-8 copy under another name. Office and binary files have their own checks.
 */
function refuseLegacyText(rel: string, cur: Uint8Array) {
  if (cur.subarray(0, 8000).includes(0) || isUtf8(cur)) return
  throw new ToolError(`'${rel}' is in a legacy encoding (${isLegacyKorean(cur) ? 'Korean CP949 / EUC-KR' : 'not UTF-8'}). ` +
    'The AI cannot change it, because the change would break its characters. Write a new UTF-8 copy under another name instead.', 'legacy_encoding')
}

export class TurnFiles {
  /** Set only by TurnRegistry.bind after the trusted launcher starts the engine. */
  enginePid: number | null = null
  readHashes = new Map<string, string>()
  /** team-folder files whose content went to the model in this turn (read, grep results): the chat's read scope */
  readPaths = new Set<string>()
  /** image blocks sent to the model in this turn (files/vision.ts VISION_TURN_IMAGES / VISION_TURN_BYTES) */
  imageBytes = 0
  imageCount = 0
  /** safe operations 1A: image versions a presentation used (safe-ops/publication.ts) */
  imageSources = new Map<string, { hash: string; identity: string }>()
  bytesWritten = 0
  filesWritten = new Set<string>()
  /** saves under skills/ the person confirmed on the server's card in this turn: path -> sha256 of the confirmed
   * bytes, or '*' for a produced file (skills/guard.ts) */
  skillApprovals = new Map<string, string>()
}

export interface ToolCtx {
  signal?: AbortSignal
  user: Principal
  turnId: string | null
  files: TurnFiles
  /** the person of a chat turn (component B): confirmation cards the server raises inside a tool call (web_fetch) */
  person?: import('../tools/url-gate').TurnPerson
  /**
   * The chat turn's "wider audience" check (design tab 7 "공용 폴더를 거친 유출"): before a tool places a new file at
   * `target` that carries content of `sources` (team-folder paths it copied bytes from) or of what the chat read,
   * the server asks the person when more people can read the target. Returns the refusal text, or null to go ahead.
   * Tools that copy file bytes into a new file (make_file) must call it; without it (no chat turn: nobody to ask)
   * they refuse whenever the target is wider than the sources.
   */
  confirmWidening?: (target: string, sources: string[], binding?: string) => Promise<string | null>
}
export interface ToolOutput { images?: { type: 'image'; mimeType: 'image/png' | 'image/jpeg'; data: string }[]; text: string; content?: McpContent[]; beforeDelivery?: () => void; isError?: boolean; summary: string }

const BINARY_WRITE = new Set(['hwp', 'hwpx', 'docx', 'pptx', 'xlsx', 'xls', 'pdf', 'odt', 'ods', 'zip', 'png', 'jpg', 'jpeg', 'gif'])

export class FileService {
  readonly quarantine: Quarantine
  readonly fx: FsCtx
  readonly office: OfficeCache
  readonly events = new EventEmitter()
  constructor(readonly db: Database, readonly cfg: ServerConfig) {
    db.exec('PRAGMA synchronous = FULL')
    this.quarantine = new Quarantine(db, cfg.teamRoot)
    recoverWorkflows(db)
    recoverPublications(db, cfg.teamRoot)
    this.fx = { quarantine: this.quarantine, root: cfg.teamRoot, caseInsensitive: detectCaseInsensitive(cfg.teamRoot) }
    this.office = new OfficeCache(path.join(cfg.dataDir, 'textcache'), this.fx, { pandoc: cfg.pandoc, pdftotext: cfg.pdftotext, ocr: cfg.ocr, quarantine: this.quarantine })
  }
  rules() { return RuleSet.load(this.db) }
  principal(userId: string) { const p = loadPrincipal(this.db, userId); if (!p) throw new Denied('unknown or disabled user'); return p }

  // ---------------- dispatcher used by the MCP server ----------------
  async call(tool: string, rawArgs: unknown, ctx: ToolCtx): Promise<ToolOutput> {
    try {
      switch (tool) {
        case 'list': return this.list(ctx, ListInput.parse(rawArgs ?? {}))
        case 'glob': return await this.glob(ctx, GlobInput.parse(rawArgs))
        case 'grep': return await this.grep(ctx, GrepInput.parse(rawArgs))
        case 'read': return await this.read(ctx, ReadInput.parse(rawArgs))
        case 'write': return this.write(ctx, WriteInput.parse(rawArgs))
        case 'edit': return this.edit(ctx, EditInput.parse(rawArgs))
        default: throw new ToolError(`unknown tool '${tool}'`)
      }
    } catch (e: any) {
      const p = typeof (rawArgs as any)?.file_path === 'string' ? (rawArgs as any).file_path : typeof (rawArgs as any)?.path === 'string' ? (rawArgs as any).path : ''
      if (e instanceof Denied) {
        if (tool === 'write' || tool === 'edit') fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: String(p).slice(0, 500), action: 'rejected', detail: { tool, reason: e.message } })
        return { text: 'Access denied: ' + e.message, isError: true, summary: `${tool} ${short(p)} -> denied: ${e.message}` }
      }
      if (e?.name === 'ZodError') return { text: 'Invalid input: ' + e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; '), isError: true, summary: `${tool} -> invalid input` }
      if (e instanceof ToolError) return { text: 'Error: ' + safeErrorText(this.db,ctx.user.id,e.code,e.message), isError: true, summary: `${tool} ${short(p)} -> error: ${e.message}` }
      return { text: 'Error: internal error', isError: true, summary: `${tool} ${short(p)} -> internal: ${String(e?.message ?? e).slice(0, 200)}` }
    }
  }

  // ---------------- list ----------------
  list(ctx: ToolCtx, a: { path?: string }): ToolOutput {
    const rules = this.rules()
    const r = authorize(this.fx, rules, ctx.user, a.path ?? '', 'list')
    if (!r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a file; use read`, 'not_folder')
    const lines: string[] = []
    const ents = fs.readdirSync(r.abs, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))
    for (const e of ents) {
      if (hiddenEntry(e.name, r.segs.length) || badSegment(e.name) || e.isSymbolicLink()) continue
      const c = [...r.segs, e.name]
      if (e.isDirectory()) { if (rules.canList(ctx.user, c)) lines.push(e.name + '/') }
      else if (e.isFile() && atLeast(rules.access(ctx.user, c), 'read')) {
        let st: fs.Stats; try { st = fs.lstatSync(path.join(r.abs, e.name)) } catch { continue }
        if (st.nlink > 1) continue
        lines.push(`${e.name}  (${human(st.size)}, ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')})`)
      }
    }
    return { text: lines.join('\n') || '(empty folder)', summary: `list ${r.rel || '.'} -> ${lines.length} entries` }
  }

  private base(ctx: ToolCtx, p: string | undefined) {
    const rules = this.rules()
    const r = authorize(this.fx, rules, ctx.user, p ?? '', 'list')
    return { rules, r, isFile: !r.st!.isDirectory() }
  }

  async glob(ctx: ToolCtx, a: { pattern: string; path?: string }): Promise<ToolOutput> {
    if (a.pattern.startsWith('/') || a.pattern.split('/').includes('..')) throw new Denied('glob patterns must be relative and must not contain ..')
    const { rules, r, isFile } = this.base(ctx, a.path)
    const res = await globFiles({ fx: this.fx, rules, user: ctx.user, rg: this.cfg.rg, timeoutMs: this.cfg.grepTimeoutMs, office: this.office }, r.segs, isFile, a.pattern.normalize('NFC'))
    const text = res.files.length ? res.files.join('\n') + (res.truncated ? '\n(Results are truncated. Use a more specific path or pattern.)' : '') : 'No files found'
    return { text, summary: `glob ${r.rel || '.'} pattern(len=${a.pattern.length}) -> ${res.files.length} files` }
  }

  async grep(ctx: ToolCtx, a: any): Promise<ToolOutput> {
    const { rules, r, isFile } = this.base(ctx, a.path)
    const ctxN = a['-C'] ?? 0
    // the person's own background share, not the shared "system" owner (one AI grep must not fill the queue for all)
    const res = await grepFiles({ fx: this.fx, rules, user: ctx.user, rg: this.cfg.rg, timeoutMs: this.cfg.grepTimeoutMs, office: this.office }, r.segs, isFile, {
      officeOwner: ctx.user.id, pattern: a.pattern, glob: a.glob, type: a.type, mode: a.output_mode ?? 'files_with_matches', ignoreCase: a['-i'],
      lineNumbers: a['-n'] ?? true, before: a['-B'] ?? ctxN, after: a['-A'] ?? ctxN, limit: a.head_limit ?? 200, multiline: a.multiline,
    })
    for (const f of res.files) ctx.files.readPaths.add(f)
    return { text: res.text, summary: `grep ${r.rel || '.'} pattern(len=${a.pattern.length}) mode=${a.output_mode ?? 'files_with_matches'} -> ${res.text === 'No matches' ? 0 : res.text.split('\n').length} lines, filtered=${res.stats.filtered}` }
  }

  // ---------------- read ----------------
  /** Converter seams (tests replace them): an image file -> the model's JPEG, a PDF page -> the model's JPEG. */
  modelImage(name: string, bytes: Uint8Array, signal?: AbortSignal) { return modelImage(name, bytes, this.visionTools(), signal) }
  pdfPageImage(bytes: Uint8Array, page: number, signal?: AbortSignal) { return pdfPageImage(bytes, page, this.visionTools(), signal) }
  visionTools(): VisionTools { return visionTools({ nativeBin: this.cfg.nativeBin, pdftotext: this.cfg.pdftotext, ocr: this.cfg.ocr, which }) }

  async read(ctx: ToolCtx, a: ReadArgs): Promise<ToolOutput> {
    const e = ext(a.file_path)
    if ((a.pages !== undefined || a.as_images) && e !== 'pdf') throw new ToolError('pages and as_images are only for PDF files', 'bad_pages')
    if (isVisionImage(a.file_path)) return this.readImage(ctx, a)
    if (e === 'pdf') return this.readPdf(ctx, a)
    return this.readText(ctx, a)
  }

  /** Text of a file (Office files converted), numbered lines. */
  private async readText(ctx: ToolCtx, a: ReadArgs): Promise<ToolOutput> {
    const r = authorize(this.fx, this.rules(), ctx.user, a.file_path, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; use list`, 'is_folder')
    // the plan's read limit (system/limits.ts readMaxBytes; 200 MB without a plan, as before)
    const { bytes } = readRegular(r.abs, readMaxBytes())
    const text = await extractText(r.rel, bytes, { pandoc: this.cfg.pandoc, pdftotext: this.cfg.pdftotext, ocr: this.cfg.ocr, quarantine: this.quarantine }, ctx.signal)
    ctx.files.readHashes.set(r.rel, sha256(bytes))
    ctx.files.readPaths.add(r.rel)
    return numberedLines(r.rel, text, a)
  }

  /**
   * An image, as the model's JPEG (files/vision.ts), like Claude Code's Read. The bytes are bound to the authorized
   * path, refused when quarantined, and access is checked again right before delivery (also at socket drain,
   * mcp/socket.ts). No pixels when the team switched image viewing off (a Mac reads the text with Apple Vision then),
   * for the text-only API engine, or for a connection without a chat turn: a short note says why.
   */
  private async readImage(ctx: ToolCtx, a: ReadArgs): Promise<ToolOutput> {
    const r = authorize(this.fx, this.rules(), ctx.user, a.file_path, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; use list`, 'is_folder')
    const block = visionBlock(this.db, ctx.turnId)
    if (block === 'off' && this.cfg.ocr) return this.readText(ctx, a)
    if (block) return { text: visionText(this.db, ctx.user.id, block), summary: `read ${r.rel} -> image not shown (${block})` }
    if (r.st!.size > VISION_INPUT_MAX) return { text: visionText(this.db, ctx.user.id, 'tooLarge'), isError: true, summary: `read ${r.rel} -> image too large` }
    const full = this.imageBudget(ctx, 0)
    if (full) return { text: full, summary: `read ${r.rel} -> image not shown (turn image limit)` }
    const src = this.boundSource(ctx, r, VISION_INPUT_MAX)
    let jpeg: Buffer
    try { jpeg = await this.modelImage(src.rel, src.bytes, ctx.signal) } catch (e) {
      ctx.signal?.throwIfAborted()
      const note = this.visionFailure(ctx, e)
      return { text: note, isError: true, summary: `read ${r.rel} -> image not shown (${(e as ToolError).code})` }
    }
    ctx.signal?.throwIfAborted()
    const over = this.imageBudget(ctx, jpeg.length)
    if (over) return { text: over, summary: `read ${r.rel} -> image not shown (turn image limit)` }
    const beforeDelivery = () => this.recheckSource(ctx, src)
    beforeDelivery()
    ctx.files.readHashes.set(src.rel, src.hash)
    ctx.files.readPaths.add(src.rel)
    ctx.files.imageBytes += jpeg.length
    ctx.files.imageCount++
    const text = `Image ${src.rel} (shown below).`
    return { text, content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') }], beforeDelivery,
      summary: `read ${src.rel} -> image ${jpeg.length}B` }
  }

  /**
   * A PDF like Claude Code's Read: `pages` (at most PDF_PAGES_PER_READ; required over PDF_PAGES_WITHOUT_RANGE pages)
   * gives each page's text layer as text, and pages without one (scans, pictures) as images; `as_images` shows the
   * text pages as images too. offset/limit without `pages` give numbered lines of the text grep searched (the text
   * cache, files/search.ts): the text layer on Linux; on a Mac the cache's own text (Apple Vision for scanned pages,
   * PDFKit without poppler), so a line grep reports is the same line here. Otherwise no OCR: with image viewing off, a
   * Mac server gives Apple Vision text for scanned pages instead, a Linux server a note (scanned pages are not
   * searchable there either).
   */
  private async readPdf(ctx: ToolCtx, a: ReadArgs): Promise<ToolOutput> {
    const r = authorize(this.fx, this.rules(), ctx.user, a.file_path, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; use list`, 'is_folder')
    const src = this.boundSource(ctx, r, readMaxBytes())
    const tools = this.visionTools()
    const block = visionBlock(this.db, ctx.turnId)
    // macOS with image viewing off: Apple Vision text for scanned pages, as before this change
    const ocrText = block === 'off' && !!this.cfg.ocr
    const why = (b: VisionBlock) => visionText(this.db, ctx.user.id, b)
    const record = () => { ctx.files.readHashes.set(src.rel, src.hash); ctx.files.readPaths.add(src.rel) }

    if (a.pages === undefined && (a.offset !== undefined || a.limit !== undefined)) {
      // the same extraction as the grep text cache (OfficeCache: pdftotext, then Apple Vision when a page has no text
      // layer; PDFKit's text without poppler): on a Mac the text layer alone numbers lines differently
      const cached = this.cfg.ocr
        ? await extractText(src.rel, src.bytes, { pandoc: null, pdftotext: this.cfg.pdftotext, ocr: this.cfg.ocr, quarantine: this.quarantine }, ctx.signal)
        : null
      // the pages without a text layer, named for a read by pages (not when the Apple Vision text is the fallback)
      const layers = ocrText ? [] : await pdfLayer(src.bytes, tools, ctx.signal)
      record()
      const out = numberedLines(src.rel, cached ?? layerText(layers), a)
      const scanned = layers.flatMap((p, i) => (isScannedPage(p) ? [i + 1] : []))
      if (scanned.length) out.text += `\n\n${visionText(this.db, ctx.user.id, 'scanned', { pages: pageList(scanned) })} ${block ? why(block) : visionText(this.db, ctx.user.id, 'scannedHint', { first: scanned[0]! })}`
      return out
    }

    const layers = await pdfLayer(src.bytes, tools, ctx.signal)
    const n = layers.length
    let pages: number[]
    if (a.pages !== undefined) pages = parsePages(a.pages, n)
    else if (n > PDF_PAGES_WITHOUT_RANGE) {
      throw new ToolError(`'${src.rel}' has ${n} pages: read it in parts with pages (for example pages: "1-${PDF_PAGES_WITHOUT_RANGE}"; at most ${PDF_PAGES_PER_READ} pages per call), or lines of its text layer with offset/limit (the lines grep reports).`, 'pages_required')
    } else pages = Array.from({ length: n }, (_, i) => i + 1)

    const content: McpContent[] = []
    // the result as the engine measures it (READ_OUTPUT_TOKENS): page images that would not fit wait for another call
    let tokens = 0
    const text = (t: string) => {
      tokens += textTokens(t) + 1
      const last = content[content.length - 1]
      if (last?.type === 'text') last.text += '\n\n' + t
      else content.push({ type: 'text', text: t })
    }
    text(`PDF ${src.rel}: ${n} page${n === 1 ? '' : 's'}; ${pages.length === n ? 'all pages' : `pages ${pageList(pages)}`} below.`)
    let chars = 0
    let images = 0
    const blocked: number[] = []
    const later: number[] = []
    let noPixels = false
    for (const p of pages) {
      ctx.signal?.throwIfAborted()
      const layer = layers[p - 1] ?? ''
      const scanned = isScannedPage(layer)
      if (!scanned) {
        const room = PDF_TEXT_MAX - chars
        const body = layer.replace(/\s+$/, '')
        text(`--- Page ${p} ---\n${room <= 0 ? '(text not shown: this read already holds the most text; read fewer pages)' : body.length > room ? body.slice(0, room) + '\n… (page text cut; read fewer pages)' : body}`)
        chars += Math.min(body.length, Math.max(0, room))
      }
      if (!scanned && !a.as_images) continue
      const head = scanned ? `--- Page ${p} (no text layer: shown as an image) ---` : `--- Page ${p} as an image ---`
      if (block) {
        if (!scanned) noPixels = true
        else if (ocrText) {
          let t: string
          try {
            const png = await pdfPagePng(src.bytes, p, tools, ctx.signal)
            t = (await extractText('page.png', png, { pandoc: null, pdftotext: null, ocr: this.cfg.ocr }, ctx.signal)).trim()
          } catch (e) {
            ctx.signal?.throwIfAborted()
            t = e instanceof ToolError && e.code.startsWith('vision_') ? this.visionFailure(ctx, e) : `(${e instanceof ToolError ? e.message : 'the page could not be read'})`
          }
          text(`--- ${visionText(this.db, ctx.user.id, 'ocrPage', { page: p })} ---\n${t}`)
        } else blocked.push(p)
        continue
      }
      // once one page image did not fit, the later ones wait too (no conversion for them)
      if (later.length) { later.push(p); continue }
      const full = this.imageBudget(ctx, 0)
      if (full) { text(`--- Page ${p} ---\n${full}`); continue }
      let jpeg: Buffer
      try { jpeg = await this.pdfPageImage(src.bytes, p, ctx.signal) } catch (e) {
        ctx.signal?.throwIfAborted()
        text(`--- Page ${p} ---\n${this.visionFailure(ctx, e)}`)
        continue
      }
      ctx.signal?.throwIfAborted()
      if (tokens + textTokens(head) + imageTokens(jpeg) > READ_OUTPUT_TOKENS) { later.push(p); continue }
      const over = this.imageBudget(ctx, jpeg.length)
      if (over) { text(`--- Page ${p} ---\n${over}`); continue }
      text(head)
      tokens += imageTokens(jpeg)
      content.push({ type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') })
      ctx.files.imageBytes += jpeg.length
      ctx.files.imageCount++
      images++
    }
    if (later.length) text(`Not shown in this read: the image${later.length === 1 ? '' : 's'} of page${later.length === 1 ? '' : 's'} ${pageList(later)} (with them the result would pass the tool output limit). Read ${later.length === 1 ? 'it' : 'them'} in another call: pages: "${pageList(later).replace(/ /g, '')}"${a.as_images ? ', as_images: true' : ''}.`)
    if (blocked.length) text(`${visionText(this.db, ctx.user.id, 'scanned', { pages: pageList(blocked) })} ${why(block!)}`)
    else if (noPixels) text(why(block!))
    const beforeDelivery = images ? () => this.recheckSource(ctx, src) : undefined
    beforeDelivery?.()
    record()
    const plain = content.map((c) => (c.type === 'text' ? c.text : '[page image]')).join('\n\n')
    return { text: plain, content, beforeDelivery, summary: `read ${src.rel} -> pages ${pageList(pages)} of ${n}, ${images} image${images === 1 ? '' : 's'}` }
  }

  /**
   * An image from outside the team folder (a Google Drive file, tools/drive.ts) for this turn's model: the same
   * switch, engine check, budget and converter as a read. `text` says what happened (or holds the Apple Vision text
   * on a Mac with image viewing off); `jpeg` is set when the image goes to the model.
   */
  async imageForModel(ctx: ToolCtx, name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ jpeg?: Buffer; text: string }> {
    this.quarantine.assertBytes(bytes)
    const block = visionBlock(this.db, ctx.turnId)
    if (block === 'off' && this.cfg.ocr) return { text: await extractText(name, bytes, { pandoc: null, pdftotext: null, ocr: this.cfg.ocr }, signal) }
    if (block) return { text: visionText(this.db, ctx.user.id, block) }
    const full = this.imageBudget(ctx, 0)
    if (full) return { text: full }
    let jpeg: Buffer
    try { jpeg = await this.modelImage(name, bytes, signal) } catch (e) {
      signal?.throwIfAborted()
      return { text: this.visionFailure(ctx, e) }
    }
    signal?.throwIfAborted()
    const over = this.imageBudget(ctx, jpeg.length)
    if (over) return { text: over }
    ctx.files.imageBytes += jpeg.length
    ctx.files.imageCount++
    return { jpeg, text: 'The image is shown below.' }
  }

  /** The file's bytes, bound to the path that was authorized (same inode, size and times), not quarantined. */
  private boundSource(ctx: ToolCtx, r: Authorized, cap: number): BoundSource {
    const { bytes, st } = readRegular(r.abs, cap)
    if (identity(st) !== identity(r.st!)) throw new Denied(safeText(this.db, ctx.user.id, 'changed'))
    this.quarantine.assertBytes(bytes)
    return { rel: r.rel, bytes, hash: sha256(bytes), identity: identity(st) }
  }

  /** Right before delivery: the account, its access now and the file's identity, read again (synchronous). */
  private recheckSource(ctx: ToolCtx, src: BoundSource) {
    const user = this.principal(ctx.user.id)
    const now = authorize(this.fx, this.rules(), user, src.rel, 'read')
    if (!now.st || identity(now.st) !== src.identity) throw new Denied(safeText(this.db, ctx.user.id, 'changed'))
  }

  /** The note when this turn's images reached VISION_TURN_IMAGES / VISION_TURN_BYTES (with `next` more bytes). */
  private imageBudget(ctx: ToolCtx, next: number): string | null {
    if (ctx.files.imageCount < VISION_TURN_IMAGES && ctx.files.imageBytes + next <= VISION_TURN_BYTES) return null
    return visionText(this.db, ctx.user.id, 'budget', { images: VISION_TURN_IMAGES, mb: VISION_TURN_BYTES / 1024 / 1024 })
  }

  /** A converter's refusal as the note the AI gets (other errors go on to the caller). */
  private visionFailure(ctx: ToolCtx, e: unknown): string {
    const code = e instanceof ToolError ? e.code : ''
    const key = ({ vision_too_large: 'tooLarge', vision_unsupported: 'unsupported', vision_damaged: 'damaged', vision_heavy: 'heavy', vision_busy: 'busy', vision_unavailable: 'unavailable' } as const)[code as 'vision_busy']
    if (!key) throw e
    return visionText(this.db, ctx.user.id, key)
  }

  // ---------------- write / edit ----------------
  write(ctx: ToolCtx, a: { file_path: string; content: string }): ToolOutput {
    const data = Buffer.from(a.content, 'utf8')
    return this.writeBytes(ctx, a.file_path, data, ctx.files.readHashes, 'write')
  }

  /** shared by AI write and human save. `seen` = hashes the writer last saw. */
  writeBytes(ctx: ToolCtx, input: string, data: Buffer, seen: Map<string, string>, tool: string): ToolOutput {
    const r = authorize(this.fx, this.rules(), ctx.user, input, 'write', { createDirs: true })
    if (BINARY_WRITE.has(ext(r.rel)) && tool !== 'human') throw new ToolError(`'${ext(r.rel)}' files cannot be written as text; write .md/.csv/.txt instead`)
    this.limits(ctx, r.rel, data.length)
    if (r.exists) {
      if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`, 'is_folder')
      const cur = readRegular(r.abs).bytes
      if (tool === 'write') refuseLegacyText(r.rel, cur)
      const before = seen.get(r.rel)
      if (!before) throw new ToolError(`read '${r.rel}' first (with read) before overwriting it`, 'not_read')
      if (sha256(cur) !== before) return this.conflict(ctx, r.segs, data, `write ${r.rel}`)
      if (sha256(cur) === sha256(data)) return { text: `No change: ${r.rel} already has this content`, summary: `${tool} ${r.rel} -> unchanged` }
      requireSkillApproval(ctx, r.rel, data)
      saveVersion(this.db, this.fx.root, r.rel, cur, { userId: ctx.user.id, turnId: ctx.turnId })
      atomicWrite(this.fx.root, r.segs, data)
      fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: r.rel, action: 'update', size: data.length, sha256: sha256(data), detail: { tool } })
      this.changed(ctx, r.rel, 'update')
    } else {
      requireSkillApproval(ctx, r.rel, data)
      atomicWrite(this.fx.root, r.segs, data, { createDirs: true })
      fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: r.rel, action: 'create', size: data.length, sha256: sha256(data), detail: { tool } })
      this.changed(ctx, r.rel, 'create')
    }
    consumeSkillApproval(ctx, r.rel)
    seen.set(r.rel, sha256(data))
    ctx.files.bytesWritten += data.length
    ctx.files.filesWritten.add(r.rel)
    return { text: `${r.exists ? 'Updated' : 'Created'} ${r.rel} (${human(data.length)})`, summary: `${tool} ${r.rel} -> ${r.exists ? 'update' : 'create'} ${data.length}B` }
  }

  edit(ctx: ToolCtx, a: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): ToolOutput {
    if (a.old_string === a.new_string) throw new ToolError('old_string and new_string are the same')
    const r = authorize(this.fx, this.rules(), ctx.user, a.file_path, 'write', { mustExist: true })
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`, 'is_folder')
    if (isOffice(r.rel) || BINARY_WRITE.has(ext(r.rel))) throw new ToolError('only text files can be edited')
    const cur = readRegular(r.abs).bytes
    if (cur.subarray(0, 8000).includes(0)) throw new ToolError('binary file; cannot edit')
    refuseLegacyText(r.rel, cur)
    const before = ctx.files.readHashes.get(r.rel)
    if (!before) throw new ToolError(`read '${r.rel}' first (with read) before editing it`, 'not_read')
    const text = cur.toString('utf8')
    const n = text.split(a.old_string).length - 1
    const apply = () => editedText(text, a.old_string, a.new_string, a.replace_all)
    if (sha256(cur) !== before) {
      if (n === 1 || (n > 1 && a.replace_all)) return this.conflict(ctx, r.segs, Buffer.from(apply(), 'utf8'), `edit ${r.rel}`)
      fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: r.rel, action: 'conflict', detail: { tool: 'edit', copy: null } })
      throw new ToolError(`'${r.rel}' was changed by someone else after you read it, and your edit no longer applies. Read it again.`, 'conflict')
    }
    if (n === 0) throw new ToolError('old_string not found in the file')
    if (n > 1 && !a.replace_all) throw new ToolError(`old_string appears ${n} times; add more surrounding text to make it unique, or set replace_all`)
    const data = Buffer.from(apply(), 'utf8')
    this.limits(ctx, r.rel, data.length)
    requireSkillApproval(ctx, r.rel, data)
    saveVersion(this.db, this.fx.root, r.rel, cur, { userId: ctx.user.id, turnId: ctx.turnId })
    atomicWrite(this.fx.root, r.segs, data)
    consumeSkillApproval(ctx, r.rel)
    fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: r.rel, action: 'update', size: data.length, sha256: sha256(data), detail: { tool: 'edit' } })
    this.changed(ctx, r.rel, 'update')
    ctx.files.readHashes.set(r.rel, sha256(data))
    ctx.files.bytesWritten += data.length
    return { text: `Edited ${r.rel} (${a.replace_all ? n : 1} replacement${(a.replace_all ? n : 1) > 1 ? 's' : ''})`, summary: `edit ${r.rel} -> ${a.replace_all ? n : 1} replacements` }
  }

  /** 'changed' event { path, action, userId, turnId } for live file-screen updates (component C publishes files.changed) */
  private changed(ctx: ToolCtx, rel: string, action: 'create' | 'update') {
    this.events.emit('changed', { path: rel, action, userId: ctx.user.id, userName: ctx.user.name, turnId: ctx.turnId })
  }

  private limits(ctx: ToolCtx, rel: string, size: number) {
    if (ctx.files.bytesWritten + size > this.cfg.maxWriteBytesPerTurn) throw new ToolError('write limit for this turn reached')
    assertStorageRoomForAI(size) // the team disk near full (system/storage.ts; Linux / a plan)
    if (!ctx.files.filesWritten.has(rel) && ctx.files.filesWritten.size >= this.cfg.maxFilesWrittenPerTurn) throw new ToolError('file count limit for this turn reached')
  }

  /** Someone changed the file after this writer read it: leave the original alone, save a conflict copy. */
  private conflict(ctx: ToolCtx, segs: string[], data: Buffer, what: string): ToolOutput {
    const rel = segs.join('/')
    const dir = segs.slice(0, -1)
    const loc = teamDefaultLocale(this.db)
    const tz = teamTimeZone(this.db)
    let name = conflictCopyName(segs[segs.length - 1], ctx.user.name, new Date(), loc, tz)
    for (let i = 2; fs.existsSync(path.join(this.fx.root, ...dir, name)); i++) name = conflictCopyName(segs[segs.length - 1], `${ctx.user.name} ${i}`, new Date(), loc, tz)
    if (badSegment(name)) name = `conflict-${Date.now()}-${segs[segs.length - 1]}`
    const copy = [...dir, name]
    // the card showed the save at `rel`: its conflict copy right next to it is that same save
    requireSkillApproval(ctx, copy.join('/'), data, rel)
    atomicWrite(this.fx.root, copy, data)
    consumeSkillApproval(ctx, rel)
    const copyRel = copy.join('/')
    const last = recordConflictCopy(this.db, this.events, { original: rel, copy: copyRel, userId: ctx.user.id, turnId: ctx.turnId, size: data.length, sha256: sha256(data), tool: what.split(' ')[0]! }).changedBy
    fileEvent(this.db, { turnId: ctx.turnId, userId: ctx.user.id, path: copyRel, action: 'create', size: data.length, sha256: sha256(data), detail: { conflictCopyOf: rel } })
    this.changed(ctx, copyRel, 'create')
    const who = last?.name ? ` by ${last.name}` : ''
    return { text: `Conflict: '${rel}' was changed${who} after you read it. The original was left unchanged; your version was saved as '${copyRel}'. Tell the user about both files.`,
      summary: `${what} -> conflict copy ${copyRel}` }
  }

  // ---------------- human-side operations (file screen; same rules) ----------------
  humanSave(userId: string, rel: string, content: Buffer, baseSha: string | null): ToolOutput {
    const ctx: ToolCtx = { user: this.principal(userId), turnId: null, files: new TurnFiles() }
    const seen = new Map<string, string>()
    if (baseSha) seen.set(authorize(this.fx, this.rules(), ctx.user, rel, 'write', { createDirs: true }).rel, baseSha)
    return this.writeBytes(ctx, rel, content, seen, 'human')
  }
  deleteFile(userId: string, rel: string, turnId: string | null = null) {
    const user = this.principal(userId)
    const r = authorize(this.fx, this.rules(), user, rel, 'write', { mustExist: true })
    if (r.st!.isDirectory()) throw new ToolError('folders cannot be deleted with this call')
    return moveToTrash(this.db, this.fx.root, r.segs, { userId, turnId })
  }
  restoreTrash(userId: string, trashId: string) {
    const user = this.principal(userId)
    const t = this.db.query('SELECT * FROM trash_items WHERE id = ? AND restored_at IS NULL').get(trashId) as any
    if (!t) throw new ToolError('not in trash', 'not_found')
    const r = authorize(this.fx, this.rules(), user, t.original_path, 'write', { createDirs: true })
    if (r.exists) throw new ToolError('a file with that name exists again; rename it first')
    const bytes = fs.readFileSync(path.join(this.fx.root, ...t.storage_path.split('/')))
    atomicWrite(this.fx.root, r.segs, bytes, { createDirs: true })
    this.db.query('UPDATE trash_items SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), trashId)
    fileEvent(this.db, { turnId: null, userId, path: r.rel, action: 'restore', size: bytes.length, sha256: sha256(bytes) })
    return r.rel
  }
}

type ReadArgs = { file_path: string; offset?: number; limit?: number; pages?: string; as_images?: boolean }
interface BoundSource { rel: string; bytes: Buffer; hash: string; identity: string }
const identity = (s: fs.Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(':')

/** Text as numbered lines (cat -n), from `offset` (1-based), `limit` lines (default 2000), long lines cut. */
function numberedLines(rel: string, text: string, a: { offset?: number; limit?: number }): ToolOutput {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const off = a.offset ?? 1, lim = a.limit ?? 2000
  if (!lines.length) return { text: '(empty file)', summary: `read ${rel} -> empty` }
  if (off > lines.length) throw new ToolError(`offset ${off} is past the end of the file (${lines.length} lines)`)
  const slice = lines.slice(off - 1, off - 1 + lim).map((l, i) => `${String(off + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '… (line cut)' : l}`)
  const more = off - 1 + lim < lines.length ? `\n… (${lines.length} lines in total; use offset/limit to read more)` : ''
  return { text: slice.join('\n') + more, summary: `read ${rel} -> ${slice.length} lines${isOffice(rel) ? ' (converted)' : ''}` }
}

const short = (p: unknown) => (typeof p === 'string' ? p.slice(0, 200) : '')
function human(n: number) { return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB` }
