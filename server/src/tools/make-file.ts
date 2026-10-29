// make_file (design tab 3): Markdown / CSV -> Word, PowerPoint, Excel, PDF in the team folder.
// - docx / pptx: pandoc --sandbox --fail-if-warnings (a missing or remote image is an error, not a silent hole),
//   optional --reference-doc template from skills/
// - pdf: pandoc -t typst, then typst compile --root <work folder> (nothing outside the work folder can be read,
//   remote images are never fetched); Korean-capable fonts first
// - xlsx: exceljs (CSV, or every Markdown pipe table becomes a sheet); numbers become numbers, header row bold,
//   filter + frozen header. A data cell that starts with "=" becomes a formula (R2-GEN-02); "'=" keeps it as text.
//   A formula that can reach outside the workbook (external workbook refs, DDE, HYPERLINK, WEBSERVICE, INDIRECT, ...)
//   is refused and nothing is saved. The file has no stored results: Excel / LibreOffice calculate them on open.
// Converters run isolated (tools/isolate.ts) in an empty work folder. Images the document refers to by a relative
// path are copied into the work folder only if the person may read them; anything else fails the conversion.
// The output goes through the policy function; an existing file is never overwritten silently: it gets a conflict
// copy ("name (충돌 사본 - 사람 날짜 HH.mm).docx"), unless this turn read that exact version first.
// Every file whose bytes end up in the output (the source, each embedded image, the template) is a source of the new
// file (design tab 7 "공용 폴더를 거친 유출"): they join the chat's read scope, and before the output is placed the
// chat turn asks the person when more people can read the output folder than those files (ToolCtx.confirmWidening).
// Without a chat turn there is nobody to ask: such a save is refused.
// - pptx: the slide level is set from the headings and the slides pandoc made are checked against expected_slides /
//   expected_notes before anything is saved (tools/pptx-check.ts)
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import type { z } from 'zod'
import type { MakeFileInput } from '@mycel/shared'
import type { AppContext } from '../context'
import { teamDefaultLocale, teamTimeZone } from '../admin/settings'
import { ext } from '../files/extract'
import type { ToolCtx } from '../files/service'
import { conflictCopyName, fileEvent, readRegular, recordConflictCopy, sha256 } from '../files/store'
import { sourceOf, widening } from '../chat/read-scope'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { which } from '../config'
import { publishChanges } from '../team-files/changes'
import { checkRegular, freeName, hashFile, installFile, snapshotVersion } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir, runIsolated } from './isolate'
import { consumeSkillApproval, requireSkillApproval } from '../skills/guard'
import { PRODUCT } from '@mycel/shared'
import { typstJobs } from '../system/limits'
import { assertStorageRoomForAI } from '../system/storage'
import { deckMismatch, deckShape, type Deck, type DeckShape } from './pptx-check'
import { readDeckIsolated } from '../safe-ops/deck-check'
import { safeOpsEnabled } from '../safe-ops/runner'
import { withWorkflow } from '../safe-ops/workflow'
import { publishArtifact } from '../safe-ops/publication'
import { preparePresentation, policyStamp } from '../safe-ops/presentation'
import { snapshot, recheck, type SourceSnapshot } from '../safe-ops/source'
import { safeText } from '../safe-ops/strings'

type Input = z.output<typeof MakeFileInput>
export interface MadeFile { path: string; size: number; sha256: string; conflictCopyOf?: string; deck?: Deck; formulas?: number }

