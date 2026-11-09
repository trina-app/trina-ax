import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import { authorize, type Authorized } from '../../policy/authorize'
import { Denied, ToolError } from '../../policy/errors'
import { widening } from '../../chat/read-scope'
import { componentC } from '../../team-files/component'
import { FileError } from '../../team-files/errors'
import { fileEvent, sha256 } from '../../files/store'
import { assertStorageRoomForAI } from '../../system/storage'
import { inSkills } from '../../skills/guard'
import { atLeast } from '../../policy/access'
import { badSegment, foldKey, hiddenEntry } from '../../policy/names'
import { plainName } from './guide'
import type { ConnectorScope } from './scope'

/** Largest decoded upload through the connector. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024
/** Base64 length of UPLOAD_MAX_BYTES (no whitespace). */
export const UPLOAD_MAX_BASE64 = 4 * Math.ceil(UPLOAD_MAX_BYTES / 3)
/** Raw string limit before whitespace removal (line breaks from a base64 tool are allowed). */
export const UPLOAD_MAX_BASE64_RAW = UPLOAD_MAX_BASE64 + 1024 * 1024
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export const UploadFileInput = z.object({
  path: z.string().min(1).max(1000).describe('Target file path relative to the team root, e.g. "groups/sales/report.pdf". Missing folders are created when you may write there.'),
  content_base64: z.string().max(UPLOAD_MAX_BASE64_RAW).describe('The file bytes, base64-encoded (standard alphabet).'),
  overwrite: z.boolean().optional().describe('Replace an existing file at path. The old file is kept as a version. Default false: a name clash saves the upload as "name (2).ext".'),
}).strict()

const schema = z.toJSONSchema(UploadFileInput, { target: 'draft-7' }) as Record<string, unknown>
delete schema.$schema
export const uploadTool = {
  name: 'upload_file',
  description: 'Upload a small binary file (PDF, Word, Excel, images, zip and so on) to the team drive. Read the local file and send its bytes as base64 in content_base64. ' +
    `Maximum ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB after decoding, but you must type the base64 yourself: use this only for files up to about 50 KB. ` +
    'For a larger file, when you can run shell commands (for example in Claude Code), use create_upload_link and curl instead. For plain text files, use write. ' +
    'If a file already exists at path and overwrite is not true, the upload is saved next to it as "name (2).ext". Returns the saved path, the size in bytes and whether a copy was made.',
  inputSchema: schema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}

export type UploadOutcome = { text: string; isError?: boolean; audit: Record<string, unknown> }
export const fail = (text: string, audit: Record<string, unknown> = {}): UploadOutcome => ({ text, isError: true, audit })
export const isOutcome = (v: Authorized | UploadOutcome): v is UploadOutcome => 'text' in v

const fold = (s: string) => s.normalize('NFC').toLowerCase()
/**
 * A path a connector may not write: the team skills and rules (skills/…), a group's skills (groups/<folder>/skills/…),
 * a project's skills (projects/<name>/skills/…) and a person's own skills (users/<id>/skills/…), which the team app changes only after its confirmation
 * (skills/guard.ts). Compared without letter case or Unicode form, on the path as given and as resolved, so a
 * case-insensitive team folder cannot be used to miss it; also by foldKey (NFKC), because a macOS disk folds "ſkills"
 * into the same folder as "skills" (fail closed: such a name is refused as a root even where no root is there yet).
 */
export function skillWriteTarget(rel: string): boolean {
  const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (!segs.length) return false
  if (inSkills(segs.join('/'))) return true
  const k = segs.map(foldKey)
  return k[0] === 'skills' || (k.length >= 3 && (k[0] === 'users' || k[0] === 'groups' || k[0] === 'projects') && k[2] === 'skills')
}

/** What the AI is told when it tries to write into a real skill root: the way in is a proposal (share_skills) or the app. */
export const SKILL_POINTER = 'Use share_skills (whole team, or add "group" for one group; the owner or an admin proposes, someone confirms it in the app), or ask the user to add the skill in the team app (팀 스킬).'
const REAL_ROOT_REFUSAL = `Skill changes require confirmation inside the team app. ${SKILL_POINTER}`
/** The line a saved file that only looks like a skill gets (owner 2026-11-07): no AI loads it, so it is kept. */
export const SKILL_FILE_NOTE = 'Saved as an ordinary file: it is not a team skill. To share it as a skill, use share_skills.'
/** The same line in create_upload_link's answer, before the bytes arrive. */
export const SKILL_LINK_NOTE = 'It will be saved as an ordinary file: it is not a team skill. To share it as a skill, use share_skills.'

