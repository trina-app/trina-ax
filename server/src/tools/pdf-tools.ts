// edit_pdf, merge_pdfs and split_pdf (owner 2026-11-16: "PDFs must be freely editable"; docs/decisions/
// 20261116-edit-pdf.md): page work on existing PDFs the person may read, saved as NEW files. The PDFs, images
// and the font are parsed only in the office worker (files/pdf-pages.ts, pdf-lib); this process reads the files, checks
// access and places the results, as stamp_pdf does (tools/stamp-pdf.ts):
// - read access to every PDF and image a call names, write access where each result goes (checked again when placed,
//   team-files/place.ts), the same answer for a file that does not exist and one the person cannot open;
// - by default a free name next to the original ("<name> (edited).pdf", "(merged)", "(part 1)", in the team's
//   language), so nothing is overwritten; edit_pdf replaces the original only with replace: true, after a read of it in
//   this turn (a new version, the old one in its history); an `output` that names an existing file the AI did not read
//   gets a conflict copy (make-file.ts placeProduced); a PDF the AI made itself in this turn and nobody changed since is
//   changed in place by edit_pdf without output (stamp-pdf.ts madeThisTurn; docs/decisions/20261117-stamp-own-fresh-pdf.md);
// - every result carries the bytes of what it is made from: the wider-audience check of make_file (confirmSources);
// - never into a skill folder;
// - a file of this chat (chat:files/<id>/<name>, QA TC-7044): without output edit_pdf saves a new version of it, as
//   edit_office does (ChatPlaces.head / version: a chat shared with people or personal, not a project chat, not an answer
//   with a k group, the person continuing the chat, checked again at the insert; read first, by the head's hash); with
//   output a new file is made from it (its bytes through the place's one safe open). Pictures and inserted PDFs stay
//   team paths.
import { authorizeOutput, readPlaceFile, versionText, type ChatHead, type ChatVersionMade } from '../files/place-output'
import { PLACE_WORDS } from '../files/places'
import { isReservedPlace, parsePlace } from '@mycel/shared/places'
import fs from 'node:fs'
import { pdfOutputPath } from './make-file-path'
import path from 'node:path'
import type { z } from 'zod'
import type { EditPdfInput, MergePdfsInput, SplitPdfInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale } from '../admin/settings'
import { ext, officeWorkerWrite } from '../files/extract'
import { assertGuestOutput, PDF_GATE, pdfInputMax, tooLargeText } from '../files/big-inputs'
import { serverFontDirs } from '../files/html-pdf'
import { decodePagesResult, encodePagesRequest, PDF_OUTPUT_MAX, PDF_PAGES_FILES_MAX, PDF_PAGES_INPUT_MAX, PDF_PAGES_MODE, type PageOp, type PagesJob, type PagesReport } from '../files/pdf-pages'
import { STAMP_IMAGE_MAX } from '../files/pdf-stamp'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { inAnySkills } from '../skills/guard'
import { checkRegular, freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir } from './isolate'
import { confirmSources, placeProduced, type MadeFile } from './make-file'
import { madeThisTurn } from './stamp-pdf'

type EditIn = z.output<typeof EditPdfInput>
type MergeIn = z.output<typeof MergePdfsInput>
type SplitIn = z.output<typeof SplitPdfInput>

/** the words in default output names, in the team's language */
export const PDF_WORDS: Record<'edited' | 'merged' | 'part', Record<Locale, string>> = {
  edited: { ko: '수정', en: 'edited', id: 'diubah', ja: '編集', es: 'editado', zh: '已编辑' },
  merged: { ko: '합침', en: 'merged', id: 'digabung', ja: '結合', es: 'combinado', zh: '合并' },
  part: { ko: '부분', en: 'part', id: 'bagian', ja: 'パート', es: 'parte', zh: '部分' },
}