const MAX_SOURCE = 10 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_IMAGES = 200
const MAX_IMAGES_BYTES = 100 * 1024 * 1024
/** pandoc's JSON tree of a 10 MB Markdown file stays well below this */
const MAX_AST = 200 * 1024 * 1024
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'])
export const PDF_FONTS = ['Pretendard', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', 'Helvetica Neue', 'Arial', 'Libertinus Serif']

export interface Converters { pandoc: string | null; typst: string | null }
export const findConverters = (pandoc: string | null): Converters => ({ pandoc, typst: process.env.MYCEL_TYPST_BIN ?? which('typst') })

/** The tool error when a converter is missing; the AI repeats it to the person. A Mac installs it with Homebrew; a
 * Linux server (self-hosted or the cloud) gets it with the release bundle (app/<version>/bin), so there a missing one
 * means an incomplete install, and `brew install` would be wrong advice. */
export function missingConverter(tool: 'pandoc' | 'typst', platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? `${tool} is not installed on the server; ask the owner to run \`brew install ${tool}\``
    : `${tool} is not installed on the server (the Linux server bundle includes it); ask whoever runs the server to update or reinstall it`
}

export class MakeFile {
  constructor(private ctx: AppContext, private files: TeamFiles, private conv: Converters) {}

  async run(c: ToolCtx, a: Input): Promise<MadeFile> {
    if(a.format==='pptx' && safeOpsEnabled()) return withWorkflow(this.ctx.files,c,() => this.safePresentation(c,a))
    if(a.expected_layouts) throw new ToolError(safeText(this.ctx.db,c.user.id,'unavailable'))
    const fx = this.files.fx
    const rules = this.files.rules()
    // ---- input
    let text: string
    let kind: 'markdown' | 'csv' | 'tsv'
    let baseDir: string[] = []
    /** team-folder files whose bytes go into the output */
    const sources: string[] = []
    if (a.source !== undefined) {
      const r = authorize(fx, rules, c.user, a.source, 'read')
      if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`)
      const x = ext(r.rel)
      if (!['md', 'markdown', 'txt', 'csv', 'tsv'].includes(x)) throw new ToolError('source must be a .md, .txt, .csv or .tsv file')
      const { bytes } = readRegular(r.abs, MAX_SOURCE)
      text = bytes.toString('utf8')
      kind = x === 'csv' ? 'csv' : x === 'tsv' ? 'tsv' : 'markdown'
      baseDir = r.segs.slice(0, -1)
      sources.push(r.rel)
    } else {
      text = a.content!
      if (Buffer.byteLength(text) > MAX_SOURCE) throw new ToolError('content is too large (max 10 MB)')
      kind = a.format === 'xlsx' && !hasPipeRow(text) ? (text.includes('\t') && !text.includes(',') ? 'tsv' : 'csv') : 'markdown'
    }
    // ---- output path (extension follows the format)
    let outRel = a.output.replace(/\/+$/, '')
    if (ext(outRel) !== a.format) outRel += '.' + a.format
    const out = authorize(fx, rules, c.user, outRel, 'write', { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)

    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const produced = path.join(work, 'out.' + a.format)
      /** pptx from Markdown: what decides the slides (pptx-check.ts) */
      let shape: DeckShape | null = null
      let formulas: number | undefined
      if (a.format === 'xlsx') formulas = await this.xlsx(text, kind, produced)
      else {
        if (!this.conv.pandoc) throw new ToolError(missingConverter('pandoc'))
        let input: string
        let from: 'json' | 'csv'
        let images: string[] = []
        if (kind === 'markdown') {
          if (/<(img|image|object|embed|iframe|video|audio|source|picture)\b/i.test(text)) throw new ToolError('HTML image tags are not supported; use Markdown images ![alt](path) with team-folder paths')
          // Markdown -> pandoc's document tree first (pandoc --sandbox reads nothing but in.md). Every image of the
          // document, whatever syntax it was written in (inline, reference, <angle brackets>, attributes), is an
          // Image node there: each one is checked and pointed at a checked copy in the work folder, so the second
          // pandoc run can only read those copies.
          fs.writeFileSync(path.join(work, 'in.md'), text)
          const j = await runIsolated({ cmd: this.conv.pandoc, args: ['--sandbox', '-f', 'markdown', '-t', 'json', '-o', 'ast.json', 'in.md'], workDir: work, timeoutMs: 120_000 })
          if (j.code !== 0) throw new ToolError(convertError('pandoc', j.stderr, j.killed, work))
          const astFile = path.join(work, 'ast.json')
          if (fs.statSync(astFile).size > MAX_AST) throw new ToolError('the document is too large to convert')
          const ast = JSON.parse(fs.readFileSync(astFile, 'utf8'))
          images = this.copyImages(c, ast, baseDir, work)
          sources.push(...images)
          if (a.format === 'pptx') shape = deckShape(ast)
          fs.writeFileSync(astFile, JSON.stringify(ast))
          input = 'ast.json'
          from = 'json'
        } else {
          input = `in.${kind}`
          fs.writeFileSync(path.join(work, input), kind === 'tsv' ? tsvToCsv(text) : text)
          from = 'csv'
        }
        if (a.format === 'pdf') await this.pdf(work, input, from)
        else {
          // without images pandoc reads only the files on its command line (--sandbox); with images it must read
          // the copies, which are the only image paths left in the tree (and the OS sandbox, when there is one,
          // keeps it inside the work folder anyway)
          const args = [...(images.length === 0 ? ['--sandbox'] : []), '--fail-if-warnings', '--resource-path=.', '-f', from, '-t', a.format, '-o', path.basename(produced), input]
          // pptx: an explicit slide level, never pandoc's guess from the document shape (B-W24-1: one slide)
          if (shape) args.push(`--slide-level=${shape.level}`)
          if (a.template) {
            const tpl = this.template(c, a.template, a.format, work)
            sources.push(tpl.rel)
            args.push('--reference-doc', tpl.local)
          }
          const r = await runIsolated({ cmd: this.conv.pandoc, args, workDir: work, timeoutMs: 120_000 })
          if (r.code !== 0) throw new ToolError(convertError('pandoc', r.stderr, r.killed, work))
        }
      }
      if (!fs.existsSync(produced)) throw new ToolError('the converter produced no file')
      // the slides that were really made, checked before the person is asked anything or a file is placed
      let deck: Deck | undefined
      if (a.format === 'pptx') {
        deck = await readDeckIsolated(readRegular(produced,32*1024**2).bytes,c.signal)
        const bad = deckMismatch(deck, shape ?? { level: 1, metaTitle: false, sections: 0, textUnderSection: 0, rules: 0 }, { slides: a.expected_slides, notes: a.expected_notes })
        if (bad) throw new ToolError(bad)
      }
      // only now are all the files known whose bytes are in the output (images come out of pandoc's tree)
      await this.checkWidening(c, out.rel, out.segs, sources)
      const made = await this.place(c, out.segs, produced)
      return deck ? { ...made, deck } : formulas !== undefined ? { ...made, formulas } : made
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  private async safePresentation(c: ToolCtx, a: Input): Promise<MadeFile> {
    if(a.template) throw new ToolError(safeText(this.ctx.db,c.user.id,'template'))
    if((a.expected_slides??0)>30 || (a.expected_notes??0)>30) throw new ToolError(safeText(this.ctx.db,c.user.id,'limit'),'safe_ops_limit')
    if(!this.conv.pandoc) throw new ToolError(safeText(this.ctx.db,c.user.id,'unavailable'))
    const snapshots: SourceSnapshot[]=[]
    let text=a.content??'', base: string[]=[]
    if(a.source!==undefined) {
      const s=snapshot(this.ctx.files,c,a.source,400_000)
      if(!['md','markdown','txt'].includes(ext(s.path))) throw new ToolError(safeText(this.ctx.db,c.user.id,'source'))
      snapshots.push(s); text=s.bytes.toString('utf8'); base=s.path.split('/').slice(0,-1)
    }
    const output=ext(a.output)==='pptx'?a.output:a.output+'.pptx'
    c.user=this.ctx.files.principal(c.user.id)
    const out=authorize(this.files.fx,this.files.rules(),c.user,output,'write',{mustExist:false,download:true})
    const {bytes,deck}=await preparePresentation(this.ctx.files,c,this.conv.pandoc,text,base,{slides:a.expected_slides,notes:a.expected_notes,layouts:a.expected_layouts},snapshots)
    const made=await publishArtifact(this.ctx,this.files,c,out.rel,bytes,snapshots,
      (target,sources,binding)=>this.checkWidening(c,target,target.split('/'),sources,binding))
    return {...made,deck}
  }

  /**
   * Images: only files in the team folder the person may read, by relative path (to the source file, or to the
   * team root), are copied into the work folder; the Image nodes of the document tree then point at the copies.
   * Anything else (web addresses, data: URLs, absolute paths, hidden or missing files) stops the conversion.
   */
  private copyImages(c: ToolCtx, ast: unknown, baseDir: string[], work: string): string[] {
    let n = 0
    const rels: string[] = []
    let bytes = 0
    const fx = this.files.fx
    const rules = this.files.rules()
    const bad = (target: string, why: string): never => { throw new ToolError(`image '${target.slice(0, 200)}': ${why}. Images must be files in the team folder you can read, given by a relative path (no web addresses or absolute paths).`) }
    const local = (target: string): string => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) bad(target, 'web addresses are not fetched')
      if (target.startsWith('/') || target.startsWith('~') || target.startsWith('\\')) bad(target, 'absolute paths are not allowed')
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* keep */ }
      const x = ext(decoded)
      if (!IMAGE_EXT.has(x)) bad(target, 'not an image file')
      if (++n > MAX_IMAGES) bad(target, `more than ${MAX_IMAGES} images`)
      const candidates = [path.posix.normalize([...baseDir, decoded].join('/')), path.posix.normalize(decoded)]
      for (const rel of candidates) {
        if (rel.startsWith('..')) continue
        let abs: string, size: number, found: string
        try {
          const r = authorize(fx, rules, c.user, rel, 'read')
          abs = r.abs
          size = checkRegular(abs).size
          found = r.rel
        } catch { continue }
        if (size > MAX_IMAGE) bad(target, 'larger than 20 MB')
        if ((bytes += size) > MAX_IMAGES_BYTES) bad(target, 'the images together are larger than 100 MB')
        const name = `img-${n}.${x}`
        fs.copyFileSync(abs, path.join(work, name))
        rels.push(found)
        return name
      }
      return bad(target, 'not found or no access')
    }
    // iterative walk (a deeply nested document must not overflow the stack)
    const stack: unknown[] = [ast]
    while (stack.length) {
      const v = stack.pop()
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
      if (!v || typeof v !== 'object') continue
      const node = v as { t?: unknown; c?: unknown }
      if (node.t === 'Image' && Array.isArray(node.c) && Array.isArray(node.c[2]) && typeof node.c[2][0] === 'string') {
        node.c[2][0] = local(node.c[2][0])
      }
      for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
    }
    return rels
  }

  /**
   * The output carries the bytes of `sources`: they join the chat's read scope (later saves in the chat take them
   * into account), and when more people can read the output than those files (or what the chat read), the chat turn
   * asks the person first. No chat turn (nobody to ask): refused. Runs before anything is placed.
   */
  private async checkWidening(c: ToolCtx, target: string, targetSegs: string[], sources: string[], binding?: string) {
    for (const p of sources) c.files.readPaths.add(p)
    if (c.confirmWidening) {
      const refusal = await c.confirmWidening(target, sources, binding)
      if (refusal) throw new Denied(refusal)
      return
    }
    const db = this.ctx.db
    const rules = this.files.rules()
    const chatId = c.turnId ? (db.query('SELECT chat_id FROM turns WHERE id = ?').get(c.turnId) as { chat_id: string } | null)?.chat_id ?? null : null
    const w = widening(db, chatId, targetSegs, sources.map((p) => sourceOf(db, rules, p)))
    if (w) throw new Denied(`more people can read '${target}' than the files it is made from; nothing was saved. Save it in a folder that only the people who can read those files can see, or ask the user where to put it.`)
  }

  private template(c: ToolCtx, tpl: string, format: string, work: string): { local: string; rel: string } {
    const r = authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.segs[0] !== 'skills') throw new ToolError('templates must be files under skills/')
    if (ext(r.rel) !== format) throw new ToolError(`the template must be a .${format} file`)
    const st = checkRegular(r.abs)
    if (st.size > 50 * 1024 * 1024) throw new ToolError('template is too large')
    const local = `template.${format}`
    fs.copyFileSync(r.abs, path.join(work, local))
    return { local, rel: r.rel }
  }

  private async pdf(work: string, input: string, from: 'json' | 'csv') {
    if (!this.conv.typst) throw new ToolError(missingConverter('typst'))
    const t = await runIsolated({ cmd: this.conv.pandoc!, args: ['--sandbox', '--fail-if-warnings', '-f', from, '-t', 'typst', '-o', 'body.typ', input], workDir: work, timeoutMs: 120_000 })
    if (t.code !== 0) throw new ToolError(convertError('pandoc', t.stderr, t.killed, work))
    const pre = [
      `#set page(paper: "a4", margin: (x: 2cm, y: 2.2cm), numbering: "1")`,
      `#set text(font: (${PDF_FONTS.map((f) => JSON.stringify(f)).join(', ')}), size: 10.5pt, lang: "ko")`,
      `#set par(justify: false, leading: 0.75em)`,
      `#show heading: set block(above: 1.2em, below: 0.6em)`,
      `#set table(stroke: 0.5pt + luma(180), inset: 6pt)`,
      // pandoc's typst output uses this helper for horizontal rules
      `#let horizontalrule = line(start: (25%,0%), end: (75%,0%))`,
      '',
    ].join('\n')
    fs.writeFileSync(path.join(work, 'doc.typ'), pre + fs.readFileSync(path.join(work, 'body.typ'), 'utf8'))
    const jobs = typstJobs() // Linux bundle's typst: at most 2 threads (system/limits.ts)
    const r = await runIsolated({ cmd: this.conv.typst, args: ['compile', ...(jobs ? ['--jobs', String(jobs)] : []), '--root', work, 'doc.typ', 'out.pdf'], workDir: work, timeoutMs: 120_000 })
    if (r.code !== 0) throw new ToolError(convertError('typst', r.stderr, r.killed, work))
  }

  /** Writes the workbook; returns the number of formula cells. */
  private async xlsx(text: string, kind: 'markdown' | 'csv' | 'tsv', out: string): Promise<number> {
    const sheets: { name: string; rows: string[][] }[] = []
    if (kind === 'markdown') {
      const tables = markdownTables(text)
      if (!tables.length) throw new ToolError('no table found: give CSV, or Markdown with | pipe | tables |')
      tables.forEach((t, i) => sheets.push({ name: t.title ?? `Sheet${i + 1}`, rows: t.rows }))
    } else sheets.push({ name: 'Sheet1', rows: parseCsv(text, kind === 'tsv' ? '\t' : ',') })
    const wb = new ExcelJS.Workbook()
    wb.creator = PRODUCT.displayName
    wb.created = new Date()
    // formulas are written without a result: the spreadsheet app calculates them when it opens the file
    wb.calcProperties.fullCalcOnLoad = true
    const used = new Set<string>()
    let formulas = 0
    for (const s of sheets) {
      let name = s.name.replace(/[\\/?*[\]:'"|]/g, ' ').trim().slice(0, 31) || 'Sheet'
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 28)} ${i}`
      used.add(name.toLowerCase())
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: s.rows.length > 1 ? 1 : 0 }] })
      s.rows.forEach((row, ri) =>
        ws.addRow(row.map((v, ci) => {
          if (ri === 0) return v
          const cv = cellValue(v)
          if (typeof cv === 'object' && 'error' in cv) throw new ToolError(`sheet '${name}' cell ${columnName(ci + 1)}${ri + 1}: ${cv.error}; nothing was saved. Start the cell with '= to keep it as text.`)
          if (typeof cv === 'object') formulas++
          return cv
        })),
      )
      if (s.rows.length) {
        ws.getRow(1).font = { bold: true }
        const cols = Math.max(...s.rows.map((r) => r.length))
        if (s.rows.length > 1 && cols > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols } }
        for (let ci = 1; ci <= cols; ci++) {
          const w = Math.max(...s.rows.map((r) => displayWidth(String(r[ci - 1] ?? ''))))
          ws.getColumn(ci).width = Math.min(60, Math.max(8, w + 2))
        }
      }
    }
    await wb.xlsx.writeFile(out)
    return formulas
  }

  private place(c: ToolCtx, segs: string[], produced: string): Promise<MadeFile> {
    return placeProduced(this.ctx, this.files, c, segs, produced)
  }
}

