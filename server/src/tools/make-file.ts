// make_file (design tab 3): Markdown / CSV -> Word, PowerPoint, Excel, PDF in the team folder.
// - docx / pptx: pandoc --sandbox --fail-if-warnings (a missing or remote image is an error, not a silent hole),
//   optional --reference-doc template: any .docx / .pptx the person can read (docs/decisions/20261118-any-file-template.md)
// - pdf: pandoc -t typst, then typst compile --root <work folder> (nothing outside the work folder can be read,
//   remote images are never fetched); the fonts and typst's language follow the document's writing (pdfLanguage: a
//   Japanese document gets Japanese faces first, Chinese Chinese ones, else the team's language). A Linux bundle brings its own (Noto Sans CJK in
//   app/<v>/fonts, given to typst with --font-path and to the converter isolation read-only): a Linux server has no
//   Korean, Japanese or Chinese font, and without one those characters came out as empty boxes. A Mac uses its own.
// - xlsx: exceljs (CSV, or every Markdown pipe table becomes a sheet); numbers become numbers, header row bold,
//   filter + frozen header. A data cell that starts with "=" becomes a formula (R2-GEN-02); "'=" keeps it as text.
//   A formula that can reach outside the workbook (external workbook refs, DDE, WEBSERVICE, INDIRECT, ...)
//   is refused and nothing is saved. HYPERLINK is allowed to a web page, a mail address or a place in the workbook,
//   written out in the formula (hyperlinkProblem; docs/decisions/20261118-xlsx-hyperlink.md). Simple formulas also store their result (formula-values.ts); Excel / LibreOffice calculate every one on open.
//   `charts`: native Excel charts over a range of a sheet, added to the zip after exceljs wrote it (xlsx-chart.ts).
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
//   (files/hwpx-write.ts, never in this process) with the built-in or a template the person can read; anything the
//   writer does not support is refused there, naming it. The file is then read back with hwp.ts, as read and grep
//   read it: when its paragraphs and headings are not the document's, nothing is saved (files/hwpx-check.ts).
// - pdf from an .html `source`: printed by the server's headless browser exactly as a browser prints the page (its CSS,
//   colours and backgrounds, merged cells, `@page` size and margins, page breaks), never rewritten as Markdown
//   (files/html-pdf.ts: no network, no scripts, the page's pictures, stylesheets and fonts read with the person's
//   access). The page and every file it used are the PDF's sources, as for images above.
// - pdf from a .pptx `source`: the deck drawn by the server with a page per shown slide (files/pptx-html.ts, in the office
//   worker), then printed like an HTML page; nothing else here converts a deck (no LibreOffice). Its pictures come
//   from the deck itself, never from the team folder; the deck is the PDF's only source.
import { movedFact } from '../files/moved'
import { assertSafeTeamPath, readVouchers, replacedAsRead } from '../files/office-exit'
import { addFormulaResults } from './formula-values'
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { addCharts, placeCharts, type ChartSheet, type ChartSpec } from './xlsx-chart'
import { chartBlocks, insertDocxCharts, insertPptxCharts, type DocChart } from './office-chart'
import { finishDocx, markTextColors, type TextMark } from './docx-format'
import { stripUnsafeLinks } from './office-links'
import { applySheetOptions, type SheetOptions, type WrittenSheet } from './xlsx-format'
import { svgToPng, SVG_MAX, SVG_RSS_MIB } from './svg-png'
import type { z } from 'zod'
import type { MakeFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale, teamTimeZone } from '../admin/settings'
import { ext, officeWorkerText, officeWorkerWrite } from '../files/extract'
import { DOCX_TEMPLATE_CHECK_MODE, PPTX_TEMPLATE_CHECK_MODE } from '../files/office-template'
import { DOCX_LINK_CHECK_MODE, PPTX_LINK_CHECK_MODE, XLSX_LINK_CHECK_MODE } from '../files/office-links-check'
import { deckPdf, type DrawnDeck } from '../files/deck-pdf'
import type { SlidesHtml } from '../files/pptx-html'
import { encodeHwpxRequest, firstDifference, HWPX_MARKDOWN, hwpxMarkdown, HWPX_TEMPLATE_MAX, HWPX_WRITE_MODE, hwpxExpectedLines, hwpxReadLines } from '../files/hwpx-check'
import { readForMakeFile, readThisAnswer, type ToolCtx } from '../files/service'
import { conflictCopyName, fileEvent, readRegular, recordConflictCopy, saveVersion, sha256 } from '../files/store'
import { sourceOf, widening } from '../chat/read-scope'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { writeLimitText } from '../policy/refusal'
import { badSegment } from '../policy/names'
import { bundledFontDir, which } from '../config'
import { publishChanges } from '../team-files/changes'
import { checkRegular, commitVersion, dropVersion, freeName, hashFile, installRenamed, onTeamVolume, sameFile, stageVersion, undoVersion, type KeptCopy } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir, readOutput, runIsolated } from './isolate'
import { consumeSkillApproval, requireSkillApproval } from '../skills/guard'
import { makeFileOutputPath } from './make-file-path'
import { PRODUCT } from '@mycel/shared'
import { typstJobs } from '../system/limits'
import { assertStorageRoomForAI } from '../system/storage'
import { deckMismatch, deckShape, type Deck, type DeckShape } from './pptx-check'
import { pictureBesideText } from './pptx-picture'
import { readDeckIsolated } from '../safe-ops/deck-check'
import { findPdfBrowser, HTML_PDF_LIMITS, HtmlPdfError, htmlPdfUnavailable, pdfPageCount, renderHtmlPdf, renderSlot, serverFontDirs } from '../files/html-pdf'
import { safeOpsEnabled } from '../safe-ops/runner'
import { withWorkflow } from '../safe-ops/workflow'
import { publishArtifact } from '../safe-ops/publication'
import { preparePresentation } from '../safe-ops/presentation'
import { snapshot, type SourceSnapshot } from '../safe-ops/source'
import { safeText } from '../safe-ops/strings'
import { turnWriteLimits } from '../files/turn-write-limits'
import { attachProduced, authorizeOutput, isChatTarget, placeRef, readPlaceFile, type ChatMade, type PlaceBase, type PlaceFile } from '../files/place-output'
import { isReservedPlace, parsePlace } from '@mycel/shared/places'
import { PLACE_WORDS } from '../files/places'

type Input = z.output<typeof MakeFileInput>
/** a PDF printed from HTML: its pages, what the page referred to but did not get, and whether it has scripts (off) */
export interface FromHtml { pages: number; blocked: string[]; blockedCount: number; scripts: boolean }
/** A Word file or PDF made from Markdown, as the result tells the AI (scenario QA 11-22, TC-7385: a "pie chart" PDF held
 * only lines of ■ characters and the AI reported a chart): its pages (a PDF), its pictures, and whether it has bars drawn
 * with block characters but no picture. */
export interface FromMarkdown { pages?: number; pictures: number; textBars: boolean }
export interface MadeFile { path: string; size: number; sha256: string; conflictCopyOf?: string; chatFile?: ChatMade; deck?: Deck; formulas?: number; stored?: number; charts?: number; html?: FromHtml; conditional?: number; svgPictures?: number; csvSheet?: string; linksRemoved?: string[]; doc?: FromMarkdown }
/** the sources make_file prints as a page (format pdf only) */
export const HTML_SOURCE_EXT = new Set(['html', 'htm'])

/** make_file's words for a deck to PDF (part of HTML_PDF_HINT: only where a headless browser prints). Before it, an AI
 * asked for "that PPT as a PDF" rewrote the slides as a one-page Markdown document (AI flow check FL-15). */
export const PPTX_PDF_HINT =
  'PDF from PowerPoint: give `source` = the .pptx and format "pdf": the server draws every shown slide on its own page at the deck\'s slide size ' +
  '(text, pictures, tables, colours and shapes in their places). Use this whenever the user wants a deck as a PDF: never rewrite the slides as ' +
  'Markdown or HTML for it. The result says what could not be drawn (charts, diagrams); tell the user that. '

/** make_file's words for pictures in a .docx (tools/index.ts). Before it, an AI asked for a Word contract with
 * the company seal beside its signature mark said a picture cannot go into a Word file and made a PDF (scenario catalog EDIT-06). */
export const OFFICE_PICTURE_HINT =
  'Pictures in Word: a Markdown image ![](shared/stamps/seal.png){width=3cm} becomes a real picture in the .docx at the width given (cm, in, px or %), ' +
  'where it stands: on the same line as the text (after the signature mark for a seal, such as "(\uC778)"); leave the alt text empty, or a picture on a ' +
  'line of its own gets that text as a caption. To add a picture to an existing Word file, read it and make a new .docx with its text and the picture ' +
  '(a new name; the original stays); only the text, headings, lists and simple tables carry over, not its layout, fonts, headers or footers: say so in one ' +
  'sentence. Never say a picture cannot go into a Word file. (PowerPoint fits a picture to the slide and takes no width; Hangul .hwpx takes no pictures.) '

/** make_file's words for charts in Word and PowerPoint (office-chart.ts; live QA 2026-11-25: a Korean request for a Word
 * report with a chart got a PNG nobody can edit, because these words offered only SVG pictures). */
export const CHART_BLOCK_HINT =
  'Charts in Word and PowerPoint: every chart (bar, column, line, pie) is a native chart with its data sheet, so the person can change its numbers ' +
  '(right-click > Edit Data), whatever language they ask in and even when they do not say "editable": write it as a fenced block ```chart with one ' +
  'JSON object {"type":"column","title":"Sales by quarter","categories":["Q1","Q2","Q3"],"series":[{"name":"2026","values":[120,135,150]}]} ' +
  '(type column = vertical bars, bar = horizontal bars, line or pie with one series; plain numbers, null for a gap) on its own lines where the chart goes; ' +
  'in PowerPoint put it alone under its slide\'s ## heading. Draw a chart as a picture only when the person asks for a picture or the chart has no ' +
  'such form, and then say in your answer that it is a picture whose numbers cannot be edited. '

