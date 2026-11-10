// make_file (design tab 3): Markdown / CSV -> Word, PowerPoint, Excel, PDF in the team folder.
// - docx / pptx: pandoc --sandbox --fail-if-warnings (a missing or remote image is an error, not a silent hole),
//   optional --reference-doc template from skills/
// - pdf: pandoc -t typst, then typst compile --root <work folder> (nothing outside the work folder can be read,
//   remote images are never fetched); the fonts and typst's language follow the document's writing (pdfLanguage: a
//   Japanese document gets Japanese faces first, Chinese Chinese ones, else the team's language). A Linux bundle brings its own (Noto Sans CJK in
//   app/<v>/fonts, given to typst with --font-path and to the converter isolation read-only): a Linux server has no
//   Korean, Japanese or Chinese font, and without one those characters came out as empty boxes. A Mac uses its own.
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
// - hwpx (Hangul): pandoc's tree of the Markdown (or a CSV's table), written by our OWPML writer in the office worker
//   (files/hwpx-write.ts, never in this process) with the built-in or a team template from skills/; anything the
//   writer does not support is refused there, naming it. The file is then read back with hwp.ts, as read and grep
//   read it: when its paragraphs and headings are not the document's, nothing is saved (files/hwpx-check.ts).
// - pdf from an .html `source`: printed by the server's headless browser exactly as a browser prints the page (its CSS,
//   colours and backgrounds, merged cells, `@page` size and margins, page breaks), never rewritten as Markdown
//   (files/html-pdf.ts: no network, no scripts, the page's pictures, stylesheets and fonts read with the person's
//   access). The page and every file it used are the PDF's sources, as for images above.
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import type { z } from 'zod'
import type { MakeFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale, teamTimeZone } from '../admin/settings'
import { ext, officeWorkerText, officeWorkerWrite } from '../files/extract'
import { encodeHwpxRequest, firstDifference, HWPX_TEMPLATE_MAX, HWPX_WRITE_MODE, hwpxExpectedLines, hwpxReadLines } from '../files/hwpx-check'
import type { ToolCtx } from '../files/service'
import { conflictCopyName, fileEvent, readRegular, recordConflictCopy, sha256 } from '../files/store'
import { sourceOf, widening } from '../chat/read-scope'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { writeLimitText } from '../policy/refusal'
import { badSegment } from '../policy/names'
import { bundledFontDir, which } from '../config'
import { publishChanges } from '../team-files/changes'
import { checkRegular, freeName, hashFile, installFile, snapshotVersion } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir, readOutput, runIsolated } from './isolate'
import { consumeSkillApproval, requireSkillApproval } from '../skills/guard'
import { makeFileOutputPath } from './make-file-path'
import { PRODUCT } from '@mycel/shared'
import { typstJobs } from '../system/limits'
import { assertStorageRoomForAI } from '../system/storage'
import { deckMismatch, deckShape, type Deck, type DeckShape } from './pptx-check'
import { readDeckIsolated } from '../safe-ops/deck-check'
import { findPdfBrowser, HTML_PDF_LIMITS, HtmlPdfError, htmlPdfUnavailable, renderHtmlPdf, renderSlot, serverFontDirs } from '../files/html-pdf'
import { safeOpsEnabled } from '../safe-ops/runner'
import { withWorkflow } from '../safe-ops/workflow'
import { publishArtifact } from '../safe-ops/publication'
import { preparePresentation } from '../safe-ops/presentation'
import { snapshot, type SourceSnapshot } from '../safe-ops/source'
import { safeText } from '../safe-ops/strings'

type Input = z.output<typeof MakeFileInput>
/** a PDF printed from HTML: its pages, what the page referred to but did not get, and whether it has scripts (off) */
export interface FromHtml { pages: number; blocked: string[]; blockedCount: number; scripts: boolean }
export interface MadeFile { path: string; size: number; sha256: string; conflictCopyOf?: string; deck?: Deck; formulas?: number; html?: FromHtml }
/** the sources make_file prints as a page (format pdf only) */
export const HTML_SOURCE_EXT = new Set(['html', 'htm'])

/** make_file's description where this server prints HTML (tools/index.ts). Before it, an AI asked to turn a quote's
 * .html into a PDF rewrote it as Markdown tables (losing its navy headers, highlights, merged cells and A4 layout) and
 * told the person to print it from Chrome. */