/**
 * Put a produced file into the team folder (policy checked again) and record it: the AI's new files (make_file, and
 * generated media such as generate_video). An existing file the AI has not read in this turn is kept (conflict copy).
 */
export async function placeProduced(ctx: AppContext, files: TeamFiles, c: ToolCtx, segs: string[], produced: string, tool = 'make_file', guard?: () => void): Promise<MadeFile> {
  const cfg = ctx.engineConfig
  const size = fs.statSync(produced).size
  if (c.files.bytesWritten + size > cfg.maxWriteBytesPerTurn) throw new ToolError('write limit for this turn reached')
  assertStorageRoomForAI(size) // the team disk near full (system/storage.ts; Linux / a plan)
  const fx = files.fx
  // Finish asynchronous work BEFORE the fresh principal/content/conflict check. The final
  // check-to-install section is synchronous, so server saves and policy mutations cannot interleave.
  const sha = await hashFile(produced)
  c.signal?.throwIfAborted()
  c.user=ctx.files.principal(c.user.id)
  guard?.()
  const rules = files.rules()
  let conflictOf: string | undefined
  let action: 'create' | 'update' = 'create'
  // looked at again now, not before the conversion: someone may have saved a file there in the meantime
  const now = authorize(fx, rules, c.user, segs.join('/'), 'write', { mustExist: false, createDirs: true })
  if (now.exists && now.st!.isDirectory()) throw new ToolError(`'${now.rel}' is a folder`)
  segs = now.segs
  let target = segs
  const rel0 = now.rel
  // under skills/ only after the person confirmed this save on the server's card (skills/guard.ts); fail closed
  requireSkillApproval(c, rel0, null)
  if (now.exists) {
    const abs = path.join(fx.root, ...segs)
    checkRegular(abs)
    const cur = sha256(readRegular(abs).bytes)
    if (c.files.readHashes.get(rel0) === cur) {
      snapshotVersion(ctx.db, fx.root, rel0, { userId: c.user.id, turnId: c.turnId }, 'edit', cur)
      action = 'update'
    } else {
      // never overwrite a file the AI has not read in this turn: keep both
      const dir = segs.slice(0, -1)
      let name = conflictCopyName(segs[segs.length - 1]!, c.user.name, new Date(), teamDefaultLocale(ctx.db), teamTimeZone(ctx.db))
      if (badSegment(name)) name = `copy-${Date.now()}-${segs[segs.length - 1]}`
      name = freeName(path.join(fx.root, ...dir), name)
      target = authorize(fx, rules, c.user, [...dir, name].join('/'), 'write', { mustExist: false }).segs
      conflictOf = rel0
    }
  }
  if (!c.files.filesWritten.has(target.join('/')) && c.files.filesWritten.size >= cfg.maxFilesWrittenPerTurn) throw new ToolError('file count limit for this turn reached')
  // final check right before the rename (rules may have changed during the conversion)
  authorize(fx, files.rules(), c.user, target.join('/'), 'write', { mustExist: false, createDirs: true })
  installFile(fx.root, target, produced)
  consumeSkillApproval(c, rel0)
  const rel = target.join('/')
  c.files.bytesWritten += size
  c.files.filesWritten.add(rel)
  c.files.readHashes.set(rel, sha)
  // a conflict copy is told to both people and listed in the original's history (before the copy's own event)
  if (conflictOf) recordConflictCopy(ctx.db, ctx.files.events, { original: conflictOf, copy: rel, userId: c.user.id, turnId: c.turnId, size, sha256: sha, tool })
  fileEvent(ctx.db, { turnId: c.turnId, userId: c.user.id, path: rel, action, size, sha256: sha, detail: { tool, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
  // All office consumers already run in workers; PPTX was validated before this
  // publication. Never add an in-process document parser here.
  files.extractText(rel)
  publishChanges(ctx, [{ path: rel, action, by: { id: c.user.id, name: c.user.name }, turnId: c.turnId }])
  return { path: rel, size, sha256: sha, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) }
}

function convertError(tool: string, stderr: string, killed: string | null, work: string): string {
  if (killed === 'timeout') return `${tool} took too long`
  // the server's own folders stay out of the message (plain string replace: stderr echoes the document)
  const s = stderr.slice(0, 16 * 1024).split(work + '/').join('').split(work).join('.').trim()
  if (/Could not fetch resource|PandocResourceNotFound|file not found|failed to load file|access denied/i.test(s))
    return `an image or file the document refers to is not available. Images must be files in the team folder you can read, given by a relative path (no web addresses or absolute paths). (${tool}: ${s.split('\n').slice(0, 3).join(' ').slice(0, 300)})`
  return `${tool} could not convert the document: ${s.split('\n').slice(0, 4).join(' ').slice(0, 400) || 'unknown error'}`
}

// ---------------- tables ----------------
/** RFC 4180 CSV (quotes, doubled quotes, newlines inside quotes); a BOM is ignored. */
export function parseCsv(s: string, sep = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  // blank rows are dropped as they end, not collected and filtered afterwards: millions of blank lines (hostile input)
  // made millions of arrays, 13 s of garbage collection on a Linux VM where the rest took 0.4 s
  const keep = (r: string[]) => { if (r.some((c) => c.trim() !== '')) rows.push(r) }
  s = s.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === sep) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); keep(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); keep(row) }
  return rows
}
const tsvToCsv = (s: string) => parseCsv(s, '\t').map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'

