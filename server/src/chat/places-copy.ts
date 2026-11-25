// copy_files between every place of a chat turn (plan docs/AGENTS/plan/20261121-1415-places-copy.md, P2 of
// 20261121-0615-chat-places-as-paths.md): the team folder, this chat's files (chat:files/) and this chat's work folder
// (chat:work/, $TRINA_WORK of box_shell). A call whose `paths` or `to_folder` names a chat place comes here; any other
// stays the team copy (tools/file-moves.ts), unchanged. save_chat_file and save_work_file are aliases: their calls run
// the routes below (chatFileToTeam, workToTeam, workToChat), so a card, a step line and an audit row are the same.
//
//   into chat:work/   devenv/work-write.ts writeIntoWork (a checked stage copy, then a box command with the box's
//                     rights: never a write by the server into the work folder). A shared chat: what is copied in that
//                     not everyone here may read asked the shared read card first (chat/tools.ts call() →
//                     confirmSharedRead: its yes is a y group in the answer), and the same sources are recorded under the
//                     workspace key (srt/copied-in.ts), so every later run, read, list or grep there records them again.
//                     A folder: every entry the person may read; a folder with its own rules under it is a source too
//                     (turn.ts sharedSources, as make_zip).
//   into chat:files/  attached to this answer (ChatFiles.createFromAi + TurnExec.attachToAnswer; 1 GB at most), only in
//                     a chat shared with people (files/places.ts mayAttachChatFile), never in a turn with a k group.
//   into a team path  the person's write rights, then the wider-audience card with the chat (a chat file) or the work
//                     folder's sources (the person, or the chat and what was copied in) as the source, then
//                     placeProduced (write access again, storage, versions, events).
// A chat file carried only by answers hidden from people who may join (k) is never copied. A project chat's place is
// its project folder: chat:files/ is read-only there and it has no work folder.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CopyFilesInput } from '@mycel/shared'
import { CHAT_FILE_AI_MAX, type Locale } from '@mycel/shared/api'
import { fillPlurals } from '@mycel/shared/plural'
import { chatFilePath, isReservedPlace, parsePlace, workPlacePath, type Place } from '@mycel/shared/places'
import type { McpContent } from '../turns'
import type { ToolCtx, TurnFiles } from '../files/service'
import { mayAttachChatFile, PLACE_WORDS, resolvePlace, type ResolveCtx } from '../files/places'
import { openToRead } from '../files/store'
import { contentKind, fdReader, type ContentKind } from '../files/office-exit'
import { officeRecalc, officeViewer } from '../files/office-view'
import { OFFICE_WRITE_MAX, officeWorkerWrite } from '../files/extract'
import { DOCX_REVIEW_MODE, docxReviewLine, type DocxReview } from '../files/docx-review'
import { CHART_DATA_MODE, chartDataLine, type ChartDataReview } from '../files/chart-data'
import { turnWriteLimits } from '../files/turn-write-limits'
import { authorize } from '../policy/authorize'
import { atLeast } from '../policy/access'
import { Denied, ToolError } from '../policy/errors'
import { hiddenEntry } from '../policy/names'
import { cardEndShort, cardNext, cardReason, endOfText, refusal } from '../policy/refusal'
import { inSkills, SKILL_FILES_REFUSAL } from '../skills/guard'
import { componentC } from '../team-files/component'
import { placeProduced } from '../tools/make-file'
import { TEXT as MOVE_TEXT } from '../tools/file-moves'
import { askConfirm } from '../tools/url-gate'
import { confidentialChat } from '../safe-ops/confidential'
import { isGuestUser } from '../credentials/guest-ai'
import { mayRunCommands } from '../devenv/setting'
import { noteSharedReads, runsInWorkFolder, spaceOf } from '../devenv/srt/runner'
import { copyWorkFile, noWorkText, workUnavailableText, type WorkFolder } from '../devenv/work-files'
import { assertStorageRoomForAI } from '../system/storage'
import { copiedInOf, writeIntoWork, type WorkSource, type WorkTarget } from '../devenv/work-write'
import { addSources, sourceKey, type ReadSource } from './read-scope'
import { chatFilesOf, seesChatFiles, type ChatFileRow } from './chat-files'
import { placeWords } from './place-words'
import { neutralizeTags } from './prompt'
import type { Tool } from './tools'
import { instructionLike, type TurnExec, type WidenOf } from './turn'
import { chatPlaces } from './place-ctx'
import { attachProduced, versionText } from '../files/place-output'

export const COPY_FILES_TOOL = 'copy_files'

