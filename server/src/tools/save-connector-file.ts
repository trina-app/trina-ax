// save_connector_file: the original file a connected service gave, saved into the team folder as it is
// (docs/decisions/20261118-save-connector-file.md). Before it a Gmail attachment or a Google Drive file reached the AI
// only as text: a Word, Excel or Hangul attachment could be kept only by retyping its text, and a Drive file not at all.
//   - `mcp-file:<id>`: a file kept for this chat (integrations/connections/media.ts): every Gmail attachment the AI read
//     (google-apps/attachments.ts) and any file in a connection's answer. It opens only in the chat it was made in and
//     only for the person of that turn, for 24 hours; what the connection was allowed to give was decided when it was
//     read (its own scopes, and in a shared chat the asker's card, docs/decisions/20261118-shared-chat-connections.md).
//   - `drive:<id>`: a Google Drive file through drive_read's path (tools/drive.ts withDrive: the person's own Drive or a
//     team share, only inside its shared folders, the share checked again after the call, the source recorded as what
//     the chat read). Google's own formats are exported as .docx, .xlsx or .pptx. In a shared chat behind the asker's
//     one Drive notice there, as drive_read (docs/decisions/20261126-shared-chat-everything.md).
//   - Caps stay: a Gmail attachment at most ATTACHMENT_MAX_BYTES (18 MB, what one answer can carry), a Drive file the
//     server's read limit and 32 MB (10 MB for an export). Any kind of file: it is the person's own file from their
//     own service, saved with its own name, like an upload; files on the team's safety-check list are refused.
//   - Saved like save_url and save_room_file: never under skills/ or as an instruction file, the person's write access
//     checked before and again at the end (placeProduced: a version of a file the AI read in this turn, else a copy
//     next to it, the storage check, file events), and the wider-audience card when more people can see the folder
//     than what this chat read.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { z } from 'zod'
import type { SaveConnectorFileInput } from '@mycel/shared'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { getMedia, MEDIA_PREFIX } from '../integrations/connections/media'
import { driveOriginal } from '../integrations/google-drive/read'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { inAnySkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { privateToMe } from '../files/share-readers'
import { placeProduced } from './make-file'
import { savePathArg } from './save-target'
import { cleanName, humanBytes } from './save-url'
import { refusedName, sniffKind, withExtension } from './sniff'
import { withDrive } from './drive'
import { getRow, mayUse } from '../integrations/connections/store'
import { answerSources } from '../integrations/connections/tools'
import { addSources } from '../chat/read-scope'
import type { StepImage } from './registry'

type Input = z.output<typeof SaveConnectorFileInput>

export const SAVE_CONNECTOR_FILE_DESCRIPTION =
  'Save the original file a connected service gave into the team folder, as it is (a Word, Excel, Hangul, PDF or any other file, not its text): ' +
  'file "mcp-file:<id>" for a Gmail attachment you read (its handle is in the attachment\'s result) or a file in a connection\'s answer, or ' +
  '"drive:<file id>" for a Google Drive file (a Google document, sheet or presentation is saved as .docx, .xlsx or .pptx; source as in drive_read). ' +
  'Use it when the user asks to keep, save or share such a file in the team files: never retype its text into a new file instead. ' +
  'save_as is a team path; a path ending in "/" keeps the file\'s own name; left out, the user\'s own downloads folder.'

const INSTRUCTION_NAME = /^(CLAUDE|AGENTS|GEMINI|SKILL)\.md$/i
/** direction marks that make a name read differently from what it is ("invoice\u202Efdp.exe") */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
/** Office and Hangul formats that are ZIP files inside */
const ZIP_OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|hwpx)$/i

/** The name the copy gets: the given one (a Gmail attachment's comes from the AI's call, a file's address, a Drive
 * file's name), cleaned, its extension what the bytes are where that can be told; null for a program or script
 * (never saved). A name that is empty or only dots becomes "file-<random>". */