// Line patterns of pipe tables. Only [ \t] (never \s, which spans lines) and no two adjacent quantifiers over the
// same characters, so a 10 MB line of spaces or newlines is matched in linear time.
const PIPE_ROW = /^[ \t]*\|.*\|[ \t]*$/
const PIPE_SEP = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/
const hasPipeRow = (s: string) => /^[ \t]*\|.*\|[ \t]*$/m.test(s)

/** Markdown pipe tables, each with the nearest heading above it as its title. */
export function markdownTables(md: string): { title?: string; rows: string[][] }[] {
  const lines = md.split(/\r?\n/)
  const out: { title?: string; rows: string[][] }[] = []
  let heading: string | undefined
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[i]!)
    if (h) { heading = h[1]!.trim(); continue }
    if (PIPE_ROW.test(lines[i]!) && i + 1 < lines.length && PIPE_SEP.test(lines[i + 1]!.trim())) {
      const rows = [cells(lines[i]!)]
      let j = i + 2
      while (j < lines.length && PIPE_ROW.test(lines[j]!)) rows.push(cells(lines[j++]!))
      out.push({ title: heading, rows: rows.map((r) => r.map((c) => c.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1'))) })
      heading = undefined
      i = j - 1
    }
  }
  return out
}

/** "1,234" / "12.5" / "-3" become numbers; "007" and long digit strings (phone, account numbers) stay text.
 * "=SUM(B2:B5)" becomes a formula (or an error when it is not allowed, see formulaOf); "'=x" is the text "=x". */
export function cellValue(v: string): string | number | ExcelJS.CellFormulaValue | { error: string } {
  const s = v.trim()
  if (s.startsWith('=') && startsLikeFormula(s.slice(1))) {
    const r = formulaOf(s.slice(1))
    // text such as "=3 days" or "=2x" starts like a formula but does not parse: it stays text
    return 'notFormula' in r ? v : r
  }
  if (s.startsWith("'=")) return s.slice(1)
  if (/^0\d/.test(s) || /^\+/.test(s) || s.replace(/\D/g, '').length > 15) return v
  if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''))
  return v
}

