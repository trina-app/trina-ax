// edit_office (limits audit 2026-11-18 #2, QA TC-4906; plan docs/AGENTS/plan/20261118-1041-office-edit-in-place.md):
// the AI changes an existing Word, Excel or PowerPoint file in place, as Claude Code does with python-docx / openpyxl
// through a shell. Before, it could only rebuild the file from Markdown or CSV with make_file, which lost every style,
// picture, chart, comment and tracked change. The document is changed in the office worker (files/office-edit.ts and
// files/docx-edit.ts, xlsx-edit.ts, pptx-edit.ts: this process parses no document). Saved like edit_hwp and comment_docx:
// - read first: the file must be the version the AI read in this chat (this answer or, unchanged, an earlier one: #1285) (else: read it again);
// - without `output`, a new version of the same file (the old bytes in its history), a conflict copy if someone saved
//   it meanwhile; with `output`, a new file, and the document is its source (make_file's wider-audience check). A
//   replacement or inserted picture (replace_picture, insert_picture: a team file, or a file of this chat read through
//   its place) is a source too, in place as well;
// - not under skills/ (a skill is Markdown, not an Office file; no skill-save card covers this tool);
// - checked before anything is placed, not on the worker's word: the zip's parts outside the edit keep their
//   compressed bytes (read here from the central directory without expanding anything), only parts of the kinds an
//   edit may touch changed, and a fresh worker reads the old and the new file: every changed XML part is well-formed,
//   and the text reads as before except what the changes report (paragraphs; every cell of every sheet).
import { authorizeOutput, readPlaceFile, versionText, type ChatHead, type ChatVersionMade } from '../files/place-output'
import { PLACE_WORDS } from '../files/places'
import { parsePlace } from '@mycel/shared/places'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { fileShareUrl } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { ext, officeWorkerWrite } from '../files/extract'
import {
  frame, OFFICE_EDIT_LIMITS, OFFICE_EDIT_MAX, OFFICE_EDIT_MODE, OFFICE_VERIFY_MODE, unframe, type EditReport, type OfficeKind,
} from '../files/office-edit-check'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { entryData, readCentral, ZipProblem } from '../files/zip-guard'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { inSkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { checkRegular } from '../team-files/place'
import { imageSlot } from '../files/vision'
import { makeWorkDir, runIsolated } from './isolate'
import { confirmNotOwnPictures, pictureAlwaysKey } from './own-picture'
import { isOwnUpload } from '../files/own-upload'
import type { Locale } from '@mycel/shared/api'
import { cellValue, confirmSources, placeProduced } from './make-file'
import type { ToolRegistry } from './registry'
import { editOfficeOutput } from './make-file-path'

export const EDIT_OFFICE_TOOL = 'edit_office'
const text = (max: number) => z.string().max(max)
const occ = { occurrence: z.number().int().min(1).max(100_000).optional().describe('Which place (1-based, reading order) when the text is in several'), all: z.boolean().optional().describe('Every place the text is in') }
const cellV = z.union([z.string().max(32_767), z.number(), z.boolean(), z.null()])
const picturePlace = {
  x_mm: z.number().min(-5000).max(5000).optional().describe('PowerPoint: from the left edge of the slide to the picture\'s left edge'),
  y_mm: z.number().min(-5000).max(5000).optional().describe('PowerPoint: from the top edge of the slide to the picture\'s top edge'),
  center: z.boolean().optional().describe('PowerPoint: centred on the slide'),
  offset_x_mm: z.number().min(0).max(5000).optional().describe('Excel: right of the cell\'s left edge'),
  offset_y_mm: z.number().min(0).max(5000).optional().describe('Excel: below the cell\'s top edge'),
}
export const EditOfficeInput = z.strictObject({
  file_path: z.string().min(1).max(1000).describe('The .docx, .xlsx or .pptx to change (read it in this chat first): a team path, or a chat file chat:files/<file_id>/<name>'),
  changes: z.array(z.union([
    z.strictObject({
      find: text(5000).min(1).describe('Exact text from ONE paragraph (Word, PowerPoint), as read shows it, without Markdown marks'),
      replace: text(20_000).describe('The new text; it takes the formatting of the text it replaces'),
      slide: z.number().int().min(1).max(10_000).optional().describe('PowerPoint: only on this slide'),
      ...occ,
    }),
    z.strictObject({ insert_paragraph: z.strictObject({ after: text(5000).min(1).optional(), before: text(5000).min(1).optional(), text: text(20_000), occurrence: occ.occurrence }).describe('Word: new paragraphs (one per line) after or before the paragraph holding this text, in its style') }),
    z.strictObject({ delete_paragraph: z.strictObject({ text: text(5000).min(1), occurrence: occ.occurrence }).describe('Word: delete the paragraph holding this text') }),
    z.strictObject({ table_cell: z.strictObject({ table: z.number().int().min(1), row: z.number().int().min(1), column: z.number().int().min(1), value: text(20_000) }).describe('Word: set a table cell\'s text (1-based; tables in reading order)') }),
    z.strictObject({ add_rows: z.strictObject({ table: z.number().int().min(1), after_row: z.number().int().min(1), rows: z.array(z.array(text(20_000)).max(200)).min(1).max(500) }).describe('Word: new rows after row after_row, in its look') }),
    z.strictObject({ delete_rows: z.strictObject({ table: z.number().int().min(1), rows: z.array(z.number().int().min(1)).min(1).max(500) }).describe('Word: delete table rows') }),
    z.strictObject({ cell: z.strictObject({ sheet: text(200).optional().describe('Sheet name (default: the first sheet)'), ref: text(20).min(2).describe('Cell address such as B7'), value: cellV.describe('A number, text, true/false, null to empty it, or a formula starting with "=" ("\'=" keeps text)') }).describe('Excel: set one cell; it keeps its style') }),
    z.strictObject({ append_rows: z.strictObject({ sheet: text(200).optional(), rows: z.array(z.array(cellV).max(1000)).min(1).max(5000) }).describe('Excel: rows after the last row, from the column where the last row starts, in the last row\'s style') }),
    z.strictObject({ shape_text: z.strictObject({ slide: z.number().int().min(1), shape: z.union([text(200).min(1), z.number().int().min(1)]).describe('"title", "subtitle", "body", the shape\'s name, or its number among the slide\'s text shapes'), text: text(20_000).describe('One paragraph per line') }).describe('PowerPoint: set the whole text of one shape') }),
    z.strictObject({ duplicate_slide: z.strictObject({ slide: z.number().int().min(1), after: z.number().int().min(0).optional().describe('Put the copy after this slide (0 = first; default: right after the slide)') }) }),
    z.strictObject({ add_slide: z.strictObject({ layout: text(200).min(1).describe('A layout name of the deck, e.g. "Title and Content"'), after: z.number().int().min(0).optional().describe('Default: at the end'), title: text(5000).optional(), body: text(20_000).optional().describe('One paragraph per line') }) }),
    z.strictObject({ replace_picture: z.strictObject({ slide: z.number().int().min(1), picture: z.union([text(200).min(1), z.number().int().min(1)]).describe('The picture\'s name or its number on the slide'), image: z.string().min(1).max(1000).describe('A PNG, JPEG or WebP picture: a team path, or a chat file chat:files/<file_id>/<name>') }).describe('PowerPoint: the picture shows a new image, fitted into its frame') }),
    z.strictObject({ insert_picture: z.strictObject({
      image: z.string().min(1).max(1000).describe('A PNG, JPEG or WebP picture (a signature, a seal, a logo): a team path, or a chat file chat:files/<file_id>/<name>'),
      slide: z.number().int().min(1).optional().describe('PowerPoint: the slide (required there)'),
      sheet: text(200).optional().describe('Excel: the sheet (default: the first sheet)'),
      cell: text(20).min(2).optional().describe('Excel: the cell its top-left corner is tied to, e.g. B7 (required there)'),
      ...picturePlace,
      over: text(5000).min(1).optional().describe('Floats the picture behind this text, centred on it: a seal or signature over "(seal)" or "(signature)" on a form'),
      after: text(5000).min(1).optional().describe('Puts the picture in the line right after this text'),
      next_to: text(5000).min(1).optional().describe('Puts the picture into the table cell right of the cell holding this text (a form row "Signature | ")'),
      occurrence: occ.occurrence,
      width_mm: z.number().min(1).max(300).optional().describe('Width in mm; the picture keeps its shape (a seal is usually 15-20, a signature 30-40)'),
      height_mm: z.number().min(1).max(300).optional().describe('Height in mm; with width_mm, the picture fits inside both. Neither: 20 mm wide, at most 20 mm high'),
      behind_text: z.boolean().optional().describe('after / next_to: float behind the text instead of taking room in the line'),
    }).describe('A new picture. Word: at a label (exactly one of over, after, next_to: exact text of one paragraph of the body, as read shows it). PowerPoint: slide, with x_mm and y_mm from the top-left corner (without them, centred). Excel: cell, with an optional offset') }),
    z.strictObject({ move_picture: z.strictObject({
      picture: z.union([text(200).min(1), z.number().int().min(1)]).describe('The picture\'s name or its number on the slide or sheet'),
      slide: z.number().int().min(1).optional().describe('PowerPoint: the slide it is on (required there)'),
      sheet: text(200).optional().describe('Excel: the sheet it is on (default: the first sheet)'),
      cell: text(20).min(2).optional().describe('Excel: the new cell for its top-left corner'),
      ...picturePlace,
      width_mm: z.number().min(1).max(5000).optional().describe('New width; alone it keeps the picture\'s shape'),
      height_mm: z.number().min(1).max(5000).optional().describe('New height; with width_mm, the picture fits inside both'),
    }).describe('PowerPoint, Excel: move or resize a picture the file has; what you leave out stays') }),
  ])).min(1).max(OFFICE_EDIT_LIMITS.changes).describe('Applied together, each to the file as you read it (slide, table and row numbers as read; never the result of another change in the same call)'),
  output: z.string().min(1).max(1000).optional().describe('Save as a new file (same format) instead of a new version of file_path'),
})
type Input = z.output<typeof EditOfficeInput>

export const EDIT_OFFICE_DESCRIPTION =
  'Change an existing Word (.docx), Excel (.xlsx) or PowerPoint (.pptx) file in place: everything you do not change (styles, fonts, pictures, charts, ' +
  'comments, tracked changes, other sheets and slides) stays exactly as it was. Use it whenever the person wants an existing Office file changed; ' +
  'use make_file only for a new file or when they ask to rebuild one. Read the file in this chat first. ' +
  'Word: find/replace (exact text of one paragraph), insert_paragraph, delete_paragraph, table_cell, add_rows, delete_rows, ' +
  'insert_picture (a signature, seal or logo picture at a label: over floats it behind the text, centred, which keeps the layout, e.g. a seal over "(seal)" next to a name; ' +
  'after puts it in the line after the text; next_to puts it into the table cell right of the label). When someone asks to sign or stamp a Word document, use insert_picture, never a rebuilt document, ' +
  'with the person\'s own signature or seal (one they sent or keep in their own folder) or the picture they name; never pick someone else\'s signature or seal, or the company\'s, on your own: ask which picture to use. ' +
  'Excel: cell (one cell: number, text, true/false, null, or a formula starting with "="), append_rows (after the last row), insert_picture at a cell, move_picture; rows are never inserted in the middle. ' +
  'Formulas are calculated when the file is opened in Excel or LibreOffice. ' +
  'PowerPoint: find/replace (optionally on one slide), shape_text, duplicate_slide, add_slide (from a layout), replace_picture, insert_picture (slide + x/y mm, or centred), move_picture (read the slide as an image, then move or resize the same picture). ' +
  'Pictures (insert_picture, replace_picture) are PNG, JPEG or WebP files in the team folder or this chat. ' +
  'Slide, table and row numbers are as you read them, never after another change in the same call. When a change cannot be made exactly, ' +
  'nothing is saved and the reason says what to give instead (shape, layout and picture names are listed there). ' +
  'Without `output` the result is a new version of the same file (the previous one stays in its history). ' +
  'A file of this chat (chat:files/<file_id>/<name>) is changed the same way: without `output` it gets a new version, opened from the same file in the chat, and the earlier version stays (read with versions: true). ' +
  'Every call that changes a file saves it: never call it just to try something out. It cannot change speaker notes, charts, tables in a deck, comments or anything not listed here: say so in plain words ("I can\'t add speaker notes to this deck here"), never naming this tool, instead of calling it.'

const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): Record<Locale, string> => ({ ko, en, id, ja, es, zh })
/** the card before a picture that is not the asker's own goes into a document (a signature or seal someone else sent,
 * or one outside their own folder): independent review of #448 */