export const EDIT_PDF_DESCRIPTION = 'Change an existing PDF and save the result as a new PDF next to it (the original stays as it is; a PDF you made in this turn is changed in place unless you give output). ' +
  'A file of this chat (chat:files/<file_id>/<name>, read it first) is changed in place instead: without output it gets a new version, opened from the same file in the chat, and the earlier version stays; never make a second copy of it. ' +
  'Every call that changes a file saves it: never call it just to try something out. ' +
  'operations, applied in order: remove_pages, keep_pages (extract pages), reorder_pages, rotate_pages, insert_pdf (pages of another PDF at a position), ' +
  'stamp_image (a seal, signature or logo; PNG transparency kept), add_text (one line, e.g. a date at a spot), watermark (e.g. "DRAFT" across the page), page_numbers, ' +
  'and replace_text (change words inside the PDF: every match of find on the pages becomes replace; the old words are removed from the page text, not covered, ' +
  'and the new ones are written in their place in the same size and colour, in the PDF\'s own font when it has the letters; "" removes them), ' +
  'and fill_form (a fill-in form: sets its form fields by name; a read of the PDF lists the fields, so read it first. Fill a form only this way, never with add_text: ' +
  'the fields are drawn on top of the page and hide text written under them; flatten: true only when the user asks for a form that can no longer be changed). ' +
  'Pages are written like "1,3-5,last", "2-last" or "all"; each operation sees the pages as they are after the ones before it. ' +
  'Positions are a preset or { x_mm, y_mm } from the top-left of the page as it is shown. Works on scanned PDFs too. ' +
  'Words that are part of a picture (a scanned page) and the PDF\'s pictures cannot be changed. A PDF locked with a password cannot be changed. ' +
  'Replace a team PDF (replace: true) only when the user explicitly asks for that, after reading it. ' +
  'After adding text, a stamp or a watermark, read the changed page of the new file with pages and as_images to check it before you answer.'
export const MERGE_PDFS_DESCRIPTION = 'Join several PDFs into one new PDF, in the order given (a { path, pages } entry takes only those pages). ' +
  'The files stay as they are; the new file is "<first name> (merged).pdf" next to the first one unless you give output.'
export const SPLIT_PDF_DESCRIPTION = 'Split a PDF into several new PDFs: parts (one page list per file, e.g. ["1-3", "4-last"]) or every (a new file every N pages). ' +
  'The original stays as it is; the parts are "<name> (part 1).pdf" … next to it unless you give output_folder.'

/** The Pretendard file the server ships, for text that is not Latin (null: none here). */
export function textFontFile(): string | null {
  for (const d of serverFontDirs()) { const f = path.join(d, 'Pretendard-Regular.ttf'); try { if (fs.statSync(f).isFile()) return f } catch {} }
  return null
}

interface Part { name: string; bytes: Uint8Array; rel: string }
export interface PdfResult { made: MadeFile[]; pages: number[]; report: PagesReport; sources: string[]; chatVersion?: ChatVersionMade }

/**
 * The files of one call: each authorized and sized first (a path named twice is the same part), the PDFs and images
 * together at most pdfInputMax(); then load() reserves their bytes in PDF_GATE and reads each once (review of
 * feat/edit-pdf; second limits audit review: nothing is read before the reservation). release() after the call.
 */
