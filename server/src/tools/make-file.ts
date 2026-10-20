// make_file (design tab 3): Markdown / CSV -> Word, PowerPoint, Excel, PDF in the team folder.
// - docx / pptx: pandoc --sandbox --fail-if-warnings (a missing or remote image is an error, not a silent hole),
//   optional --reference-doc template from skills/
// - pdf: pandoc -t typst, then typst compile --root <work folder> (nothing outside the work folder can be read,
//   remote images are never fetched); Korean-capable fonts first
// - xlsx: exceljs (CSV, or every Markdown pipe table becomes a sheet); numbers become numbers, header row bold,
//   filter + frozen header
// Converters run isolated (tools/isolate.ts) in an empty work folder. Images the document refers to by a relative
// path are copied into the work folder only if the person may read them; anything else fails the conversion.
// The output goes through the policy function; an existing file is never overwritten silently: it gets a conflict
// copy ("name (충돌 사본 - 사람 날짜 HH.mm).docx"), unless this turn read that exact version first.
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import type { z } from 'zod'
import type { MakeFileInput } from '@mycel/shared'
import type { AppContext } from '../context'
import { ext } from '../files/extract'
import type { ToolCtx } from '../files/service'
import { conflictCopyName, fileEvent, readRegular, sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { which } from '../config'
import { publishChanges } from '../team-files/changes'
import { checkRegular, freeName, hashFile, installFile, snapshotVersion } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir, runIsolated } from './isolate'

type Input = z.output<typeof MakeFileInput>
export interface MadeFile { path: string; size: number; sha256: string; conflictCopyOf?: string }

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

export class MakeFile {
  constructor(private ctx: AppContext, private files: TeamFiles, private conv: Converters) {}