const KIND: Record<string, OfficeKind> = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' }
/** a replacement picture: these names only, at most 20 MB each and PICTURES_TOTAL_MAX together in one call */
const PICTURE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])
export const PICTURES_TOTAL_MAX = 40 * 1024 * 1024
/** Adds a picture's bytes to a call's total, both as read and as the image helper wrote it again (a re-encoded picture
 * can be larger than its file, QA TC-4965); over PICTURES_TOTAL_MAX the call is refused. */
export function countPictureBytes(total: { read: number; made: number }, kind: 'read' | 'made', n: number, i: number, max = PICTURES_TOTAL_MAX): void {
  total[kind] += n
  if (total[kind] > max) throw new ToolError(`change ${i + 1}: the new pictures together are larger than ${max / 1024 / 1024} MB${kind === 'made' ? ' once they are prepared for the deck' : ''}; replace fewer pictures in one call`)
}

/**
 * A replacement picture decoded and written again by the isolated image helper (`mycel-safeops resize`, as
 * resize_images uses it: same size, details removed, upright; PNG and WebP become PNG, JPEG stays JPEG), so the deck
 * gets only pixels the helper made, never bytes that only start like a picture (security review of #1291).
 */
export async function reencodePicture(ctx: AppContext, bytes: Uint8Array, rel: string, i: number, signal?: AbortSignal, jpeg = /^jpe?g$/.test(ext(rel))): Promise<Buffer> {
  const helper = ctx.files.visionTools().normalizer
  if (!helper) throw new ToolError(`change ${i + 1}: pictures cannot be replaced on this server right now (its image helper is missing); nothing was saved`)
  // details none (2) + format (1 JPEG, 2 PNG) * 4 + upright (16); the longest side 65535 never makes it smaller
  const r = await imageSlot(() => runIsolated({
    cmd: helper, args: ['resize', '65535', '0', '0', '0', String(2 + 4 * (jpeg ? 1 : 2) + 16)], stdin: bytes,
    timeoutMs: 60_000, maxRssMiB: 1536, maxStdout: 48 * 1024 * 1024, signal, env: { GOMAXPROCS: '2', GOMEMLIMIT: '800MiB' },
  }), signal)
  if (r.killed === 'aborted') signal?.throwIfAborted()
  const out = r.stdout
  const ok = jpeg ? out.length > 3 && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff : out.length > 8 && out.readUInt32BE(0) === 0x89504e47
  if (r.killed || r.code !== 0 || !ok) throw new ToolError(`change ${i + 1}: '${rel}' could not be read as a picture (${r.killed ? 'too large or too slow to read' : (r.stderr.trim().split('\n')[0] ?? '').replace(/^resize: /, '') || 'damaged'}); nothing was saved`)
  return out
}
/** where an `output` saves: the source's format (make-file-path.ts, so the shared chat's save card weighs the same path) */
export { editOfficeOutput }

