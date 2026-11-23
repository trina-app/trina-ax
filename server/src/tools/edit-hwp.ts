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
  hwpOutputPath, hwpPartsMismatch, hwpxPartsMismatch, hwpxReadLines, encodeVerifyPictures, type HwpChange, type HwpEditReport, type HwpImageChange,
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
import { landings, PICTURE_LIMITS, type HwpLanding, type HwpLayout } from '../files/hwp-picture'
import { SEAL_TOLERANCE_MM } from '../files/sign-slots'
import { imageKind } from '../files/pdf-stamp'
import { parsePlace } from '@mycel/shared/places'
import { authorizeOutput, readPlaceFile, versionText, type ChatVersionMade } from '../files/place-output'
import { chatSource, reencodePicture } from './edit-office'
import { confirmNotOwnPictures, pictureAlwaysKey, type NotOwnPicture } from './own-picture'
import { isOwnUpload } from '../files/own-upload'
import { confirmSources, placeProduced, type MadeFile } from './make-file'

type Input = z.output<typeof EditHwpInput>
export interface EditedHwp extends MadeFile { source: string; inPlace: boolean; report: HwpEditReport; chatVersion?: ChatVersionMade; /** where each aimed picture landed */ landed?: HwpLanding[] }

export async function editHwpFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: Input): Promise<EditedHwp> {
  const fx = files.fx
  // a chat file (chat:files/…): without output it gets a new version, with an output a new file is made from it, through
  // the same path as edit_office (who may, the file's own open, every rule again when it is saved)
  const chatPlace = parsePlace(a.file_path)
  const src = chatPlace ? await chatSource(ctx, c, a, chatPlace, 'edit_hwp', HWP_EDIT_MAX) : authorize(fx, files.rules(), c.user, a.file_path, 'read')
  if (src.st?.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  const x = ext(src.rel)
  if (x !== 'hwpx' && x !== 'hwp') throw new ToolError('edit_hwp changes Hangul documents (.hwp and .hwpx) only; use edit for text files and make_file for new documents')
  if (!chatPlace && checkRegular(src.abs).size > HWP_EDIT_MAX) throw new ToolError(`'${src.rel}' is larger than ${HWP_EDIT_MAX / 1024 / 1024} MB, too large to change here`)
  const { bytes } = 'bytes' in src ? { bytes: src.bytes } : readRegular(src.abs, HWP_EDIT_MAX, src.st)
  // the changes are found in the text the AI read: the file must still be that version
  const seen = c.files.readHashes.get(src.rel)
  if (!seen) throw new ToolError(`read '${src.rel}' first (with read) before changing it`, 'not_read')
  if (seen !== sha256(bytes)) throw new ToolError(`'${src.rel}' was changed after you read it; read it again and give the changes for what it says now`, 'conflict')
  const outRel = a.output === undefined ? undefined : hwpOutputPath(a.output, src.rel)
  // the result keeps the document's format: a .hwp stays a .hwp (Hangul converts between them)
  if (outRel !== undefined && ext(outRel) !== x) throw new ToolError(`'${outRel}' would be a .${ext(outRel)}, but '${src.rel}' is a .${x} and stays one when it is changed; give output ending in .${x} (to have a .${ext(outRel)}, open the file in Hangul and save it as one)`)
  // write access where the result goes, before any work (checked again when it is placed)
  const head = 'head' in src ? src.head : null
  const out = head ? { rel: head.path, segs: ['chat:files', head.id, head.name], exists: false, st: undefined } : authorizeOutput(fx, files.rules(), c, outRel ?? src.rel, { mustExist: outRel === undefined, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`, 'is_folder')
  const inPlace = out.rel === src.rel

  const changes = a.changes as HwpChange[]
  const binary = x === 'hwp'
  const pictures = await picturesOf(ctx, files, c, changes)
  /** one worker run on `doc` of the changes at `which` (their numbers in errors stay the call's) */
  const edit = async (which: number[], doc: Uint8Array, extra?: HwpEditExtra, targets?: number[], list: HwpChange[] = which.map((i) => changes[i]!)) => {
    // a refusal names the call's change: the changes in `which`, then the pictures whose targets went along
    const numbers = [...which, ...(targets ?? [])]
    const answer = await officeWorkerWrite(binary ? HWP_EDIT_MODE : HWPX_EDIT_MODE, encodeHwpEditRequest(list, doc, extra, targets?.map((i) => changes[i] as HwpImageChange)), c.signal).catch((e) => {
      if (!(e instanceof ToolError)) throw e
      throw new ToolError(e.message.replace(/^change (\d+):/, (_m, n: string) => `change ${(numbers[Number(n) - 1] ?? Number(n) - 1) + 1}:`), e.code)
    })
    try { return decodeHwpEditResult(answer) } catch { throw new ToolError(`the .${x} editor gave a damaged answer; nothing was saved`) }
  }
  let r: ReturnType<typeof decodeHwpEditResult>
  /** the layout the pictures were placed from */
  let placedFrom: HwpLayout | null = null
  if (!pictures) r = await edit(changes.map((_, i) => i), bytes)
  else {
    // Text and rows first, then the pictures, placed from the layout of the document as those changes left it: a row
    // added above a label or a fill that wraps moves the label
    const words = changes.flatMap((ch, i) => (isImageChange(ch) ? [] : [i]))
    const seals = changes.flatMap((ch, i) => (isImageChange(ch) ? [i] : []))
    // each picture's target is fixed on the document as read and carried through the text and row changes
    const first = words.length ? await edit(words, bytes, undefined, seals) : null
    const refs = first?.report.targets
    if (first && refs?.length !== seals.length) throw new ToolError('the pictures\' places could not be kept through the other changes; nothing was saved')
    const base = first?.file ?? bytes
    if (first) {
      const why = binary ? hwpPartsMismatch(bytes, base) : hwpxPartsMismatch(bytes, base)
      if (why) throw new ToolError(`the changed document did not read back as expected (${why}); nothing was saved`)
      try { await officeWorkerWrite(binary ? HWP_VERIFY_MODE : HWPX_VERIFY_MODE, base, c.signal) } catch (e) {
        if (!(e instanceof ToolError)) throw e
        throw new ToolError(`the changed document did not pass the checks again (${e.message.slice(0, 300)}); nothing was saved`)
      }
    }
    const layout = await layoutOf(ctx, c, base, x, src.rel)
    placedFrom = layout
    const second = await edit(seals, base, { layout, images: pictures.images.map((m) => ({ ...m, changes: m.changes.map((i) => seals.indexOf(i)) })) }, undefined, seals.map((i, k) => (refs ? { ...(changes[i] as HwpImageChange), ref: refs[k]! } : changes[i]!)))
    // one report in the call's change numbers
    const w = (n: number) => words[n]!
    r = { file: second.file, report: {
      lineEdits: (first?.report.lineEdits ?? []).map((e) => ({ ...e, changes: e.changes.map(w) })),
      notes: (first?.report.notes ?? []).map((n) => ({ ...n, change: w(n.change), ...(n.also ? { also: n.also.map(w) } : {}) })),
      placeholders: second.report.placeholders,
      pictures: (second.report.pictures ?? []).map((p) => ({ ...p, change: seals[p.change]! })),
    } }
  }
  // what came back is not taken on the worker's word: the same parts but the changed sections (the containers), the
  // text as hwp.ts reads both files in their own worker runs, and every check of a document again in a fresh one
  // each picture is one new part, however many places show it
  const added = [...new Set((r.report.pictures ?? []).map((p) => p.part))]
  if (added.length !== (pictures?.images.length ?? 0)) throw new ToolError('the changed document did not read back as expected (its pictures are not the ones asked for); nothing was saved')
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

  // where each picture really landed, on the file about to be saved. A busy or failing renderer is "not checked", never
  // a pass; a measured miss on an anchor the renderer draws as Hangul does saves nothing
  let landed: HwpLanding[] = []
  if (placedFrom && r.report.pictures?.some((p) => p.aim)) {
    const after = await componentC(ctx).hwp.layout(c.user.id, Buffer.from(r.file), x, c.signal).catch((e) => { if (e instanceof HwpError) return null; throw e })
    landed = after ? landings(placedFrom, after, r.report.pictures, SEAL_TOLERANCE_MM) : r.report.pictures.flatMap((p) => (p.aim ? [{ change: p.change, state: 'not-checked' as const }] : []))
    const miss = landed.find((l) => l.state === 'missed')
    if (miss?.state === 'missed') throw new ToolError(`change ${miss.change + 1}: the picture did not land on its place (${miss.mm === null ? 'it is not on that page' : `${miss.mm} mm off`}), so nothing was saved; give the mark's exact text or put the picture into a table cell`)
  }

  // a new file carries the document's bytes: asked like make_file's sources; a new version stays where it was. The
  // pictures' bytes go where the document's readers see them, a new version too (as stamp_pdf)
  const sources = [...(inPlace ? [] : [src.rel]), ...(pictures?.sources ?? [])]
  if (pictures) await confirmNotOwnPictures(ctx, c, pictures.notOwn, src.rel)
  if (sources.length) await confirmSources(ctx, files, c, out.rel, out.segs, sources)
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, `out.${x}`)
    fs.writeFileSync(produced, r.file, { flag: 'wx', mode: 0o600 })
    if (head) {
      // the chat file's new version (ChatFiles.putVersion through the turn's chat places: every rule again, origin 'ai')
      c.user = ctx.files.principal(c.user.id)
      c.beforePlace?.()
      const v = await c.places!.version(head.id, { bytes: r.file }, seen, c.files)
      return { path: v.path, size: v.size, sha256: v.sha256, source: src.rel, inPlace: true, report: r.report, chatVersion: v, landed }
    }
    const made = await placeProduced(ctx, files, c, out.segs, produced, 'edit_hwp')
    return { ...made, source: src.rel, inPlace, report: r.report, landed }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** One picture's landing in the result, in what it does and does not show. */
function landingText(l: HwpLanding | undefined): string {
  if (!l) return ''
  return l.state === 'checked' ? `; checked in the preview engine: ${l.mm} mm from the mark, which is not proof of the spot in Hangul` : '; its landing was not checked'
}

/** The tool result for the AI: where it went, what changed, what is left to fill. */
export function editHwpFileText(r: EditedHwp, link: string): string {
  const where = r.chatVersion ? versionText(r.chatVersion, 'Changed') : r.conflictCopyOf
    ? `'${r.conflictCopyOf}' was changed by someone else in the meantime, so the result was saved as '${r.path}' and the original left as it was. Tell the user about both.`
    : r.inPlace ? `Saved a new version of ${r.path}; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path}; ${r.source} is unchanged. Link for the user: ${link}`
  const notes = r.report.notes.map((n) => `- ${n.also?.length ? 'changes' : 'change'} ${[n.change, ...(n.also ?? [])].map((c) => c + 1).join(', ')}, ${n.where}: ${n.before ? `${JSON.stringify(n.before)} -> ` : n.where.includes('after row') ? '' : 'was empty, now '}${JSON.stringify(n.after)}`)
  const left = r.report.placeholders.length ? `\nStill in the document: ${r.report.placeholders.join(', ')}.` : ''
  const pics = (r.report.pictures ?? []).map((p) => `- change ${p.change + 1}: a picture on page ${p.page}, ${p.widthMm} x ${p.heightMm} mm, ${p.xMm} mm from the left and ${p.yMm} mm from the top (${p.where})${landingText(r.landed?.find((l) => l.change === p.change))}`)
  const loose = r.report.pictures?.some((p) => p.fromParagraph)
  const check = pics.length ? `\nPictures:\n${pics.join('\n')}\n` + (loose
    ? 'This document has no layout stored by Hangul, so each picture is tied to the paragraph or table of its label and Hangul keeps it there. hwp_render uses a different layout engine: it can draw the line after such a paragraph too high, over it, while the file is right. Do not change the file for that; tell the user to check the spot in Hangul.'
    : 'They are placed from the layout Hangul stored in the document. hwp_render uses a different layout engine, so it does not prove the spot, and on a page that is one table it can draw a row a little taller while the file is right: use it only to catch a wrong page or label, and tell the user to check the exact spot in Hangul.') +
    ' The file\'s own small preview picture (shown by some file browsers) is not redrawn.' : ''
  const body = notes.length ? `\n${notes.join('\n')}\nThe file was read back: the changed text is there and every other paragraph reads as before.` : '\nThe file was read back: every paragraph reads as before.'
  return `${where}${body} Layout in Hangul is not checked.${left}${check}`
}

/** The image changes' pictures and the page layout, or null without image changes: each picture read with the person's
 * read access, at most PICTURE_LIMITS (one, all together, how many), a PNG or JPEG by its bytes, not quarantined; the
 * layout from the HWP renderer, which must run here. */
async function picturesOf(ctx: AppContext, files: TeamFiles, c: ToolCtx, changes: HwpChange[]): Promise<{ images: HwpEditExtra['images']; sources: string[]; notOwn: NotOwnPicture[] } | null> {
  const which = changes.flatMap((ch, i) => (isImageChange(ch) ? [i] : []))
  if (!which.length) return null
  if (which.length > PICTURE_LIMITS.images) throw new ToolError(`more than ${PICTURE_LIMITS.images} pictures in one call; nothing was saved`)
  // each picture read and written again once, however many changes name it: decoded by the isolated image helper, so
  // the document gets only pixels it made (upright, no details), and bounded as read and as made
  const seen = new Map<string, HwpEditExtra['images'][number]>()
  const images: HwpEditExtra['images'] = []
  let readBytes = 0, madeBytes = 0
  /** pictures that are not the asker's own: their yes on a card first */
  const notOwn = new Map<string, string>()
  const tooMany = () => new ToolError(`the pictures of one call are larger than ${PICTURE_LIMITS.totalBytes / 1024 / 1024} MB together; use smaller ones`)
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    for (const i of which) {
      const ch = changes[i] as Extract<HwpChange, { image: string }>
      let rel: string, label: string, load: () => Uint8Array
      if (parsePlace(ch.image)) {
        if (parsePlace(ch.image)!.kind !== 'chatFiles') throw new ToolError(`change ${i + 1}: a picture is a team file or a file of this chat (chat:files/<file_id>/<name>); copy it there first`, 'bad_place')
        // the chat's own visibility and quarantine checks (the place's one safe open)
        const f = await readPlaceFile(ctx, c, ch.image, PICTURE_LIMITS.imageBytes, work)
        rel = f.place
        label = f.name
        load = () => readRegular(f.local, PICTURE_LIMITS.imageBytes).bytes
      } else {
        const img = authorize(files.fx, files.rules(), c.user, ch.image, 'read')
        if (img.st!.isDirectory()) throw new ToolError(`'${img.rel}' is a folder`, 'is_folder')
        rel = img.rel
        label = rel
        load = () => {
          if (checkRegular(img.abs).size > PICTURE_LIMITS.imageBytes) throw new ToolError(`'${img.rel}' is larger than ${PICTURE_LIMITS.imageBytes / 1024 / 1024} MB; use a smaller picture (resize_images makes one)`)
          return readRegular(img.abs, PICTURE_LIMITS.imageBytes, img.st).bytes
        }
      }
      const known = seen.get(rel)
      if (known) { known.changes.push(i); continue }
      const raw = load()
      ctx.files.quarantine.assertBytes(raw)
      // the person's own upload of the very bytes just read goes in; anything else after their yes on the card
      const at = parsePlace(rel)
      if (!isOwnUpload(ctx.db, c.user.id, at ? { chatFile: at.kind === 'chatFiles' ? at.id ?? '' : '', sha256: sha256(raw) } : { team: rel, sha256: sha256(raw) })) notOwn.set(rel, label)
      const kind = imageKind(raw)
      if (!kind) throw new ToolError(`'${rel}' is not a PNG or JPG picture; use a .png or .jpg file (a PNG keeps a transparent background)`)
      if ((readBytes += raw.length) > PICTURE_LIMITS.totalBytes) throw tooMany()
      const bytes = await reencodePicture(ctx, raw, rel, i, c.signal, kind === 'jpg')
      if ((madeBytes += bytes.length) > PICTURE_LIMITS.totalBytes) throw tooMany()
      const entry = { changes: [i], bytes: new Uint8Array(bytes) }
      seen.set(rel, entry)
      images.push(entry)
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
  return { images, sources: [...seen.keys()], notOwn: [...notOwn].map(([rel, name]) => ({ name, key: pictureAlwaysKey(rel) })) }
}

/** The page layout a picture is placed from; the HWP renderer must run here. */
async function layoutOf(ctx: AppContext, c: ToolCtx, doc: Uint8Array, x: 'hwp' | 'hwpx', rel: string) {
  try { return await componentC(ctx).hwp.layout(c.user.id, Buffer.from(doc), x, c.signal) } catch (e) {
    if (!(e instanceof HwpError)) throw e
    const why = e.reason === 'disabled' || e.reason === 'engine' || e.reason === 'isolation'
      ? 'placing a picture needs the page layout from the HWP Preview renderer, which cannot run on this server (text changes still work); the person can put the picture in with Hangul'
      : `the page layout of '${rel}' could not be read (${e.reason})`
    throw new ToolError(`${why}; nothing was saved`)
  }
}