/** make_file's words for formatting in Word and Excel and for chart pictures (tools/index.ts; second limits audit
 * N3/N4: the AI said it could not colour text, add a header, footer or conditional formatting, or make a PNG). */
export const RICH_OFFICE_HINT =
  'Word formatting: colour or highlight text with a span [overdue]{color=red} or [risk]{highlight=yellow} (both: [x]{color=darkred highlight=yellow}), ' +
  'a whole paragraph with ::: {color="#C00000"} ... ::: (names: red, darkred, orange, yellow, green, blue, purple, gray, ... or "#RRGGBB"); ' +
  'docx `page`: { header: "Acme Ltd." or { left, center, right }, footer, page_numbers: true, orientation: "landscape", size: "a4", margins_cm: 2 }, ' +
  'where {page} and {pages} in a header or footer are the page number and count. ' +
  'Excel formatting: xlsx `sheets`: [{ sheet, number_formats: [{ range: "C2:C50", format: "#,##0" }], column_widths: { "A": 30 }, ' +
  'freeze: { rows: 1, columns: 1 }, filter: false, conditional: [{ range: "D2:D50", when: "less_than", value: 0, fill: "red", font_color: "white" }] }]; ' +
  'conditional `when`: greater_than, less_than, greater_or_equal, less_or_equal, equal, not_equal, between (value, value2), contains (text), duplicates, ' +
  'top / bottom (value = how many), above_average, below_average, formula (e.g. "=$E2<0", true for a cell to format), color_scale, data_bar. ' +
  CHART_BLOCK_HINT +
  'Pictures: format "png" saves an SVG (in `content`, or an .svg `source`) as a PNG picture: draw a Gantt chart, diagram, or a chart the user ' +
  'wants as a picture, as SVG with its numbers and labels and save it as PNG, never just as SVG when the user wants a picture. An .svg picture in ' +
  'a Word or PowerPoint document (![](charts/flow.svg){width=15cm}) goes in as a PNG: write the SVG file first, then refer to it. ' +
  'Never say text colours, headers, footers, page numbers, conditional formatting, charts or chart pictures cannot be made. '

/** make_file's description where this server prints HTML (tools/index.ts). Before it, an AI asked to turn a quote's
 * .html into a PDF rewrote it as Markdown tables (losing its navy headers, highlights, merged cells and A4 layout) and
 * told the person to print it from Chrome. */
export const HTML_PDF_HINT =
  'PDF from HTML: give `source` = the .html file and format "pdf": the server prints it exactly as a browser prints it (its CSS, colours and ' +
  'backgrounds, merged cells, the page\'s `@page` size and margins (A4 when none), page breaks such as break-before: page, Korean fonts). ' +
  'Use this for every HTML page the user wants as a PDF: never rewrite HTML as Markdown for a PDF, and never send the user to print it from a browser. ' +
  'Printing loads only the page\'s own pictures, stylesheets and fonts from the team folder by relative path (web addresses are not loaded) and runs ' +
  'no JavaScript, so when you write a page for PDF, put its design in CSS and its pictures in team files (save_url), and set @page { size: A4; margin: 15mm }. ' +
  PPTX_PDF_HINT
/** make_file's description where no headless browser is installed */
export const HTML_PDF_OFF_HINT =
  'This server cannot print an HTML page to PDF (no headless browser is installed). If the user asks for one, say so; going through Markdown ' +
  'loses the page\'s design (colours, backgrounds, merged cells, layout), so say that before you offer it. ' +
  'For the same reason it cannot save a PowerPoint deck as a PDF: say so plainly, and that PowerPoint or Keynote can (File > Export > PDF); never rewrite the slides as a document instead. '

/** a PDF of a PowerPoint deck: what the server drew and what it left out (files/pptx-html.ts) */
export interface FromDeck { slides: number; hidden: number; notDrawn: SlidesHtml['notDrawn'] }
/** `deck`: the page was drawn from a PowerPoint deck by the server (fromDeck); declared here, merged into FromHtml above */
export interface FromHtml { deck?: FromDeck }

/** What the AI is told about a PDF of a deck (tools/index.ts). */
export function deckPdfResultText(d: FromDeck, pages: number): string {
  const lines = [pages === d.slides
    ? `The PDF has ${pages} page${pages === 1 ? '' : 's'}, one per slide (${d.slides} slide${d.slides === 1 ? '' : 's'} shown), drawn by the server from the deck: text, pictures, tables, colours and shapes in their places, in the fonts this server has.`
    : `The PDF has ${pages} pages for ${d.slides} shown slides (they should match; some slide did not fit its page). Tell the user and ask them to check the PDF.`]
  if (d.hidden) lines.push(`${d.hidden} hidden slide${d.hidden === 1 ? ' was' : 's were'} left out, as PowerPoint's own PDF export does; say so.`)
  const n = d.notDrawn
  const missing = [n.charts && `${n.charts} chart${n.charts === 1 ? '' : 's'}`, n.diagrams && `${n.diagrams} SmartArt diagram${n.diagrams === 1 ? '' : 's'}`, n.objects && `${n.objects} other embedded object${n.objects === 1 ? '' : 's'}`, n.pictures && `${n.pictures} picture${n.pictures === 1 ? '' : 's'} in a format the PDF cannot show`].filter(Boolean)
  if (missing.length) lines.push(`Not drawn (a light grey box in its place): ${missing.join(', ')}. Tell the user, and that PowerPoint's own "Export to PDF" keeps them.`)
  lines.push('Effects such as shadows, gradients and animations are not drawn; the layout can differ slightly from PowerPoint.')
  return lines.join('\n')
}