/** the parts an edit of each kind may change, add or remove; everything else must keep its bytes */
const MAY: Record<OfficeKind, { changed: RegExp; added: RegExp | null; removed: RegExp | null }> = {
  docx: { changed: /^word\/[^/]+\.xml$/, added: null, removed: null },
  xlsx: { changed: /^(xl\/(workbook\.xml|worksheets\/[^/]+\.xml|tables\/[^/]+\.xml|_rels\/workbook\.xml\.rels)|\[Content_Types\]\.xml)$/, added: null, removed: /^xl\/calcChain\.xml$/ },
  pptx: { changed: /^(ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels)|\[Content_Types\]\.xml)$/, added: /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|media\/image\d+\.(png|jpeg|gif))$/, removed: null },
}

/** a .docx call with insert_picture may also change the document's relationships and the content types and add pictures
 * (the relationships part is added when the document had none) */
const XLSX_PICTURES = {
  changed: /^(xl\/(workbook\.xml|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.xml\.rels|tables\/[^/]+\.xml|drawings\/[^/]+\.xml|drawings\/_rels\/[^/]+\.xml\.rels|_rels\/workbook\.xml\.rels)|\[Content_Types\]\.xml)$/,
  added: /^xl\/(media\/image\d+\.(png|jpeg|gif)|drawings\/drawing\d+\.xml|drawings\/_rels\/drawing\d+\.xml\.rels|worksheets\/_rels\/[^/]+\.xml\.rels)$/,
  removed: /^xl\/calcChain\.xml$/,
}
const DOCX_PICTURES = {
  changed: /^(word\/[^/]+\.xml|word\/_rels\/document\.xml\.rels|\[Content_Types\]\.xml)$/,
  added: /^word\/(media\/image\d+\.(png|jpeg)|_rels\/document\.xml\.rels)$/,
  removed: null,
}

