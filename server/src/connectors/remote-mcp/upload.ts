import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import { authorize, type Authorized } from '../../policy/authorize'
import { Denied, ToolError } from '../../policy/errors'
import { widening, type ReadSource } from '../../chat/read-scope'
import { componentC } from '../../team-files/component'
import { FileError } from '../../team-files/errors'
import { fileEvent, sha256 } from '../../files/store'
import { assertStorageRoomForAI } from '../../system/storage'
import { inSkills } from '../../skills/guard'

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
 * A path a connector may not write: the team skills and rules (skills/…) and a person's own skills (users/<id>/skills/…),
 * which the team app changes only after its confirmation (skills/guard.ts). Compared without letter case or Unicode
 * form, on the path as given and as resolved, so a case-insensitive team folder cannot be used to miss it.
 */
export function skillWriteTarget(rel: string): boolean {
  const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (!segs.length) return false
  if (inSkills(segs.join('/'))) return true
  return fold(segs[0]!) === 'users' && segs.length >= 3 && fold(segs[2]!) === 'skills'
}

/** What the AI is told when it tries to save a skill as a file: the real way is a proposal (share_skills) or the app. */
export const SKILL_POINTER = 'Use share_skills (whole team, or add "group" for one group; the owner or an admin proposes, someone confirms it in the app), or ask the user to add the skill in the team app (팀 스킬).'
const REAL_ROOT_REFUSAL = `Skill changes require confirmation inside the team app. ${SKILL_POINTER}`
const MISPLACED_REFUSAL = `Not saved: skills are never written as files, and a SKILL.md or a "skills" folder outside the real skill folders is not a skill. ${SKILL_POINTER}`

/**
 * The refusal for a connector write to \`rel\`, or null when it is an ordinary file. A real skill root (skills/, a group's
 * skills/, users/<id>/skills/) keeps its refusal; a file named SKILL.md or anything below a folder named "skills" that
 * is not a real root is a skill saved in the wrong place (the AI could not know the way), refused with the pointer.
 */
export function skillWriteRefusal(rel: string): string | null {
  if (skillWriteTarget(rel)) return REAL_ROOT_REFUSAL
  const segs = rel.replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.')
  if (segs.length && fold(segs[segs.length - 1]!) === 'skill.md') return MISPLACED_REFUSAL
  if (segs.some((x) => fold(x) === 'skills')) return MISPLACED_REFUSAL
  return null
}

/**
 * The checks of write for a connector upload target: the current folder rules, no skills/ target, the read-scope
 * widening check with the grant's sources, not a folder, and (when the size is known) the storage check. This
 * function is synchronous. upload_file, create_upload_link and the link PUT all use it.
 */
export function checkUploadTarget(ctx: AppContext, user: Principal, filePath: string, sources: ReadSource[], size: number | null): Authorized | UploadOutcome {
  // A null turn ID normally means a human file API. An external model has no server confirmation card. The path as
  // written first, so a case-sensitive disk (Linux) gives the same answer as macOS for "Users/<id>/Skills"
  const asGiven = skillWriteRefusal(filePath)
  if (asGiven) return fail(asGiven, { path: filePath.slice(0, 500) })
  const target = authorize(ctx.files.fx, ctx.files.rules(), user, filePath, 'write', { createDirs: true })
  const rel = target.rel
  const resolved = skillWriteRefusal(rel)
  if (resolved) return fail(resolved, { path: rel })
  if (widening(ctx.db, null, target.segs, sources)) return fail('Saving here would expose previously read material to more people. Use a folder with the same or narrower access.', { path: rel })
  if (target.exists && target.st!.isDirectory()) return fail(`'${rel}' is a folder.`, { path: rel })
  // No per-turn write budget: the grant's TurnFiles live as long as the connection is in use, so it never resets.
  // The size caps, the storage check and the connector rate limits bound the load.
  if (size !== null) assertStorageRoomForAI(size)
  return target
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
export async function placeConnectorUpload(ctx: AppContext, user: Principal, o: { path: string; sources: ReadSource[]; tmp: string; size: number; sha: string; overwrite: boolean; tool: string }): Promise<UploadOutcome> {
  const C = componentC(ctx)
  let rel = o.path.slice(0, 500)
  try {
    const target = checkUploadTarget(ctx, user, o.path, o.sources, o.size)
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
    return { text: JSON.stringify(out), audit: out }
  } catch (e) {
    return uploadFailure(ctx, user, rel, e, o.tool)
  }
}

/** upload_file: the bytes come as base64 in the tool call. */
export async function uploadFile(ctx: AppContext, user: Principal, args: unknown, sources: ReadSource[]): Promise<UploadOutcome> {
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
    const early = checkUploadTarget(ctx, user, input.data.path, sources, data.length)
    if (isOutcome(early)) return early
    tmp = uploadTmp(ctx)
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
    return await placeConnectorUpload(ctx, user, { path: input.data.path, sources, tmp, size: data.length, sha: sha256(data), overwrite: input.data.overwrite === true, tool: 'upload_file' })
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