/** What the AI is told about a PDF printed from HTML (tools/index.ts). */
export function htmlPdfResultText(h: FromHtml): string {
  if (h.deck) return deckPdfResultText(h.deck, h.pages)
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
/** a deck saved as a PDF (the office worker's own input limit is larger) */
const MAX_DECK = 100 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_IMAGES = 200
const MAX_IMAGES_BYTES = 100 * 1024 * 1024
/** pandoc's JSON tree of a 10 MB Markdown file stays well below this */
const MAX_AST = 200 * 1024 * 1024
/** typst making a PDF: its memory, as an SVG picture's (a picture in the document is drawn by the same typst) plus room
 * for long documents */
const TYPST_PDF_RSS_MIB = 2 * SVG_RSS_MIB
/** SVG pictures drawn for one Word or PowerPoint file (each has its own time and memory limit, svg-png.ts) */
const SVG_MAX_PER_DOCUMENT = 20
/** a .docx pandoc wrote (its pictures are at most MAX_IMAGES_BYTES) */
const MAX_DOCX = 256 * 1024 * 1024
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
const TYPST_LANG: Record<PdfLanguage, string> = { ko: 'lang: "ko"', en: 'lang: "en"', id: 'lang: "id"', ja: 'lang: "ja"', es: 'lang: "es"', zh: 'lang: "zh", region: "cn"', 'zh-Hans': 'lang: "zh", region: "cn"', 'zh-Hant': 'lang: "zh", region: "tw"' }

/** The fonts of a PDF in `lang`: its own CJK faces first, the other CJK faces (a Japanese report quoting a Korean name
 * still draws it), then Latin fallbacks. A language without CJK of its own keeps Korean first, as before. */
export function pdfFonts(lang: PdfLanguage): string[] {
  const first: CjkScript = lang === 'zh' ? 'zh-Hans' : lang === 'ja' || lang === 'zh-Hans' || lang === 'zh-Hant' ? lang : 'ko'
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
    // a source in this chat's work folder or its files (chat:work/…, chat:files/…): read through its place, and every
    // picture, stylesheet or font it refers to comes from that same place, never from the team folder
    if (a.source !== undefined && isReservedPlace(a.source)) return this.fromPlace(c, a)
    // an HTML page is printed, never converted through Markdown (its design would be lost)
    if (a.source !== undefined && HTML_SOURCE_EXT.has(ext(a.source))) return this.fromHtml(c, a)
    // a deck is drawn slide by slide, never converted through Markdown
    if (a.source !== undefined && ext(a.source) === 'pptx') return this.fromDeck(c, a)
    if(a.format==='pptx' && safeOpsEnabled()) return withWorkflow(this.ctx.files,c,() => this.safePresentation(c,a))
    if(a.expected_layouts) throw new ToolError(safeText(this.ctx.db,c.user.id,'unavailable'))
    // a picture drawn as SVG saved as a PNG (svg-png.ts)
    if (a.format === 'png') return this.png(c, a)
    return this.document(c, a)
  }

  /** make_file with a `source` in a chat place: read into a server-only copy first, then the same paths as a team source */
  private async fromPlace(c: ToolCtx, a: Input): Promise<MadeFile> {
    const x = ext(a.source!)
    if (a.format === 'pptx' && safeOpsEnabled()) throw new ToolError('with safe operations on, a deck is made from a team file; copy the source into a team folder first', 'safe_ops_source')
    const pre = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const max = HTML_SOURCE_EXT.has(x) ? HTML_PDF_LIMITS.maxHtmlBytes : x === 'pptx' ? MAX_DECK : x === 'svg' ? SVG_MAX : MAX_SOURCE
      const placed = await readPlaceFile(this.ctx, c, a.source!, max, pre)
      if (HTML_SOURCE_EXT.has(x)) return await this.fromHtml(c, a, placed)
      if (x === 'pptx') return await this.fromDeck(c, a, placed)
      if (a.format === 'png') return await this.png(c, a, placed)
      return await this.document(c, a, placed)
    } finally { fs.rmSync(pre, { recursive: true, force: true }) }
  }

  /** Markdown, CSV or text into docx, pptx, xlsx, pdf or hwpx; `placed`: the source read out of a chat place */
  private async document(c: ToolCtx, a: Input, placed?: PlaceFile): Promise<MadeFile> {
    const fx = this.files.fx
    const rules = this.files.rules()
    // ---- input
    let text: string
    let kind: 'markdown' | 'csv' | 'tsv'
    /** where the document's pictures resolve: its own place (a team folder, the work folder, the chat's files) */
    let base: PlaceBase = { kind: 'team', dir: [] }
    /** xlsx from a CSV source with `content` too: the CSV's sheet (named after the file) comes first, then the Markdown
     * tables of `content` as more sheets (a summary with formulas over the data; QA TC-4914: the AI retyped 999 of
     * 50,000 rows because a CSV source could not get a second sheet) */
    let first: { name: string } | undefined
    /** team-folder files whose bytes go into the output */
    const sources: string[] = []
    if (a.source !== undefined && a.content !== undefined) {
      const x = ext(a.source)
      if (a.format !== 'xlsx' || (x !== 'csv' && x !== 'tsv')) throw new ToolError('give exactly one of source or content (only an xlsx from a .csv/.tsv source may add sheets in content)')
      if (Buffer.byteLength(a.content) > MAX_SOURCE) throw new ToolError('content is too large (max 10 MB)')
      if (!hasPipeRow(a.content)) throw new ToolError('with a CSV source, content must be Markdown | pipe | tables (the sheets after the CSV\'s); nothing was saved')
    }
    if (a.source !== undefined) {
      let rel: string, bytes: Buffer
      if (placed) {
        rel = placed.name
        bytes = readRegular(placed.local, MAX_SOURCE).bytes
        base = placed.base
        sources.push(placed.place)
      } else {
        const r = authorize(fx, rules, c.user, a.source, 'read')
        if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`)
        rel = r.rel
        bytes = readRegular(r.abs, MAX_SOURCE, r.st).bytes
        base = { kind: 'team', dir: r.segs.slice(0, -1) }
        sources.push(r.rel)
      }
      const x = ext(rel)
      if (!['md', 'markdown', 'txt', 'csv', 'tsv'].includes(x)) throw new ToolError('source must be a .md, .txt, .csv or .tsv file (or an .html or .pptx file for format "pdf", an .svg file for format "png")')
      // one cap for the CSV and the sheets added to it
      if (a.content !== undefined && bytes.length + Buffer.byteLength(a.content) > MAX_SOURCE) throw new ToolError('the CSV and content are too large together (max 10 MB); nothing was saved')
      text = bytes.toString('utf8')
      kind = x === 'csv' ? 'csv' : x === 'tsv' ? 'tsv' : 'markdown'
      if (a.content !== undefined) first = { name: path.basename(rel).replace(/\.[^.]+$/, '') }
    } else {
      text = a.content!
      if (Buffer.byteLength(text) > MAX_SOURCE) throw new ToolError('content is too large (max 10 MB)')
      kind = a.format === 'xlsx' && !hasPipeRow(text) ? (text.includes('\t') && !text.includes(',') ? 'tsv' : 'csv') : 'markdown'
    }
    // ---- output path (extension follows the format); chat:files/<name> attaches it to this answer
    const outRel = makeFileOutputPath(a.output, a.format)
    const out = authorizeOutput(fx, rules, c, outRel, { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)
    // before any work: a file read earlier that changed since, or that this session does not hold, asks for a new read
    if (out.exists) readForMakeFile(c.files, out.rel)

    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      let produced = path.join(work, 'out.' + a.format)
      /** pptx from Markdown: what decides the slides (pptx-check.ts) */
      let shape: DeckShape | null = null
      let formulas: number | undefined
      let stored = 0
      let charts = 0
      let conditional = 0
      /** docx: the text colours the document uses (docx-format.ts) */
      let marks = new Map<string, TextMark>()
      let svgPictures = 0
      /** pdf and docx from Markdown: what is in the file (FromMarkdown) */
      let doc: FromMarkdown | undefined
      /** the CSV sheet's name when it is not the file's name (cut at 31 characters, or characters Excel refuses) */
      let csvSheet: string | undefined
      /** link targets that became plain text (office-links.ts) */
      let linksRemoved: string[] = []
      /** docx and pptx: the ```chart blocks, by the marker paragraph pandoc writes for each (office-chart.ts) */
      let docCharts = new Map<string, DocChart>()
      if (a.format === 'xlsx') { const x = await this.xlsx(text, kind, produced, a.charts ?? [], a.sheets ?? [], first ? { name: first.name, more: a.content! } : undefined); formulas = x.formulas; stored = x.stored; charts = x.charts; conditional = x.conditional; csvSheet = x.csvSheet }
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
          // raw markup for the writer (`...`{=openxml}) would go into the file as it is: refused (TC-4941)
          checkRawMarkup(ast)
          // a link to anything but a web page, a mail address or a place in the document becomes its text (TC-4949)
          linksRemoved = stripUnsafeLinks(ast)
          images = await this.copyImages(c, ast, base, work)
          sources.push(...images)
          // ```chart blocks: native charts with their data sheet in Word and PowerPoint, put in after pandoc
          docCharts = chartBlocks(ast, a.format === 'pptx' ? 'pptx' : a.format === 'pdf' ? 'pdf' : 'docx')
          if (docCharts.size && a.format === 'pdf') throw new ToolError('a ```chart block makes a native chart in a Word (docx) or PowerPoint (pptx) file; a PDF cannot hold one: for a PDF, draw the chart as SVG and put it in as a picture (![](charts/sales.svg)); nothing was saved')
          if (a.format === 'pdf' || a.format === 'docx') doc = { pictures: imageCount(ast), textBars: textBars(text) }
          // Word and PowerPoint: an SVG picture (a chart the AI drew) goes in as a PNG, which every reader shows
          if (a.format === 'docx' || a.format === 'pptx') svgPictures = await this.svgPictures(c, ast, work, text)
          if (a.format === 'docx') marks = markTextColors(ast)
          if (a.format === 'pptx') {
            shape = deckShape(ast)
            // a picture next to text keeps the slide's title and bullets, with no second caption (TC-4445)
            pictureBesideText(ast, shape.level)
          }
          input = freshName(work, 'tree', 'json')
          fs.writeFileSync(path.join(work, input), JSON.stringify(ast), { flag: 'wx', mode: 0o600 })
          from = 'json'
        } else {
          input = `in.${kind}`
          fs.writeFileSync(path.join(work, input), kind === 'tsv' ? tsvToCsv(text) : text)
          from = 'csv'
        }
        if (a.format === 'pdf') {
          await this.pdf(work, input, from, text)
          if (doc) { try { doc.pages = pdfPageCount(readRegular(produced, 64 * 1024 ** 2).bytes) } catch { /* the count is a hint: the file is checked below */ } }
        }
        else {
          // without images pandoc reads only the files on its command line (--sandbox); with images it must read
          // the copies, which are the only image paths left in the tree (and the OS sandbox, when there is one,
          // keeps it inside the work folder anyway)
          const args = [...(images.length === 0 ? ['--sandbox'] : []), '--fail-if-warnings', '--resource-path=.', '-f', from, '-t', a.format, '-o', path.basename(produced), input]
          // pptx: an explicit slide level, never pandoc's guess from the document shape (B-W24-1: one slide)
          if (shape) args.push(`--slide-level=${shape.level}`)
          if (a.template) {
            const tpl = await this.template(c, a.template, a.format, work)
            sources.push(tpl.rel)
            args.push('--reference-doc', tpl.local)
          }
          // a memory cap: a small template (any readable file now) can expand to hundreds of MB in pandoc (QA TC-4948)
          const r = await runIsolated({ cmd: this.conv.pandoc, args, workDir: work, timeoutMs: 120_000, maxRssMiB: PANDOC_RSS_MIB })
          if (r.code !== 0) throw new ToolError(r.killed === 'memory' ? `the conversion needed more than ${PANDOC_RSS_MIB} MB of memory${a.template ? ' (the template is too large or too complex; use another one)' : ''}; nothing was saved` : convertError('pandoc', r.stderr, r.killed, work))
          // docx: text colours, page, header and footer (docx-format.ts); docx and pptx: no link or reference out of
          // the file but to the web and mail, whoever wrote it (a template too; office-links-check.ts, TC-4949), in the
          // office worker with a real XML parser. Written under a name pandoc could not plant.
          if (a.format === 'docx' || a.format === 'pptx') {
            const got = readOutput(work, path.basename(produced), MAX_DOCX)
            if (!got.ok) throw new ToolError(got.why === 'too_large' ? 'the document is too large to convert' : got.why === 'not_regular' ? 'the converter left a link or a special file instead of the document (symbolic links are not followed); nothing was saved' : 'the converter produced no file')
            let bytes: Uint8Array = new Uint8Array(got.bytes)
            if (a.format === 'docx' && (marks.size || a.page)) bytes = finishDocx(bytes, marks, a.page)
            if (docCharts.size) { bytes = a.format === 'docx' ? insertDocxCharts(bytes, docCharts) : insertPptxCharts(bytes, docCharts); charts = docCharts.size }
            const checked = await officeWorkerWrite(a.format === 'docx' ? DOCX_LINK_CHECK_MODE : PPTX_LINK_CHECK_MODE, bytes, c.signal)
            const finished = path.join(work, freshName(work, 'finished', a.format))
            fs.writeFileSync(finished, checked, { flag: 'wx', mode: 0o600 })
            produced = finished
          }
        }
      }
      if (!fs.existsSync(produced)) throw new ToolError('the converter produced no file')
      // xlsx: exceljs writes no link from the cells, and HYPERLINK formulas are refused; checked all the same (TC-4949)
      if (a.format === 'xlsx') await officeWorkerWrite(XLSX_LINK_CHECK_MODE, new Uint8Array(readRegular(produced, MAX_DOCX).bytes), c.signal)
      // the slides that were really made, checked before the person is asked anything or a file is placed
      let deck: Deck | undefined
      if (a.format === 'pptx') {
        deck = await readDeckIsolated(readRegular(produced,32*1024**2).bytes,c.signal)
        const bad = deckMismatch(deck, shape ?? { level: 1, metaTitle: false, sections: 0, textUnderSection: 0, rules: 0 }, { slides: a.expected_slides, notes: a.expected_notes })
        if (bad) throw new ToolError(bad)
      }
      // only now are all the files known whose bytes are in the output (images come out of pandoc's tree)
      this.movedFirst(c, out)
      await this.checkWidening(c, out.rel, out.segs, sources)
      const made = await this.place(c, out.segs, produced, sources)
      const extra = { ...(docCharts.size ? { charts } : {}), ...(conditional ? { conditional } : {}), ...(svgPictures ? { svgPictures } : {}), ...(linksRemoved.length ? { linksRemoved } : {}), ...(doc ? { doc } : {}) }
      return deck ? { ...made, deck, ...extra } : formulas !== undefined ? { ...made, formulas, stored, ...(charts ? { charts } : {}), ...(csvSheet ? { csvSheet } : {}), ...extra } : { ...made, ...extra }
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  /**
   * PDF from an HTML page in the team folder (files/html-pdf.ts): printed by the server's headless browser, its
   * pictures, stylesheets and fonts read with the person's own access. The page and those files are the PDF's sources
   * (the wider-audience card, as for images); then the PDF is placed like every make_file output.
   */
  private async fromHtml(c: ToolCtx, a: Input, placed?: PlaceFile): Promise<MadeFile> {
    if (a.format !== 'pdf') throw new ToolError(`an .html source can only be printed to PDF: give format "pdf" (for ${a.format}, write the document as Markdown)`)
    if (a.template) throw new ToolError('a PDF printed from HTML takes no template: the page\'s own CSS is its design')
    const fx = this.files.fx
    const outRel = makeFileOutputPath(a.output, 'pdf')
    const out = authorizeOutput(fx, this.files.rules(), c, outRel, { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)
    // before any work: a file read earlier that changed since, or that this session does not hold, asks for a new read
    if (out.exists) readForMakeFile(c.files, out.rel)
    const printed = placed ? await printPlaceHtml(this.ctx, c, placed) : await printTeamHtml(this.ctx, this.files, c.user, a.source!, { signal: c.signal })
    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const produced = path.join(work, 'out.pdf')
      fs.writeFileSync(produced, printed.pdf, { flag: 'wx', mode: 0o600 })
      this.movedFirst(c, out)
      await this.checkWidening(c, out.rel, out.segs, printed.sources)
      // the audit line names every team file whose bytes are in the PDF (the page's pictures, stylesheets, fonts)
      const made = await placeProduced(this.ctx, this.files, c, out.segs, produced, 'make_file', undefined, { movedCheck: true, detail: { from: printed.source, pages: printed.pages, files: printed.sources.slice(1, 51), fileCount: printed.sources.length - 1 } })
      return { ...made, html: { pages: printed.pages, blocked: printed.blocked, blockedCount: printed.blockedCount, scripts: printed.scripts } }
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  /**
   * PDF of a PowerPoint deck in the team folder: the office worker draws it as a page per shown slide
   * (files/pptx-html.ts), the server's headless browser prints that page; the pictures are the deck's own, handed over
   * by name (never a team file). The deck is the PDF's only source (the wider-audience card); then the PDF is placed
   * like every make_file output.
   */
  private async fromDeck(c: ToolCtx, a: Input, placed?: PlaceFile): Promise<MadeFile> {
    if (a.format !== 'pdf') throw new ToolError(`a .pptx source can only be saved as a PDF: give format "pdf" (for ${a.format}, write the document as Markdown)`)
    if (a.template) throw new ToolError('a PDF of a deck takes no template: the deck\'s own design is used')
    const fx = this.files.fx
    const rules = this.files.rules()
    // a deck in a chat place: its bytes from the checked copy; the page is named after it (its pictures are the deck's own)
    const src = placed ? { rel: placed.place, segs: [placed.name], abs: placed.local, st: undefined } : authorize(fx, rules, c.user, a.source!, 'read')
    if (src.st?.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`)
    const outRel = makeFileOutputPath(a.output, 'pdf')
    const out = authorizeOutput(fx, rules, c, outRel, { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)
    // before any work: a file read earlier that changed since, or that this session does not hold, asks for a new read
    if (out.exists) readForMakeFile(c.files, out.rel)
    const why = htmlPdfUnavailable()
    const browser = findPdfBrowser()
    if (why || !browser) throw new ToolError(`this server cannot make a PDF of a deck (${why ?? 'no headless browser is installed'}); nothing was saved. Tell the user so, and that PowerPoint or Keynote can (File > Export > PDF); never rewrite the slides as a document instead`, 'html_pdf_unavailable')
    const { bytes } = readRegular(src.abs, MAX_DECK, src.st)
    this.ctx.files.quarantine.assertBytes(bytes)
    // drawn in the office worker, printed by the isolated browser; the pictures are the deck's own (files/deck-pdf.ts)
    let drawn: DrawnDeck
    try { drawn = await deckPdf(bytes, { user: c.user.id, workBase: this.ctx.config.dataDir, signal: c.signal }) } catch (e) {
      throw e instanceof HtmlPdfError ? new ToolError(htmlPdfErrorText(e), `html_pdf_${e.code}`) : e
    }
    const printed = { pdf: drawn.pdf, pages: drawn.pages }
    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const produced = path.join(work, 'out.pdf')
      fs.writeFileSync(produced, printed.pdf, { flag: 'wx', mode: 0o600 })
      this.movedFirst(c, out)
      await this.checkWidening(c, out.rel, out.segs, [src.rel])
      const made = await placeProduced(this.ctx, this.files, c, out.segs, produced, 'make_file', undefined, { movedCheck: true, detail: { from: src.rel, pages: printed.pages, slides: drawn.pages } })
      return { ...made, html: { pages: printed.pages, blocked: [], blockedCount: 0, scripts: false, deck: { slides: drawn.pages, hidden: drawn.hidden, notDrawn: drawn.notDrawn } } }
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
    const output=makeFileOutputPath(a.output,'pptx')
    if(isReservedPlace(output)) throw new ToolError('with safe operations on, a deck is saved in a team folder (it is published there); save it in a folder and link it','safe_ops_output')
    c.user=this.ctx.files.principal(c.user.id)
    const out=authorize(this.files.fx,this.files.rules(),c.user,output,'write',{mustExist:false,download:true})
    const {bytes,deck}=await preparePresentation(this.ctx.files,c,this.conv.pandoc,text,base,{slides:a.expected_slides,notes:a.expected_notes,layouts:a.expected_layouts},snapshots)
    const made=await publishArtifact(this.ctx,this.files,c,out.rel,bytes,snapshots,
      (target,sources,binding)=>this.checkWidening(c,target,target.split('/'),sources,binding))
    return {...made,deck}
  }

  /**
   * Images: only files the person may read in the document's own place are copied into the work folder; the Image nodes
   * of the document tree then point at the copies. A team source's pictures are team files by a relative path (to the
   * source file, or to the team root); a source in the chat's work folder takes its pictures from the work folder only
   * (relative to it), one in the chat's files from the chat's files only, and a `chat:work/…` or `chat:files/…` reference
   * goes through the resolver (plan 20261121-0615-chat-places-as-paths.md review fix 4: a work-folder HTML or Markdown
   * never pulls a team file). Anything else (web addresses, data: URLs, absolute paths, hidden or missing files) stops
   * the conversion. Returns the sources: team paths and place paths.
   */
  private async copyImages(c: ToolCtx, ast: unknown, base: PlaceBase, work: string): Promise<string[]> {
    let n = 0
    const rels: string[] = []
    let bytes = 0
    const fx = this.files.fx
    const rules = this.files.rules()
    const where = base.kind === 'work' ? 'files in this chat\'s work folder (chat:work/), given by a path relative to the document' : base.kind === 'chatFiles' ? 'files of this chat (chat:files/<name>)' : c.places ? 'files in the team folder you can read, given by a relative path, or files of this chat by their chat place path (chat:files/<file_id>/<name>, chat:work/<path>); no web addresses, links or absolute paths' : 'files in the team folder you can read, given by a relative path (no web addresses or absolute paths)'
    const bad = (target: string, why: string): never => { throw new ToolError(`image '${target.slice(0, 200)}': ${why}. Images must be ${where}.`) }
    /** a picture of a chat place, copied through its one safe open */
    const fromPlace = async (target: string, place: string, x: string): Promise<string> => {
      let got: Awaited<ReturnType<typeof readPlaceFile>>
      try { got = await readPlaceFile(this.ctx, c, place, MAX_IMAGE, work) } catch (e) {
        if (e instanceof ToolError && e.code === 'too_large') return bad(target, 'larger than 20 MB')
        return bad(target, e instanceof ToolError || e instanceof Denied ? e.message.replace(/\.$/, '') : 'not found or no access')
      }
      if ((bytes += got.size) > MAX_IMAGES_BYTES) bad(target, 'the images together are larger than 100 MB')
      const name = freshName(work, `img-${n}`, x)
      fs.renameSync(got.local, path.join(work, name))
      rels.push(got.place)
      return name
    }
    const local = async (target: string): Promise<string> => {
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* keep */ }
      // a chat place written as the app's file link (/files/view?path=chat:files/…: QA TC-6460, a real model did): the
      // place itself, through the resolver like any chat: reference
      const linked = /^\/files\/view\?path=([^&#]+)/.exec(decoded)
      if (linked && isReservedPlace(linked[1]!)) { decoded = linked[1]!; target = decoded }
      const named = isReservedPlace(decoded) ? parsePlace(decoded) : null
      if (!named && (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//'))) bad(target, 'web addresses are not fetched')
      if (target.startsWith('/') || target.startsWith('~') || target.startsWith('\\')) bad(target, 'absolute paths are not allowed')
      const x = ext(decoded)
      if (!IMAGE_EXT.has(x)) bad(target, 'not an image file')
      if (++n > MAX_IMAGES) bad(target, `more than ${MAX_IMAGES} images`)
      // a chat place named outright, or a relative reference of a document that is in one: through the resolver only
      if (named) return fromPlace(target, decoded, x)
      if (base.kind !== 'team') {
        const p = placeRef(base, decoded)
        return p ? fromPlace(target, p, x) : bad(target, 'it leaves the document\'s place')
      }
      const candidates = [path.posix.normalize([...base.dir, decoded].join('/')), path.posix.normalize(decoded)]
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
    // iterative walk (a deeply nested document must not overflow the stack); the pictures in document order after it
    const targets: string[][] = []
    const stack: unknown[] = [ast]
    while (stack.length) {
      const v = stack.pop()
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
      if (!v || typeof v !== 'object') continue
      const node = v as { t?: unknown; c?: unknown }
      if (node.t === 'Image' && Array.isArray(node.c) && Array.isArray(node.c[2]) && typeof node.c[2][0] === 'string') {
        targets.push(node.c[2] as string[])
      }
      for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
    }
    for (const t of targets) t[0] = await local(t[0]!)
    return rels
  }

  /**
   * Word and PowerPoint: every SVG picture of the document (already a checked copy in the work folder, copyImages) is
   * drawn as a PNG there (svg-png.ts) and its Image nodes point at the PNG. Returns how many SVG files were drawn.
   */
  private async svgPictures(c: ToolCtx, ast: unknown, work: string, text: string): Promise<number> {
    const nodes: { c: [unknown, unknown, [string, string]] }[] = []
    const stack: unknown[] = [ast]
    while (stack.length) {
      const v = stack.pop()
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
      if (!v || typeof v !== 'object') continue
      const node = v as { t?: unknown; c?: unknown }
      if (node.t === 'Image' && Array.isArray(node.c) && Array.isArray(node.c[2]) && typeof node.c[2][0] === 'string' && /\.svg$/i.test(node.c[2][0])) nodes.push(node as never)
      for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
    }
    if (!nodes.length) return 0
    if (new Set(nodes.map((n) => n.c[2][0])).size > SVG_MAX_PER_DOCUMENT) throw new ToolError(`the document has more than ${SVG_MAX_PER_DOCUMENT} SVG pictures; save some as PNG first (format "png") or use fewer; nothing was saved`)
    const fonts = pdfFonts(pdfLanguage(text, teamDefaultLocale(this.ctx.db)))
    const drawn = new Map<string, string>()
    for (const n of nodes) {
      const local = n.c[2][0]
      let png = drawn.get(local)
      if (!png) {
        const svg = readOutput(work, local, SVG_MAX)
        if (!svg.ok) throw new ToolError(svg.why === 'too_large' ? `the SVG picture '${local}' is larger than ${SVG_MAX / 1024 / 1024} MB` : 'an SVG picture could not be read')
        let i = 0
        let base = ''
        for (;; i++) { base = `svgpng-${i}`; if (['svg', 'typ', 'png'].every((x) => !fs.existsSync(path.join(work, `${base}.${x}`)))) break }
        const bytes = await svgToPng(this.conv, new Uint8Array(svg.bytes), work, base, fonts, c.signal)
        png = freshName(work, `${base}-out`, 'png')
        fs.writeFileSync(path.join(work, png), bytes, { flag: 'wx', mode: 0o600 })
        drawn.set(local, png)
      }
      n.c[2][0] = png
    }
    return drawn.size
  }

  /**
   * A PNG of an SVG picture (a chart, a Gantt chart, a diagram the AI drew): `content` is the SVG, or `source` an .svg
   * file in the team folder (then that file is the PNG's source). Drawn by typst (svg-png.ts), then placed like every
   * make_file output.
   */
  private async png(c: ToolCtx, a: Input, placed?: PlaceFile): Promise<MadeFile> {
    if (a.template) throw new ToolError('a PNG takes no template')
    const fx = this.files.fx
    const rules = this.files.rules()
    let svg: Uint8Array
    const sources: string[] = []
    if (placed) {
      if (ext(placed.name) !== 'svg') throw new ToolError('for format "png" the source must be an .svg file (or give the SVG as `content`)')
      svg = new Uint8Array(readRegular(placed.local, SVG_MAX).bytes)
      sources.push(placed.place)
    } else if (a.source !== undefined) {
      const r = authorize(fx, rules, c.user, a.source, 'read')
      if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder`)
      if (ext(r.rel) !== 'svg') throw new ToolError('for format "png" the source must be an .svg file (or give the SVG as `content`)')
      svg = new Uint8Array(readRegular(r.abs, SVG_MAX, r.st).bytes)
      sources.push(r.rel)
    } else {
      if (Buffer.byteLength(a.content!) > SVG_MAX) throw new ToolError(`content is too large (max ${SVG_MAX / 1024 / 1024} MB)`)
      svg = new TextEncoder().encode(a.content!)
    }
    if (!/<svg\b/i.test(new TextDecoder().decode(svg.subarray(0, 64 * 1024)))) throw new ToolError('for format "png" give an SVG picture (an <svg> element) as `content` or an .svg `source`; nothing was saved')
    const outRel = makeFileOutputPath(a.output, 'png')
    const out = authorizeOutput(fx, rules, c, outRel, { mustExist: false, createDirs: true })
    if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`)
    const work = makeWorkDir(path.join(this.ctx.config.dataDir, 'work'))
    try {
      const text = new TextDecoder().decode(svg)
      const png = await svgToPng(this.conv, svg, work, 'picture', pdfFonts(pdfLanguage(text, teamDefaultLocale(this.ctx.db))), c.signal)
      const produced = path.join(work, freshName(work, 'out', 'png'))
      fs.writeFileSync(produced, png, { flag: 'wx', mode: 0o600 })
      this.movedFirst(c, out)
      await this.checkWidening(c, out.rel, out.segs, sources)
      return await this.place(c, out.segs, produced, sources)
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  /**
   * The output carries the bytes of `sources`: they join the chat's read scope (later saves in the chat take them
   * into account), and when more people can read the output than those files (or what the chat read), the chat turn
   * asks the person first. No chat turn (nobody to ask): refused. Runs before anything is placed.
   */
  /** A new file where a file was moved away from (movedAwayCheck, said once per answer and place) is said before the
   * wider-audience card: else the person approves the card, then hears "Nothing was saved", and a retry asks the card
   * again (re-review of batch 2). placeProduced's own check then lets the second call through. */
  private movedFirst(c: ToolCtx, out: { rel: string; exists: boolean }) {
    if (!out.exists && c.turnId && !isReservedPlace(out.rel)) movedAwayCheck(this.ctx, c, out.rel)
  }

  private checkWidening(c: ToolCtx, target: string, targetSegs: string[], sources: string[], binding?: string) {
    return confirmSources(this.ctx, this.files, c, target, targetSegs, sources, binding)
  }

  private async template(c: ToolCtx, tpl: string, format: string, work: string): Promise<{ local: string; rel: string }> {
    // any file the person can read (not only skills/): it is a source of the output, so the wider-audience check covers it;
    // one in a chat place (chat:work/…, chat:files/…) through its place
    const placed = isReservedPlace(tpl) ? await readPlaceFile(this.ctx, c, tpl, 50 * 1024 * 1024, work) : null
    const r = placed ? { rel: placed.place, abs: placed.local, st: undefined } : authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.st?.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; give a .${format} file as the template`, 'is_folder')
    if (ext(placed ? placed.name : r.rel) !== format) throw new ToolError(`the template must be a .${format} file`)
    const st = checkRegular(r.abs)
    if (st.size > 50 * 1024 * 1024) throw new ToolError('template is too large')
    // pandoc copies the template's headers, footers, settings, masters and layouts as they are: a field that runs or
    // fetches something, an external relationship or an embedded object would be in every new file, so the template
    // is checked first in the office worker (files/office-template.ts, QA TC-4948). It returns the bytes with any
    // attached template taken out (TC-4949), and those are the bytes pandoc reads.
    const bytes = readRegular(r.abs, 50 * 1024 * 1024, r.st).bytes
    const checked = await officeWorkerWrite(format === 'docx' ? DOCX_TEMPLATE_CHECK_MODE : PPTX_TEMPLATE_CHECK_MODE, bytes, c.signal)
    const local = freshName(work, 'template', format)
    fs.writeFileSync(path.join(work, local), checked, { flag: 'wx', mode: 0o600 })
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
    fs.writeFileSync(path.join(work, input), kind === 'tsv' ? tsvToCsv(text) : kind === 'markdown' ? hwpxMarkdown(text) : text)
    const j = await runIsolated({ cmd: this.conv.pandoc, args: ['--sandbox', '-f', kind === 'markdown' ? HWPX_MARKDOWN : 'csv', '-t', 'json', '-o', 'ast.json', input], workDir: work, timeoutMs: 120_000 })
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

  /** A .hwpx template the person can read: its bytes go to the office worker, which checks them as untrusted (files/hwpx-write.ts).
   * Only its header's style lists and its first section's page setup are used, never its text (so no field or link
   * in it reaches the new file); scripts, OLE objects and addresses or paths in what is kept are refused there. */
  private hwpxTemplate(c: ToolCtx, tpl: string): { bytes: Uint8Array; rel: string } {
    if (isReservedPlace(tpl)) throw new ToolError('a .hwpx template must be a team file; copy it into a team folder first', 'bad_place')
    const r = authorize(this.files.fx, this.files.rules(), c.user, tpl, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; give a .hwpx file as the template`, 'is_folder')
    if (ext(r.rel) !== 'hwpx') throw new ToolError('the template must be a .hwpx file (a .hwp can be saved as .hwpx in Hangul)')
    if (checkRegular(r.abs).size > HWPX_TEMPLATE_MAX) throw new ToolError(`template is too large (max ${HWPX_TEMPLATE_MAX / 1024 / 1024} MB)`)
    return { bytes: readRegular(r.abs, HWPX_TEMPLATE_MAX, r.st).bytes, rel: r.rel }
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
    const r = await runIsolated({ cmd: this.conv.typst, args: typstArgs({ work, doc, fonts, jobs: typstJobs() }), workDir: work, readPaths: fonts ? [fonts] : [], timeoutMs: 120_000, maxRssMiB: TYPST_PDF_RSS_MIB })
    if (r.code !== 0) throw new ToolError(r.killed === 'memory' ? 'making the PDF needs too much memory (a picture or the document is too heavy); nothing was saved' : convertError('typst', r.stderr, r.killed, work))
  }

  /** Writes the workbook and its charts (xlsx-chart.ts); returns the number of formula cells, how many of them have
   * their result stored, and the number of charts. */
  /** `csvFirst`: the CSV `text` is a sheet named `name`, followed by the Markdown tables of `more` */
  private async xlsx(text: string, kind: 'markdown' | 'csv' | 'tsv', out: string, charts: ChartSpec[], options: SheetOptions[] = [], csvFirst?: { name: string; more: string }): Promise<{ formulas: number; stored: number; charts: number; conditional: number; csvSheet?: string }> {
    const sheets: { name: string; rows: string[][] }[] = []
    if (kind === 'markdown') {
      const tables = markdownTables(text)
      if (!tables.length) throw new ToolError('no table found: give CSV, or Markdown with | pipe | tables |')
      tables.forEach((t, i) => sheets.push({ name: t.title ?? `Sheet${i + 1}`, rows: t.rows }))
    } else sheets.push({ name: csvFirst?.name ?? 'Sheet1', rows: parseCsv(text, kind === 'tsv' ? '\t' : ',') })
    if (csvFirst) markdownTables(csvFirst.more).forEach((t, i) => sheets.push({ name: t.title ?? `Sheet${i + 2}`, rows: t.rows }))
    const wb = new ExcelJS.Workbook()
    wb.creator = PRODUCT.displayName
    wb.created = new Date()
    // the spreadsheet app calculates every formula when it opens the file; the simple ones also get a stored result below
    wb.calcProperties.fullCalcOnLoad = true
    const used = new Set<string>()
    let formulas = 0, stored = 0
    const written: ChartSheet[] = []
    const styled: WrittenSheet[] = []
    for (const s of sheets) {
      // at most 31 UTF-16 units, never half of a surrogate pair (an emoji)
      let name = s.name.replace(/[\\/?*[\]:'"|]/g, ' ').trim().slice(0, 31).replace(/[\uD800-\uDBFF]$/, '') || 'Sheet'
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 28).replace(/[\uD800-\uDBFF]$/, '')} ${i}`
      used.add(name.toLowerCase())
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: s.rows.length > 1 ? 1 : 0 }] })
      // the values first, then the results of the simple formulas (formula-values.ts) so a preview shows numbers
      const grid = s.rows.map((row, ri) => row.map((v, ci) => {
        if (ri === 0) return v
        const cv = cellValue(v)
        if (typeof cv === 'object' && 'error' in cv) throw new ToolError(`sheet '${name}' cell ${columnName(ci + 1)}${ri + 1}: ${cv.error}; nothing was saved. Start the cell with '= to keep it as text.`)
        if (typeof cv === 'object') formulas++
        return cv
      }))
      addFormulaResults(grid)
      written.push({ name, title: s.name, rows: grid })
      for (const row of grid) for (const c of row) if (typeof c === 'object' && c !== null && 'formula' in c && (c as { result?: unknown }).result !== undefined) stored++
      for (const row of grid) ws.addRow(row)
      styled.push({ name, title: s.name, rows: s.rows.length, cols: s.rows.length ? Math.max(...s.rows.map((r) => r.length)) : 0, ws })
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
    // a chart that does not fit the sheets is refused before anything is written
    if (charts.length) placeCharts(charts, written)
    // number formats, widths, frozen panes, filter, conditional formatting (xlsx-format.ts), refused before writing
    const { conditional } = applySheetOptions(options, styled, (f) => { const r = formulaOf(f); return 'formula' in r ? r.formula : { error: r.error } })
    await wb.xlsx.writeFile(out)
    if (charts.length) fs.writeFileSync(out, addCharts(new Uint8Array(fs.readFileSync(out)), charts, written))
    const csvSheet = csvFirst && written[0] && written[0].name !== csvFirst.name ? written[0].name : undefined
    return { formulas, stored, charts: charts.length, conditional, ...(csvSheet ? { csvSheet } : {}) }
  }

  /** `sources`: the team files whose bytes are in the output (the source, embedded images, a template). The event says
   * so: with none, the file is the AI's own text alone (`own`: chat/shared-actions.ts ownWritingSql counts only that
   * as written by the AI); else where it came from. */
  private place(c: ToolCtx, segs: string[], produced: string, sources: readonly string[]): Promise<MadeFile> {
    return placeProduced(this.ctx, this.files, c, segs, produced, 'make_file', undefined, { movedCheck: true, detail: sources.length ? { from: sources[0], files: sources.slice(1, 51) } : { own: true } })
  }
}