export const HTML_PDF_HINT =
  'PDF from HTML: give `source` = the .html file and format "pdf": the server prints it exactly as a browser prints it (its CSS, colours and ' +
  'backgrounds, merged cells, the page\'s `@page` size and margins (A4 when none), page breaks such as break-before: page, Korean fonts). ' +
  'Use this for every HTML page the user wants as a PDF: never rewrite HTML as Markdown for a PDF, and never send the user to print it from a browser. ' +
  'Printing loads only the page\'s own pictures, stylesheets and fonts from the team folder by relative path (web addresses are not loaded) and runs ' +
  'no JavaScript, so when you write a page for PDF, put its design in CSS and its pictures in team files (save_url), and set @page { size: A4; margin: 15mm }. '
/** make_file's description where no headless browser is installed */
export const HTML_PDF_OFF_HINT =
  'This server cannot print an HTML page to PDF (no headless browser is installed). If the user asks for one, say so; going through Markdown ' +
  'loses the page\'s design (colours, backgrounds, merged cells, layout), so say that before you offer it. '

/** What the AI is told about a PDF printed from HTML (tools/index.ts). */
export function htmlPdfResultText(h: FromHtml): string {
  const lines = [`The PDF has ${h.pages} page${h.pages === 1 ? '' : 's'}, printed from the HTML as a browser prints it.`]
  if (h.blockedCount) lines.push(`${h.blockedCount} reference${h.blockedCount === 1 ? ' was' : 's were'} not loaded (web addresses, other kinds of files, or files the user cannot read; a picture shows as a grey box): ${h.blocked.slice(0, 3).join(', ')}. Tell the user; to include a web picture, save it into the team folder (save_url) and refer to it by a relative path.`)
  if (h.scripts) lines.push('The page has scripts, which did not run: JavaScript is off when printing, so anything a script draws or fills in is missing. If that matters, write that part as plain HTML and print again.')
  return lines.join('\n')
}

/** The AI's words for a failed HTML print (files/html-pdf.ts HtmlPdfError). Nothing was saved in every case. */
export function htmlPdfErrorText(e: HtmlPdfError): string {
  if (e.code === 'pages') return `${e.message}; nothing was saved. Split the page into shorter HTML files, or ask the user which part to print`
  if (e.code === 'browser') return `the HTML could not be printed to PDF (${e.message}); nothing was saved`
  return `${e.message}; nothing was saved`
}

const MAX_SOURCE = 10 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_IMAGES = 200
const MAX_IMAGES_BYTES = 100 * 1024 * 1024
/** pandoc's JSON tree of a 10 MB Markdown file stays well below this */
const MAX_AST = 200 * 1024 * 1024
/** pandoc's Typst text of a document (the source is at most MAX_SOURCE) */
const MAX_TYPST = 64 * 1024 * 1024

/** A name in the work folder that nothing has taken: a converter that ran there may have left files or links under the
 * names the server writes next, and a write must never go through one of them. */
function freshName(work: string, base: string, x: string): string {
  for (let i = 0; ; i++) {
    const n = `${base}${i ? '-' + i : ''}.${x}`
    try { fs.lstatSync(path.join(work, n)) } catch { return n }
  }
}
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'])
/** The faces of each CJK writing system, a Mac's own first, then the bundled Noto Sans CJK family (one .ttc holds all
 * four), then other systems'. Han characters look different in each (骨, 直, 角 …): the document's own language must
 * come first, or a Japanese PDF gets Korean-style kanji. */