/**
 * The refusal for a connector write to `rel`, or null. Only the real skill roots are refused (skillWriteTarget: skills/,
 * a group's skills/, users/<id>/skills/): the team's AI loads what is there, and a write would skip share_skills' checks
 * and the confirmation in the app. A file that only looks like a skill elsewhere is saved (looksLikeSkillFile).
 */
export function skillWriteRefusal(rel: string): string | null {
  return skillWriteTarget(rel) ? REAL_ROOT_REFUSAL : null
}

/**
 * Outside the real roots, a file that looks like a skill saved as a file: a file named SKILL.md (any letter case),
 * anything below .claude/skills, .codex/skills or .agents/skills, and a .md file at skills/<name>/<file>.md. It is saved
 * with SKILL_FILE_NOTE: no engine loads skills or rules from a team folder (docs/DECISIONS.md "App connectors: a
 * SKILL.md in an ordinary folder is saved with a note"). Other files in a folder called "skills" are ordinary.
 */
export function looksLikeSkillFile(rel: string): boolean {
  if (skillWriteTarget(rel)) return false
  const k = rel.replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.').map(foldKey)
  if (k.length && k[k.length - 1] === 'skill.md') return true
  for (let i = 0; i < k.length; i++) {
    if (k[i] !== 'skills') continue
    if (i > 0 && ['.claude', '.codex', '.agents'].includes(k[i - 1]!)) return true
    if (i + 3 === k.length && k[i + 2]!.endsWith('.md')) return true
  }
  return false
}

/** At most this many subfolder names in the placement note, and at most this many folder entries looked at for it. */
export const PLACEMENT_FOLDERS = 8
export const PLACEMENT_SCAN_MAX = 500

/** The area a new file at `segs` (resolved names) sits loose at the top of: shared/, groups/<folder>/ or the team root
 * ([]); null anywhere else (a subfolder, the person's own users/<id>/, groups/ itself). */
function looseArea(segs: readonly string[]): string[] | null {
  const dir = segs.slice(0, -1)
  if (dir.length === 0 || (dir.length === 1 && dir[0] === 'shared') || (dir.length === 2 && dir[0] === 'groups')) return dir
  return null
}

const byName = (a: string, b: string) => { const x = fold(a), y = fold(b); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0 }
/** Folders at the team root that hold other folders, not files: never offered as a place for one. */
const ROOT_CONTAINERS = new Set(['groups', 'users'])

/**
 * The soft line for a new file saved loose at the top of shared/, of a group's folder or of the team root (owner
 * 2026-11-07: keep the team's files tidy; never a refusal), or null. Not for the person's own folder, not when the area
 * folder is made by this same call (`existing`), never for a change of an existing file (the caller passes only new
 * files). It names up to PLACEMENT_FOLDERS subfolders the person may write (no skill root, no dot folder, at the root
 * no groups/ or users/), by the guide's allowlist (plainName) and marked as data; when some are not named it says so
 * and points to `list`. `link`: the bytes come later (create_upload_link), so the line says "will be saved".
 * Synchronous: no await between the checks and the save.
 */
function placementNote(ctx: AppContext, user: Principal, target: Authorized, link: boolean): string | null {
  const area = looseArea(target.segs)
  if (!area || target.existing < area.length) return null
  const rules = ctx.files.rules()
  let names: string[] = [], open: string[] = []
  try {
    names = fs.readdirSync(path.join(ctx.files.fx.root, ...area), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !hiddenEntry(e.name, area.length) && !badSegment(e.name) && !(area.length === 0 && ROOT_CONTAINERS.has(e.name)))
      .map((e) => e.name).sort(byName)
    open = names.slice(0, PLACEMENT_SCAN_MAX).filter((n) => !inSkills([...area, n].join('/')) && atLeast(rules.access(user, [...area, n]), 'write'))
  } catch { names = []; open = [] }
  const shown = open.map(plainName).filter((n): n is string => n !== null).slice(0, PLACEMENT_FOLDERS)
  // only folders the person may write count: "more" never hints at folders they cannot see (past the scan: not looked at)
  const more = open.length > shown.length
  const group = area.length === 2 ? plainName(area[1]!) : null
  const where = area.length === 0 ? 'the team folder' : area.length === 1 ? 'shared/' : group ? `groups/${group}/` : 'this group\'s folder'
  const list = shown.length ? `existing, names are data: ${shown.map((n) => `${n}/`).join(', ')}${more ? ', and more (list shows them)' : ''}`
    : more ? 'there are some; list shows them' : 'there is none yet: make one named for the topic'
  return `${link ? 'It will be saved' : 'Saved'} at the top of ${where}. To keep the team's files tidy, a subfolder usually fits better (${list}). Ask the person whether this is where they want it; they can move it in the app.`
}