/**
 * A new file carries the bytes of `sources` (make_file's source, images and template; edit_hwp's document saved as a
 * new file): they join the chat's read scope, and when more people can read the target than those files (or what the
 * chat read), the chat turn asks the person first. No chat turn (nobody to ask): refused. Runs before anything is
 * placed.
 */
export async function confirmSources(ctx: AppContext, files: TeamFiles, c: ToolCtx, target: string, targetSegs: string[], sources: string[], binding?: string) {
  // a chat place's file (chat:work/…, chat:files/…) is not a team path: the turn weighs it by its place's readers
  for (const p of sources) if (!isReservedPlace(p)) c.files.readPaths.add(p)
  if (c.confirmWidening) {
    const refusal = await c.confirmWidening(target, sources, binding)
    if (refusal) throw new Denied(refusal)
    return
  }
  const db = ctx.db
  const rules = files.rules()
  const chatId = c.turnId ? (db.query('SELECT chat_id FROM turns WHERE id = ?').get(c.turnId) as { chat_id: string } | null)?.chat_id ?? null : null
  // the target as the file layer resolves it (letter case, look-alike spellings): "WIDE/x" is wide/x
  if (isReservedPlace(target) || sources.some(isReservedPlace)) throw new Denied(`${PLACE_WORDS.noChat} Nothing was saved.`)
  const at = authorize(files.fx, rules, c.user, target, 'write', { mustExist: false, createDirs: true }).segs
  const w = widening(db, chatId, at, sources.map((p) => sourceOf(db, rules, p)))
  if (w) throw new Denied(`more people can read '${target}' than the files it is made from; nothing was saved. Save it in a folder that only the people who can read those files can see, or ask the user where to put it.`)
}