/** Functions that read or open something outside the workbook, run code, or build references from text (which gets
 * past the checks below). The AI writes the formula and a team-folder CSV can be an upload, so these are refused. */
const BLOCKED_FUNCTIONS = new Set([
  'HYPERLINK', 'WEBSERVICE', 'FILTERXML', 'ENCODEURL', 'RTD', 'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC', 'DDE', 'DDEAUTO',
  'IMAGE', 'INDIRECT', 'STOCKHISTORY', 'INFO', 'CELL', 'IMPORTDATA', 'IMPORTXML', 'IMPORTHTML', 'IMPORTFEED', 'IMPORTRANGE',
])
/** Functions newer than Excel 2007: the file format stores them with the "_xlfn." prefix, else Excel shows #NAME?. */
const XLFN = new Set([
  'IFS', 'SWITCH', 'MAXIFS', 'MINIFS', 'CONCAT', 'TEXTJOIN', 'XLOOKUP', 'XMATCH', 'IFNA', 'DAYS', 'STDEV.S', 'STDEV.P',
  'VAR.S', 'VAR.P', 'RANK.EQ', 'RANK.AVG', 'MODE.SNGL', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC',
  'CEILING.MATH', 'FLOOR.MATH', 'UNIQUE', 'SORT', 'SORTBY', 'FILTER', 'SEQUENCE',
])

