// stamp_pdf: the AI puts an image (a company seal, a signature, a logo) on one page of an existing PDF the person may
// read and saves the result as a NEW file (owner 2026-11-16: a seal on a quote; docs/decisions/
// 20261116-edit-pdf.md). The PDF and the image are parsed only in the office worker (files/pdf-stamp.ts,
// pdf-lib); this process reads the files, checks access and places the result. Saved like every other AI save:
// - read access to the PDF and the image, write access where the result goes (checked again when it is placed,
//   team-files/place.ts), the same answer for a file that does not exist and one the person cannot open;
// - by default "<name> (stamped).pdf" next to the original, a free name, so nothing is overwritten; an `output` that
//   names an existing file becomes a new version only when the AI read that file in this turn, else a conflict copy
//   (make-file.ts placeProduced);
// - the new file carries the PDF's and the image's bytes: the wider-audience check of make_file (confirmSources), and
//   in a shared chat the read card before the call (chat/tools.ts);
// - under skills/ only after the person's card (placeProduced's skill approval; there is no card for this tool, so it
//   is refused there).
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { StampPdfInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale } from '../admin/settings'
import { ext, officeWorkerWrite } from '../files/extract'
import { decodeStampResult, encodeStampRequest, imageKind, PDF_STAMP_MODE, STAMP_DEFAULT_MARGIN_MM, STAMP_DEFAULT_WIDTH_MM, STAMP_IMAGE_MAX, STAMP_PDF_MAX, type StampReport } from '../files/pdf-stamp'
import type { ToolCtx } from '../files/service'
import { readRegular } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { checkRegular, freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { skillRootOf } from '../skills/guard'
import { makeWorkDir } from './isolate'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type Input = z.output<typeof StampPdfInput>
export interface StampedPdf extends MadeFile { source: string; image: string; report: StampReport }

/** the word in a default output name, in the team's language ("견적서 (날인).pdf") */
export const STAMPED: Record<Locale, string> = { ko: '날인', en: 'stamped', id: 'distempel', ja: '押印', es: 'sellado', zh: '盖章' }

/** Where a stamp goes when no `output` is given: next to the original, "<name> (stamped).pdf" with a free name. */
export function stampedName(dirAbs: string, source: string, locale: Locale): string {
  const base = source.replace(/\.pdf$/i, '')
  return freeName(dirAbs, `${base} (${STAMPED[locale] ?? STAMPED.en}).pdf`)
}

export const STAMP_PDF_DESCRIPTION = 'Put an image (a company seal, a signature, a logo) on one page of an existing PDF and save the result as a new PDF; ' +
  'the original stays as it is. The image is a PNG (its transparent parts stay see-through) or a JPG in the team folder. ' +
  'page: a number or "last" (default). position: "top-left", "top-right", "bottom-left", "bottom-right" (default) or "center", ' +
  'with margin_mm to the edges (default 15), or { x_mm, y_mm } for the image\'s top-left corner, measured from the top-left of the page as it is shown. ' +
  'width_mm: the image\'s width (default 30; a company seal is usually 20-40 mm); its height follows the image. ' +
  'The new file is "<name> (stamped).pdf" next to the original unless you give output. ' +
  'To find a spot (next to a name or "(seal)"), read that page with pages and as_images first; the page image shows the whole page. ' +
  'After stamping, read the new file\'s page with as_images to check the placement before you answer. ' +
  'It cannot change the text of a PDF; a PDF locked with a password cannot be stamped.'

/** Where stamp_pdf saves when `output` is given (trimmed, ".pdf" added when missing), or null (none given: a new name
 * next to the original, which only the tool works out). Also the target of its cards (chat/tools.ts widenOf, chat/turn.ts
 * fileChangeTarget), so a card names the file the tool writes. */
export function stampOutputOf(output: unknown): string | null {
  if (typeof output !== 'string' || output.trim() === '') return null
  const o = output.trim()
  return /\.pdf$/i.test(o) ? o : `${o.replace(/\/+$/, '')}.pdf`
}

export async function stampPdfFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input): Promise<StampedPdf> {
  const fx = files.fx
  const rules = files.rules()
  const src = authorize(fx, rules, c.user, a.file_path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  if (ext(src.rel) !== 'pdf') throw new ToolError(`stamp_pdf puts an image on a PDF; '${src.rel}' is not a .pdf`)
  if (checkRegular(src.abs).size > STAMP_PDF_MAX) throw new ToolError(`'${src.rel}' is larger than ${STAMP_PDF_MAX / 1024 / 1024} MB, too large to stamp here`)
  const img = authorize(fx, rules, c.user, a.image, 'read')
  if (img.st!.isDirectory()) throw new ToolError(`'${img.rel}' is a folder`, 'is_folder')
  if (checkRegular(img.abs).size > STAMP_IMAGE_MAX) throw new ToolError(`'${img.rel}' is larger than ${STAMP_IMAGE_MAX / 1024 / 1024} MB; use a smaller picture`)
  const pdf = readRegular(src.abs, STAMP_PDF_MAX, src.st).bytes
  const picture = readRegular(img.abs, STAMP_IMAGE_MAX, img.st).bytes
  ctx.files.quarantine.assertBytes(pdf)
  ctx.files.quarantine.assertBytes(picture)
  const kind = imageKind(picture)
  if (!kind) throw new ToolError(`'${img.rel}' is not a PNG or JPG picture; use a .png or .jpg file (a PNG keeps a transparent background)`)

  // where the result goes: `output` (with .pdf), else "<name> (stamped).pdf" next to the original
  let outRel: string
  const named = stampOutputOf(a.output)
  if (named !== null) {
    outRel = named
  } else {
    const dir = src.segs.slice(0, -1)
    const dirAbs = path.join(fx.root, ...dir)
    outRel = [...dir, stampedName(dirAbs, src.segs.at(-1)!, teamDefaultLocale(ctx.db))].join('/')
  }
  // write access where the result goes, before any work (checked again when it is placed)
  const out = authorize(fx, rules, c.user, outRel, 'write', { mustExist: false, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder; give output a file name ending in .pdf`, 'is_folder')
  if (skillRootOf(out.rel)) throw new ToolError('a stamped PDF is not saved in a skill folder; save it in a project or the person\'s own folder')
  if (out.rel === src.rel && !c.files.readHashes.has(src.rel)) {
    // never over the original unless the AI read it in this turn (then: a new version, the old one in its history)
    throw new ToolError(`output is the original '${src.rel}'; to replace it (its old version stays in its history), read it in this turn first. Otherwise leave output out to save a new file next to it`)
  }

  const answer = await officeWorkerWrite(PDF_STAMP_MODE, encodeStampRequest({
    page: a.page ?? 'last', position: a.position ?? 'bottom-right', width_mm: a.width_mm ?? STAMP_DEFAULT_WIDTH_MM,
    margin_mm: a.margin_mm ?? STAMP_DEFAULT_MARGIN_MM, image: kind,
  }, pdf, picture), c.signal)
  let r: ReturnType<typeof decodeStampResult>
  try { r = decodeStampResult(answer) } catch { throw new ToolError('the PDF stamper gave a damaged answer; nothing was saved') }
  if (r.file.length < 5 || Buffer.from(r.file.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ToolError('the PDF stamper gave a damaged answer; nothing was saved')

  // the new file carries the PDF's and the image's bytes: asked like make_file's sources
  if (out.rel !== src.rel) await confirmSources(ctx, files, c, out.rel, out.segs, [src.rel, img.rel])
  // over the original: the image's bytes still go where the PDF's readers see them
  else await confirmSources(ctx, files, c, out.rel, out.segs, [img.rel])
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, 'out.pdf')
    fs.writeFileSync(produced, r.file, { flag: 'wx', mode: 0o600 })
    const made = await placeProduced(ctx, files, c, out.segs, produced, 'stamp_pdf')
    return { ...made, source: src.rel, image: img.rel, report: r.report }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The tool result for the AI: where it went, where the image is, and how to check it. */
export function stampPdfText(r: StampedPdf, link: string): string {
  const x = r.report
  const where = r.conflictCopyOf
    ? `'${r.conflictCopyOf}' already exists and was not read in this turn, so the stamped PDF was saved as '${r.path}'. Tell the user about both.`
    : r.path === r.source ? `Saved a new version of ${r.path} with the image on it; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const at = `The image is on page ${x.page} of ${x.pages}: ${x.rectMm.width} x ${x.rectMm.height} mm, ${x.rectMm.x} mm from the left and ${x.rectMm.y} mm from the top (the page is ${x.pageMm.width} x ${x.pageMm.height} mm).`
  const check = `Check it before you answer: read '${r.path}' with pages: "${x.page}" and as_images: true, and look at where the image landed; if it covers text or sits in the wrong place, stamp the original again with another position and output: '${r.path}' (that replaces this copy instead of making another one).`
  const signed = x.signed ? ' The original PDF had a digital signature; tell the user that the stamped copy no longer carries a valid signature.' : ''
  return `${where}\n${at}\n${check}${signed}`
}