/** Why the new zip is not the old one with only the reported parts changed, or null. Reads only the two central
 * directories and compares compressed bytes: nothing is expanded in this process. `pictures`: the call puts new
 * pictures into a .docx (DOCX_PICTURES). */
export function officePartsMismatch(kind: OfficeKind, a: Uint8Array, b: Uint8Array, r: Pick<EditReport, 'changed' | 'added' | 'removed'>, pictures = false): string | null {
  let ea: ReturnType<typeof readCentral>, eb: ReturnType<typeof readCentral>
  try { ea = readCentral(a); eb = readCentral(b) } catch (e) { return e instanceof ZipProblem ? `the zip: ${e.why}` : 'the zip' }
  const name = (e: (typeof ea)[number]) => new TextDecoder().decode(e.nameBytes)
  const A = new Map(ea.map((e) => [name(e), e])), B = new Map(eb.map((e) => [name(e), e]))
  // two entries with one name: readers disagree about which one is the part
  if (A.size !== ea.length) return 'the original has two parts with one name'
  if (B.size !== eb.length) return 'the result has two parts with one name'
  const may = pictures && kind === 'docx' ? DOCX_PICTURES : pictures && kind === 'xlsx' ? XLSX_PICTURES : MAY[kind]
  for (const n of r.changed) if (!may.changed.test(n) || !A.has(n) || !B.has(n)) return `a part that is not changed here: ${n}`
  for (const n of r.added) if (!may.added?.test(n) || A.has(n) || !B.has(n)) return `a part that is not added here: ${n}`
  for (const n of r.removed) if (!may.removed?.test(n) || !A.has(n) || B.has(n)) return `a part that is not removed here: ${n}`
  const changed = new Set(r.changed), added = new Set(r.added), removed = new Set(r.removed)
  for (const n of B.keys()) if (!A.has(n) && !added.has(n)) return `a new part ${n}`
  for (const [n, e] of A) {
    if (changed.has(n) || removed.has(n)) continue
    const f = B.get(n)
    if (!f) return `the part ${n} is missing`
    if (f.method !== e.method || f.crc !== e.crc || f.csize !== e.csize || f.usize !== e.usize) return `the part ${n} changed`
    if (!Buffer.from(entryData(a, e)).equals(Buffer.from(entryData(b, f)))) return `the part ${n} changed`
  }
  return null
}

