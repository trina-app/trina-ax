// edit_hwp: the AI changes the text of an existing Hangul document (.hwpx or .hwp, the result in the same format) the
// person may write: fills placeholders and empty table cells, replaces exact text, adds table rows (files/hwpx-edit.ts
// and files/hwp-edit.ts, in the office worker: this process parses no document). Saved like every other AI save:
// - read first: the file must be the version the AI read in this turn (else: read it again);
// - the folder rules of the person, checked again right before the file is placed (team-files/place.ts);
// - without `output`, a new version of the same file: the old bytes go to the file history (file_versions) and the
//   change is the person's file event; if someone saved the file in the meantime, a conflict copy instead
//   (make-file.ts placeProduced, as make_file does); with `output`, a new file (an existing one the AI read is a new
//   version of it, one it did not read gets a conflict copy), and the document is a source of it: the wider-audience
//   check of make_file;
// - under skills/, the person's confirmation card first (chat/turn.ts confirmSkillWrite).
// - an image change (a signature or seal): the picture is a team file the person may read (authorize, as stamp_pdf), a
//   PNG or JPEG within PICTURE_LIMITS, not quarantined; the page layout comes from the HWP renderer (files/hwp-preview.ts
//   layout, the preview's renderer and turn-taking), so an image change needs the renderer to run here; the new file
//   carries the picture's bytes, so the picture is one of its sources even for a new version (confirmSources).
// The plain write and edit still refuse .hwp and .hwpx (files/service.ts BINARY_WRITE).
// Read back before anything is placed, without taking the editor's worker on its word: the containers must hold the
// same parts with the same bytes but the changed sections (a .hwpx: the two zip directories, hwpxPartsMismatch; a
// .hwp: the two compound files' directories and streams, read here without expanding anything, hwpPartsMismatch);
// hwp.ts reads the old and the new file in their own worker runs, as read and grep read them, and the new one must
// read as the old one with the worker's line edits, each edit what its changes make (hwpEditMismatch); and the new
// file passes every check of a document again in a fresh worker (mode hwpx-verify or hwp-verify).
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { EditHwpInput } from '@mycel/shared'
import type { AppContext } from '../context'
import { ext, officeWorkerText, officeWorkerWrite } from '../files/extract'
import {
  decodeHwpEditResult, encodeHwpEditRequest, isImageChange, type HwpEditExtra, HWP_EDIT_MAX, HWP_EDIT_MODE, HWP_VERIFY_MODE, HWPX_EDIT_MODE, HWPX_VERIFY_MODE, hwpEditMismatch,
  hwpOutputPath, hwpPartsMismatch, hwpxPartsMismatch, hwpxReadLines, encodeVerifyPictures, type HwpChange, type HwpEditReport,
} from '../files/hwpx-check'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { checkRegular } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir } from './isolate'
import { componentC } from '../team-files/component'
import { HwpError } from '../files/hwp-engine'
import { PICTURE_LIMITS } from '../files/hwp-picture'
import { imageKind } from '../files/pdf-stamp'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type Input = z.output<typeof EditHwpInput>
export interface EditedHwp extends MadeFile { source: string; inPlace: boolean; report: HwpEditReport }