/** True when the text after "=" starts with an operand: an optional unary +/- and then a function call "NAME(", a
 * cell or range reference ("B2", "$B$2", "B:B", "Sheet!B2", "'Sheet 2'!B2"), a number, a "string", "(", "{" or
 * TRUE/FALSE. An external reference ("[1]S!A1") and a DDE link ("app|topic!A1") are operands too, so that
 * formulaOf refuses them and does not keep them as text. Other text ("=> done", "= see note", "== x ==", "=-") is not a formula and stays text. */
export function startsLikeFormula(f: string): boolean {
  return /^\s*(?:[-+]\s*)*(?:["({]|\.?\d|\$?[A-Za-z]{1,3}\$?\d|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![\p{L}\p{N}_.])|[A-Za-z_][A-Za-z0-9_.]*\(|'(?:[^']|'')+'!|[\p{L}_][\p{L}\p{N}_.]*!|(?:TRUE|FALSE)(?![\p{L}\p{N}_.(])|\[|[A-Za-z_][A-Za-z0-9_.]*\|)/iu.test(f)
}

type Token = { kind: 'code' | 'string' | 'sheet'; text: string }

/** Splits a formula in one left-to-right pass, as Excel reads it: "double-quoted strings" ("" is a quote) and
 * 'quoted sheet names' ('' is an apostrophe, a "!" must follow). Everything else is code. */
function tokenize(f: string): Token[] | { error: string } {
  const out: Token[] = []
  let code = ''
  for (let i = 0; i < f.length; ) {
    const q = f[i]
    if (q !== '"' && q !== "'") { code += q; i++; continue }
    let j = i + 1
    for (;;) {
      if (j >= f.length) return { error: q === '"' ? 'the formula has an unclosed "' : "the formula has an unclosed '" }
      if (f[j] === q) { if (f[j + 1] === q) { j += 2; continue } break }
      j++
    }
    if (code) out.push({ kind: 'code', text: code })
    code = ''
    out.push({ kind: q === '"' ? 'string' : 'sheet', text: f.slice(i, j + 1) })
    i = j + 1
    if (q === "'" && f[i] !== '!') return { error: "text in single quotes must be a sheet name followed by '!'" }
  }
  if (code) out.push({ kind: 'code', text: code })
  return out
}

const CELL_REF = /^\$?[A-Za-z]{1,3}\$?\d+$/
const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)/i
const STRING_MARK = '\u0001', SHEET_MARK = '\u0002'

/** Why the formula (from tokenize) does not parse as a whole, or null when it parses. The check is lexical: each
 * operand must be a number, a "string", a function call NAME( (no space before "("), a cell or range reference
 * ("B2", "$B$2", "B:B", "1:3"), a sheet-qualified reference ("Sheet!B2", "'Sheet 2'!B2"), TRUE/FALSE, an error
 * value (#N/A) or an array {...}. Two operands next to each other ("3 days", "1 apple"), a number followed by letters
 * ("2x") and other words ("Total", "see") do not parse. Note: this also refuses the intersection operator (a space
 * between two ranges). */
function structureError(tokens: Token[]): string | null {
  const s = tokens.map((t) => (t.kind === 'code' ? t.text : t.kind === 'string' ? STRING_MARK : SHEET_MARK)).join('')
  let operand = false // the last item ends an operand, so the next item must be an operator
  let afterColon = false
  const start = (): string | null => (operand ? 'two values are next to each other without an operator' : null)
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i)
    const ch = s[i]!
    if (/\s/.test(ch)) { i++; continue }
    const colon = afterColon
    afterColon = false
    if (ch === STRING_MARK) { const e = start(); if (e) return e; operand = true; i++; continue }
    if (ch === SHEET_MARK || /^[\p{L}_$]/u.test(rest)) {
      const e = start(); if (e) return e
      let word = ''
      if (ch === SHEET_MARK) i++
      else { word = /^[\p{L}\p{N}_.$]+/u.exec(rest)![0]; i += word.length }
      if (ch === SHEET_MARK || s[i] === '!') {
        // a sheet-qualified reference: the sheet name, "!", then a cell, column or row reference
        if (ch !== SHEET_MARK && (word.includes('$') || /^\d/.test(word))) return `"${word}" is not a sheet name`
        if (s[i] !== '!') return "a sheet name must be followed by '!'"
        const ref = /^(?:\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}|\$?\d+)(?![\p{L}\p{N}_.$])/u.exec(s.slice(i + 1))
        if (!ref) return 'a sheet name must be followed by a cell reference'
        i += 1 + ref[0].length
        operand = true
        continue
      }
      if (s[i] === '(' && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) { i++; operand = false; continue } // a function call
      const nextColon = /^\s*:/.test(s.slice(i))
      if (CELL_REF.test(word) || /^(?:TRUE|FALSE)$/i.test(word) || ((colon || nextColon) && /^\$?(?:[A-Za-z]{1,3}|\d+)$/.test(word))) {
        operand = true
        continue
      }
      return `"${word}" is not a function, a cell reference or TRUE/FALSE`
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest)
    if (num) {
      const e = start(); if (e) return e
      i += num[0].length
      if (/^[\p{L}\p{N}_.$]/u.test(s.slice(i))) return 'a number is followed by letters'
      operand = true
      continue
    }
    if (ch === '#') {
      const e = start(); if (e) return e
      const lit = ERROR_LITERAL.exec(rest)
      if (!lit) return 'the formula has an unknown error value'
      i += lit[0].length
      operand = true
      continue
    }
    if (ch === '(' || ch === '{') { const e = start(); if (e) return e; operand = false; i++; continue }
    if (ch === ')' || ch === '}' || ch === '%') { operand = true; i++; continue }
    if ('+-*/^&=<>,;:'.includes(ch)) { operand = false; afterColon = ch === ':'; i++; continue }
    return `the formula has the character "${ch}" in an unexpected place`
  }
  return null
}