const CJK_FONTS = {
  ko: ['Pretendard', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic'],
  ja: ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans CJK JP', 'Noto Sans JP', 'Yu Gothic'],
  'zh-Hans': ['PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei'],
  'zh-Hant': ['PingFang TC', 'Heiti TC', 'Noto Sans CJK TC', 'Noto Sans TC', 'Microsoft JhengHei'],
} as const
type CjkScript = keyof typeof CJK_FONTS
const LATIN_FONTS = ['Helvetica Neue', 'Arial', 'Libertinus Serif']
/** a PDF's language: the team's languages and the two Chinese scripts */
export type PdfLanguage = Locale | 'zh-Hans' | 'zh-Hant'
/** typst's lang (and region) for each */
const TYPST_LANG: Record<PdfLanguage, string> = { ko: 'lang: "ko"', en: 'lang: "en"', id: 'lang: "id"', ja: 'lang: "ja"', es: 'lang: "es"', 'zh-Hans': 'lang: "zh", region: "cn"', 'zh-Hant': 'lang: "zh", region: "tw"' }

/** The fonts of a PDF in `lang`: its own CJK faces first, the other CJK faces (a Japanese report quoting a Korean name
 * still draws it), then Latin fallbacks. A language without CJK of its own keeps Korean first, as before. */
export function pdfFonts(lang: PdfLanguage): string[] {
  const first: CjkScript = lang === 'ja' || lang === 'zh-Hans' || lang === 'zh-Hant' ? lang : 'ko'
  return [...CJK_FONTS[first], ...(Object.keys(CJK_FONTS) as CjkScript[]).filter((k) => k !== first).flatMap((k) => CJK_FONTS[k]), ...LATIN_FONTS]
}
/** the font list of a Korean (or Latin-script) PDF */
export const PDF_FONTS = pdfFonts('ko')

const SIMPLIFIED = new Set('们这说时会来个为国学对发经过还进实现与关从开问长东车门见电话体书业产动机后头间两样么认义务网络页数据'.split(''))
const TRADITIONAL = new Set('們這說時會來個為國學對發經過還進實現與關從開問長東車門見電話體書業產動機後頭間兩樣麼認義務網絡頁數據'.split(''))

/**
 * The language a PDF is set in, from its text: Hangul makes it Korean, kana Japanese (whichever there is more of),
 * Han characters alone Chinese (traditional when more of its common characters are, else simplified; Japanese when the
 * team's language is). Text without CJK takes the team's language when that is written in Latin letters, else
 * English. Only the first 200,000 characters are looked at.
 */
export function pdfLanguage(text: string, team: Locale): PdfLanguage {
  let hangul = 0, kana = 0, han = 0, simp = 0, trad = 0
  const end = Math.min(text.length, 200_000)
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) kana++
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) {
      han++
      const ch = text[i]!
      if (SIMPLIFIED.has(ch)) simp++
      else if (TRADITIONAL.has(ch)) trad++
    }
  }
  if (kana > hangul || (kana > 0 && kana === hangul && team === 'ja')) return 'ja'
  if (hangul > 0) return 'ko'
  if (han > 0) return team === 'ja' ? 'ja' : trad > simp ? 'zh-Hant' : 'zh-Hans'
  return team === 'en' || team === 'es' || team === 'id' ? team : 'en'
}

/** The first lines of a PDF's typst document: page, the language's fonts and typst language, headings, tables. */
export function typstPreamble(lang: PdfLanguage): string {
  return [
    `#set page(paper: "a4", margin: (x: 2cm, y: 2.2cm), numbering: "1")`,
    `#set text(font: (${pdfFonts(lang).map((f) => JSON.stringify(f)).join(', ')}), size: 10.5pt, ${TYPST_LANG[lang]})`,
    `#set par(justify: false, leading: 0.75em)`,
    `#show heading: set block(above: 1.2em, below: 0.6em)`,
    `#set table(stroke: 0.5pt + luma(180), inset: 6pt)`,
    // pandoc's typst output uses this helper for horizontal rules
    `#let horizontalrule = line(start: (25%,0%), end: (75%,0%))`,
    '',
  ].join('\n')
}

export interface Converters {
  pandoc: string | null
  typst: string | null
  /** a folder of fonts typst also uses (config.ts bundledFontDir); null: the system's fonts only */
  fonts?: string | null
}
export const findConverters = (pandoc: string | null): Converters => ({ pandoc, typst: process.env.MYCEL_TYPST_BIN ?? which('typst'), fonts: bundledFontDir() })