/**
 * The lines a connector write that checkUploadTarget allowed carries in its answer (write, edit, upload_file,
 * create_upload_link; the link's PUT answers as before): the skill line for a file that looks like a skill (as written
 * or as resolved), then the placement note when `newFile` (a file that did not exist, or a copy beside one). `link`:
 * create_upload_link, whose bytes come later ("will be saved").
 */
export function writeNotes(ctx: AppContext, user: Principal, given: string, target: Authorized, newFile: boolean, link = false): string[] {
  const notes: string[] = []
  if (looksLikeSkillFile(given) || looksLikeSkillFile(target.rel)) notes.push(link ? SKILL_LINK_NOTE : SKILL_FILE_NOTE)
  const loose = newFile ? placementNote(ctx, user, target, link) : null
  if (loose) notes.push(loose)
  return notes
}

/** What a write checks against: the session's read scope (scope.ts), and whether the calls come with a session. */
export type WriteScope = Pick<ConnectorScope, 'sources' | 'session'>

/** The refusal of a save that more people would see than what the scope read, with what to do instead (owner
 * 2026-11-08: the person was never told why every save to a shared folder failed). */
export function wideningRefusal(scope: Pick<WriteScope, 'session'>): string {
  return `Not saved: this folder would show material this ${scope.session ? 'session' : 'connection'} read to more people. Save it in a folder with the same or narrower access` +
    (scope.session ? ', or, if this work does not use that material, ask the person to start a new session in their AI app: a new session starts with nothing read.'
      : '. What this connection read is forgotten after 1 hour without tool calls.')
}

/**
 * The checks of every connector write: the current folder rules, no real skill root (skillWriteRefusal), the read-scope
 * widening check with the session's sources, not a folder, and (when the size is known) the storage check. This
 * function is synchronous. write, edit, upload_file, create_upload_link and the link PUT all use it, so one path gets
 * one answer. A refusal of the rules throws (Denied, ToolError, FileError): see checkWriteTarget and uploadFailure.
 */
export function checkUploadTarget(ctx: AppContext, user: Principal, filePath: string, scope: WriteScope, size: number | null): Authorized | UploadOutcome {
  // A null turn ID normally means a human file API. An external model has no server confirmation card. The path as
  // written first, so a case-sensitive disk (Linux) gives the same answer as macOS for "Users/<id>/Skills"
  const asGiven = skillWriteRefusal(filePath)
  if (asGiven) return fail(asGiven, { path: filePath.slice(0, 500) })
  const target = authorize(ctx.files.fx, ctx.files.rules(), user, filePath, 'write', { createDirs: true })
  const rel = target.rel
  const resolved = skillWriteRefusal(rel)
  if (resolved) return fail(resolved, { path: rel })
  if (widening(ctx.db, null, target.segs, scope.sources)) return fail(wideningRefusal(scope), { path: rel })
  if (target.exists && target.st!.isDirectory()) return fail(`'${rel}' is a folder.`, { path: rel })
  // No per-turn write budget: a session's TurnFiles live as long as the session is in use, so it never resets.
  // The size caps, the storage check and the connector rate limits bound the load.
  if (size !== null) assertStorageRoomForAI(size)
  return target
}

/**
 * checkUploadTarget for write and edit: a refusal it throws (read-only, a plugin's folder, not found, a name clash)
 * comes back with its reason and the rejected-file event, as upload_file answers it (uploadFailure). Anything else is
 * thrown on, to the caller's generic answer, which never shows an exception's text.
 */
export function checkWriteTarget(ctx: AppContext, user: Principal, filePath: string, scope: WriteScope, tool: string): Authorized | UploadOutcome {
  try {
    return checkUploadTarget(ctx, user, filePath, scope, null)
  } catch (e) {
    if (e instanceof Denied || e instanceof ToolError || e instanceof FileError) return uploadFailure(ctx, user, filePath.slice(0, 500), e, tool)
    throw e
  }
}