const BLOCKED_CALL = new RegExp(`(${[...BLOCKED_FUNCTIONS].map((n) => n.replace('.', '\\.')).join('|')})\\s*\\(`, 'i')

/** A formula (without the leading "=") as ExcelJS writes it, or why it is refused. Only text in "double quotes" is
 * not checked; code and 'quoted sheet names' may refer only to cells of this workbook ("B2", "Sheet2!B2",
 * "'Sheet 2'!B2"). */
export function formulaOf(f: string): ExcelJS.CellFormulaValue | { error: string; notFormula?: true } {
  if (f.length > 8192) return { error: 'the formula is longer than 8192 characters' }
  if (!startsLikeFormula(f)) return { error: 'the formula does not start with a value, a reference or a function' }
  const tokens = tokenize(f)
  if (!Array.isArray(tokens)) return tokens
  // the checks below read code and sheet names, never string literals
  for (const t of tokens) {
    if (t.kind === 'string') continue
    const body = t.kind === 'sheet' ? t.text.slice(1, -1) : t.text
    if (t.kind === 'code' && body.includes('|')) return { error: 'formulas may not use DDE links (|)' }
    if (/[[\]]/.test(body)) return { error: 'formulas may not refer to other files ([...])' }
    if (body.includes('\\')) return { error: 'formulas may not refer to file paths' }
    if (t.kind === 'sheet' && body.includes('|')) return { error: 'formulas may not use DDE links (|)' }
    if (t.kind === 'sheet' && body.includes('"')) return { error: 'sheet names in formulas may not contain "' }
  }
  // a space stands for each string or sheet name, so that two code parts never join into one name
  const code = tokens.map((t) => (t.kind === 'code' ? t.text : ' ')).join('')
  const call = BLOCKED_CALL.exec(code)
  if (call) return { error: `the function ${call[1]!.toUpperCase()} is not allowed in formulas (it can reach outside the workbook)` }
  // the whole formula must parse; when it does not, cellValue keeps the cell as text ("=3 days", "=2x")
  const bad = structureError(tokens)
  if (bad) return { error: `the formula does not parse: ${bad}`, notFormula: true }
  let depth = 0
  for (const ch of code) if ((depth += ch === '(' ? 1 : ch === ')' ? -1 : 0) < 0) break
  if (depth !== 0) return { error: 'the parentheses of the formula do not match' }
  // "=A1+" would make a file that Excel opens only after a repair
  if (tokens[tokens.length - 1]!.kind === 'code' && /[-+*/^&=<>,]\s*$/.test(code)) return { error: 'the formula ends with an operator' }
  const out = tokens.map((t) => (t.kind !== 'code' ? t.text : t.text.replace(/(?<![A-Za-z0-9_.])((?:_xl[A-Za-z]*\.)*)([A-Za-z][A-Za-z0-9_.]*)(?=\s*\()/g, (_m, prefix: string, name: string) => {
    const n = name.toUpperCase()
    return prefix ? prefix + n : XLFN.has(n) ? `_xlfn.${n}` : n
  }))).join('')
  return { formula: out }
}

/** 1 -> A, 27 -> AA */
const columnName = (n: number): string => (n > 26 ? columnName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))
const displayWidth = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