/**
 * Print an HTML page read out of a chat place (files/place-output.ts readPlaceFile) to PDF: its pictures, stylesheets and
 * fonts come from that same place only (relative to the page inside the work folder, or among the chat's files), each
 * through the place's one safe open; a reference that leaves the place, or names the team folder, gets nothing. The page
 * and those files are the PDF's sources (place paths).
 */
export async function printPlaceHtml(ctx: AppContext, c: ToolCtx, placed: PlaceFile): Promise<PrintedHtml> {
  if (!HTML_SOURCE_EXT.has(ext(placed.name))) throw new ToolError('only an .html file can be printed to PDF')
  const max = HTML_PDF_LIMITS.maxHtmlBytes
  if (placed.size > max) { const e = new HtmlPdfError('html_too_large', `the HTML file is larger than ${max / 1024 / 1024} MB`); throw new ToolError(htmlPdfErrorText(e), `html_pdf_${e.code}`) }
  const why = htmlPdfUnavailable()
  const browser = findPdfBrowser()
  if (why || !browser) throw new ToolError(`${why ?? 'no headless browser is installed on this server'}; nothing was saved. Tell the user so; never rewrite the HTML as Markdown instead without saying that its design (colours, backgrounds, merged cells, page layout) would be lost`, 'html_pdf_unavailable')
  const bytes = readRegular(placed.local, max).bytes
  ctx.files.quarantine.assertBytes(bytes)
  // the page's own path inside its place: the browser resolves its references against it (never a team path)
  const page = placed.base.kind === 'work' ? [...placed.base.dir, placed.name].join('/') : placed.name
  const used = new Map<string, string>()
  const toTool = (e: unknown) => (e instanceof HtmlPdfError ? new ToolError(htmlPdfErrorText(e), `html_pdf_${e.code}`) : e)
  const tmp = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  let release: () => void
  try { release = await renderSlot(c.user.id, c.signal) } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw toTool(e) }
  try {
    const r = await renderHtmlPdf({
      browser, html: bytes, page, workBase: ctx.config.dataDir, fonts: serverFontDirs(), signal: c.signal,
      asset: async (p, maxBytes) => {
        if (p === page) return null
        const at = placed.base.kind === 'work' ? placeRef({ kind: 'work', dir: [] }, p) : placeRef(placed.base, p)
        if (!at) return null
        try {
          const got = await readPlaceFile(ctx, c, at, maxBytes, tmp)
          const b = readRegular(got.local, maxBytes).bytes
          fs.rmSync(got.local, { force: true })
          if (ctx.files.quarantine.hasBytes(b)) return null
          used.set(p, got.place)
          return b
        } catch { return null }
      },
    })
    return { pdf: r.pdf, pages: r.pages, blocked: r.blocked, blockedCount: r.blockedCount, scripts: r.scripts, source: placed.place, sources: [placed.place, ...r.assets.map((p) => used.get(p) ?? p)] }
  } catch (e) {
    throw toTool(e)
  } finally { release(); fs.rmSync(tmp, { recursive: true, force: true }) }
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
  const { bytes } = readRegular(src.abs, max, src.st)
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
          const b = readRegular(f.abs, max, f.st).bytes
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
/** tools whose output the AI made itself (tools/stamp-pdf.ts madeThisTurn) */
const MADE_BY = new Set(['make_file', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'stamp_pdf'])