export interface EditedOffice { path: string; size: number; sha256: string; conflictCopyOf?: string; source: string; inPlace: boolean; report: EditReport; kind: OfficeKind; chatVersion?: ChatVersionMade; look?: string }

/** edit_office's document when it is a chat file: in place (no output) the chain's head as a new version's writer may
 * have it (ChatPlaces.head), else a server-only copy read through the resolver (readPlaceFile). `rel` is its chat place
 * path (the read-before-write key: chat:files/<id>/<name>), `bytes` what the tool works on. */
export async function chatSource(ctx: AppContext, c: ToolCtx, a: { file_path: string; output?: string }, place: NonNullable<ReturnType<typeof parsePlace>>, tool = 'edit_office', maxBytes = OFFICE_EDIT_MAX): Promise<{ rel: string; abs: string; st?: fs.Stats; bytes: Buffer; head?: ChatHead }> {
  if (place.kind !== 'chatFiles' || (!place.id && !place.name)) throw new ToolError(`${tool} changes a team file or one of this chat's files (chat:files/<file_id>/<name>)`, 'bad_place')
  if (!c.places) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
  if (a.output === undefined) {
    const head = c.places.head(place.id, place.name ?? '')
    if (head.quarantined) throw new ToolError(`'${head.name}' is held by the team's safety check, so it is not changed`, 'held')
    if (head.size > maxBytes) throw new ToolError(`'${head.name}' is larger than ${maxBytes / 1024 / 1024} MB, too large to change here`)
    return { rel: head.path, abs: head.abs, bytes: readRegular(head.abs, maxBytes).bytes, head }
  }
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const f = await readPlaceFile(ctx, c, a.file_path, maxBytes, work)
    return { rel: f.place, abs: f.local, bytes: readRegular(f.local, maxBytes).bytes }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** Excel values as make_file reads them (tools/make-file.ts cellValue): "1,234" a number, "007" text, a formula checked
 * (nothing that reaches outside the workbook), "=3 days" text. */
function excelValue(v: unknown, i: number): unknown {
  if (typeof v !== 'string') return v
  const cv = cellValue(v)
  if (typeof cv === 'number') return cv
  if (typeof cv === 'string') return cv.trim().startsWith('=') ? `'${cv}` : cv
  if ('error' in cv) throw new ToolError(`change ${i + 1}: ${cv.error}; nothing was saved. Start the value with '= to keep it as text.`)
  return `=${cv.formula}`
}

/** The fields of a picture change that fit this kind of file; the error names what to give. */
function pictureTarget(kind: OfficeKind, p: Record<string, unknown>, move: boolean, i: number) {
  const fields: Record<OfficeKind, string[]> = {
    docx: ['over', 'after', 'next_to', 'occurrence', 'behind_text'],
    pptx: ['slide', 'x_mm', 'y_mm', 'center'],
    xlsx: ['sheet', 'cell', 'offset_x_mm', 'offset_y_mm'],
  }
  if (move && kind === 'docx') throw new ToolError(`change ${i + 1}: move_picture is for PowerPoint decks and Excel workbooks`)
  const wrong = Object.keys(fields).flatMap((k) => (k === kind ? [] : fields[k as OfficeKind])).filter((f) => p[f] !== undefined)
  if (wrong.length) throw new ToolError(`change ${i + 1}: ${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not for this kind of file; here a picture takes ${fields[kind].join(', ')}`)
  if (kind === 'pptx' && p.slide === undefined) throw new ToolError(`change ${i + 1}: give the slide`)
  if (kind === 'xlsx' && !move && p.cell === undefined) throw new ToolError(`change ${i + 1}: give the cell, e.g. B7`)
}

export async function editOffice(ctx: AppContext, c: ToolCtx, a: Input): Promise<EditedOffice> {
  const files = componentC(ctx).files
  const fx = files.fx
  // a chat file (chat:files/…, P4): without output it gets a new version (ChatPlaces.head / version: who may, the file
  // there); with an output a new file is made from it (its bytes through the resolver's one safe open)
  const chatSrc = parsePlace(a.file_path)
  const src = chatSrc ? await chatSource(ctx, c, a, chatSrc) : authorize(fx, files.rules(), c.user, a.file_path, 'read')
  if (src.st?.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  const kind = KIND[ext(src.rel)]
  if (!kind) throw new ToolError(`edit_office changes .docx, .xlsx and .pptx files only${/^(doc|xls|ppt|odt|ods|odp)$/.test(ext(src.rel)) ? ' (this older or OpenDocument format cannot be changed here; offer to make a new .docx, .xlsx or .pptx with make_file)' : ''}; use edit for text files, edit_hwp for Hangul documents and make_file for new documents`)
  if (checkRegular(src.abs).size > OFFICE_EDIT_MAX) throw new ToolError(`'${src.rel}' is larger than ${OFFICE_EDIT_MAX / 1024 / 1024} MB, too large to change here`)
  const { bytes } = 'bytes' in src ? { bytes: src.bytes } : readRegular(src.abs, OFFICE_EDIT_MAX, src.st)
  const seen = c.files.readHashes.get(src.rel)
  if (!seen) throw new ToolError(`read '${src.rel}' first (with read) before changing it`, 'not_read')
  if (seen !== sha256(bytes)) throw new ToolError(`'${src.rel}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
  const outRel = a.output === undefined ? src.rel : editOfficeOutput(a.output, src.rel)
  if (inSkills(outRel)) throw new ToolError('Office files cannot be saved in a skills folder (skills/: skills and rules people\'s AI follow); give another output')
  const head = 'head' in src ? src.head : null
  const out = head ? { rel: head.path, segs: ['chat:files', head.id, head.name], exists: false, st: undefined } : authorizeOutput(fx, files.rules(), c, outRel, { mustExist: a.output === undefined, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`, 'is_folder')
  const inPlace = out.rel === src.rel

  // the changes as the worker gets them: Excel values read as make_file reads them, pictures as their bytes
  const images: Buffer[] = []
  const imagePaths: string[] = []
  /** each picture read once, however many changes name it; all of them together bounded */
  const imageIndex = new Map<string, number>()
  const imageBytes = { read: 0, made: 0 }
  const changes: unknown[] = []
  /** a picture's index among the call's re-encoded pictures: a team file (read access as the person), or a file of this
   * chat (read through its place's one safe open); each sized, quarantine-checked and re-encoded before the worker */
  const picWork: string[] = []
  /** inserted pictures that are not the asker's own upload (files/own-upload.ts), each with the name its card shows:
   * a team file's full path, a chat file's name */
  const notMine = new Map<string, string>()
  const ownPic = new Map<string, boolean>()
  const picture = async (p: string, i: number, insert = false): Promise<number> => {
    let rel: string, raw: Uint8Array
    const place = parsePlace(p)
    if (place) {
      if (place.kind !== 'chatFiles') throw new ToolError(`change ${i + 1}: a picture is a team file or a file of this chat (chat:files/<file_id>/<name>); copy it there first`, 'bad_place')
      const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
      picWork.push(work)
      const f = await readPlaceFile(ctx, c, p, OFFICE_EDIT_LIMITS.imageBytes, work)
      rel = f.place
      const known = imageIndex.get(rel)
      if (known !== undefined) { if (insert && !ownPic.get(rel)) notMine.set(rel, f.name); return known }
      if (!PICTURE_EXT.has(ext(f.name))) throw new ToolError(`change ${i + 1}: '${f.name}' is not a PNG, JPEG or WebP picture; give one of those`)
      countPictureBytes(imageBytes, 'read', f.size, i)
      raw = readRegular(f.local, OFFICE_EDIT_LIMITS.imageBytes).bytes
      fs.rmSync(f.local, { force: true })
      // judged on the very bytes that go into the document (the place path names the chain, its read is the newest version)
      const at = parsePlace(rel)
      ownPic.set(rel, isOwnUpload(ctx.db, c.user.id, { chatFile: at?.kind === 'chatFiles' ? at.id ?? '' : '', sha256: sha256(raw) }))
      if (insert && !ownPic.get(rel)) notMine.set(rel, f.name)
    } else {
      const img = authorize(fx, files.rules(), c.user, p, 'read')
      if (img.st!.isDirectory()) throw new ToolError(`'${img.rel}' is a folder`, 'is_folder')
      rel = img.rel
      const known = imageIndex.get(rel)
      if (known !== undefined) { if (insert && !ownPic.get(rel)) notMine.set(rel, rel); return known }
      if (!PICTURE_EXT.has(ext(rel))) throw new ToolError(`change ${i + 1}: '${rel}' is not a PNG, JPEG or WebP picture; give one of those`)
      const size = checkRegular(img.abs).size
      if (size > OFFICE_EDIT_LIMITS.imageBytes) throw new ToolError(`change ${i + 1}: the picture is larger than ${OFFICE_EDIT_LIMITS.imageBytes / 1024 / 1024} MB`)
      countPictureBytes(imageBytes, 'read', size, i)
      raw = readRegular(img.abs, OFFICE_EDIT_LIMITS.imageBytes, img.st).bytes
      // judged on the very bytes that go into the document
      ownPic.set(rel, isOwnUpload(ctx.db, c.user.id, { team: rel, sha256: sha256(raw) }))
      if (insert && !ownPic.get(rel)) notMine.set(rel, rel)
    }
    ctx.files.quarantine.assertBytes(raw)
    const made = await reencodePicture(ctx, raw, rel, i, c.signal)
    countPictureBytes(imageBytes, 'made', made.length, i)
    images.push(made)
    imagePaths.push(rel)
    imageIndex.set(rel, images.length - 1)
    return images.length - 1
  }
  try {
  for (const [i, ch] of a.changes.entries()) changes.push(await (async () => {
    const x = ch as Record<string, any>
    if (kind !== 'xlsx' && (x.cell || x.append_rows)) throw new ToolError(`change ${i + 1}: cell and append_rows are for Excel workbooks`)
    if (kind !== 'docx' && (x.insert_paragraph || x.delete_paragraph || x.table_cell || x.add_rows || x.delete_rows)) throw new ToolError(`change ${i + 1}: ${Object.keys(x)[0]} is for Word documents`)
    const pic = x.insert_picture ?? x.move_picture
    if (pic) pictureTarget(kind, pic, !!x.move_picture, i)
    if (kind !== 'pptx' && (x.shape_text || x.duplicate_slide || x.add_slide || x.replace_picture || x.slide !== undefined)) throw new ToolError(`change ${i + 1}: ${x.slide !== undefined ? 'slide' : Object.keys(x)[0]} is for PowerPoint decks`)
    if (kind === 'xlsx' && typeof x.find === 'string') throw new ToolError(`change ${i + 1}: in a workbook, set cells with cell (find and replace is for Word and PowerPoint)`)
    if (x.cell) return { cell: { ...x.cell, value: excelValue(x.cell.value, i) } }
    if (x.append_rows) return { append_rows: { ...x.append_rows, rows: x.append_rows.rows.map((r: unknown[]) => r.map((v) => excelValue(v, i))) } }
    for (const key of ['replace_picture', 'insert_picture'] as const) {
      if (!x[key]) continue
      return { [key]: { ...x[key], image: await picture(String(x[key].image), i, key === 'insert_picture') } }
    }
    return x
  })())
  } finally { for (const w of picWork) fs.rmSync(w, { recursive: true, force: true }) }
  // the card comes before the worker's real run here: a target that cannot be resolved (several sign marks, a hidden
  // mark) is refused first, so nobody approves a call that then fails. The result of this run is dropped
  if (notMine.size) await officeWorkerWrite(OFFICE_EDIT_MODE, frame({ kind, changes }, [bytes, ...images]), c.signal)
  // a signature or seal that is not the asker's own goes in only after their yes on a card (never on the AI's choice)
  await confirmNotOwnPictures(ctx, c, [...notMine].map(([rel, name]) => ({ name, key: pictureAlwaysKey(rel) })), src.rel)
  // what the chat read, the document (for a new file) and a new picture may go where more people see them: asked before
  // the worker runs, in place too, as comment_docx does
  await confirmSources(ctx, files, c, out.rel, out.segs, [...(inPlace ? [] : [src.rel]), ...imagePaths])

  const answer = await officeWorkerWrite(OFFICE_EDIT_MODE, frame({ kind, changes }, [bytes, ...images]), c.signal)
  let report: EditReport, file: Uint8Array
  try {
    const r = unframe<EditReport>(answer)
    report = r.json
    file = r.blobs[0]!
    if (!file || !Array.isArray(report.notes) || !Array.isArray(report.changed) || !Array.isArray(report.added) || !Array.isArray(report.removed)) throw new Error('bad')
  } catch { throw new ToolError('the Office editor gave a damaged answer; nothing was saved') }
  const parts = officePartsMismatch(kind, bytes, file, report, a.changes.some((ch) => 'insert_picture' in ch || 'move_picture' in ch))
  if (parts) throw new ToolError(`the changed file did not read back as expected (${parts}); nothing was saved`)
  try {
    await officeWorkerWrite(OFFICE_VERIFY_MODE, frame({ kind, changed: report.changed, added: report.added, notes: report.notes, cells: report.cells ?? [], placed: report.placed ?? [] }, [bytes, file]), c.signal)
  } catch (e) {
    if (!(e instanceof ToolError)) throw e
    throw new ToolError(e.message.includes('nothing was saved') ? e.message : `the changed file did not pass the checks (${e.message.slice(0, 300)}); nothing was saved`)
  }

  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, `out.${kind}`)
    fs.writeFileSync(produced, file, { flag: 'wx', mode: 0o600 })
    if (head) {
      // the chat file's new version (ChatFiles.putVersion through the turn's chat places: every rule again, origin 'ai')
      c.user = ctx.files.principal(c.user.id)
      c.beforePlace?.()
      const v = await c.places!.version(head.id, { bytes: file }, seen, c.files)
      return { path: v.path, size: v.size, sha256: v.sha256, source: src.rel, inPlace: true, report, kind, chatVersion: v, look: pictureLook(kind, a, v.path) }
    }
    const made = await placeProduced(ctx, files, c, out.segs, produced, EDIT_OFFICE_TOOL)
    return { path: made.path, size: made.size, sha256: made.sha256, conflictCopyOf: made.conflictCopyOf, source: src.rel, inPlace, report, kind, look: pictureLook(kind, a, made.path) }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** after a picture was placed or moved: how the AI sees the result, or that it cannot */
function pictureLook(kind: OfficeKind, a: Input, file: string): string | undefined {
  const placed = a.changes.flatMap((ch) => { const x = ch as Record<string, { slide?: number } | undefined>; return x.insert_picture ?? x.move_picture ?? [] })
  if (!placed.length || kind === 'docx') return undefined
  if (kind === 'xlsx') return ' No picture of the sheet is drawn here, so where the picture landed has not been seen: say so, and ask the person to check it in Excel.'
  const shifted = a.changes.some((ch) => 'add_slide' in ch || 'duplicate_slide' in ch)
  const pages = shifted ? 'as_images: true' : `pages: "${[...new Set(placed.map((p) => p.slide))].join(',')}"`
  return ` To see it, read ${file} with ${pages}; if it is off, call move_picture with the same picture.`
}

const APP: Record<OfficeKind, string> = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' }
export function editOfficeText(r: EditedOffice): string {
  const link = `[${r.path.split('/').pop()}](${fileShareUrl(r.path, 'preview')})`
  const where = r.chatVersion ? versionText(r.chatVersion, 'Changed')
    : r.conflictCopyOf
    ? `'${r.conflictCopyOf}' was changed by someone else in the meantime, so the result was saved as '${r.path}' and the original left as it was. Tell the user about both.`
    : r.inPlace ? `Saved a new version of ${r.path}; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const q = (s: string) => JSON.stringify(s.length > 160 ? s.slice(0, 160) + '…' : s)
  const lines = r.report.notes.slice(0, 200).map((n) => {
    const after = n.after?.length ? n.after.filter((t) => t !== '').map(q).join(' / ') : ''
    return `- change ${n.change + 1}, ${n.where}${n.before !== undefined ? `: ${q(n.before)}${after ? ` -> ${after}` : ' (removed)'}` : after ? `: ${after}` : ''}`
  })
  if (r.report.notes.length > 200) lines.push(`- … and ${r.report.notes.length - 200} more`)
  const calc = r.kind === 'xlsx' && r.report.cells?.length ? ' Formulas are calculated again when the file is opened in Excel or LibreOffice; until then a preview shows a formula cell as its formula.' : ''
  return `${where}\n${lines.join('\n')}\nThe file was read back: the changes are there and everything else reads as before; the rest of the file is unchanged.${calc}${r.look ?? ` Layout in ${APP[r.kind]} is not checked.`}`
}

export function registerEditOffice(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: EDIT_OFFICE_TOOL,
    description: EDIT_OFFICE_DESCRIPTION,
    input: EditOfficeInput,
    describe: (a) => `${EDIT_OFFICE_TOOL} ${a.file_path}${a.output ? ` -> ${a.output}` : ''} (${a.changes.length} changes)`,
    async run(a, t) {
      const r = await editOffice(ctx, t, a)
      return {
        text: editOfficeText(r),
        summary: `${EDIT_OFFICE_TOOL} ${r.source} -> ${r.path} ${r.size}B ${a.changes.length} changes${r.inPlace ? ' (new version)' : ''}${r.conflictCopyOf ? ' (conflict copy)' : ''}`,
        structured: { path: r.path, size: r.size, sha256: r.sha256 },
      }
    },
  })
}