/** typst's command line for one PDF: the bundled fonts first (--font-path), then the system's; threads capped on Linux. */
export function typstArgs(o: { work: string; doc: string; fonts?: string | null; jobs?: number | null }): string[] {
  return ['compile', ...(o.jobs ? ['--jobs', String(o.jobs)] : []), ...(o.fonts ? ['--font-path', o.fonts] : []), '--root', o.work, o.doc, 'out.pdf']
}

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
    // an HTML page is printed, never converted through Markdown (its design would be lost)
    if (a.source !== undefined && HTML_SOURCE_EXT.has(ext(a.source))) return this.fromHtml(c, a)
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
      if (!['md', 'markdown', 'txt', 'csv', 'tsv'].includes(x)) throw new ToolError('source must be a .md, .txt, .csv or .tsv file (or an .html file for format "pdf")')
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
    const outRel = makeFileOutputPath(a.output, a.format)
    const out = authorize(fx, rules, c.user, outRel, 'write', { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)

    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const produced = path.join(work, 'out.' + a.format)
      /** pptx from Markdown: what decides the slides (pptx-check.ts) */
      let shape: DeckShape | null = null
      let formulas: number | undefined
      if (a.format === 'xlsx') formulas = await this.xlsx(text, kind, produced)
      else if (a.format === 'hwpx') await this.hwpx(c, a, text, kind, work, produced, sources)
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
          // pandoc's output is read without following a link, and nothing the server writes after a converter ran
          // goes through a name the converter could have planted (tools/isolate.ts readOutput)
          const got = readOutput(work, 'ast.json', MAX_AST)
          if (!got.ok) throw new ToolError(got.why === 'too_large' ? 'the document is too large to convert' : 'the converter produced no file')
          const ast = JSON.parse(got.bytes.toString('utf8'))
          images = this.copyImages(c, ast, baseDir, work)
          sources.push(...images)
          if (a.format === 'pptx') shape = deckShape(ast)
          input = freshName(work, 'tree', 'json')
          fs.writeFileSync(path.join(work, input), JSON.stringify(ast), { flag: 'wx', mode: 0o600 })
          from = 'json'
        } else {
          input = `in.${kind}`
          fs.writeFileSync(path.join(work, input), kind === 'tsv' ? tsvToCsv(text) : text)
          from = 'csv'
        }
        if (a.format === 'pdf') await this.pdf(work, input, from, text)
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

  /**
   * PDF from an HTML page in the team folder (files/html-pdf.ts): printed by the server's headless browser, its
   * pictures, stylesheets and fonts read with the person's own access. The page and those files are the PDF's sources
   * (the wider-audience card, as for images); then the PDF is placed like every make_file output.
   */
  private async fromHtml(c: ToolCtx, a: Input): Promise<MadeFile> {
    if (a.format !== 'pdf') throw new ToolError(`an .html source can only be printed to PDF: give format "pdf" (for ${a.format}, write the document as Markdown)`)
    if (a.template) throw new ToolError('a PDF printed from HTML takes no template: the page\'s own CSS is its design')
    const fx = this.files.fx
    const outRel = makeFileOutputPath(a.output, 'pdf')
    const out = authorize(fx, this.files.rules(), c.user, outRel, 'write', { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)
    const printed = await printTeamHtml(this.ctx, this.files, c.user, a.source!, { signal: c.signal })
    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const produced = path.join(work, 'out.pdf')
      fs.writeFileSync(produced, printed.pdf, { flag: 'wx', mode: 0o600 })
      await this.checkWidening(c, out.rel, out.segs, printed.sources)
      // the audit line names every team file whose bytes are in the PDF (the page's pictures, stylesheets, fonts)
      const made = await placeProduced(this.ctx, this.files, c, out.segs, produced, 'make_file', undefined, { detail: { from: printed.source, pages: printed.pages, files: printed.sources.slice(1, 51), fileCount: printed.sources.length - 1 } })
      return { ...made, html: { pages: printed.pages, blocked: printed.blocked, blockedCount: printed.blockedCount, scripts: printed.scripts } }
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
        const name = freshName(work, `img-${n}`, x)
        fs.copyFileSync(abs, path.join(work, name), fs.constants.COPYFILE_EXCL)
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
  private checkWidening(c: ToolCtx, target: string, targetSegs: string[], sources: string[], binding?: string) {
    return confirmSources(this.ctx, this.files, c, target, targetSegs, sources, binding)
  }

  private template(c: ToolCtx, tpl: string, format: string, work: string): { local: string; rel: string } {
    const r = authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.segs[0] !== 'skills') throw new ToolError('templates must be files under skills/')
    if (ext(r.rel) !== format) throw new ToolError(`the template must be a .${format} file`)
    const st = checkRegular(r.abs)
    if (st.size > 50 * 1024 * 1024) throw new ToolError('template is too large')
    const local = freshName(work, 'template', format)
    fs.copyFileSync(r.abs, path.join(work, local), fs.constants.COPYFILE_EXCL)
    return { local, rel: r.rel }
  }

  /**
   * .hwpx: pandoc's tree (pandoc --sandbox reads only the input file), then the office worker writes the file
   * (files/hwpx-write.ts: what it cannot hold is refused there, naming it all). The bytes are read back by hwp.ts in the
   * worker, as read and grep read them; the file is put in the work folder only when they read as the document.
   */
  private async hwpx(c: ToolCtx, a: Input, text: string, kind: 'markdown' | 'csv' | 'tsv', work: string, produced: string, sources: string[]) {
    if (!this.conv.pandoc) throw new ToolError(missingConverter('pandoc'))
    const tpl = a.template ? this.hwpxTemplate(c, a.template) : null
    if (tpl) sources.push(tpl.rel)
    const input = kind === 'markdown' ? 'in.md' : 'in.csv'
    fs.writeFileSync(path.join(work, input), kind === 'tsv' ? tsvToCsv(text) : text)
    const j = await runIsolated({ cmd: this.conv.pandoc, args: ['--sandbox', '-f', kind === 'markdown' ? 'markdown' : 'csv', '-t', 'json', '-o', 'ast.json', input], workDir: work, timeoutMs: 120_000 })
    if (j.code !== 0) throw new ToolError(convertError('pandoc', j.stderr, j.killed, work))
    const got = readOutput(work, 'ast.json', MAX_AST)
    if (!got.ok) throw new ToolError(got.why === 'too_large' ? 'the document is too large to convert' : 'the converter produced no file')
    const astJson = got.bytes.toString('utf8')
    let ast: unknown
    try { ast = JSON.parse(astJson) } catch { throw new ToolError('the converter produced an unexpected document tree') }
    const bytes = await officeWorkerWrite(HWPX_WRITE_MODE, encodeHwpxRequest(astJson, tpl?.bytes), c.signal)
    const diff = firstDifference(hwpxExpectedLines(ast), hwpxReadLines(await officeWorkerText('hwpx', bytes, c.signal)))
    if (diff) throw new ToolError(`the .hwpx did not read back as the document (${diff}); nothing was saved`)
    try { fs.writeFileSync(produced, bytes, { flag: 'wx', mode: 0o600 }) } catch { throw new ToolError('the converter produced no file') }
  }

  /** A team's .hwpx template under skills/: its bytes go to the office worker, which checks them (files/hwpx-write.ts). */
  private hwpxTemplate(c: ToolCtx, tpl: string): { bytes: Uint8Array; rel: string } {
    const r = authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.segs[0] !== 'skills') throw new ToolError('templates must be files under skills/')
    if (ext(r.rel) !== 'hwpx') throw new ToolError('the template must be a .hwpx file (a .hwp can be saved as .hwpx in Hangul)')
    if (checkRegular(r.abs).size > HWPX_TEMPLATE_MAX) throw new ToolError(`template is too large (max ${HWPX_TEMPLATE_MAX / 1024 / 1024} MB)`)
    return { bytes: readRegular(r.abs, HWPX_TEMPLATE_MAX).bytes, rel: r.rel }
  }

  /** `text`: the document's source, whose writing decides the language and font order (pdfLanguage) */
  private async pdf(work: string, input: string, from: 'json' | 'csv', text: string) {
    if (!this.conv.typst) throw new ToolError(missingConverter('typst'))
    const t = await runIsolated({ cmd: this.conv.pandoc!, args: ['--sandbox', '--fail-if-warnings', '-f', from, '-t', 'typst', '-o', 'body.typ', input], workDir: work, timeoutMs: 120_000 })
    if (t.code !== 0) throw new ToolError(convertError('pandoc', t.stderr, t.killed, work))
    const pre = typstPreamble(pdfLanguage(text, teamDefaultLocale(this.ctx.db)))
    const body = readOutput(work, 'body.typ', MAX_TYPST)
    if (!body.ok) throw new ToolError(body.why === 'too_large' ? 'the document is too large to convert' : 'the converter produced no file')
    const doc = freshName(work, 'doc', 'typ')
    fs.writeFileSync(path.join(work, doc), pre + body.bytes.toString('utf8'), { flag: 'wx', mode: 0o600 })
    const fonts = this.conv.fonts ?? null
    // Linux bundle's typst: at most 2 threads (system/limits.ts); the bundled fonts readable inside the isolation
    const r = await runIsolated({ cmd: this.conv.typst, args: typstArgs({ work, doc, fonts, jobs: typstJobs() }), workDir: work, readPaths: fonts ? [fonts] : [], timeoutMs: 120_000 })
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
 * A new file carries the bytes of `sources` (make_file's source, images and template; edit_hwp's document saved as a
 * new file): they join the chat's read scope, and when more people can read the target than those files (or what the
 * chat read), the chat turn asks the person first. No chat turn (nobody to ask): refused. Runs before anything is
 * placed.
 */
