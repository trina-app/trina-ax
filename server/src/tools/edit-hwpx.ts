// edit_hwpx: the AI changes the text of an existing Hangul document (.hwpx) the person may write: fills placeholders and
// empty table cells, replaces exact text, adds table rows (files/hwpx-edit.ts, in the office worker: this process
// parses no document). Saved like every other AI save:
// - read first: the file must be the version the AI read in this turn (else: read it again);
// - the folder rules of the person, checked again right before the file is placed (team-files/place.ts);
// - without `output`, a new version of the same file: the old bytes go to the file history (file_versions) and the
//   change is the person's file event; if someone saved the file in the meantime, a conflict copy instead
//   (make-file.ts placeProduced, as make_file does); with `output`, a new file (an existing one the AI read is a new
//   version of it, one it did not read gets a conflict copy), and the document is a source of it: the wider-audience
//   check of make_file;
// - under skills/, the person's confirmation card first (chat/turn.ts confirmSkillWrite).
// The plain write and edit still refuse .hwp and .hwpx (files/service.ts BINARY_WRITE).
// Read back before anything is placed, without taking the editor's worker on its word: the two zip directories must
// list the same parts with the same bytes but the changed sections (hwpxPartsMismatch); hwp.ts reads the old and the
// new file in their own worker runs, as read and grep read them, and the new one must read as the old one with the
// worker's line edits, each edit what its changes make (hwpxEditMismatch); and the new file passes every check of a
// document again in a fresh worker (mode hwpx-verify).
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { EditHwpxInput } from '@mycel/shared'
import type { AppContext } from '../context'
import { ext, officeWorkerText, officeWorkerWrite } from '../files/extract'
import {
  decodeHwpxEditResult, encodeHwpxEditRequest, HWPX_EDIT_MAX, HWPX_EDIT_MODE, HWPX_VERIFY_MODE, hwpxEditMismatch, hwpxOutputPath, hwpxPartsMismatch,
  hwpxReadLines, type HwpxChange, type HwpxEditReport,
} from '../files/hwpx-check'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { checkRegular } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir } from './isolate'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type Input = z.output<typeof EditHwpxInput>
export interface EditedHwpx extends MadeFile { source: string; inPlace: boolean; report: HwpxEditReport }

export async function editHwpx(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input): Promise<EditedHwpx> {
  const fx = files.fx
  const src = authorize(fx, files.rules(), c.user, a.file_path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  const x = ext(src.rel)
  if (x === 'hwp') throw new ToolError(`'${src.rel}' is a .hwp file (Hangul's older binary format), which cannot be changed yet. Ask the user to open it in Hangul and save it as .hwpx, then change that file.`)
  if (x !== 'hwpx') throw new ToolError('edit_hwpx changes Hangul documents (.hwpx) only; use edit for text files and make_file for new documents')
  if (checkRegular(src.abs).size > HWPX_EDIT_MAX) throw new ToolError(`'${src.rel}' is larger than ${HWPX_EDIT_MAX / 1024 / 1024} MB, too large to change here`)
  const { bytes } = readRegular(src.abs, HWPX_EDIT_MAX)
  // the changes are found in the text the AI read: the file must still be that version
  const seen = c.files.readHashes.get(src.rel)
  if (!seen) throw new ToolError(`read '${src.rel}' first (with read) before changing it`, 'not_read')
  if (seen !== sha256(bytes)) throw new ToolError(`'${src.rel}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
  const outRel = a.output === undefined ? undefined : hwpxOutputPath(a.output)
  // write access where the result goes, before any work (checked again when it is placed)
  const out = authorize(fx, files.rules(), c.user, outRel ?? src.rel, 'write', { mustExist: outRel === undefined, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`, 'is_folder')
  const inPlace = out.rel === src.rel

  const changes = a.changes as HwpxChange[]
  const answer = await officeWorkerWrite(HWPX_EDIT_MODE, encodeHwpxEditRequest(changes, bytes), c.signal)
  let r: ReturnType<typeof decodeHwpxEditResult>
  try { r = decodeHwpxEditResult(answer) } catch { throw new ToolError('the .hwpx editor gave a damaged answer; nothing was saved') }
  // what came back is not taken on the worker's word: the same parts but the changed sections (central directories),
  // the text as hwp.ts reads both files in their own worker runs, and every check of a document again in a fresh one
  const parts = hwpxPartsMismatch(bytes, r.file)
  if (parts) throw new ToolError(`the changed document did not read back as expected (${parts}); nothing was saved`)
  const old = hwpxReadLines(await officeWorkerText('hwpx', bytes, c.signal))
  const got = hwpxReadLines(await officeWorkerText('hwpx', r.file, c.signal))
  const bad = hwpxEditMismatch(changes, old, got, r.report)
  if (bad) throw new ToolError(`the changed document did not read back as expected (${bad}); nothing was saved`)
  try { await officeWorkerWrite(HWPX_VERIFY_MODE, r.file, c.signal) } catch (e) {
    if (!(e instanceof ToolError)) throw e
    throw new ToolError(`the changed document did not pass the checks again (${e.message.slice(0, 300)}); nothing was saved`)
  }

  // a new file carries the document's bytes: asked like make_file's sources; a new version stays where it was
  if (!inPlace) await confirmSources(ctx, files, c, out.rel, out.segs, [src.rel])
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, 'out.hwpx')
    fs.writeFileSync(produced, r.file, { flag: 'wx', mode: 0o600 })
    const made = await placeProduced(ctx, files, c, out.segs, produced, 'edit_hwpx')
    return { ...made, source: src.rel, inPlace, report: r.report }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** The tool result for the AI: where it went, what changed, what is left to fill. */
export function editHwpxText(r: EditedHwpx, link: string): string {
  const where = r.conflictCopyOf
    ? `'${r.conflictCopyOf}' was changed by someone else in the meantime, so the result was saved as '${r.path}' and the original left as it was. Tell the user about both.`
    : r.inPlace ? `Saved a new version of ${r.path}; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const notes = r.report.notes.map((n) => `- ${n.also?.length ? 'changes' : 'change'} ${[n.change, ...(n.also ?? [])].map((c) => c + 1).join(', ')}, ${n.where}: ${n.before ? `${JSON.stringify(n.before)} -> ` : n.where.includes('after row') ? '' : 'was empty, now '}${JSON.stringify(n.after)}`)
  const left = r.report.placeholders.length ? `\nStill in the document: ${r.report.placeholders.join(', ')}.` : ''
  return `${where}\n${notes.join('\n')}\nThe file was read back: the changed text is there and every other paragraph reads as before. Layout in Hangul is not checked.${left}`
}