/** placeProduced options. `turnBytes: false`: the file does not count against the turn's write budget
 * (turnWriteLimits bytes, a guard against an AI writing in a loop): save_url's downloads, which the person sized on a
 * card over 1 GB and the disk check bounds (tools/save-url.ts). `turnFiles: false`: the file does not count against the
 * turn's file count (turnWriteLimits files): unzip_file, whose zip has its own limits (files/unzip.ts) and a budget per
 * answer (tools/unzip.ts). `detail`: more for the file event (the source URL). */
/** thisAnswerOnly: a save of a new thing (a web page, a room's file, a video, an unzip): an existing file there is
 * replaced only when this answer read it (a read in an earlier message keeps both, as before); make_file and the
 * tools that change a named file count the chat's earlier reads too (files/service.ts ReadHashes) */
/** `movedCheck`: a new file where a file was moved away from is said first (make_file, copies out of the work folder) */
/** `fetched`: the bytes are a file from outside saved exactly as it came (a web download, a connector's or a mail's
 * attachment, a file a person sent in a room, an entry of a zip or an email), not something the AI built or changed:
 * like a person saving a download, it keeps the earlier behaviour and skips the Office exit check (files/office-exit.ts),
 * which is for what the AI produces. */
export interface PlaceOptions { turnBytes?: boolean; turnFiles?: boolean; detail?: Record<string, unknown>; thisAnswerOnly?: boolean; movedCheck?: boolean; fetched?: boolean }