export async function confirmSources(ctx: AppContext, files: TeamFiles, c: ToolCtx, target: string, targetSegs: string[], sources: string[], binding?: string) {
  for (const p of sources) c.files.readPaths.add(p)
  if (c.confirmWidening) {
    const refusal = await c.confirmWidening(target, sources, binding)
    if (refusal) throw new Denied(refusal)
    return
  }
  const db = ctx.db
  const rules = files.rules()
  const chatId = c.turnId ? (db.query('SELECT chat_id FROM turns WHERE id = ?').get(c.turnId) as { chat_id: string } | null)?.chat_id ?? null : null
  const w = widening(db, chatId, targetSegs, sources.map((p) => sourceOf(db, rules, p)))
  if (w) throw new Denied(`more people can read '${target}' than the files it is made from; nothing was saved. Save it in a folder that only the people who can read those files can see, or ask the user where to put it.`)
}

/** An HTML page of the team folder printed to PDF (files/html-pdf.ts), and every team file whose bytes are in it. */
export interface PrintedHtml extends FromHtml { pdf: Buffer; source: string; sources: string[] }

/**
 * Print the team file `source` (an .html page `user` may read) to PDF with the server's headless browser: one render
 * per person at a time (files/html-pdf.ts renderSlot). The page's pictures, stylesheets and fonts are read through the
 * normal authorize path for `user`, so a reference that leaves their access gets nothing; `embedOnly` (the file
 * preview's action) also leaves out a file that someone who can read the page cannot read, as the preview does
 * (team-files/embed.ts). Throws ToolError with the reason (no browser here, busy, too long, too many pages ...).
 */