export function nameFor(given: string, bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 64)
  const refused = refusedName(head)
  if (refused === 'a program' || refused === 'a script') return null
  let name = cleanName(given.replace(BIDI, ''))
  const kind = sniffKind(head)
  if (kind) return withExtension(name || `file-${crypto.randomBytes(3).toString('hex')}`, kind).name
  if (!name) name = `file-${crypto.randomBytes(3).toString('hex')}`
  if (refused === 'a ZIP archive (or an Office file)') {
    // an Office or Hangul name over a ZIP that is not one (no [Content_Types].xml, no mimetype entry): a .zip
    const office = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const isOffice = office.includes('[Content_Types].xml') || office.includes('mimetype')
    if (!(ZIP_OFFICE.test(name) && isOffice) && !/\.zip$/i.test(name)) name = `${name.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.zip`
  }
  return name
}

/** a saved picture the chat draws under the step by itself (web isDisplayableImagePath: PNG, JPEG, GIF, WebP) */
const SHOWN_PICTURE = /\.(png|jpe?g|gif|webp)$/i
/** What the result says about a saved picture: shown in the chat already, so the AI does not retype its path as a
 * Markdown image (the demo's Higgsfield picture; a retyped banner path showed one size twice, 11-22). */
export const PICTURE_SHOWN = 'The chat already shows this picture under this step: do not write it as a Markdown image or link in your answer (that would show it twice).'