export async function editHwpFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input): Promise<EditedHwp> {
  const fx = files.fx
  const src = authorize(fx, files.rules(), c.user, a.file_path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  const x = ext(src.rel)
  if (x !== 'hwpx' && x !== 'hwp') throw new ToolError('edit_hwp changes Hangul documents (.hwp and .hwpx) only; use edit for text files and make_file for new documents')
  if (checkRegular(src.abs).size > HWP_EDIT_MAX) throw new ToolError(`'${src.rel}' is larger than ${HWP_EDIT_MAX / 1024 / 1024} MB, too large to change here`)
  const { bytes } = readRegular(src.abs, HWP_EDIT_MAX, src.st)
  // the changes are found in the text the AI read: the file must still be that version
  const seen = c.files.readHashes.get(src.rel)
  if (!seen) throw new ToolError(`read '${src.rel}' first (with read) before changing it`, 'not_read')
  if (seen !== sha256(bytes)) throw new ToolError(`'${src.rel}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
  const outRel = a.output === undefined ? undefined : hwpOutputPath(a.output, src.rel)
  // the result keeps the document's format: a .hwp stays a .hwp (Hangul converts between them)
  if (outRel !== undefined && ext(outRel) !== x) throw new ToolError(`'${outRel}' would be a .${ext(outRel)}, but '${src.rel}' is a .${x} and stays one when it is changed; give output ending in .${x} (to have a .${ext(outRel)}, open the file in Hangul and save it as one)`)
  // write access where the result goes, before any work (checked again when it is placed)
  const out = authorize(fx, files.rules(), c.user, outRel ?? src.rel, 'write', { mustExist: outRel === undefined, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`, 'is_folder')
  const inPlace = out.rel === src.rel

  const changes = a.changes as HwpChange[]
  const binary = x === 'hwp'
  const pictures = await picturesOf(ctx, files, c, changes, bytes, x, src.rel)
  const answer = await officeWorkerWrite(binary ? HWP_EDIT_MODE : HWPX_EDIT_MODE, encodeHwpEditRequest(changes, bytes, pictures?.extra), c.signal)
  let r: ReturnType<typeof decodeHwpEditResult>
  try { r = decodeHwpEditResult(answer) } catch { throw new ToolError(`the .${x} editor gave a damaged answer; nothing was saved`) }
  // what came back is not taken on the worker's word: the same parts but the changed sections (the containers), the
  // text as hwp.ts reads both files in their own worker runs, and every check of a document again in a fresh one
  const added = (r.report.pictures ?? []).map((p) => p.part)
  if (added.length !== (pictures?.extra.images.length ?? 0) || new Set(added).size !== added.length) throw new ToolError('the changed document did not read back as expected (its pictures are not the ones asked for); nothing was saved')
  const parts = binary ? hwpPartsMismatch(bytes, r.file, added) : hwpxPartsMismatch(bytes, r.file, added)
  if (parts) throw new ToolError(`the changed document did not read back as expected (${parts}); nothing was saved`)
  const old = hwpxReadLines(await officeWorkerText(x, bytes, c.signal))
  const got = hwpxReadLines(await officeWorkerText(x, r.file, c.signal))
  const bad = hwpEditMismatch(changes, old, got, r.report)
  if (bad) throw new ToolError(`the changed document did not read back as expected (${bad}); nothing was saved`)
  // with pictures the fresh worker also compares the old and the new file: DocInfo / content.hpf only gained the
  // pictures' entries, and each new part is a clean PNG or JPEG
  try { await officeWorkerWrite(binary ? HWP_VERIFY_MODE : HWPX_VERIFY_MODE, added.length ? encodeVerifyPictures(bytes, r.file) : r.file, c.signal) } catch (e) {
    if (!(e instanceof ToolError)) throw e
    throw new ToolError(`the changed document did not pass the checks again (${e.message.slice(0, 300)}); nothing was saved`)
  }

  // a new file carries the document's bytes: asked like make_file's sources; a new version stays where it was. The
  // pictures' bytes go where the document's readers see them, a new version too (as stamp_pdf)
  const sources = [...(inPlace ? [] : [src.rel]), ...(pictures?.sources ?? [])]
  if (sources.length) await confirmSources(ctx, files, c, out.rel, out.segs, sources)
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, `out.${x}`)
    fs.writeFileSync(produced, r.file, { flag: 'wx', mode: 0o600 })
    const made = await placeProduced(ctx, files, c, out.segs, produced, 'edit_hwp')
    return { ...made, source: src.rel, inPlace, report: r.report }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The tool result for the AI: where it went, what changed, what is left to fill. */
export function editHwpFileText(r: EditedHwp, link: string): string {
  const where = r.conflictCopyOf
    ? `'${r.conflictCopyOf}' was changed by someone else in the meantime, so the result was saved as '${r.path}' and the original left as it was. Tell the user about both.`
    : r.inPlace ? `Saved a new version of ${r.path}; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const notes = r.report.notes.map((n) => `- ${n.also?.length ? 'changes' : 'change'} ${[n.change, ...(n.also ?? [])].map((c) => c + 1).join(', ')}, ${n.where}: ${n.before ? `${JSON.stringify(n.before)} -> ` : n.where.includes('after row') ? '' : 'was empty, now '}${JSON.stringify(n.after)}`)
  const left = r.report.placeholders.length ? `\nStill in the document: ${r.report.placeholders.join(', ')}.` : ''
  const pics = (r.report.pictures ?? []).map((p) => `- change ${p.change + 1}: a picture on page ${p.page}, ${p.widthMm} x ${p.heightMm} mm, ${p.xMm} mm from the left and ${p.yMm} mm from the top (${p.where})`)
  const check = pics.length ? `\nPictures:\n${pics.join('\n')}\nCheck each before you answer: look at the page with hwp_render and see where the picture landed; if it is off, change the original again with other width_mm / place (or output a new file). The file's own small preview picture (shown by some file browsers) is not redrawn.` : ''
  const body = notes.length ? `\n${notes.join('\n')}\nThe file was read back: the changed text is there and every other paragraph reads as before.` : '\nThe file was read back: every paragraph reads as before.'
  return `${where}${body} Layout in Hangul is not checked.${left}${check}`
}

/** The image changes' pictures and the page layout, or null without image changes: each picture read with the person's
 * read access, at most PICTURE_LIMITS (one, all together, how many), a PNG or JPEG by its bytes, not quarantined; the
 * layout from the HWP renderer, which must run here. */
async function picturesOf(ctx: AppContext, files: TeamFiles, c: ToolCtx, changes: HwpChange[], doc: Uint8Array, x: 'hwp' | 'hwpx', rel: string): Promise<{ extra: HwpEditExtra; sources: string[] } | null> {
  const which = changes.flatMap((ch, i) => (isImageChange(ch) ? [i] : []))
  if (!which.length) return null
  if (which.length > PICTURE_LIMITS.images) throw new ToolError(`more than ${PICTURE_LIMITS.images} pictures in one call; nothing was saved`)
  const read = new Map<string, Uint8Array>()
  const images: HwpEditExtra['images'] = []
  let total = 0
  for (const i of which) {
    const ch = changes[i] as Extract<HwpChange, { image: string }>
    const img = authorize(files.fx, files.rules(), c.user, ch.image, 'read')
    if (img.st!.isDirectory()) throw new ToolError(`'${img.rel}' is a folder`, 'is_folder')
    let b = read.get(img.rel)
    if (!b) {
      if (checkRegular(img.abs).size > PICTURE_LIMITS.imageBytes) throw new ToolError(`'${img.rel}' is larger than ${PICTURE_LIMITS.imageBytes / 1024 / 1024} MB; use a smaller picture (resize_images makes one)`)
      b = readRegular(img.abs, PICTURE_LIMITS.imageBytes, img.st).bytes
      ctx.files.quarantine.assertBytes(b)
      if (!imageKind(b)) throw new ToolError(`'${img.rel}' is not a PNG or JPG picture; use a .png or .jpg file (a PNG keeps a transparent background)`)
      total += b.length
      if (total > PICTURE_LIMITS.totalBytes) throw new ToolError(`the pictures of one call are larger than ${PICTURE_LIMITS.totalBytes / 1024 / 1024} MB together; use smaller ones`)
      read.set(img.rel, b)
    }
    images.push({ change: i, bytes: b })
  }
  let layout
  try { layout = await componentC(ctx).hwp.layout(c.user.id, Buffer.from(doc), x, c.signal) } catch (e) {
    if (!(e instanceof HwpError)) throw e
    const why = e.reason === 'disabled' || e.reason === 'engine' || e.reason === 'isolation'
      ? 'placing a picture needs the page layout from the HWP Preview renderer, which cannot run on this server (text changes still work); the person can put the picture in with Hangul'
      : `the page layout of '${rel}' could not be read (${e.reason})`
    throw new ToolError(`${why}; nothing was saved`)
  }
  return { extra: { layout, images }, sources: [...read.keys()] }
}