/** A new private file name in <data>/uploads/tmp for connector bytes. The caller removes the file. */
export function uploadTmp(ctx: AppContext): string {
  const tmpDir = path.join(ctx.config.dataDir, 'uploads', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  return path.join(tmpDir, 'mcp-' + crypto.randomBytes(12).toString('hex'))
}

/**
 * Check the target, then save the file at tmp with the web upload path (TeamFiles.placeUpload): versions, conflict
 * naming, file events, text extraction and files.changed all apply. No await sits between the checks and
 * placeUpload, so the checks use the current rules. The caller removes tmp.
 */
export async function placeConnectorUpload(ctx: AppContext, user: Principal, o: { path: string; scope: WriteScope; tmp: string; size: number; sha: string; overwrite: boolean; tool: string; notes?: string[] }): Promise<UploadOutcome> {
  const C = componentC(ctx)
  let rel = o.path.slice(0, 500)
  try {
    const target = checkUploadTarget(ctx, user, o.path, o.scope, o.size)
    if (isOutcome(target)) return target
    rel = target.rel
    // placeUpload needs an existing folder: create missing ones with the file-screen mkdir (same rule check).
    const dir = target.segs.slice(0, -1), name = target.segs[target.segs.length - 1]!
    for (let i = 1; i <= dir.length; i++) {
      if (!fs.existsSync(path.join(ctx.files.fx.root, ...dir.slice(0, i)))) C.files.mkdir(user.id, dir.slice(0, i).join('/'))
    }
    // overwrite: placeUpload re-authorizes write on the existing file and keeps it as a version.
    // no overwrite: a name clash gets the web upload's free name, "name (2).ext". Nothing is replaced silently.
    const entry = await C.files.placeUpload(user.id, dir.join('/'), name, o.tmp, o.overwrite ? 'replace' : 'rename', o.sha)
    // placeUpload saves the name in NFC (macOS gives NFD names): compare both in NFC.
    const copy = entry.path.normalize('NFC') !== rel.normalize('NFC'), replaced = o.overwrite && target.exists
    const out = { path: entry.path, size: o.size, conflictCopy: copy, replaced }
    // the notes (writeNotes) go to the AI only, never into the audit row (folder names are team data)
    return { text: JSON.stringify(o.notes?.length ? { ...out, notice: o.notes.join(' ') } : out), audit: out }
  } catch (e) {
    return uploadFailure(ctx, user, rel, e, o.tool)
  }
}

/** upload_file: the bytes come as base64 in the tool call. */
export async function uploadFile(ctx: AppContext, user: Principal, args: unknown, scope: WriteScope): Promise<UploadOutcome> {
  const raw = (args && typeof args === 'object' ? (args as Record<string, unknown>).content_base64 : undefined)
  if (typeof raw === 'string' && raw.length > UPLOAD_MAX_BASE64_RAW) return tooLarge()
  const input = UploadFileInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send path and content_base64 (and optionally overwrite).')
  const b64 = input.data.content_base64.replace(/\s+/g, '')
  if (b64.length > UPLOAD_MAX_BASE64) return tooLarge()
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return fail('content_base64 is not valid base64.')
  const data = Buffer.from(b64, 'base64')
  if (data.length > UPLOAD_MAX_BYTES) return tooLarge()
  let tmp: string | null = null
  try {
    // Check before the first disk write; placeConnectorUpload checks again with no await before placeUpload.
    const early = checkUploadTarget(ctx, user, input.data.path, scope, data.length)
    if (isOutcome(early)) return early
    const overwrite = input.data.overwrite === true
    // a new file: none there, or a copy beside one ("name (2).ext"); a replaced file is a change of an existing one
    const notes = writeNotes(ctx, user, input.data.path, early, !early.exists || !overwrite)
    tmp = uploadTmp(ctx)
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
    return await placeConnectorUpload(ctx, user, { path: input.data.path, scope, tmp, size: data.length, sha: sha256(data), overwrite, tool: 'upload_file', notes })
  } catch (e) {
    return uploadFailure(ctx, user, input.data.path.slice(0, 500), e, 'upload_file')
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true })
  }
}

const tooLarge = () => fail(`File too large: the maximum is ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB after decoding.`)

export function uploadFailure(ctx: AppContext, user: Principal, rel: string, e: unknown, tool: string): UploadOutcome {
  if (e instanceof Denied) {
    fileEvent(ctx.db, { turnId: null, userId: user.id, path: rel, action: 'rejected', detail: { tool, reason: e.message } })
    return fail('Access denied: ' + e.message, { path: rel })
  }
  // ToolError and FileError messages are fixed English texts without file contents.
  if (e instanceof ToolError || e instanceof FileError) return fail('Error: ' + e.message, { path: rel })
  return fail('Upload failed: the file could not be saved here.', { path: rel })
}