export async function printTeamHtml(ctx: AppContext, files: TeamFiles, user: ToolCtx['user'], source: string, o: { signal?: AbortSignal; embedOnly?: (page: string[], file: string[]) => boolean } = {}): Promise<PrintedHtml> {
  const fx = files.fx
  const rules = files.rules()
  const src = authorize(fx, rules, user, source, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`)
  if (!HTML_SOURCE_EXT.has(ext(src.rel))) throw new ToolError('only an .html file can be printed to PDF')
  // a page over the limit is the print's own refusal (the route words it), not the file layer's general "too large"
  const max = HTML_PDF_LIMITS.maxHtmlBytes
  if (src.st!.size > max) { const e = new HtmlPdfError('html_too_large', `the HTML file is larger than ${max / 1024 / 1024} MB`); throw new ToolError(htmlPdfErrorText(e), `html_pdf_${e.code}`) }
  const why = htmlPdfUnavailable()
  const browser = findPdfBrowser()
  if (why || !browser) throw new ToolError(`${why ?? 'no headless browser is installed on this server'}; nothing was saved. Tell the user so; never rewrite the HTML as Markdown instead without saying that its design (colours, backgrounds, merged cells, page layout) would be lost`, 'html_pdf_unavailable')
  const { bytes } = readRegular(src.abs, max)
  ctx.files.quarantine.assertBytes(bytes)
  /** the team path the page asked for -> its actual name (authorize resolves case and Unicode forms) */
  const used = new Map<string, string>()
  /** HtmlPdfError -> ToolError with code html_pdf_<code> (the file preview's route words each one for the person) */
  const toTool = (e: unknown) => (e instanceof HtmlPdfError ? new ToolError(htmlPdfErrorText(e), `html_pdf_${e.code}`) : e)
  let release: () => void
  try { release = await renderSlot(user.id, o.signal) } catch (e) { throw toTool(e) }
  try {
    const r = await renderHtmlPdf({
      browser, html: bytes, page: src.rel, workBase: ctx.config.dataDir, fonts: serverFontDirs(), signal: o.signal,
      asset: (p, max) => {
        try {
          const f = authorize(fx, rules, user, p, 'read')
          if (f.st!.isDirectory() || f.rel === src.rel) return null
          if (o.embedOnly && !o.embedOnly(src.segs, f.segs)) return null
          const b = readRegular(f.abs, max).bytes
          if (ctx.files.quarantine.hasBytes(b)) return null
          used.set(p, f.rel)
          return b
        } catch { return null }
      },
    })
    return { pdf: r.pdf, pages: r.pages, blocked: r.blocked, blockedCount: r.blockedCount, scripts: r.scripts, source: src.rel, sources: [src.rel, ...r.assets.map((p) => used.get(p) ?? p)] }
  } catch (e) {
    throw toTool(e)
  } finally { release() }
}

/**
 * Put a produced file into the team folder (policy checked again) and record it: the AI's new files (make_file, and
 * generated media such as generate_video) and edit_hwp's changed documents. An existing file the AI read in this turn
 * gets a new version (the old bytes in its history); one it has not read, or that changed since, is kept (conflict copy).
 */
/** placeProduced options. `turnBytes: false`: the file does not count against the turn's write budget
 * (maxWriteBytesPerTurn, a guard against an AI writing in a loop): save_url's downloads, which the person sized on a
 * card over 1 GB and the disk check bounds (tools/save-url.ts). `detail`: more for the file event (the source URL). */
export interface PlaceOptions { turnBytes?: boolean; detail?: Record<string, unknown> }

export async function placeProduced(ctx: AppContext, files: TeamFiles, c: ToolCtx, segs: string[], produced: string, tool = 'make_file', guard?: () => void, po: PlaceOptions = {}): Promise<MadeFile> {
  const cfg = ctx.engineConfig
  // lstat, never the size of what a link left by a converter points at (hashFile below refuses such a link anyway)
  const size = checkRegular(produced).size
  const counted = po.turnBytes !== false
  if (counted && c.files.bytesWritten + size > cfg.maxWriteBytesPerTurn) throw new ToolError(writeLimitText('bytes', cfg.maxWriteBytesPerTurn, segs.join('/')))
  assertStorageRoomForAI(size) // the team disk near full (system/storage.ts; Linux / a plan)
  const fx = files.fx
  // Finish asynchronous work BEFORE the fresh principal/content/conflict check. The final
  // check-to-install section is synchronous, so server saves and policy mutations cannot interleave.
  const sha = await hashFile(produced)
  c.signal?.throwIfAborted()
  c.user=ctx.files.principal(c.user.id)
  guard?.()
  c.beforePlace?.()
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
  if (!c.files.filesWritten.has(target.join('/')) && c.files.filesWritten.size >= cfg.maxFilesWrittenPerTurn) throw new ToolError(writeLimitText('files', cfg.maxFilesWrittenPerTurn, target.join('/')))
  // final check right before the rename (rules may have changed during the conversion)
  authorize(fx, files.rules(), c.user, target.join('/'), 'write', { mustExist: false, createDirs: true })
  installFile(fx.root, target, produced)
  consumeSkillApproval(c, rel0)
  const rel = target.join('/')
  if (counted) c.files.bytesWritten += size
  c.files.filesWritten.add(rel)
  c.files.readHashes.set(rel, sha)
  // a conflict copy is told to both people and listed in the original's history (before the copy's own event)
  if (conflictOf) recordConflictCopy(ctx.db, ctx.files.events, { original: conflictOf, copy: rel, userId: c.user.id, turnId: c.turnId, size, sha256: sha, tool })
  fileEvent(ctx.db, { turnId: c.turnId, userId: c.user.id, path: rel, action, size, sha256: sha, detail: { tool, ...po.detail, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
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