export async function placeProduced(ctx: AppContext, files: TeamFiles, c: ToolCtx, segs: string[], produced: string, tool = 'make_file', guard?: () => void, po: PlaceOptions = {}): Promise<MadeFile> {
  // `chat:files/<name>` (files/place-output.ts authorizeOutput): attached to this answer, never a team file
  if (isChatTarget(segs)) { guard?.(); return attachProduced(ctx, c, segs, produced, { turnBytes: po.turnBytes, turnFiles: po.turnFiles, ...(po.fetched ? { fetched: true } : {}) }) }
  // a guest has the smaller pair (files/turn-write-limits.ts)
  const max = turnWriteLimits(ctx.engineConfig, ctx.db, c.user.id)
  // lstat, never the size of what a link left by a converter points at (hashFile below refuses such a link anyway)
  const size = checkRegular(produced).size
  const counted = po.turnBytes !== false
  if (counted && c.files.bytesWritten + size > max.bytes) throw new ToolError(writeLimitText('bytes', max.bytes, segs.join('/')))
  assertStorageRoomForAI(size) // the team disk near full (system/storage.ts; Linux / a plan)
  const fx = files.fx
  // the one check of an AI's file going into a team folder, by its content (files/office-exit.ts): only the file it
  // replaces, in the bytes this answer read, vouches for what that file already held
  if (!po.fetched) await assertSafeTeamPath(segs[segs.length - 1] ?? '', produced, () => replacedAsRead(path.join(fx.root, ...segs), c.files.readHashes.get(segs.join('/'))), c.signal, { read: () => readVouchers(fx.root, c.files.readHashes) })
  // Finish asynchronous work BEFORE the fresh principal/content/conflict check. The final
  // check-to-install section is synchronous, so server saves and policy mutations cannot interleave.
  const sha = await hashFile(produced)
  // the slow copies too, off the event loop (a 20 GB file on ext4 takes minutes: docs/decisions/20261127-restart.md):
  // the produced file onto the team folder's volume (placed below with a rename), and the content of the file it may
  // replace (its version, used only when the section below finds that very file there still: place.ts KeptCopy)
  const vol = await onTeamVolume(fx.root, produced)
  let kept: KeptCopy | null = null
  let placed = false
  try {
    try { if (fs.lstatSync(path.join(fx.root, ...segs)).isFile()) kept = await stageVersion(fx.root, path.join(fx.root, ...segs)) } catch { kept = null }
    return placeChecked()
  } finally { if (kept) dropVersion(kept); vol.finish(placed) }

  function placeChecked(): MadeFile {
    c.signal?.throwIfAborted()
    c.user=ctx.files.principal(c.user.id)
    guard?.()
    c.beforePlace?.()
    const rules = files.rules()
    let conflictOf: string | undefined
    let action: 'create' | 'update' = 'create'
    let keptId: string | null = null
    // looked at again now, not before the conversion: someone may have saved a file there in the meantime
    const now = authorize(fx, rules, c.user, segs.join('/'), 'write', { mustExist: false, createDirs: true })
    if (now.exists && now.st!.isDirectory()) throw new ToolError(`'${now.rel}' is a folder`)
    segs = now.segs
    let target = segs
    const rel0 = now.rel
    // under skills/ only after the person confirmed this save on the server's card (skills/guard.ts); fail closed
    requireSkillApproval(c, rel0, null)
    // a new file where a file was moved away from (QA TC-7234, real claude-code run: the remade poster went to its old
    // place, the moved one stayed on the old date, and the answer said "saved the same file"): said first, once per answer
    // and place, with where the file is now (when this person, and everyone in the chat, may read it there). A second
    // call for the same place makes the new file (the person may want one there)
    if (!now.exists && po.movedCheck && c.turnId) movedAwayCheck(ctx, c, rel0)
    if (now.exists) {
      const abs = path.join(fx.root, ...segs)
      checkRegular(abs)
      const read = readRegular(abs, undefined, now.st)
      const cur = sha256(read.bytes)
      // make_file replaces a whole file: only from a read this session still holds (readForMakeFile); the in-place tools
      // (edit_hwp, comment_docx, the PDF and image tools) work from the old bytes and use every unchanged read
      if ((po.thisAnswerOnly ? readThisAnswer(c.files, rel0) : tool === 'make_file' ? readForMakeFile(c.files, rel0) : c.files.readHashes.get(rel0)) === cur) {
        // the copy made above when it is of this very file; else (changed while it was copied) the bytes just read
        if (kept && sameFile(kept.st, read.st)) keptId = commitVersion(ctx.db, kept, rel0, { userId: c.user.id, turnId: c.turnId }, 'edit', cur)
        else saveVersion(ctx.db, fx.root, rel0, read.bytes, { userId: c.user.id, turnId: c.turnId })
        action = 'update'
      } else {
        // never overwrite a file the AI has not read in this chat (this answer or, unchanged, an earlier one of the
        // person's: files/service.ts ReadHashes; changed since then it asks for a new read): keep both
        const dir = segs.slice(0, -1)
        let name = conflictCopyName(segs[segs.length - 1]!, c.user.name, new Date(), teamDefaultLocale(ctx.db), teamTimeZone(ctx.db))
        if (badSegment(name)) name = `copy-${Date.now()}-${segs[segs.length - 1]}`
        name = freeName(path.join(fx.root, ...dir), name)
        target = authorize(fx, rules, c.user, [...dir, name].join('/'), 'write', { mustExist: false }).segs
        conflictOf = rel0
      }
    }
    if (po.turnFiles !== false && !c.files.filesWritten.has(target.join('/')) && c.files.filesWritten.size >= max.files) throw new ToolError(writeLimitText('files', max.files, target.join('/')))
    // final check right before the rename (rules may have changed during the conversion)
    authorize(fx, files.rules(), c.user, target.join('/'), 'write', { mustExist: false, createDirs: true })
    try { installRenamed(fx.root, target, vol.file) } catch (e) { if (kept && keptId) undoVersion(ctx.db, kept, keptId); throw e }
    placed = true
    consumeSkillApproval(c, rel0)
    const rel = target.join('/')
    if (counted) c.files.bytesWritten += size
    if (po.turnFiles !== false) c.files.filesWritten.add(rel)
    c.files.readHashes.set(rel, sha)
    // made by the AI here (not a copy of someone's file from the web or a room): stamp_pdf / edit_pdf may change it in place
    if (MADE_BY.has(tool)) c.files.madeHashes.set(rel, sha); else c.files.madeHashes.delete(rel)
    // a conflict copy is told to both people and listed in the original's history (before the copy's own event)
    if (conflictOf) recordConflictCopy(ctx.db, ctx.files.events, { original: conflictOf, copy: rel, userId: c.user.id, turnId: c.turnId, size, sha256: sha, tool })
    fileEvent(ctx.db, { turnId: c.turnId, userId: c.user.id, path: rel, action, size, sha256: sha, detail: { tool, ...po.detail, ...(po.fetched ? { fetched: true } : {}), ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
    // All office consumers already run in workers; PPTX was validated before this
    // publication. Never add an in-process document parser here.
    files.extractText(rel)
    publishChanges(ctx, [{ path: rel, action, by: { id: c.user.id, name: c.user.name }, turnId: c.turnId }])
    return { path: rel, size, sha256: sha, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) }
  }
}

/** Raw formats pandoc's docx, pptx and typst writers ignore: their blocks are dropped (\newpage, \pagebreak). */
const IGNORED_RAW = new Set(['tex', 'latex'])
/** Raw formats left in the tree: the docx, pptx and typst writers never copy them into the file. */
const HARMLESS_RAW = new Set(['html', 'html4', 'html5', 'markdown'])

/**
 * Raw markup in pandoc's tree of a Markdown document (QA TC-4941): pandoc copies a RawBlock / RawInline of the output's
 * own format into the file unchanged, so `<w:instrText>DDEAUTO ...</w:instrText>`{=openxml} became a DDE field in
 * word/document.xml (and {=typst} raw code in a PDF). Any raw format other than HTML and Markdown is refused, nothing
 * saved; TeX ones (`\newpage`), which these writers ignore anyway, are emptied. Walks the whole tree, metadata
 * included.
 */
export function checkRawMarkup(ast: unknown): void {
  const stack: unknown[] = [ast]
  while (stack.length) {
    const v = stack.pop()
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
    if (!v || typeof v !== 'object') continue
    const node = v as { t?: unknown; c?: unknown }
    if (node.t === 'RawBlock' || node.t === 'RawInline') {
      const format = Array.isArray(node.c) ? String(node.c[0]).toLowerCase() : ''
      if (IGNORED_RAW.has(format)) {
        // an empty Div / Span in its place: the writers write nothing for it
        const block = node.t === 'RawBlock'
        node.t = block ? 'Div' : 'Span'
        node.c = [['', [], []], []]
        continue
      }
      if (!HARMLESS_RAW.has(format)) throw new ToolError(`raw ${format.replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'unknown'} markup (\`...\`{=${format.replace(/[^a-z0-9_-]/g, '').slice(0, 20)}} or a \`\`\`{=...} block) cannot go into a file made here; write it as plain Markdown; nothing was saved`)
      continue
    }
    for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
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
/** pandoc's memory for a .docx / .pptx (with or without a template) */
export const PANDOC_RSS_MIB = 1024

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
  'WEBSERVICE', 'FILTERXML', 'ENCODEURL', 'RTD', 'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC', 'DDE', 'DDEAUTO',
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

/** mailto parameters a link may carry (the same list as the Word and PowerPoint links of make_file) */
const MAILTO_PARAMS = new Set(['subject', 'body', 'cc', 'bcc', 'to'])
// eslint-disable-next-line no-control-regex
const NOT_IN_LINK = /[\s\x00-\x1f\x7f\\\p{Cf}]/u
// eslint-disable-next-line no-control-regex
const NOT_IN_PLACE = /[\x00-\x1f\x7f\\\p{Cf}]/u
const LINK_RULE = 'HYPERLINK may point only to a web page (http, https), a mail address (mailto:) or a place in this workbook ("#Sheet1!A1"): ' +
  'a file:, network-share (\\\\server) or other local link is refused, because opening one can hand a coworker\'s Windows sign-in to another computer'

/**
 * The link of every HYPERLINK in the formula, or why one is refused. Claude Code's openpyxl writes any HYPERLINK; the one
 * thing kept from coworkers who open the file is a link to something on their own computer or network (file:,
 * \\host\share, a relative path, javascript:, a program's own scheme), which can run a program or send their Windows
 * sign-in to another computer. So the link is the first argument, written out as "text": a web page (http, https), a
 * mail address (mailto:, with subject, body, cc, bcc, to only, written out whole), or a place in this workbook
 * ("#Sheet1!A1", "#'Q3 sales'!B2", "#Total"). A web link may go on with & and cells ("https://example.com/item/"&A2),
 * with no comparison: the kind of link is fixed by the text it starts with. A link that is a cell, or a place built from cells, cannot be checked and is refused.
 */
export function hyperlinkProblem(tokens: Token[]): string | null {
  for (const [k, t] of tokens.entries()) {
    if (t.kind !== 'code') continue
    for (const m of t.text.matchAll(/([A-Za-z0-9_.]?)HYPERLINK\s*\(/gi)) {
      // a prefixed or longer name (_xludf.HYPERLINK, XHYPERLINK) is not checked here: refused as before
      if (m[1]) return 'the function HYPERLINK may only be written as HYPERLINK(...), with no prefix'
      const rest = t.text.slice(m.index! + m[0].length)
      const arg = tokens[k + 1]
      if (rest.trim() !== '' || arg?.kind !== 'string') return `${LINK_RULE}. Write the link in the formula in "double quotes", e.g. HYPERLINK("https://example.com/report","Report") or HYPERLINK("https://example.com/item/"&A2,A2)`
      const target = arg.text.slice(1, -1).replace(/""/g, '"')
      const after = tokens[k + 2]
      const joined = after?.kind === 'code' && /^\s*&/.test(after.text)
      const ended = !after || (after.kind === 'code' && /^\s*[,)]/.test(after.text))
      if (!joined && !ended) return `${LINK_RULE}. Write the link in the formula in "double quotes"`
      if (joined) {
        // the rest of the first argument: a comparison there ("https://x"&A1="y") makes the link TRUE or FALSE, not
        // the text it starts with (review of #1337)
        let depth = 0
        outer: for (let j = k + 2; j < tokens.length; j++) {
          const tj = tokens[j]!
          if (tj.kind !== 'code') continue
          for (const ch of tj.text) {
            if (ch === '(' || ch === '{') depth++
            else if (ch === ')' || ch === '}') { if (depth === 0) break outer; depth-- }
            else if (ch === ',' && depth === 0) break outer
            else if ((ch === '=' || ch === '<' || ch === '>') && depth === 0) return `${LINK_RULE}. The link may go on with & and cells, but not with a comparison (=, <, >)`
          }
        }
      }
      // a place in this workbook may have a space in a 'quoted sheet name'; a web or mail link has none
      if (target.length > 2048 || (target.startsWith('#') ? NOT_IN_PLACE : NOT_IN_LINK).test(target)) return `${LINK_RULE}. The link "${target.slice(0, 60)}" has spaces, backslashes or control characters`
      if (/^https?:\/\//i.test(target)) { if (joined || /^https?:\/\/[^/?#]/i.test(target)) continue }
      else if (/^mailto:/i.test(target)) {
        const q = target.indexOf('?')
        const params = q < 0 ? [] : target.slice(q + 1).split('&').filter(Boolean).map((p) => p.split('=')[0]!.toLowerCase())
        // a mail link is written out whole: what & would add after it could be another parameter (&attach=...)
        if (joined) return `${LINK_RULE}. Write a mail link out whole in "double quotes", e.g. "mailto:sales@example.com?subject=Order"`
        if (params.every((p) => MAILTO_PARAMS.has(p)) && target.length > 7) continue
        return `${LINK_RULE}. A mail link may carry only subject, body, cc, bcc and to`
      } else if (target.startsWith('#') && !joined) {
        // a place in this workbook: a defined name, a cell or range, or one on a (quoted) sheet; never another file
        const place = target.slice(1)
        const cell = '\\$?[A-Za-z]{1,3}\\$?\\d+(?::\\$?[A-Za-z]{1,3}\\$?\\d+)?'
        if (new RegExp(`^(?:(?:'(?:[^'\\[\\]\\\\/:*?]|'')+'|[\\p{L}_][\\p{L}\\p{N}_.]*)!)?${cell}$`, 'u').test(place) || /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(place)) continue
        return `${LINK_RULE}. A place in this workbook is written like "#Sheet1!A1" or "#'Q3 sales'!B2"`
      }
      return `${LINK_RULE}. This link is "${target.slice(0, 60)}${target.length > 60 ? '…' : ''}"`
    }
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
  const link = hyperlinkProblem(tokens)
  if (link) return { error: link }
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


/** The Image nodes of a pandoc document tree (every picture of the document, whatever syntax wrote it). */
export function imageCount(ast: unknown): number {
  let n = 0
  const stack: unknown[] = [ast]
  while (stack.length) {
    const x = stack.pop()
    if (Array.isArray(x)) { for (const y of x) stack.push(y); continue }
    if (x && typeof x === 'object') {
      const o = x as { t?: unknown; c?: unknown }
      if (o.t === 'Image') n++
      for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v)
    }
  }
  return n
}
/** a run of block characters (■ █ ▇ ▒ …): a bar drawn with text */
const TEXT_BAR = /[\u2580-\u259F\u25A0\u25AE\u25AC]{4,}/u
export const textBars = (markdown: string): boolean => TEXT_BAR.test(markdown)
/** make_file's line for a Word file or PDF made from Markdown (FromMarkdown). */
export function docResultText(d: FromMarkdown, format: 'pdf' | 'docx'): string {
  const pages = d.pages ? `${d.pages} page${d.pages === 1 ? '' : 's'} and ` : ''
  const pics = d.pictures ? `${d.pictures} picture${d.pictures === 1 ? '' : 's'}` : 'no pictures'
  const bars = !d.pictures && d.textBars ? ` Bars drawn with block characters (■, █) are text, not a chart: for a chart, ${format === 'docx' ? 'write a ```chart block (a native chart)' : 'draw it as SVG, save it as PNG with make_file and put the picture in'}; otherwise do not call it a chart.` : ''
  return `The ${format === 'pdf' ? 'PDF' : 'Word file'} has ${pages}${pics}.${bars}`
}

/** the places this answer was told a file had moved away from (a second save there goes ahead) */
const movedTold = new WeakMap<object, Set<string>>()
function movedAwayCheck(ctx: AppContext, c: ToolCtx, rel: string): void {
  const told = movedTold.get(c.files) ?? new Set<string>()
  if (told.has(rel)) return
  let f: ReturnType<typeof movedFact> = null
  try {
    const chatId = c.turnId ? (ctx.db.query('SELECT chat_id FROM turns WHERE id = ?').get(c.turnId) as { chat_id: string } | null)?.chat_id ?? null : null
    f = movedFact(ctx.db, ctx.files.fx, ctx.files.rules(), c.user, rel, { chatId })
  } catch { f = null }
  if (!f || f.kind !== 'moved') return
  told.add(rel); movedTold.set(c.files, told)
  const who = f.byName || 'someone on the team'
  throw new ToolError(f.to
    ? `Nothing was saved: '${rel}' is where a file used to be. ${who} moved that file to '${f.to}' (moved, not deleted), so saving here would make a second, NEW file and leave '${f.to}' unchanged. To change the file the person means, read '${f.to}', then save your result to '${f.to}' itself (or copy it into that folder under the same name): that saves a new version of it. Only if the person wants a separate new file here, call this again with the same path.`
    : `Nothing was saved: '${rel}' is where a file used to be. ${who} moved that file to a place not named here (moved, not deleted), so saving here would make a second, NEW file. Tell the person the file was moved and ask where it is; only if they want a separate new file here, call this again with the same path.`, 'moved_away')
}