export async function saveConnectorFile(ctx: AppContext, a: Input, t: ToolCtx): Promise<{ text: string; summary: string; structured: Record<string, unknown>; stepImages?: StepImage[] }> {
  if (!t.turnId) throw new ToolError('save_connector_file only works inside a chat turn')
  const turn = ctx.db.query('SELECT chat_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; user_id: string } | null
  if (!turn) throw new ToolError('unknown turn')
  if (turn.user_id !== t.user.id) throw new Denied('turn belongs to another person')
  const chatId = turn.chat_id
  const files = componentC(ctx).files
  const ref = a.file.trim()

  // where it goes: save_as (a folder when it ends in "/" or is one), or the person's own downloads folder
  const wanted = a.save_as === undefined ? '' : savePathArg(a.save_as)
  let isFolder = !wanted || wanted.endsWith('/')
  if (!isFolder) { try { isFolder = !!authorize(files.fx, files.rules(), t.user, wanted, 'list').st?.isDirectory() } catch { /* not a folder this person sees */ } }
  const folder = !wanted ? `users/${t.user.id}/downloads` : isFolder ? wanted.replace(/\/+$/, '') : wanted.split('/').slice(0, -1).join('/')
  const place = (name: string) => {
    const target = isFolder ? [folder, name].filter(Boolean).join('/') : wanted
    if (inAnySkills(target)) throw new ToolError('files cannot be saved in a skills folder (skills/, a group\'s or a project\'s: skills and rules people\'s AI follows); pick another folder')
    if (INSTRUCTION_NAME.test(target.split('/').pop() ?? '')) throw new ToolError(`'${target}' is named like an instruction file the AI follows (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md), and a connected service's file is not put there. Pick another name`)
    // refused before any card: a place the person cannot write (placeProduced checks again right before the write)
    const r = authorize(files.fx, files.rules(), t.user, target, 'write', { mustExist: false, createDirs: true })
    if (r.exists && r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; give a file name or end the path with "/"`)
    return target
  }
  // the place is checked before anything is fetched: an explicit file name as it is, a folder with a stand-in name
  place(isFolder ? 'file' : wanted.split('/').pop()!)

  let bytes: Buffer
  let name: string
  let from: string
  let type: string
  if (ref.startsWith(MEDIA_PREFIX)) {
    const item = getMedia(ctx.engineConfig.dataDir, chatId, t.user.id, ref)
    if (!item) throw new ToolError(`no file ${ref.slice(0, 60)} in this chat: an mcp-file handle works only in the chat whose connection answer named it, for 24 hours. Read the attachment or call the service again to get a new one`)
    // the connection it came from: still there, and this person may still use it (a connection removed, or a rule that
    // no longer includes them, takes what it gave with it)
    const row = getRow(ctx.db, item.meta.integrationId)
    if (!row || !mayUse(ctx.db, row, t.user.id)) throw new ToolError('the connection this file came from is gone, or the user may no longer use it, so it was not saved')
    // where the bytes come from, for the wider-audience card (as save_room_file does: the read is recorded again)
    addSources(ctx.db, chatId, answerSources(row))
    bytes = fs.readFileSync(item.file)
    const kind = sniffKind(bytes.subarray(0, 64))
    const named = nameFor(item.meta.name ?? '', bytes)
    if (named === null) throw new ToolError('the file is a program or a script, so it was not saved')
    name = named
    from = ref
    type = kind?.mime ?? (item.meta.declared || 'application/octet-stream')
  } else {
    if (!googleDriveOf(ctx).enabled) throw new ToolError('Google Drive is not set up on this server')
    const fileId = ref.slice('drive:'.length)
    const { result } = await withDrive(ctx, t, a.source, (s, signal) => driveOriginal(s.conn, fileId, signal, s.scope))
    bytes = result.bytes
    const named = nameFor(result.name, bytes)
    if (named === null) throw new ToolError('the file is a program or a script, so it was not saved')
    name = named
    // where it came from: its Drive link, or on a demo server (no real Drive address) its name marked as Drive's, never
    // a bare file name that something reading `url` could take for a relative link
    from = result.webViewLink ?? `Google Drive: ${name}`
    type = result.mimeType
    ctx.files.events.emit('external', { turnId: t.turnId, userId: t.user.id, source: 'save_connector_file', url: from })
  }
  if (!bytes.length) throw new ToolError('the file is empty, so it was not saved')
  // bytes the team's safety check holds back are given to no AI tool (safe-ops/quarantine.ts)
  ctx.files.quarantine.assertBytes(bytes)
  const target = place(name)

  // the wider-audience card: more people can see the target than what this chat read (the connection's answer, the
  // Drive share); without a chat turn's check only the person's own private folder (fail closed, like save_url)
  if (!t.confirmWidening) {
    let mine = false
    try { mine = target.startsWith(`users/${t.user.id}/`) && privateToMe(ctx.db, t.user.id, authorize(files.fx, files.rules(), t.user, target, 'write', { mustExist: false, createDirs: true }).segs) } catch { /* no */ }
    if (!mine) throw new ToolError('outside a chat this can only save into your own folder (users/<you>/)')
  } else {
    const refusal = await t.confirmWidening(target, [])
    if (refusal) throw new ToolError(refusal)
  }
  t.signal?.throwIfAborted()

  const workRoot = path.join(ctx.engineConfig.dataDir, 'work')
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
  const work = fs.mkdtempSync(path.join(workRoot, 'connector-file-'))
  try {
    const tmp = path.join(work, 'file')
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' })
    const made = await placeProduced(ctx, files, t, target.split('/').filter(Boolean), tmp, 'save_connector_file', undefined, { turnBytes: false, fetched: true, detail: { url: from.slice(0, 4000), type } })
    const note = made.conflictCopyOf ? `\n${made.conflictCopyOf} already existed and was not read in this turn, so this was saved as a copy next to it; the original is unchanged.` : ''
    const picture = SHOWN_PICTURE.test(made.path) && type.startsWith('image/')
    return {
      text: `Saved the original file "${name}" as ${made.path} (${humanBytes(made.size)}).${note}${picture ? `\n${PICTURE_SHOWN}` : ''}`,
      ...(picture ? { stepImages: [{ path: made.path, alt: name }] } : {}),
      summary: `save_connector_file -> ${made.path} (${made.size} B, ${type.slice(0, 100)}, sha256 ${made.sha256}) from ${from.slice(0, 300)}`,
      structured: { path: made.path, size: made.size, sha256: made.sha256, type, ...(made.conflictCopyOf ? { conflictCopyOf: made.conflictCopyOf } : {}) },
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}
