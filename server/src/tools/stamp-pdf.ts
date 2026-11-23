// stamp_pdf: the AI puts an image (a company seal, a signature, a logo) on one page of an existing PDF the person may
// read and saves the result as a NEW file (owner 2026-11-16: a seal on a quote; docs/decisions/
// 20261116-edit-pdf.md). The PDF and the image are parsed only in the office worker (files/pdf-stamp.ts,
// pdf-lib); this process reads the files, checks access and places the result. Saved like every other AI save:
// - read access to the PDF and the image, write access where the result goes (checked again when it is placed,
//   team-files/place.ts), the same answer for a file that does not exist and one the person cannot open;
// - by default "<name> (stamped).pdf" next to the original, a free name, so nothing is overwritten; an `output` that
//   names an existing file becomes a new version only when the AI read that file in this turn, else a conflict copy
//   (make-file.ts placeProduced);
// - except a PDF the AI itself made in this turn and nobody changed since (madeThisTurn): without `output` the image
//   goes onto that file (a new version, the one without the image in its history). A quote made in the team's quotes
//   folder is stamped there, instead of an unstamped copy the AI had to park somewhere, often the person's own folder
//   (FL-08, 2026-11-17; docs/decisions/20261117-stamp-own-fresh-pdf.md);
// - the new file carries the PDF's and the image's bytes: the wider-audience check of make_file (confirmSources), and
//   in a shared chat the read card before the call (chat/tools.ts);
// - under skills/ only after the person's card (placeProduced's skill approval; there is no card for this tool, so it
//   is refused there).
import { authorizeOutput } from '../files/place-output'
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { StampPdfInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale } from '../admin/settings'
import { ext, officeWorkerWrite } from '../files/extract'
import { PDF_OUTPUT_MAX } from '../files/pdf-pages'
import { assertGuestOutput, PDF_GATE, pdfInputMax, tooLargeText } from '../files/big-inputs'
import { decodeStampResult, encodeStampRequest, imageKind, PDF_STAMP_MODE, STAMP_DEFAULT_MARGIN_MM, STAMP_DEFAULT_WIDTH_MM, STAMP_IMAGE_MAX, STAMP_PDF_MAX, type StampReport } from '../files/pdf-stamp'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { stampOutputOf } from './make-file-path'
import { ToolError } from '../policy/errors'
import { checkRegular, freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { skillRootOf } from '../skills/guard'
import { makeWorkDir } from './isolate'
import { assertNoStampAfterRefusal, planPdfAt, verifyPdfAt, type PdfLanding } from './pdf-at'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type Input = z.output<typeof StampPdfInput>
/** fresh: the image went onto the AI's own PDF of this turn (madeThisTurn), not into a copy */
export interface StampedPdf extends MadeFile { source: string; image: string; report: StampReport; fresh?: boolean; /** at: the text it landed on and the distance measured on the saved file */ landed?: PdfLanding }

/** the word in a default output name, in the team's language ("견적서 (날인).pdf") */
export const STAMPED: Record<Locale, string> = { ko: '날인', en: 'stamped', id: 'distempel', ja: '押印', es: 'sellado', zh: '盖章' }

/** Where a stamp goes when no `output` is given: next to the original, "<name> (stamped).pdf" with a free name. */
export function stampedName(dirAbs: string, source: string, locale: Locale): string {
  const base = source.replace(/\.pdf$/i, '')
  return freeName(dirAbs, `${base} (${STAMPED[locale] ?? STAMPED.en}).pdf`)
}

export const STAMP_PDF_DESCRIPTION = 'Put an image (a company seal, a signature, a logo) on one page of an existing PDF and save the result as a new PDF; ' +
  'the original stays as it is. A PDF you made in this turn (make_file) is the exception: without output the image goes onto that same file, ' +
  'and its version without the image stays in its history. So make the PDF where it belongs (the folder the skill or the person names) and stamp it there. The image is a PNG (its transparent parts stay see-through) or a JPG in the team folder. ' +
  'page: a number or "last" (default). position: "top-left", "top-right", "bottom-left", "bottom-right" (default) or "center", ' +
  'with margin_mm to the edges (default 15), or { x_mm, y_mm } for the image\'s top-left corner, measured from the top-left of the page as it is shown. ' +
  'width_mm: the image\'s width (default 30; a company seal is usually 20-40 mm); its height follows the image. ' +
  'Otherwise the new file is "<name> (stamped).pdf" next to the original unless you give output. ' +
  'To sign or seal at a printed mark, give at (the mark, or the signer\'s name and its mark on one line) instead of position: the tool measures the place and checks it on the saved file. If it refuses, ask the person which place; do not work out coordinates to get around it. ' +
  'For any other spot, read that page with pages and as_images first; the page image shows the whole page. ' +
  'After stamping, read the new file\'s page with as_images to check the placement before you answer. ' +
  'It cannot change the text of a PDF; a PDF locked with a password cannot be stamped.'

/**
 * A PDF the AI made in this turn (make_file or a PDF tool; not one it saved from the web or a room) whose bytes are
 * still the ones it wrote: its own fresh draft, which a stamp or a page edit without `output` changes in place rather than
 * leaving an unchanged copy next to the result. Anything else (a file it only read, one someone saved over since) is
 * the person's file and stays as it is.
 */
export function madeThisTurn(c: ToolCtx, rel: string, bytes: Uint8Array): boolean {
  const sha = sha256(bytes)
  // the bytes the turn made (a re-read after someone saved over it does not count) and this agent's own view of them
  return c.files.madeHashes.get(rel) === sha && c.files.readHashes.get(rel) === sha
}

/** Where stamp_pdf saves when `output` is given (trimmed, ".pdf" added when missing), or null (none given: a new name
 * next to the original, or the AI's own PDF of this turn itself, which only the tool works out). Also the target of its cards (chat/tools.ts widenOf, chat/turn.ts
 * fileChangeTarget), so a card names the file the tool writes. */
export { stampOutputOf }

export async function stampPdfFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input): Promise<StampedPdf> {
  const fx = files.fx
  const rules = files.rules()
  const src = authorize(fx, rules, c.user, a.file_path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  if (ext(src.rel) !== 'pdf') throw new ToolError(`stamp_pdf puts an image on a PDF; '${src.rel}' is not a .pdf`)
  // the PDF tools' limit on this server (lower where the office worker has less memory, files/big-inputs.ts)
  const max = Math.min(STAMP_PDF_MAX, pdfInputMax())
  const pdfSize = checkRegular(src.abs).size
  if (pdfSize > max) throw new ToolError(tooLargeText(src.rel, max, STAMP_PDF_MAX, 'a PDF to stamp'))
  const img = authorize(fx, rules, c.user, a.image, 'read')
  if (img.st!.isDirectory()) throw new ToolError(`'${img.rel}' is a folder`, 'is_folder')
  const imgSize = checkRegular(img.abs).size
  if (imgSize > STAMP_IMAGE_MAX) throw new ToolError(`'${img.rel}' is larger than ${STAMP_IMAGE_MAX / 1024 / 1024} MB; use a smaller picture`)
  // their room in the PDF tools' gate before the bytes are read, kept until the result is placed
  const release = await PDF_GATE.enter(pdfSize + imgSize, c.signal)
  try { return await stamp(ctx, files, c, a, src, img, max) } finally { release() }
}

async function stamp(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input, src: ReturnType<typeof authorize>, img: ReturnType<typeof authorize>, max: number): Promise<StampedPdf> {
  const fx = files.fx
  const rules = files.rules()
  const pdf = readRegular(src.abs, max, src.st).bytes
  const picture = readRegular(img.abs, STAMP_IMAGE_MAX, img.st).bytes
  ctx.files.quarantine.assertBytes(pdf)
  ctx.files.quarantine.assertBytes(picture)
  const kind = imageKind(picture)
  if (!kind) throw new ToolError(`'${img.rel}' is not a PNG or JPG picture; use a .png or .jpg file (a PNG keeps a transparent background)`)

  // where the result goes: `output` (with .pdf); else the AI's own PDF of this turn itself; else "<name> (stamped).pdf"
  // next to the original
  let outRel: string
  const fresh = madeThisTurn(c, src.rel, pdf)
  const named = stampOutputOf(a.output)
  if (named !== null) {
    outRel = named
  } else if (fresh) {
    outRel = src.rel
  } else {
    const dir = src.segs.slice(0, -1)
    const dirAbs = path.join(fx.root, ...dir)
    outRel = [...dir, stampedName(dirAbs, src.segs.at(-1)!, teamDefaultLocale(ctx.db))].join('/')
  }
  // write access where the result goes, before any work (checked again when it is placed)
  const out = authorizeOutput(fx, rules, c, outRel, { mustExist: false, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder; give output a file name ending in .pdf`, 'is_folder')
  if (skillRootOf(out.rel)) throw new ToolError('a stamped PDF is not saved in a skill folder; save it in a project or the person\'s own folder')
  if (out.rel === src.rel && !c.files.readHashes.has(src.rel)) {
    // never over the original unless the AI read it in this chat (then: a new version, the old one in its history)
    throw new ToolError(`output is the original '${src.rel}'; to replace it (its old version stays in its history), read it in this chat first. Otherwise leave output out to save a new file next to it`)
  }

  // `at`: the one proved place of the printed mark, or a refusal; a stamp by coordinates cannot step around that refusal
  if (a.at !== undefined && a.position !== undefined) throw new ToolError('give at or position, not both; nothing was saved')
  if (a.at === undefined && a.occurrence !== undefined) throw new ToolError('occurrence goes with at; nothing was saved')
  if (a.at === undefined) assertNoStampAfterRefusal(c)
  const planned = a.at !== undefined ? await planPdfAt(c, src.rel, pdf, picture, kind, { at: a.at, occurrence: a.occurrence, page: a.page, width_mm: a.width_mm }) : null
  const answer = await officeWorkerWrite(PDF_STAMP_MODE, encodeStampRequest({
    page: planned ? planned.page + 1 : a.page ?? 'last', position: planned?.position ?? a.position ?? 'bottom-right', width_mm: planned?.width_mm ?? a.width_mm ?? STAMP_DEFAULT_WIDTH_MM,
    margin_mm: a.margin_mm ?? STAMP_DEFAULT_MARGIN_MM, image: kind,
  }, pdf, picture), c.signal, PDF_OUTPUT_MAX)
  let r: ReturnType<typeof decodeStampResult>
  try { r = decodeStampResult(answer) } catch { throw new ToolError('the PDF stamper gave a damaged answer; nothing was saved') }
  if (r.file.length < 5 || Buffer.from(r.file.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ToolError('the PDF stamper gave a damaged answer; nothing was saved')
  // what was saved is what was planned: the same text everywhere, the picture drawn in its place
  const landed = planned ? await verifyPdfAt(c, planned, r.file) : undefined
  assertGuestOutput(ctx.db, c.user.id, r.file.length, out.rel)

  // the new file carries the PDF's and the image's bytes: asked like make_file's sources
  if (out.rel !== src.rel) await confirmSources(ctx, files, c, out.rel, out.segs, [src.rel, img.rel])
  // over the original: the image's bytes still go where the PDF's readers see them
  else await confirmSources(ctx, files, c, out.rel, out.segs, [img.rel])
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, 'out.pdf')
    fs.writeFileSync(produced, r.file, { flag: 'wx', mode: 0o600 })
    const made = await placeProduced(ctx, files, c, out.segs, produced, 'stamp_pdf')
    return { ...made, source: src.rel, image: img.rel, report: r.report, ...(fresh && made.path === src.rel ? { fresh: true } : {}), ...(landed ? { landed } : {}) }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The tool result for the AI: where it went, where the image is, and how to check it. */
export function stampPdfText(r: StampedPdf, link: string): string {
  const x = r.report
  const where = r.conflictCopyOf
    ? `'${r.conflictCopyOf}' already exists and was not read in this chat (or changed after the read), so the stamped PDF was saved as '${r.path}'. Tell the user about both.`
    : r.path === r.source ? `Saved a new version of ${r.path} with the image on it; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const at = `The image is on page ${x.page} of ${x.pages}: ${x.rectMm.width} x ${x.rectMm.height} mm, ${x.rectMm.x} mm from the left and ${x.rectMm.y} mm from the top (the page is ${x.pageMm.width} x ${x.pageMm.height} mm).`
  const on = r.landed ? `\nIt is on ${r.landed.on}: measured on the saved file, ${r.landed.mm} mm from the centre of that text. That text was matched from the PDF's text layer, which a file can state differently from what it draws, so say the person should check the name beside the seal.` : ''
  const redo = r.fresh
    ? `redo the steps that made the PDF (same output) and stamp it again with another position (stamping this file again would put a second image on it)`
    : `stamp the original again with another position and output: '${r.path}' (that replaces this copy instead of making another one)`
  const check = `Check it before you answer: read '${r.path}' with pages: "${x.page}" and as_images: true, and look at where the image landed; if it covers text or sits in the wrong place, ${redo}.`
  const signed = x.signed ? ` The original PDF had a digital signature; tell the user that the stamped ${r.path === r.source ? 'version' : 'copy'} no longer carries a valid signature.` : ''
  return `${where}\n${at}${on}\n${check}${signed}`
}