class Inputs {
  parts: Part[] = []
  private total = 0
  /** parts whose bytes load() reads, after their room in PDF_GATE is reserved */
  private pending: { part: number; read: () => Uint8Array }[] = []
  private release: (() => void) | null = null
  private max = pdfInputMax()
  constructor(private ctx: AppContext, private files: TeamFiles, private c: ToolCtx) {}
  add(p: string, kind: 'pdf' | 'image'): number {
    const r = authorize(this.files.fx, this.files.rules(), this.c.user, p, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`, 'is_folder')
    if (kind === 'pdf' && ext(r.rel) !== 'pdf') throw new ToolError(`'${r.rel}' is not a .pdf`)
    const at = this.parts.findIndex((x) => x.rel === r.rel)
    if (at >= 0) return at
    if (this.parts.length >= PDF_PAGES_FILES_MAX) throw new ToolError(`one call takes at most ${PDF_PAGES_FILES_MAX} files`)
    const max = kind === 'pdf' ? this.max : Math.min(STAMP_IMAGE_MAX, this.max)
    const size = checkRegular(r.abs).size
    if (size > max) throw new ToolError(kind === 'pdf' ? tooLargeText(r.rel, max, PDF_PAGES_INPUT_MAX, 'one PDF call') : `'${r.rel}' is larger than ${max / 1024 / 1024} MB, too large to work on here`)
    if (this.total + size > this.max) throw new ToolError(`these files are more than ${Math.floor(this.max / 1024 / 1024)} MB together; work on fewer or smaller files`)
    this.total += size
    this.pending.push({ part: this.parts.length, read: () => readRegular(r.abs, max, r.st).bytes })
    this.parts.push({ name: r.rel, bytes: new Uint8Array(0), rel: r.rel })
    return this.parts.length - 1
  }
  /** a chat file as the call's first part (`rel` its place path): `size` counted now, its bytes read by load() */
  addPlace(rel: string, size: number, read: () => Uint8Array): number {
    if (this.parts.length) throw new ToolError('a chat file is only the PDF that is changed')
    if (size > this.max) throw new ToolError(tooLargeText(rel, this.max, PDF_PAGES_INPUT_MAX, 'one PDF call'))
    this.total += size
    this.pending.push({ part: 0, read })
    this.parts.push({ name: rel, bytes: new Uint8Array(0), rel })
    return 0
  }
  /** every part's bytes, read after their room in PDF_GATE is reserved */
  async load(): Promise<void> {
    this.release ??= await PDF_GATE.enter(this.total, this.c.signal)
    for (const f of this.pending) {
      if (this.parts[f.part]!.bytes.length) continue
      const bytes = f.read()
      this.ctx.files.quarantine.assertBytes(bytes)
      this.parts[f.part]!.bytes = bytes
    }
  }
  done() { this.release?.(); this.release = null; for (const p of this.parts) p.bytes = new Uint8Array(0) }
}

/** Where a result goes: `output` (with .pdf) or a free "<base> (<word>).pdf" in `dir`; write access checked now. */
function target(files: TeamFiles, c: ToolCtx, output: string | undefined, dir: string[], base: string, word: string) {
  let rel: string
  if (output !== undefined && output.trim() !== '') {
    rel = pdfOutputPath(output)
  } else rel = [...dir, freeName(path.join(files.fx.root, ...dir), `${base.replace(/\.pdf$/i, '')} (${word}).pdf`)].join('/')
  const out = authorizeOutput(files.fx, files.rules(), c, rel, { mustExist: false, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder; give a file name ending in .pdf`, 'is_folder')
  if (inAnySkills(out.rel)) throw new ToolError('a PDF made here is not saved in a skill folder; save it in a project or the person\'s own folder')
  return out
}

async function runJob(ctx: AppContext, c: ToolCtx, job: PagesJob, parts: Part[]): Promise<{ report: PagesReport; files: Uint8Array[] }> {
  const answer = await officeWorkerWrite(PDF_PAGES_MODE, encodePagesRequest(job, parts), c.signal, PDF_OUTPUT_MAX)
  let r: ReturnType<typeof decodePagesResult>
  try { r = decodePagesResult(answer) } catch { throw new ToolError('the PDF tool gave a damaged answer; nothing was saved') }
  for (const f of r.files) if (f.length < 5 || Buffer.from(f.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ToolError('the PDF tool gave a damaged answer; nothing was saved')
  return r
}

async function place(ctx: AppContext, files: TeamFiles, c: ToolCtx, segs: string[], bytes: Uint8Array, tool: string): Promise<MadeFile> {
  assertGuestOutput(ctx.db, c.user.id, bytes.length, segs.join('/'))
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, 'out.pdf')
    fs.writeFileSync(produced, bytes, { flag: 'wx', mode: 0o600 })
    return await placeProduced(ctx, files, c, segs, produced, tool)
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The operations as the worker gets them (an inserted PDF or a picture by its part number), every file added */
function editOps(inputs: Inputs, a: EditIn): PageOp[] {
  const index = (p: string, kind: 'pdf' | 'image') => inputs.add(p, kind)
  return a.operations.map((op) => {
    if ('insert_pdf' in op) return { insert_pdf: { ...op.insert_pdf, file: index(op.insert_pdf.file, 'pdf') } }
    if ('stamp_image' in op) return { stamp_image: { ...op.stamp_image, image: index(op.stamp_image.image, 'image') } }
    return op as PageOp
  })
}

/** text that is not Latin needs the Pretendard font, sent with the request (the worker reads no files): its part, or null */
function editFont(parts: Part[], a: EditIn): number | null {
  const texts = a.operations.flatMap((op) => ('add_text' in op ? [op.add_text.text] : 'watermark' in op ? [op.watermark.text] : 'page_numbers' in op ? [op.page_numbers.format ?? ''] : 'replace_text' in op ? [op.replace_text.replace] : 'fill_form' in op ? Object.values(op.fill_form.fields).filter((v): v is string => typeof v === 'string').map((v) => v.replace(/[\r\n]+/g, ' ')) : []))
  if (!texts.some((t) => /[^\x20-\x7e\xa0-\xff]/.test(t))) return null
  const f = textFontFile()
  if (!f) return null
  parts.push({ name: 'font', rel: '', bytes: fs.readFileSync(f) })
  return parts.length - 1
}

/**
 * edit_pdf on a file of this chat (QA TC-7044). Without output (or with replace: true): a new version of it, as
 * edit_office makes one (tools/edit-office.ts chatSource): the chain's head as ChatPlaces.head gives it (who may change
 * it here, never a file a hidden answer carries), read in this chat first (the head's hash), then ChatPlaces.version
 * with every rule again right before the insert. The worker's whole result is checked (a PDF) before anything is saved;
 * a refusal at any step saves nothing. With output: a new file made from it, as from a team PDF.
 */
async function editChatPdf(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: EditIn): Promise<PdfResult> {
  const at = parsePlace(a.file_path)
  if (at?.kind !== 'chatFiles' || (!at.id && !at.name)) throw new ToolError('edit_pdf changes a team PDF or one of this chat\'s files (chat:files/<file_id>/<name>)', 'bad_place')
  if (!c.places) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
  let output = a.output !== undefined && a.output.trim() !== '' ? a.output : undefined
  // an output that names this same chat file (chat:files/<its name>, or its id) is the file itself: a new version, never
  // a "<name> (2).pdf" beside it (QA TC-7044)
  const o = output !== undefined ? parsePlace(output.trim()) : null
  const fold = (n: string) => n.normalize('NFC').toLowerCase()
  if (o?.kind === 'chatFiles' && ((o.id && o.id === at.id) || (!o.id && o.name && at.name && fold(o.name) === fold(at.name)))) output = undefined
  if (a.replace === true && output !== undefined) throw new ToolError('give either replace: true or output, not both')
  const inputs = new Inputs(ctx, files, c)
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    let head: ChatHead | null = null
    let rel: string
    let seen: string | undefined
    if (output === undefined) {
      head = c.places.head(at.id, at.name ?? '')
      if (ext(head.name) !== 'pdf') throw new ToolError(`'${head.name}' is not a .pdf; edit_pdf changes PDFs (edit_office changes Word, Excel and PowerPoint files)`)
      if (head.quarantined) throw new ToolError(`'${head.name}' is held by the team's safety check, so it is not changed`, 'held')
      seen = c.files.readHashes.get(head.path)
      if (!seen) throw new ToolError(`read '${head.path}' first (with read) before changing it`, 'not_read')
      if (seen !== head.sha256) throw new ToolError(`'${head.path}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
      const abs = head.abs
      rel = head.path
      inputs.addPlace(rel, head.size, () => readRegular(abs, pdfInputMax()).bytes)
    } else {
      const f = await readPlaceFile(ctx, c, a.file_path, pdfInputMax(), work)
      if (ext(f.name) !== 'pdf') throw new ToolError(`'${f.name}' is not a .pdf`)
      rel = f.place
      inputs.addPlace(rel, f.size, () => readRegular(f.local, pdfInputMax()).bytes)
    }
    const parts = inputs.parts
    const ops = editOps(inputs, a)
    await inputs.load()
    // the bytes are the ones the AI read (a save in between: read again)
    if (head && sha256(parts[0]!.bytes) !== seen) throw new ToolError(`'${head.path}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
    const font = editFont(parts, a)
    const sources = [...new Set(parts.filter((p) => p.rel).map((p) => p.rel))]
    if (head) {
      // what goes into the chat file from elsewhere (an inserted PDF, a picture) is weighed against the chat's people
      // before the worker runs, as edit_office's pictures are
      await confirmSources(ctx, files, c, head.path, ['chat:files', head.id, head.name], sources.filter((s) => s !== rel))
      const r = await runJob(ctx, c, { kind: 'edit', ops, font }, parts)
      const bytes = r.files[0]!
      c.user = ctx.files.principal(c.user.id)
      c.beforePlace?.()
      const v = await c.places.version(head.id, { bytes }, seen!, c.files)
      return { made: [{ path: v.path, size: v.size, sha256: v.sha256 }], pages: [r.report.files[0]!.pages], report: r.report, sources, chatVersion: v }
    }
    const out = target(files, c, output, [], '', '')
    const r = await runJob(ctx, c, { kind: 'edit', ops, font }, parts)
    await confirmSources(ctx, files, c, out.rel, out.segs, sources)
    const made = await place(ctx, files, c, out.segs, r.files[0]!, 'edit_pdf')
    return { made: [made], pages: [r.report.files[0]!.pages], report: r.report, sources }
  } finally {
    inputs.done()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

export async function editPdfFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: EditIn): Promise<PdfResult> {
  if (isReservedPlace(a.file_path)) return editChatPdf(ctx, files, c, a)
  const inputs = new Inputs(ctx, files, c)
  try {
    const parts = inputs.parts
    inputs.add(a.file_path, 'pdf')
    const src = parts[0]!
    const ops = editOps(inputs, a)
    await inputs.load()
    const font = editFont(parts, a)
    const sources = [...new Set(parts.filter((p) => p.rel).map((p) => p.rel))]
    if (a.replace === true && a.output !== undefined) throw new ToolError('give either replace: true or output, not both')
    let out
    if (a.replace === true) {
      if (!c.files.readHashes.has(src.rel)) throw new ToolError(`to replace '${src.rel}' (its old version stays in its history), read it in this chat first. Replace it only when the user asked for that; otherwise leave replace out to save a new file next to it`)
      out = authorize(files.fx, files.rules(), c.user, src.rel, 'write', { mustExist: true })
      if (inAnySkills(out.rel)) throw new ToolError('a PDF in a skill folder is not changed here; save the result in a project or the person\'s own folder')
    } else if ((a.output === undefined || a.output.trim() === '') && madeThisTurn(c, src.rel, src.bytes)) {
      // the AI's own PDF of this turn: changed in place (a new version), no unchanged copy left next to it
      out = authorize(files.fx, files.rules(), c.user, src.rel, 'write', { mustExist: true })
      if (inAnySkills(out.rel)) throw new ToolError('a PDF in a skill folder is not changed here; save the result in a project or the person\'s own folder')
    } else {
      out = target(files, c, a.output, src.rel.split('/').slice(0, -1), src.rel.split('/').at(-1)!, PDF_WORDS.edited[teamDefaultLocale(ctx.db)] ?? 'edited')
      if (out.rel === src.rel) throw new ToolError(`output is the original '${src.rel}'; to replace it use replace: true, only when the user asked for that`)
    }
    const r = await runJob(ctx, c, { kind: 'edit', ops, font }, parts)
    await confirmSources(ctx, files, c, out.rel, out.segs, out.rel === src.rel ? sources.filter((s) => s !== src.rel) : sources)
    const made = await place(ctx, files, c, out.segs, r.files[0]!, 'edit_pdf')
    return { made: [made], pages: [r.report.files[0]!.pages], report: r.report, sources }
  } finally { inputs.done() }
}

export async function mergePdfFiles(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: MergeIn): Promise<PdfResult> {
  const inputs = new Inputs(ctx, files, c)
  try {
    const parts = inputs.parts
    const list = a.files.map((f) => {
      const p = typeof f === 'string' ? { path: f } : f
      return { part: inputs.add(p.path, 'pdf'), ...(p.pages ? { pages: p.pages } : {}) }
    })
    await inputs.load()
    const first = parts[0]!
    const out = target(files, c, a.output, first.rel.split('/').slice(0, -1), first.rel.split('/').at(-1)!, PDF_WORDS.merged[teamDefaultLocale(ctx.db)] ?? 'merged')
    if (parts.some((p) => p.rel === out.rel)) throw new ToolError(`output '${out.rel}' is one of the files being joined; give another name`)
    const r = await runJob(ctx, c, { kind: 'merge', files: list }, parts)
    const sources = parts.map((p) => p.rel)
    await confirmSources(ctx, files, c, out.rel, out.segs, sources)
    const made = await place(ctx, files, c, out.segs, r.files[0]!, 'merge_pdfs')
    return { made: [made], pages: [r.report.files[0]!.pages], report: r.report, sources }
  } finally { inputs.done() }
}

export async function splitPdfFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: SplitIn): Promise<PdfResult> {
  const inputs = new Inputs(ctx, files, c)
  try {
    inputs.add(a.file_path, 'pdf')
    await inputs.load()
    const src = inputs.parts[0]!
    let specs = a.parts
    if (!specs) {
      // every N pages: the parts are only known once the page count is; the worker counts, the server names them
      specs = []
      const every = a.every!
      const count = await pageCount(ctx, c, src)
      for (let s = 1; s <= count; s += every) specs.push(`${s}-${Math.min(count, s + every - 1)}`)
      if (specs.length > 50) throw new ToolError(`that would make ${specs.length} files, more than 50; give a larger every`)
    }
    const word = PDF_WORDS.part[teamDefaultLocale(ctx.db)] ?? 'part'
    const base = src.rel.split('/').at(-1)!.replace(/\.pdf$/i, '')
    const wanted = a.output_folder?.trim().replace(/\/+$/, '')
    // chat:files/ as the folder: each part is attached to this answer (its output check: authorizeOutput in target())
    const folder = wanted ? (isReservedPlace(wanted) ? wanted.split('/') : authorize(files.fx, files.rules(), c.user, wanted, 'write', { mustExist: false, createDirs: true }).segs) : src.rel.split('/').slice(0, -1)
    const outs = specs.map((_, i) => {
      const dir = path.join(files.fx.root, ...folder)
      const name = fs.existsSync(dir) ? freeName(dir, `${base} (${word} ${i + 1}).pdf`) : `${base} (${word} ${i + 1}).pdf`
      return target(files, c, [...folder, name].join('/'), [], '', '')
    })
    const r = await runJob(ctx, c, { kind: 'split', parts: specs }, [src])
    // every part's wider-audience check before any part is placed, so a "no" leaves nothing behind
    for (const out of outs) await confirmSources(ctx, files, c, out.rel, out.segs, [src.rel])
    const made: MadeFile[] = []
    for (const [i, out] of outs.entries()) {
      try { made.push(await place(ctx, files, c, out.segs, r.files[i]!, 'split_pdf')) } catch (e) {
        // a later part refused when it is placed (a limit, a rule changed): say which parts are already saved
        if (!made.length || !(e instanceof Error)) throw e
        throw new ToolError(`${e.message}. Parts already saved: ${made.map((m) => m.path).join(', ')}; the others were not saved`)
      }
    }
    return { made, pages: r.report.files.map((f) => f.pages), report: r.report, sources: [src.rel] }
  } finally { inputs.done() }
}

/** a PDF's page count, through the worker (it parses the PDF; this process does not) */
async function pageCount(ctx: AppContext, c: ToolCtx, src: Part): Promise<number> {
  const r = await runJob(ctx, c, { kind: 'count' }, [src])
  return r.report.files[0]!.pages
}

/** The tool result for the AI: what was saved, and how to check it. */
export function pdfResultText(tool: string, r: PdfResult, link: (p: string) => string, check: boolean): string {
  if (r.chatVersion) {
    const v = r.chatVersion
    const signed = r.report.signed ? ' The PDF had a digital signature; tell the user that the new version no longer carries a valid signature.' : ''
    const notes = r.report.notes.length ? `\n${r.report.notes.join('\n')}` : ''
    const look = check ? `\nCheck the pages you drew on before you answer: read ${v.path} with pages and as_images: true.` : ''
    return `${versionText(v, 'Changed')} (${r.pages[0]} page${r.pages[0] === 1 ? '' : 's'})${signed}${notes}${look}`
  }
  const lines = r.made.map((m, i) => m.conflictCopyOf
    ? `'${m.conflictCopyOf}' already exists and was not read in this chat (or changed after the read), so this result was saved as '${m.path}' (${r.pages[i]} page${r.pages[i] === 1 ? '' : 's'}). Tell the user about both.`
    : `Saved ${m.path} (${r.pages[i]} page${r.pages[i] === 1 ? '' : 's'}). Link for the user: ${link(m.path)}`)
  const replaced = tool === 'edit_pdf' && r.made[0] && r.sources[0] === r.made[0].path && !r.made[0].conflictCopyOf
  const kept = replaced ? `This is a new version of ${r.sources[0]}; the previous version is in its file history.` : `${r.sources.join(', ')} ${r.sources.length === 1 ? 'is' : 'are'} unchanged.`
  const signed = r.report.signed ? ' A PDF here had a digital signature; tell the user that the new file no longer carries a valid signature.' : ''
  const look = check ? `\nCheck the pages you drew on before you answer: read the new file with pages and as_images: true.` : ''
  const notes = r.report.notes.length ? `\n${r.report.notes.join('\n')}` : ''
  return `${lines.join('\n')}\n${kept}${signed}${notes}${look}`
}