type Out = { content: McpContent[]; isError?: boolean; summary: string }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })
const oneLine = (s: string, n: number) => s.replace(/[\r\n"<>]+/g, ' ').slice(0, n)
const mb = (n: number) => (n / 1024 ** 2).toFixed(1)
/** a link the app opens (the same form the prompt asks for: SOURCE_LINK_RULE) */
const fileLink = (p: string) => `[${p.split('/').pop()}](/files/view?path=${encodeURIComponent(p)})`
const clean = (p: string) => p.normalize('NFC').split('/').filter((s) => s !== '' && s !== '.').join('/')

/** What one copy route gives back: where it went (a team path, chat:files/<id>/<name>, chat:work/<path>) and the words
 * for the AI, or the refusal in words */
export type Routed = { ok: true; to: string; text: string; summary: string } | { ok: false; text: string; summary: string }

// ---------------- the turn as the resolver sees it ----------------

/** box_shell's commands of this person run in a work folder here (made or not yet): a copy in may make it */
export function workCopyInHere(exec: TurnExec): boolean {
  const d = exec.devEnv
  if (!d || !exec.files.workFolder) return false
  if (!mayRunCommands(exec.rt.db, exec.rt.files, exec.spec.userId)) return false
  try { return runsInWorkFolder(exec.rt.ctx, workAt(exec)) } catch { return false }
}

const workAt = (exec: TurnExec) => {
  const d = exec.devEnv!
  return { userId: exec.spec.userId, chatId: exec.spec.chatId, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null, ...(d.shared ? { shared: d.shared } : {}) }
}

/** The resolver's view of this turn (files/places.ts ResolveCtx) for the calling agent's `files` */
export function resolveCtxOf(exec: TurnExec, files: TurnFiles): ResolveCtx {
  const { rt, spec } = exec
  const kind: ResolveCtx['chatKind'] = isGuestUser(rt.db, spec.userId) ? 'guest' : confidentialChat(rt.db, spec.chatId) ? 'locked'
    : spec.clientKind === 'schedule' ? 'scheduled' : exec.shared?.kind === 'people' ? 'people' : exec.shared?.kind === 'project' ? 'project' : 'personal'
  return {
    db: rt.db, userId: spec.userId, chatId: spec.chatId, main: files === exec.files, chatKind: kind,
    // read only where a file would be attached or changed (files/places.ts): asking it there starts the next answer fresh
    get hiddenGroup() { return exec.hiddenFromLater },
    workFolder: files.workFolder, workWhy: files.workWhy, workCopyIn: () => files === exec.files && workCopyInHere(exec),
    live: () => { try { exec.livePrincipal(); return true } catch { return false } },
  }
}

// ---------------- the routes (one each; copy_files and the old tools run them) ----------------

/** A chat file into the team folder at `target` (save_chat_file's route): the wider-audience card with the chat as the
 * source, then placeProduced. `file` was found by ChatFiles.find; it is opened again after the card. */
export async function chatFileToTeam(exec: TurnExec, files: TurnFiles, o: { file: ChatFileRow; target: string; tool: string; args: unknown }): Promise<Routed> {
  const { rt, spec } = exec
  const { file, target, tool } = o
  const gone = 'That file is no longer in this chat, or the user no longer sees the chat.'
  if (chatFilesOf(rt.ctx).kCarried(file)) return { ok: false, text: `The file "${oneLine(file.name, 120)}" came with an answer that is kept from some people who may join this chat, so it is not copied.`, summary: `${tool} -> refused: carried by a hidden answer` }
  // the chat is where the bytes come from: saving where people outside it can read asks (the wider-audience card)
  const chat: ReadSource[] = [{ type: 'chat', id: spec.chatId }]
  addSources(rt.db, spec.chatId, chat)
  const call = { tool, args: o.args }
  const no = await exec.confirmWidening(target, [], undefined, call)
  if (no) { const e = endOfText(no); return { ok: false, text: no, summary: `${tool} -> ${e === 'failed' ? 'the check failed' : cardEndShort(e)} (wider audience)` } }
  // the card may have waited minutes: the person still in the chat, the file still there, the bytes as sent
  exec.abort.signal.throwIfAborted()
  if (!seesChatFiles(rt.db, spec.userId, spec.chatId)) return { ok: false, text: gone, summary: `${tool} -> not found` }
  let abs: string
  try { const op = chatFilesOf(rt.ctx).open(spec.userId, spec.chatId, file.id, false); if (op.quarantined || op.sha256 !== file.sha256) throw new Error('changed'); abs = op.abs } catch { return { ok: false, text: gone, summary: `${tool} -> not found` } }
  const work = tempDir(exec, 'chat-file-')
  try {
    const tmp = path.join(work, 'file')
    const got = await streamCopy(abs, undefined, tmp, Math.max(file.size, 1), exec.abort.signal)
    if (got.sha256 !== file.sha256 || rt.files.quarantine.hasHash(got.sha256)) return { ok: false, text: gone, summary: `${tool} -> not found` }
    const c: ToolCtx = { user: exec.livePrincipal(), turnId: spec.turnId, files, signal: exec.abort.signal, confirmWidening: (t, s, b) => exec.confirmWidening(t, s, b, call) }
    const made = await placeProduced(rt.ctx, componentC(rt.ctx).files, c, target.split('/').filter(Boolean), tmp, tool, undefined, { turnBytes: false, thisAnswerOnly: true, detail: { type: file.mime, chatFile: file.id } })
    const note = made.conflictCopyOf ? ` ${made.conflictCopyOf} already existed and was not read in this turn, so this was saved as a copy next to it; the original is unchanged.` : ''
    return { ok: true, to: made.path, text: `Saved a copy of "${neutralizeTags(oneLine(file.name, 200))}" from this chat as ${made.path} (${made.size} bytes). The file tools (read, stamp_pdf, merge_pdfs, unzip_file, resize_images, …) can use it at that path.${note}`, summary: `${tool} -> ${made.path} (${made.size} B)` }
  } catch (e) {
    exec.abort.signal.throwIfAborted()
    if (e instanceof ToolError || e instanceof Denied) return { ok: false, text: `Not saved: ${e.message}`, summary: `${tool} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
    throw e
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** What a work folder holds may have come from, for a save out of it: the person (a personal chat: it may hold anything
 * they can read), or the chat and every group copied into it (a shared chat: srt/copied-in.ts). */
function workSources(exec: TurnExec, wf: WorkFolder | null): ReadSource[] {
  const me: ReadSource = { type: 'user', id: exec.spec.userId }
  if (!exec.devEnv?.shared) return [me]
  const out: ReadSource[] = [{ type: 'chat', id: exec.spec.chatId }]
  const seen = new Set(out.map(sourceKey))
  for (const g of wf ? copiedInOf(exec.spec.chatId, wf.path) : []) for (const s of g.s) if (!seen.has(sourceKey(s))) { seen.add(sourceKey(s)); out.push(s) }
  return out
}

/** A shared chat's work folder is about to be read for a copy out: what a run there may read and what was copied in
 * join this answer (runner noteSharedReads, which records the copied-in groups again). False: not recorded. */
/** The work folder could not be recorded for this answer: the reason when the turn knows it, else "try again" */
const workUnavailable = (files: TurnFiles): string => workUnavailableText(files.workWhy?.())

function noteWorkRead(exec: TurnExec): boolean {
  const d = exec.devEnv
  if (!d?.shared) return true
  // a shared project chat: its runs' space (the project folder) with its scratch folder (srt/runner.ts scratchOf)
  const space = spaceOf(exec.rt.ctx, { userId: exec.spec.userId, chatId: exec.spec.chatId, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null, shared: d.shared })
  if (!space || !noteSharedReads(exec.rt.ctx, space)) return false
  addSources(exec.rt.db, exec.spec.chatId, [{ type: 'chat', id: exec.spec.chatId }])
  return true
}

/** A workbook leaving the work folder gets every formula's result stored (files/xlsx-values.ts), so a preview shows
 * numbers. A Word file is read back (files/docx-review.ts): the result says how many tracked changes and comments the
 * saved bytes hold, so the answer does not claim what the file lacks (QA A-43-L). The charts of a deck or Word file are
 * read back too (files/chart-data.ts): each keeps its data sheet, so Edit Data works (QA A-03-L). The safety check itself is where the
 * file lands (placeProduced, chat files: files/office-exit.ts). */
async function officeOut(exec: TurnExec, _files: TurnFiles, tmp: string, got: { name: string; size: number; sha256: string }, _also: string[] = [], _given: Uint8Array[] = []): Promise<{ name: string; size: number; sha256: string; note?: string }> {
  const fd = fs.openSync(tmp, 'r'); let k: ContentKind
  try { k = contentKind(got.name, fs.fstatSync(fd).size, fdReader(fd)) } finally { fs.closeSync(fd) }
  if (k && 'office' in k && k.office === 'docx') return { ...got, note: await docxReadBack(exec, tmp, got.size) + await chartReadBack(exec, tmp, got.size, k.names) }
  if (k && 'office' in k && k.office === 'pptx') return { ...got, note: await chartReadBack(exec, tmp, got.size, k.names) }
  if (!k || !('office' in k) || !k.names.some((n) => n.toLowerCase() === 'xl/workbook.xml')) return got
  if (!officeViewer()) return { ...got, note: ' This server cannot calculate the formulas, so a preview may show empty formula cells until the file is opened in Excel: say so.' }
  const bytes = new Uint8Array(fs.readFileSync(tmp))
  let out: Uint8Array
  try { out = await officeRecalc(bytes, { user: exec.spec.userId, workBase: exec.rt.ctx.engineConfig.dataDir, signal: exec.abort.signal }) } catch (e) {
    exec.abort.signal.throwIfAborted()
    return { ...got, note: ` Its formula results could not be calculated (${e instanceof Error ? e.message.slice(0, 120) : 'failed'}), so a preview may show empty formula cells: say so.` }
  }
  if (Buffer.compare(Buffer.from(out), Buffer.from(bytes)) === 0) return got
  fs.writeFileSync(tmp, out)
  return { name: got.name, size: out.length, sha256: crypto.createHash('sha256').update(out).digest('hex') }
}

/** The read-back line of a Word file about to be saved (files/docx-review.ts, in the office worker). */
async function docxReadBack(exec: TurnExec, tmp: string, size: number): Promise<string> {
  if (size > OFFICE_WRITE_MAX) return ' It is too large for its tracked changes and comments to be read back here (the file itself is saved): describe them only as read shows them.'
  try {
    const r = JSON.parse((await officeWorkerWrite(DOCX_REVIEW_MODE, new Uint8Array(fs.readFileSync(tmp)), exec.abort.signal, 64 * 1024)).toString('utf8')) as DocxReview
    return docxReviewLine(r)
  } catch {
    exec.abort.signal.throwIfAborted()
    return ' Its tracked changes and comments could not be read back this time (the file itself is saved): describe them only as read shows them.'
  }
}

/** The chart read-back of a deck or Word file about to be saved (files/chart-data.ts, in the office worker); '' when it
 * has no chart part. */
async function chartReadBack(exec: TurnExec, tmp: string, size: number, names: string[]): Promise<string> {
  if (!names.some((n) => /^(ppt|word)\/charts\/chart\d+\.xml$/.test(n))) return ''
  if (size > OFFICE_WRITE_MAX) return ' It is too large for its charts to be read back here (the file itself is saved): do not say its charts can be edited unless you checked.'
  try {
    const r = JSON.parse((await officeWorkerWrite(CHART_DATA_MODE, new Uint8Array(fs.readFileSync(tmp)), exec.abort.signal, 256 * 1024)).toString('utf8')) as ChartDataReview
    return chartDataLine(r)
  } catch {
    exec.abort.signal.throwIfAborted()
    return ' Its charts could not be read back this time (the file itself is saved): do not say its charts can be edited unless you checked.'
  }
}

/** A work-folder file into the team folder at `to` (save_work_file's route): the wider-audience card with the work
 * folder's sources, then a copy from one checked descriptor and placeProduced. `shown`: how the result names the file. */
export async function workToTeam(exec: TurnExec, files: TurnFiles, o: { rel: string; target: string; where: () => WorkFolder | null; tool: string; args: unknown; shown: string }): Promise<Routed> {
  const { rt, spec } = exec
  const { rel, target: to, tool, shown } = o
  const call = { tool, args: o.args }
  const source = workSources(exec, o.where())
  const no = await exec.confirmWidening(to, [], undefined, call, source)
  if (no) { const e = endOfText(no); return { ok: false, text: no, summary: `${tool} -> ${e === 'failed' ? 'the check failed' : cardEndShort(e)} (wider audience)` } }
  exec.abort.signal.throwIfAborted()
  // the card may have waited: the work folder looked up again, with every check of the open
  const wf = o.where()
  if (!wf) return { ok: false, text: 'Not saved: the work folder of this chat is not available now.', summary: `${tool} -> no work folder` }
  if (!noteWorkRead(exec)) return { ok: false, text: `Not saved: ${workUnavailable(files)}`, summary: `${tool} -> refused: not recorded` }
  const work = tempDir(exec, 'work-file-')
  try {
    const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, spec.userId)
    const left = Math.max(0, max.bytes - files.bytesWritten)
    const tmp = path.join(work, 'file')
    // the team disk near full: refused before the copy is made (placeProduced checks again)
    let got = await copyWorkFile(wf, rel, tmp, left, exec.abort.signal, { beforeCopy: assertStorageRoomForAI }).catch((e) => {
      if (e instanceof ToolError && e.code === 'too_large') throw new ToolError(`${shown} is larger than what one answer may still save (${(left / 1024 ** 2).toFixed(0)} MB left of ${(max.bytes / 1024 ** 2).toFixed(0)} MB). Make it smaller (a lower bitrate or a shorter cut), or save it in the next answer.`, 'too_large')
      throw e
    })
    got = await officeOut(exec, files, tmp, got, [to])
    if (rt.files.quarantine.hasHash(got.sha256)) return { ok: false, text: 'Not saved: the team\'s safety check holds this file.', summary: `${tool} -> held` }
    const c: ToolCtx = { user: exec.livePrincipal(), turnId: spec.turnId, files, signal: exec.abort.signal, confirmWidening: (t, s, b) => exec.confirmWidening(t, s, b, call, source) }
    const made = await placeProduced(rt.ctx, componentC(rt.ctx).files, c, to.split('/').filter(Boolean), tmp, tool, undefined, { thisAnswerOnly: true, movedCheck: true, detail: { from: 'work folder' } })
    const note = made.conflictCopyOf ? ` ${made.conflictCopyOf} already existed and was not read in this answer, so this was saved next to it; the original is unchanged.` : ''
    return { ok: true, to: made.path, text: `Saved ${shown} as ${made.path} (${mb(made.size)} MB).${note}${'note' in got ? got.note ?? '' : ''} Link it in your answer: ${fileLink(made.path)}`, summary: `${tool} -> ${made.path} (${made.size} B)` }
  } catch (e) {
    exec.abort.signal.throwIfAborted()
    if (e instanceof ToolError || e instanceof Denied) return { ok: false, text: `Not saved: ${e.message}`, summary: `${tool} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
    throw e
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** A work-folder file attached to this answer for everyone in a chat shared with people (save_work_file's chat route). */
export async function workToChat(exec: TurnExec, files: TurnFiles, o: { rel: string; where: () => WorkFolder | null; tool: string; shown: string }): Promise<Routed> {
  const { rt, spec } = exec
  const { rel, tool, shown } = o
  const first = o.where()
  if (!first || !exec.devEnv?.shared) return { ok: false, text: 'Not attached: the work folder of this chat is not available now.', summary: `${tool} -> no work folder` }
  // what a run there may read joins this answer's record with who sees the chat now (as a command does), so the
  // newcomer warning counts this answer and its file
  if (!noteWorkRead(exec)) return { ok: false, text: `Not attached: ${workUnavailable(files)}`, summary: `${tool} -> refused: not recorded` }
  // from here until the file is on the answer, no connection's answer hidden from later people joins it (a call
  // running beside this one is refused), and one recorded before is seen by the check right after
  const release = exec.beginAttach()
  if (exec.hiddenFromLater) { release(); return { ok: false, text: 'Not attached: this answer now holds a connected service\'s answer that people added later may not see.', summary: `${tool} -> refused: answer hidden from later people` } }
  const work = tempDir(exec, 'work-file-')
  try {
    const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, spec.userId)
    const left = Math.min(CHAT_FILE_AI_MAX, Math.max(0, max.bytes - files.bytesWritten))
    if (files.filesWritten.size >= max.files) throw new ToolError(`this answer saved its most files already (${max.files}); attach it in the next answer`, 'too_many')
    const tmp = path.join(work, 'file')
    // the team disk near full: refused before the copy is made (createFromAi checks again)
    let got = await copyWorkFile(first, rel, tmp, left, exec.abort.signal, { beforeCopy: assertStorageRoomForAI }).catch((e) => {
      if (e instanceof ToolError && e.code === 'too_large') throw new ToolError(`${shown} is larger than what can be attached now (at most ${(left / 1024 ** 2).toFixed(0)} MB in this answer; a file attached to an answer is at most ${CHAT_FILE_AI_MAX / 1024 ** 3} GB). Make it smaller (a lower bitrate or a shorter cut)`, 'too_large')
      throw e
    })
    got = await officeOut(exec, files, tmp, got)
    if (rt.files.quarantine.hasHash(got.sha256)) return { ok: false, text: 'Not attached: the team\'s safety check holds this file.', summary: `${tool} -> held` }
    // right before the hand-off: still the work folder of the chat's people now, and still no hidden part in the answer
    const now = o.where()
    if (!now || now.real !== first.real) return { ok: false, text: 'Not attached: the people of this chat changed while the file was copied. Make it again for the people here now.', summary: `${tool} -> refused: people changed` }
    const r = await attach(exec, files, { tmp, name: got.name, sha256: got.sha256, tool, shown })
    return 'note' in got && got.note && r.ok ? { ...r, text: r.text + got.note } : r
  } catch (e) {
    exec.abort.signal.throwIfAborted()
    if (e instanceof ToolError || e instanceof Denied) return { ok: false, text: `Not attached: ${e.message}`, summary: `${tool} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
    throw e
  } finally { release(); fs.rmSync(work, { recursive: true, force: true }) }
}

/** The chat files this answer copied into its work folder to remake, by their chain path, with the head's hash then: only
 * workToChatVersion takes such a copy as the read (code review: other edit tools still read first). */
const remakes = new WeakMap<TurnFiles, Map<string, string>>()
const remakesOf = (files: TurnFiles) => { let m = remakes.get(files); if (!m) { m = new Map(); remakes.set(files, m) }; return m }

/** A work-folder file saved as the newest version of an existing file of this chat (`to`: chat:files/<id>/<name>; QA
 * TC-r2u-10: three people's edits of one video each made a new file, so "go back to Junho's version" could not be done).
 * The rules of a produce tool's new version (files/place-output.ts versionProduced): who may change it here, the same
 * name and format, read (or copied into the work folder) in this answer first, every check again at the insert; the
 * version records the person who asked (ChatFiles.putVersion, origin 'ai'); the chain keeps its version cap. */
export async function workToChatVersion(exec: TurnExec, files: TurnFiles, o: { rel: string; to: string; tool: string; shown: string }): Promise<Routed> {
  const { rt, spec } = exec
  const { rel, tool, shown } = o
  const wf = files.workFolder?.() ?? null
  if (!wf) return { ok: false, text: 'Not saved: the work folder of this chat is not available now.', summary: `${tool} -> no work folder` }
  if (!noteWorkRead(exec)) return { ok: false, text: `Not saved: ${workUnavailable(files)}`, summary: `${tool} -> refused: not recorded` }
  const release = exec.beginAttach()
  if (exec.hiddenFromLater) { release(); return { ok: false, text: 'Not saved: this answer now holds a connected service\'s answer that people added later may not see.', summary: `${tool} -> refused: answer hidden from later people` } }
  const work = tempDir(exec, 'work-version-')
  try {
    const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, spec.userId)
    const left = Math.min(CHAT_FILE_AI_MAX, Math.max(0, max.bytes - files.bytesWritten))
    const tmp = path.join(work, 'file')
    let got = await copyWorkFile(wf, rel, tmp, left, exec.abort.signal, { beforeCopy: assertStorageRoomForAI })
    if (rt.files.quarantine.hasHash(got.sha256)) return { ok: false, text: 'Not saved: the team\'s safety check holds this file.', summary: `${tool} -> held` }
    const places = chatPlaces(exec, files)
    const dest = parsePlace(o.to)
    const head = places.head(dest?.kind === 'chatFiles' ? dest.id ?? null : null, '')
    // a workbook gets its formula results (the safety check is where it lands: chat-files.ts putVersion)
    got = await officeOut(exec, files, tmp, got)
    // the same format: a .mov is never saved as a version of a .mp4
    const ext = (n: string) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : '' }
    if (ext(got.name) !== ext(head.name)) return { ok: false, text: `Not saved: ${shown} is a .${ext(got.name) || '(no extension)'} file and '${head.name}' is a .${ext(head.name) || '(no extension)'} file; a new version keeps the file's format. Make it in the same format, or attach it as a separate file (to_folder "chat:files/").`, summary: `${tool} -> refused: other format` }
    // copied into the work folder in this answer to be remade: that copy stands for the read, for this route only
    const copied = remakesOf(files).get(head.path)
    if (copied && copied === head.sha256 && !files.readHashes.has(head.path)) files.readHashes.set(head.path, copied)
    const c: ToolCtx = { user: exec.livePrincipal(), turnId: spec.turnId, files, signal: exec.abort.signal, places }
    const made = await attachProduced(rt.ctx, c, o.to.split('/'), tmp)
    const v = 'chatVersion' in made ? (made as { chatVersion: import('../files/place-output').ChatVersionMade }).chatVersion : null
    if (!v) return { ok: false, text: 'Not saved: name an existing file of this chat (chat:files/<file_id>/<name>).', summary: `${tool} -> refused: not a chat file` }
    return { ok: true, to: v.path, text: `${versionText(v, 'Saved')} (from ${shown}, ${mb(v.size)} MB)${'note' in got ? got.note ?? '' : ''}`, summary: `${tool} -> version ${v.version} of ${v.path} (${v.size} B)` }
  } catch (e) {
    exec.abort.signal.throwIfAborted()
    if (e instanceof ToolError || e instanceof Denied) return { ok: false, text: `Not saved: ${e.message}`, summary: `${tool} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
    throw e
  } finally { release(); fs.rmSync(work, { recursive: true, force: true }) }
}

/** The staged copy `tmp` attached to this answer as a chat file (the k check again right before). */
async function attach(exec: TurnExec, files: TurnFiles, o: { tmp: string; name: string; sha256: string; tool: string; shown: string }): Promise<Routed> {
  const { rt, spec } = exec
  if (exec.hiddenFromLater) return { ok: false, text: 'Not attached: this answer now holds a connected service\'s answer that people added later may not see.', summary: `${o.tool} -> refused: answer hidden from later people` }
  const att = await chatFilesOf(rt.ctx).createFromAi(spec.userId, spec.chatId, o.name, o.tmp, o.sha256, files.readHashes)
  files.bytesWritten += att.size
  files.filesWritten.add(`chat-file:${att.id}`)
  exec.attachToAnswer(att)
  return { ok: true, to: chatFilePath(att.id, att.name), text: `Attached ${o.shown} to your answer as "${att.name}" (${mb(att.size)} MB, file_id=${att.id}, path ${chatFilePath(att.id, att.name)}). Everyone in this chat opens or plays it under your answer: say it is attached to this answer (it has no folder link). Anyone here can put it into a team folder with copy_files.`, summary: `${o.tool} -> attached to the answer (${att.size} B)` }
}

// ---------------- copy_files with a chat place ----------------

type Item = { from: string; ok: true; to: string; note?: string } | { from: string; ok: false; error: string }

/** Does this copy_files call name a chat place (chat:files/…, chat:work/…, or another reserved form)? */
export function namesPlace(args: unknown): boolean {
  const a = args && typeof args === 'object' ? args as { paths?: unknown; to_folder?: unknown } : {}
  return isReservedPlace(a.to_folder) || (Array.isArray(a.paths) && a.paths.some(isReservedPlace))
}

/** Why the target of a places copy is refused before any card (plain words), or null. */
function targetRefusal(exec: TurnExec, files: TurnFiles, to: string): string | null {
  const place = parsePlace(to)
  if (!place) return null
  const rc = resolveCtxOf(exec, files)
  if (place.kind === 'reserved') return `${place.why}.`
  if (rc.chatKind === 'project') return PLACE_WORDS.projectSave
  if (place.kind === 'chatFiles') {
    // an existing chat file by its own path: a work file saved as its newest version (QA TC-r2u-10: a remade video
    // became a new file each time); who may and the file itself are checked by ChatPlaces.head in the route
    if (place.id && place.name) return null
    if (place.id || place.name) return 'to_folder is a folder: give "chat:files/" (the copy keeps its name), not a file in it; to save a work file as a new version of a file of this chat, give that file\'s own path, chat:files/<file_id>/<name>.'
    const ok = mayAttachChatFile(rc)
    return ok === true ? null : ok
  }
  const r = resolvePlace(to, rc, 'write')
  return r.refused ?? (r.writable === true ? null : r.writable)
}

/** Why a chat place source is refused whatever the person says (before any card), or null (a team path: its own checks
 * run in the call). */
function sourceRefusal(exec: TurnExec, from: string, to: string): string | null {
  const src = parsePlace(from)
  if (!src) return null
  if (src.kind === 'reserved') return `${src.why}.`
  const dest = parsePlace(to)
  if (src.kind === 'work') return dest?.kind === 'work' ? 'it is in the work folder already: copy it there with a box_shell command (cp).' : null
  if (dest?.kind === 'chatFiles') return 'it is a file of this chat already.'
  const f = chatFileFor(exec, src)
  return typeof f === 'string' ? f : null
}

/** copy_files, with the places copy for a call that names a chat place; the team copy (`team`) for any other. */
/** `personOf`: the turn's person as a registered tool's call gets it (chat/tools.ts toolContext: after a room read,
 * copy_files' own card carries the room line) */
export type PersonOf = (files: TurnFiles, call: { tool: string; args: unknown }) => ToolCtx['person']

export function withPlaces(exec: TurnExec, team: Tool, personOf: PersonOf): Tool {
  return {
    ...team,
    refuse(args, files) {
      if (!namesPlace(args)) return null
      const a = CopyFilesInput.safeParse(args)
      if (!a.success) return null
      try { exec.livePrincipal() } catch { return { text: 'Access denied: this account is disabled.', summary: `${COPY_FILES_TOOL} -> denied: account disabled` } }
      const no = targetRefusal(exec, files ?? exec.files, a.data.to_folder)
      if (no) return { text: `Nothing was copied: ${no}`, summary: `${COPY_FILES_TOOL} -> refused: ${parsePlace(a.data.to_folder)?.kind ?? 'place'}` }
      // every source a chat place that is refused anyway (not found, held, carried by a hidden answer): before any card
      const bad = a.data.paths.map((p) => ({ p, why: sourceRefusal(exec, p, a.data.to_folder) }))
      if (bad.every((b) => b.why)) return { text: `Nothing was copied:\n${bad.map((b) => `- ${b.p}: ${b.why}`).join('\n')}`, summary: `${COPY_FILES_TOOL} -> refused: source` }
      return null
    },
    widen(args) {
      // a chat file or a work file into a team folder: that folder, with the chat (or the work folder's sources) as source
      if (!namesPlace(args)) return undefined
      const a = CopyFilesInput.safeParse(args)
      if (!a.success || isReservedPlace(a.data.to_folder)) return undefined
      const first = a.data.paths.map((p) => parsePlace(p)).find((p): p is Extract<Place, { kind: 'chatFiles' | 'work' }> => p?.kind === 'chatFiles' || p?.kind === 'work')
      if (!first) return undefined
      const name = first.kind === 'work' ? first.rel.split('/').pop() ?? '' : first.name
      const w: WidenOf = { target: `${clean(a.data.to_folder)}/${name || 'file'}`, extra: [], read: first.kind === 'work' ? workSources(exec, exec.files.workFolder?.() ?? null) : [{ type: 'chat', id: exec.spec.chatId }] }
      return w
    },
    async call(args, files) {
      if (!namesPlace(args)) return team.call(args, files)
      const a = CopyFilesInput.safeParse(args)
      if (!a.success) return team.call(args, files)
      return copyPlaces(exec, team, files, a.data.paths, a.data.to_folder, args, personOf)
    },
  }
}

async function copyPlaces(exec: TurnExec, team: Tool, files: TurnFiles, paths: string[], toFolder: string, args: unknown, personOf: PersonOf): Promise<Out> {
  const tool = COPY_FILES_TOOL
  try { exec.livePrincipal() } catch { return { ...text('Access denied: this account is disabled.', true), summary: `${tool} -> denied: account disabled` } }
  const no = targetRefusal(exec, files, toFolder)
  if (no) return { ...text(`Nothing was copied: ${no}`, true), summary: `${tool} -> refused` }
  const dest = parsePlace(toFolder)
  const uniq = [...new Set(paths.map((p) => p.trim()))]
  const items: Item[] = []
  const extra: string[] = []
  // into a team folder: the team sources through the team copy (its own card), the chat places here
  if (!dest) {
    const teamOnes = uniq.filter((p) => !isReservedPlace(p))
    if (teamOnes.length) {
      const r = await team.call({ paths: teamOnes, to_folder: toFolder }, files)
      extra.push(r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'))
    }
  }
  const folderShown = dest?.kind === 'work' ? workPlacePath(dest.rel) : dest?.kind === 'chatFiles' ? 'chat:files/' : clean(toFolder) || 'the team root'
  // after a room read in the person's own chat: copy_files asks on its own card before anything goes to a team folder
  // (as the team copy does: TurnPerson.roomsSeen)
  const chatOnes = uniq.filter((p) => !dest ? isReservedPlace(p) : true)
  if (!dest && chatOnes.length) {
    const asked = await roomCard(exec, files, personOf(files, { tool, args }), chatOnes, clean(toFolder))
    if (asked) return { ...text([...extra, asked].filter(Boolean).join('\n\n'), true), summary: `${tool} -> refused (after a room read)` }
  }
  for (const p of chatOnes) {
    if (exec.abort.signal.aborted) { items.push({ from: p, ok: false, error: 'cancelled' }); continue }
    try { items.push(await copyOne(exec, files, p, toFolder, dest, args)) } catch (e) {
      exec.abort.signal.throwIfAborted()
      if (e instanceof ToolError || e instanceof Denied) { items.push({ from: p, ok: false, error: e.message }); continue }
      throw e
    }
  }
  const done = items.filter((i): i is Extract<Item, { ok: true }> => i.ok)
  const failed = items.filter((i): i is Extract<Item, { ok: false }> => !i.ok)
  const body = [
    ...extra,
    done.length ? `Copied ${done.length} to ${folderShown}:\n${done.map((d) => `- ${d.from} -> ${d.to}`).join('\n')}` : chatOnes.length ? 'Nothing was copied.' : '',
    ...done.map((d) => d.note ?? '').filter(Boolean),
    failed.length ? `Not copied:\n${failed.map((f) => `- ${f.from}: ${f.error}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  const summary = `${tool} ${done.length}/${items.length} -> ${dest?.kind === 'work' ? 'chat:work/' : dest?.kind === 'chatFiles' ? 'chat:files/' : clean(toFolder)}`
  return { ...text(body, !done.length && !extra.length), summary }
}

/** After a room read in the person's own chat: the copy card before chat files or work files go to a team folder.
 * Null to go on, or the refusal. */
async function roomCard(exec: TurnExec, files: TurnFiles, person: ToolCtx['person'], from: string[], folder: string): Promise<string | null> {
  const main = files === exec.files
  if (!exec.ownCard(COPY_FILES_TOOL) || !person?.roomsSeen) return null
  // this chat's own files (what its commands made, what was sent or made here) as NEW files in the person's own folder:
  // no card, as write's exception for a new file there (QA TC-f2-c02; chat/turn.ts ownFolderCopy)
  const landing = landingPaths(exec, files, from, folder)
  if (landing && exec.ownFolderCopy(landing, main)) return null
  const L: Locale = person.locale ?? exec.spec.locale
  const fill = (s: string, v: Record<string, string | number>) => fillPlurals(s, v, L).replace(/\{(\w+)\}/g, (_, k) => String(v[k]))
  const question = [fill(MOVE_TEXT.copy[L], { n: from.length, to: placeWords(exec.rt.db, folder, L, exec.spec.userId) }), fill(MOVE_TEXT.askCopy[L], { count: from.length })].join(' ') + '\n\n' + from.slice(0, 10).map((p) => p.split('/').pop()).join('\n')
  const end = await askConfirm(person, question, MOVE_TEXT.yesCopy[L], MOVE_TEXT.no[L], { always: 'move_files' })
  if (end === 'yes') return null
  return refusal({ done: end === 'declined' ? 'The user did not allow this, so nothing was copied.' : 'Nothing was copied.', why: cardReason(end), next: end === 'declined' ? 'ask the user what they want' : cardNext(end), names: [folder || '/'] })
}

/** Where each of these chat place sources lands in team folder `folder`, by the names copyOne gives them (a chat file
 * by its name, a work file by its last part), or null when any is not a file of this chat or its work folder that can
 * be found now (a folder of the work folder, a hidden or refused one: the card asks). */
export function landingPaths(exec: TurnExec, files: TurnFiles, from: readonly string[], folder: string): string[] | null {
  const out: string[] = []
  for (const p of from) {
    const src = parsePlace(p)
    let name: string
    if (src?.kind === 'chatFiles') {
      const f = chatFileFor(exec, src)
      if (typeof f === 'string') return null
      name = f.name.normalize('NFC').replace(/[/\\\u0000-\u001f]+/g, '_').trim() || 'file'
    } else if (src?.kind === 'work') {
      if (!src.rel) return null
      const wf = files.workFolder?.() ?? null
      if (!wf) return null
      try { if (!fs.lstatSync(path.join(wf.real, src.rel)).isFile()) return null } catch { return null }
      name = src.rel.split('/').pop()!
    } else return null
    out.push(folder ? `${folder}/${name}` : name)
  }
  return out
}

/** One source of a places copy: to the work folder, to this chat's files, or to a team folder. */
async function copyOne(exec: TurnExec, files: TurnFiles, from: string, toFolder: string, dest: Place | null, args: unknown): Promise<Item> {
  const { rt, spec } = exec
  const src = parsePlace(from)
  const fail = (error: string): Item => ({ from, ok: false, error })
  if (src?.kind === 'reserved') return fail(`${src.why}.`)
  const rc = resolveCtxOf(exec, files)
  if (src) {
    const r = resolvePlace(from, rc, 'read')
    if (r.refused) return fail(r.refused)
  }
  const routed = (r: Routed, shown = from): Item => (r.ok ? { from: shown, ok: true, to: r.to, note: r.text } : fail(r.text))

  // ---- into the work folder ----
  if (dest?.kind === 'work') {
    if (src?.kind === 'work') return fail('it is in the work folder already: copy it there with a box_shell command (cp).')
    const target = workTarget(exec, files)
    if (!target) return fail(noWorkText(files.workWhy?.()))
    let source: WorkSource
    let sources: ReadSource[]
    if (src?.kind === 'chatFiles') {
      const f = chatFileFor(exec, src)
      if (typeof f === 'string') return fail(f)
      const op = chatFilesOf(rt.ctx).open(spec.userId, spec.chatId, f.id, false)
      if (op.quarantined || op.sha256 !== f.sha256) return fail('the team\'s safety check holds this file, so it is not copied.')
      source = { kind: 'file', abs: op.abs, name: f.name }
      // copied in to be remade (a video cut again with box_shell): it counts as read, so the remade file can be saved as
      // its newest version (workToChatVersion; the head's hash, as edit_office's read-first rule)
      try { const head = chatPlaces(exec, files).head(f.id, ''); if (head.sha256 === f.sha256) remakesOf(files).set(head.path, head.sha256) } catch { /* not one this person may change here */ }
      sources = [{ type: 'chat', id: spec.chatId }]
    } else {
      const team = teamSource(exec, from)
      if (typeof team === 'string') return fail(team)
      source = team.source
      sources = team.sources
    }
    const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, spec.userId)
    const r = await writeIntoWork(rt.ctx, target, dest.rel ? `${dest.rel}/` : '', source, {
      ...(target.shared ? { sources } : {}),
      turnLeft: { bytes: Math.max(0, max.bytes - files.bytesWritten), files: Math.max(0, max.files - files.filesWritten.size) },
      signal: exec.abort.signal,
    })
    files.bytesWritten += r.bytes
    for (let i = 0; i < r.files; i++) files.filesWritten.add(`chat:work/${r.path}${r.files > 1 ? `#${i}` : ''}`)
    const notes = [
      r.files > 1 ? `${r.files} files, ${mb(r.bytes)} MB.` : '',
      r.skipped.length ? `Not copied from inside it (links, pipes, hard links and odd names never are): ${r.skipped.slice(0, 20).map((s) => `${s.path} (${s.why})`).join(', ')}${r.skipped.length > 20 ? ', …' : ''}.` : '',
      r.viaLink ? `Note: ${workPlacePath(r.viaLink)} in the work folder is a link a command made, so the copy went where that link points (as far as the box may write there), not into the work folder itself. Copy it again into a plain folder of the work folder if a command needs it there.` : '',
      `In box_shell it is $TRINA_WORK/${r.path}.${exec.devEnv?.shared ? ' Everyone in this chat sees what is made from it.' : ''}`,
    ].filter(Boolean).join(' ')
    return { from, ok: true, to: workPlacePath(r.path), note: notes }
  }

  // ---- into this chat's files (attached to the answer) ----
  if (dest?.kind === 'chatFiles') {
    if (src?.kind === 'chatFiles') return fail('it is a file of this chat already.')
    if (dest.id) {
      if (src?.kind !== 'work') return fail('only a file your box_shell commands made in the work folder (chat:work/…) is saved as a new version this way; change a document with edit_office, edit_pdf, write or edit.')
      return routed(await workToChatVersion(exec, files, { rel: src.rel, to: toFolder.trim(), tool: COPY_FILES_TOOL, shown: workPlacePath(src.rel) }))
    }
    if (src?.kind === 'work') return routed(await workToChat(exec, files, { rel: src.rel, where: () => files.workFolder?.() ?? null, tool: COPY_FILES_TOOL, shown: workPlacePath(src.rel) }))
    return routed(await teamToChat(exec, files, from))
  }

  // ---- into a team folder ----
  const folder = clean(toFolder)
  if (src?.kind === 'chatFiles') {
    const f = chatFileFor(exec, src)
    if (typeof f === 'string') return fail(f)
    const own = f.name.normalize('NFC').replace(/[/\\\u0000-\u001f]+/g, '_').trim() || 'file'
    const target = folder ? `${folder}/${own}` : own
    const no = teamTargetRefusal(exec, target)
    if (no) return fail(no)
    return routed(await chatFileToTeam(exec, files, { file: f, target, tool: COPY_FILES_TOOL, args }))
  }
  if (src?.kind === 'work') {
    if (!src.rel) return fail('this is the work folder itself; name a file in it.')
    const wf = files.workFolder?.() ?? null
    if (!wf) return fail(noWorkText(files.workWhy?.()))
    let st: fs.Stats | null = null
    try { st = fs.lstatSync(path.join(wf.real, src.rel)) } catch { st = null }
    if (st?.isDirectory()) return fail('a folder of the work folder is not copied out; zip it with a box_shell command first and copy the zip.')
    const target = folder ? `${folder}/${src.rel.split('/').pop()}` : src.rel.split('/').pop()!
    const no = teamTargetRefusal(exec, target)
    if (no) return fail(no)
    return routed(await workToTeam(exec, files, { rel: src.rel, target, where: () => files.workFolder?.() ?? null, tool: COPY_FILES_TOOL, args, shown: workPlacePath(src.rel) }))
  }
  return fail('copy it with copy_files to a team folder without chat places in the same call.')
}

/** The work folder target of this turn for its main AI, or null where commands run in no work folder. */
function workTarget(exec: TurnExec, files: TurnFiles): WorkTarget | null {
  if (files !== exec.files || !workCopyInHere(exec)) return null
  return { ...workAt(exec), expect: files.workFolder?.() ?? null }
}

/** A chat file a place names, as the person may open it now, or why not (plain words). */
export function chatFileFor(exec: TurnExec, place: Extract<Place, { kind: 'chatFiles' }>): ChatFileRow | string {
  const { rt, spec } = exec
  const name = place.name || place.id || ''
  const notFound = `No file "${oneLine(name, 120)}" sent in this chat.`
  if (!place.id && !place.name) return 'name a file of this chat (list chat:files/ shows them), not the list itself.'
  if (!seesChatFiles(rt.db, spec.userId, spec.chatId)) return notFound
  // ChatFiles.find (over visibleTo): any id of a chain gives its newest version; a chain a k answer carries is refused
  const store = chatFilesOf(rt.ctx)
  const f = store.find(spec.userId, spec.chatId, place.id ?? place.name, true)?.head ?? null
  if (!f) return notFound
  if (store.kCarried(f)) return `the file "${oneLine(f.name, 120)}" came with an answer that is kept from some people who may join this chat, so it is not copied.`
  if (rt.files.quarantine.hasHash(f.sha256)) return 'the team\'s safety check holds this file, so it is not copied.'
  return f
}

/** A team file or folder as a copy into the work folder reads it: every entry the person may read (a folder: links,
 * pipes and hard links are skipped by the writer; hidden and skills entries here), and the read scope's sources of it
 * (its folder, and each folder with its own rules under it the person may read: turn.ts sharedSources). */
function teamSource(exec: TurnExec, p: string): { source: WorkSource; sources: ReadSource[] } | string {
  const { rt } = exec
  const me = exec.livePrincipal()
  const rules = rt.files.rules()
  const rel = clean(p)
  if (inSkills(rel)) return SKILL_FILES_REFUSAL
  const r = authorize(rt.files.fx, rules, me, rel, 'read')
  if (!r.exists || !r.st) return `'${rel}' was not found or you have no access`
  const sources = exec.sharedSources(COPY_FILES_TOOL, { paths: [r.rel], to_folder: 'chat:work/' }).filter((s) => s.type !== 'chat')
  if (r.st.isDirectory()) {
    const include = (sub: string, kind: 'file' | 'folder') => {
      const parts = sub.split('/')
      if (parts.some((n, i) => hiddenEntry(n, r.segs.length + i))) return false
      const segs = [...r.segs, ...parts]
      if (inSkills(segs.join('/'))) return false
      return kind === 'folder' ? rules.canList(me, segs) || atLeast(rules.access(me, segs), 'read') : atLeast(rules.access(me, segs), 'read')
    }
    return { source: { kind: 'folder', abs: r.abs, include }, sources }
  }
  return { source: { kind: 'file', abs: r.abs, seen: r.st }, sources }
}

/** Why a copy will not be placed at the team path `target` whatever the person says, or null. */
export function teamTargetRefusal(exec: TurnExec, target: string): string | null {
  const rt = exec.rt
  if (inSkills(target)) return 'a file is not copied into a skills folder (team, group or project skills and rules) this way; pick another folder.'
  if (instructionLike(target)) return `'${target}' is named like an instruction file the AI follows (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md); pick another name.`
  try { authorize(rt.files.fx, rt.files.rules(), exec.livePrincipal(), target, 'write', { createDirs: true }) } catch (e) {
    if (e instanceof Denied || e instanceof ToolError) return e.message
    throw e
  }
  return null
}

/** A team file attached to this answer (a chat shared with people; the shared read card already asked in call()). */
async function teamToChat(exec: TurnExec, files: TurnFiles, p: string): Promise<Routed> {
  const { rt, spec } = exec
  const tool = COPY_FILES_TOOL
  const rel = clean(p)
  const r = authorize(rt.files.fx, rt.files.rules(), exec.livePrincipal(), rel, 'read')
  if (!r.exists || !r.st) return { ok: false, text: `'${rel}' was not found or you have no access`, summary: `${tool} -> not found` }
  if (r.st.isDirectory()) return { ok: false, text: 'chat files have no folders: copy the files in it one by one, or zip it with make_zip first.', summary: `${tool} -> refused: folder` }
  const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, spec.userId)
  const left = Math.min(CHAT_FILE_AI_MAX, Math.max(0, max.bytes - files.bytesWritten))
  if (files.filesWritten.size >= max.files) return { ok: false, text: `this answer saved its most files already (${max.files}); attach it in the next answer`, summary: `${tool} -> refused: too many` }
  if (r.st.size > left) return { ok: false, text: `'${rel}' is larger than what can be attached now (at most ${(left / 1024 ** 2).toFixed(0)} MB in this answer; a file attached to an answer is at most ${CHAT_FILE_AI_MAX / 1024 ** 3} GB).`, summary: `${tool} -> refused: too large` }
  // the same mark as workToChat (#200 review): no k group joins this answer while the file is copied and attached
  const release = exec.beginAttach()
  if (exec.hiddenFromLater) { release(); return { ok: false, text: 'Not attached: this answer now holds a connected service\'s answer that people added later may not see.', summary: `${tool} -> refused: answer hidden from later people` } }
  const work = tempDir(exec, 'team-file-')
  try {
    const tmp = path.join(work, 'file')
    // the team disk near full: refused before the copy is made (createFromAi checks again)
    assertStorageRoomForAI(r.st.size)
    const got = await streamCopy(r.abs, r.st, tmp, left, exec.abort.signal)
    if (rt.files.quarantine.hasHash(got.sha256)) return { ok: false, text: 'Not attached: the team\'s safety check holds this file.', summary: `${tool} -> held` }
    // what it holds is in the answer now: its folder joins the chat's read scope, as a read does
    files.readPaths.add(r.rel)
    return await attach(exec, files, { tmp, name: r.segs.at(-1)!, sha256: got.sha256, tool, shown: r.rel })
  } finally { release(); fs.rmSync(work, { recursive: true, force: true }) }
}

function tempDir(exec: TurnExec, prefix: string): string {
  const base = path.join(exec.rt.ctx.engineConfig.dataDir, 'work')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  return fs.mkdtempSync(path.join(base, prefix))
}

/** Stream `abs` (checked against `seen`, or opened with O_NOFOLLOW) into the new file `dest`, at most `max` bytes. */
async function streamCopy(abs: string, seen: fs.Stats | undefined, dest: string, max: number, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const { fd, st } = openToRead(abs, seen)
  const { createHash } = await import('node:crypto')
  try {
    if (st.size > max) throw new ToolError('the file is too large to copy here', 'too_large')
    const out = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      const h = createHash('sha256')
      const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
      let pos = 0
      while (pos < st.size) {
        signal?.throwIfAborted()
        const n = await new Promise<number>((ok, no) => fs.read(fd, buf, 0, Math.min(buf.length, st.size - pos), pos, (e, k) => (e ? no(e) : ok(k))))
        if (n <= 0) break
        h.update(buf.subarray(0, n))
        fs.writeSync(out, buf, 0, n, pos)
        pos += n
      }
      return { size: pos, sha256: h.digest('hex') }
    } finally { fs.closeSync(out) }
  } finally { fs.closeSync(fd) }
}


/**
 * A chat place as an input file of a tool (query_data's paths): copied to `dest` (a new file) through this turn's own
 * checks: a chat file as the person may open it now (not held, not carried only by a hidden answer), a work-folder file
 * through copyWorkFile, after a shared chat recorded what a run there may read and what was copied in. Its source joins
 * the chat's read scope (the chat, or the person for a personal chat's work folder), and the turn is marked as after
 * other people's words, as a read of it is. ToolError in plain words.
 */
export async function stagePlaceInput(exec: TurnExec, files: TurnFiles, value: string, dest: string, max: number, signal?: AbortSignal): Promise<{ name: string; size: number; sha256: string }> {
  const { rt, spec } = exec
  const place = parsePlace(value)
  if (!place || place.kind === 'reserved') throw new ToolError(place?.kind === 'reserved' ? `${place.why}.` : `'${value}' is not a chat place`, 'bad_path')
  const r = resolvePlace(value, resolveCtxOf(exec, files), 'read')
  if (r.refused) throw new ToolError(r.refused, 'not_found')
  exec.noteTaint('read', { file_path: value })
  if (place.kind === 'chatFiles') {
    const f = chatFileFor(exec, place)
    if (typeof f === 'string') throw new ToolError(f, 'not_found')
    const op = chatFilesOf(rt.ctx).open(spec.userId, spec.chatId, f.id, false)
    if (op.quarantined || op.sha256 !== f.sha256) throw new ToolError('the team\'s safety check holds this file', 'safe_ops_quarantined')
    if (f.size > max) throw new ToolError(`'${value}' is ${mb(f.size)} MB, larger than the ${mb(max)} MB that can be calculated over here`, 'too_large')
    const got = await streamCopy(op.abs, undefined, dest, max, signal)
    if (got.sha256 !== f.sha256) throw new ToolError('the file changed while it was read; try again', 'changed')
    addSources(rt.db, spec.chatId, [{ type: 'chat', id: spec.chatId }])
    return { name: f.name, ...got }
  }
  const wf = files.workFolder?.() ?? null
  if (!wf || files !== exec.files) throw new ToolError(noWorkText(files === exec.files ? files.workWhy?.() : 'helper'), 'not_found')
  if (!noteWorkRead(exec)) throw new ToolError(workUnavailable(files), 'not_recorded')
  const got = await copyWorkFile(wf, place.rel, dest, max, signal)
  if (!exec.devEnv?.shared) addSources(rt.db, spec.chatId, [{ type: 'user', id: spec.userId }])
  return got
}