  async run(c: ToolCtx, a: Input): Promise<MadeFile> {
    const fx = this.files.fx
    const rules = this.files.rules()
    // ---- input
    let text: string
    let kind: 'markdown' | 'csv' | 'tsv'
    let baseDir: string[] = []
    if (a.source !== undefined) {
      const r = authorize(fx, rules, c.user, a.source, 'read')
      if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`)
      const x = ext(r.rel)
      if (!['md', 'markdown', 'txt', 'csv', 'tsv'].includes(x)) throw new ToolError('source must be a .md, .txt, .csv or .tsv file')
      const { bytes } = readRegular(r.abs, MAX_SOURCE)
      text = bytes.toString('utf8')
      kind = x === 'csv' ? 'csv' : x === 'tsv' ? 'tsv' : 'markdown'
      baseDir = r.segs.slice(0, -1)
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
      if (a.format === 'xlsx') await this.xlsx(text, kind, produced)
      else {
        if (!this.conv.pandoc) throw new ToolError('pandoc is not installed on the server; ask the owner to run `brew install pandoc`')
        let input: string
        let from: 'json' | 'csv'
        let images = 0
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
          const args = [...(images === 0 ? ['--sandbox'] : []), '--fail-if-warnings', '--resource-path=.', '-f', from, '-t', a.format, '-o', path.basename(produced), input]
          if (a.template) args.push('--reference-doc', this.template(c, a.template, a.format, work))
          const r = await runIsolated({ cmd: this.conv.pandoc, args, workDir: work, timeoutMs: 120_000 })
          if (r.code !== 0) throw new ToolError(convertError('pandoc', r.stderr, r.killed, work))
        }
      }
      if (!fs.existsSync(produced)) throw new ToolError('the converter produced no file')
      return await this.place(c, out.segs, produced)
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  /**
   * Images: only files in the team folder the person may read, by relative path (to the source file, or to the
   * team root), are copied into the work folder; the Image nodes of the document tree then point at the copies.
   * Anything else (web addresses, data: URLs, absolute paths, hidden or missing files) stops the conversion.
   */
  private copyImages(c: ToolCtx, ast: unknown, baseDir: string[], work: string): number {
    let n = 0
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
        let abs: string, size: number
        try {
          const r = authorize(fx, rules, c.user, rel, 'read')
          abs = r.abs
          size = checkRegular(abs).size
        } catch { continue }
        if (size > MAX_IMAGE) bad(target, 'larger than 20 MB')
        if ((bytes += size) > MAX_IMAGES_BYTES) bad(target, 'the images together are larger than 100 MB')
        const name = `img-${n}.${x}`
        fs.copyFileSync(abs, path.join(work, name))
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
    return n
  }

  private template(c: ToolCtx, tpl: string, format: string, work: string): string {
    const r = authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.segs[0] !== 'skills') throw new ToolError('templates must be files under skills/')
    if (ext(r.rel) !== format) throw new ToolError(`the template must be a .${format} file`)
    const st = checkRegular(r.abs)
    if (st.size > 50 * 1024 * 1024) throw new ToolError('template is too large')
    const local = `template.${format}`
    fs.copyFileSync(r.abs, path.join(work, local))
    return local
  }

  private async pdf(work: string, input: string, from: 'json' | 'csv') {
    if (!this.conv.typst) throw new ToolError('typst is not installed on the server; ask the owner to run `brew install typst`')
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
    const r = await runIsolated({ cmd: this.conv.typst, args: ['compile', '--root', work, 'doc.typ', 'out.pdf'], workDir: work, timeoutMs: 120_000 })
    if (r.code !== 0) throw new ToolError(convertError('typst', r.stderr, r.killed, work))
  }

  private async xlsx(text: string, kind: 'markdown' | 'csv' | 'tsv', out: string) {
    const sheets: { name: string; rows: string[][] }[] = []
    if (kind === 'markdown') {
      const tables = markdownTables(text)
      if (!tables.length) throw new ToolError('no table found: give CSV, or Markdown with | pipe | tables |')
      tables.forEach((t, i) => sheets.push({ name: t.title ?? `Sheet${i + 1}`, rows: t.rows }))
    } else sheets.push({ name: 'Sheet1', rows: parseCsv(text, kind === 'tsv' ? '\t' : ',') })
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Team AX'
    wb.created = new Date()
    const used = new Set<string>()
    for (const s of sheets) {
      let name = s.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet'
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 28)} ${i}`
      used.add(name.toLowerCase())
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: s.rows.length > 1 ? 1 : 0 }] })
      s.rows.forEach((row, ri) => ws.addRow(row.map((v) => (ri === 0 ? v : cellValue(v)))))
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
  }

  /** Put the produced file into the team folder (policy checked again) and record it. */
  private async place(c: ToolCtx, segs: string[], produced: string): Promise<MadeFile> {
    const cfg = this.ctx.engineConfig
    const size = fs.statSync(produced).size
    if (c.files.bytesWritten + size > cfg.maxWriteBytesPerTurn) throw new ToolError('write limit for this turn reached')
    const fx = this.files.fx
    const rules = this.files.rules()
    let conflictOf: string | undefined
    let action: 'create' | 'update' = 'create'
    // looked at again now, not before the conversion: someone may have saved a file there in the meantime
    const now = authorize(fx, rules, c.user, segs.join('/'), 'write', { mustExist: false, createDirs: true })
    if (now.exists && now.st!.isDirectory()) throw new ToolError(`'${now.rel}' is a folder`)
    segs = now.segs
    let target = segs
    const rel0 = now.rel
    if (now.exists) {
      const abs = path.join(fx.root, ...segs)
      checkRegular(abs)
      const cur = await hashFile(abs)
      if (c.files.readHashes.get(rel0) === cur) {
        snapshotVersion(this.ctx.db, fx.root, rel0, { userId: c.user.id, turnId: c.turnId }, 'edit', cur)
        action = 'update'
      } else {
        // never overwrite a file the AI has not read in this turn: keep both
        const dir = segs.slice(0, -1)
        let name = conflictCopyName(segs[segs.length - 1]!, c.user.name)
        if (badSegment(name)) name = `copy-${Date.now()}-${segs[segs.length - 1]}`
        name = freeName(path.join(fx.root, ...dir), name)
        target = authorize(fx, rules, c.user, [...dir, name].join('/'), 'write', { mustExist: false }).segs
        conflictOf = rel0
      }
    }
    if (!c.files.filesWritten.has(target.join('/')) && c.files.filesWritten.size >= cfg.maxFilesWrittenPerTurn) throw new ToolError('file count limit for this turn reached')
    const sha = await hashFile(produced)
    // final check right before the rename (rules may have changed during the conversion)
    authorize(fx, this.files.rules(), c.user, target.join('/'), 'write', { mustExist: false, createDirs: true })
    installFile(fx.root, target, produced)
    const rel = target.join('/')
    c.files.bytesWritten += size
    c.files.filesWritten.add(rel)
    c.files.readHashes.set(rel, sha)
    fileEvent(this.ctx.db, { turnId: c.turnId, userId: c.user.id, path: rel, action, size, sha256: sha, detail: { tool: 'make_file', ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
    if (conflictOf) fileEvent(this.ctx.db, { turnId: c.turnId, userId: c.user.id, path: conflictOf, action: 'conflict', size, sha256: sha, detail: { tool: 'make_file', copy: rel } })
    this.files.extractText(rel)
    publishChanges(this.ctx, [{ path: rel, action, by: { id: c.user.id, name: c.user.name }, turnId: c.turnId }])
    return { path: rel, size, sha256: sha, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) }
  }
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
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
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

/** "1,234" / "12.5" / "-3" become numbers; "007" and long digit strings (phone, account numbers) stay text. */
export function cellValue(v: string): string | number {
  const s = v.trim()
  if (/^0\d/.test(s) || /^\+/.test(s) || s.replace(/\D/g, '').length > 15) return v
  if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''))
  return v
}
const displayWidth = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

