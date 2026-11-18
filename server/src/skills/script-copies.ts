// Group and project skill scripts never run (QA TC-4911, TC-4932; docs/decisions/20261119-skill-script-copies.md).
// A group skill is written by any member of the group and a project skill by anyone who may write the project folder,
// and a script runs with the reading person's access and allowed sites: a script one member planted could take another
// member's files out. The prompt says so (chat/prompt.ts skillScriptsRun); the server holds it in two places:
//   - box_shell: every run hides the group and project skills folders (devenv/srt/access.ts RunWrites.othersSkills,
//     the folders from othersSkillRoots below), so a command cannot read, copy or run a file there; a command that
//     names such a folder is refused before it runs (devenv/tool.ts).
//   - the file tools: an AI-side save outside those folders whose content is an exact copy of such a file that this turn
//     or an earlier answer of this chat read (the turn's read records: TurnFiles.allReads and carried; the AI read it, then wrote or edited it elsewhere to run it from there) is
//     refused (refuseSkillScriptCopy, called by files/service.ts next to requireSkillApproval). Only what was read is
//     compared: nothing is walked, so a save costs at most a few small reads. Copy and move of a skill folder's files
//     are refused already (skills/guard.ts SKILL_FILES_REFUSAL).
// Text is compared after line endings and trailing spaces are evened out, so a copy with other line endings or a
// final newline is the same copy. A rewritten script, or a copy made in a run, is not caught here.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Denied } from '../policy/errors'
import { skillRootOf } from '@mycel/shared/skill-roots'

/** read files compared per save (the newest reads first), and the largest one compared (a script, not a data file) */
const MAX_COMPARED = 200
const MAX_BYTES = 1 << 20
/** shorter normalised text is never taken as a copy (an empty __init__.py, "print(1)") */
const MIN_TEXT = 24

/** The group and project skills folders on disk, team-relative (groups/<folder>/skills and projects/<name>/skills, in
 * any letter case: skillRootOf). Only groups/ and projects/ are read, two levels down. `skip`: a folder to leave out by
 * its absolute path (a run's empty placeholder, devenv/srt/placeholders.ts isSkillPlaceholder). */
export function othersSkillRoots(root: string, skip?: (abs: string) => boolean): string[] {
  const out: string[] = []
  const dirs = (abs: string) => { try { return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }
  const holder = (t: string) => { const k = skillRootOf(`${t}/x/skills`)?.kind; return k === 'group' || k === 'project' }
  for (const top of dirs(root).filter(holder)) {
    for (const name of dirs(path.join(root, top))) {
      for (const sub of dirs(path.join(root, top, name))) {
        const rel = `${top}/${name}/${sub}`
        const r = skillRootOf(rel)
        if (r && r.kind !== 'team' && rel.split('/').length === 3 && !skip?.(path.join(root, top, name, sub))) out.push(rel)
      }
    }
  }
  return out
}

/** in a group's or project's skills folder (or the folder itself) */
export const inOthersSkills = (rel: string) => { const r = skillRootOf(rel); return !!r && r.kind !== 'team' }

/** The hash a copy is compared by: text with line endings and trailing spaces evened out, else the bytes. Null for
 * text too short to tell a copy from a coincidence. */
export function copyKey(data: Uint8Array): string | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!b.subarray(0, 8000).includes(0)) {
    const t = b.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim()
    if (t.length < MIN_TEXT) return null
    return 't:' + crypto.createHash('sha256').update(t).digest('hex')
  }
  return b.length < MIN_TEXT ? null : 'b:' + crypto.createHash('sha256').update(b).digest('hex')
}

/** What a turn read, as files/service.ts TurnFiles keeps it: every file any agent of this answer read (allReads: path
 * -> sha256; readPaths is drained after each call) and the files of the chat's earlier answers (carried). */
export interface ReadRecords { allReads: ReadonlyMap<string, string>; carried?: { hashes: ReadonlyMap<string, string> } | null }

/** The files of a group's or project's skill (not Markdown: the instructions, which may be quoted) that this turn or
 * an earlier answer of this chat read, newest first, at most MAX_COMPARED. */
export function readSkillFiles(files: ReadRecords): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (rel: string) => { if (!seen.has(rel) && inOthersSkills(rel) && !/\.md$/i.test(rel) && out.length < MAX_COMPARED) { seen.add(rel); out.push(rel) } }
  for (const r of [...files.allReads.keys()].reverse()) add(r)
  for (const r of files.carried?.hashes.keys() ?? []) add(r)
  return out
}

/** The refusal of a copy. `from`: the file it copies when the person may read it now, else null (no path named). */
export const scriptCopyRefusal = (rel: string, from: string | null) =>
  `nothing was saved to '${rel}': it is a copy of ${from ?? 'a file'}, a file of a group's or project's skill that this chat read. Other members wrote it, and the scripts and other code of group and project skills never run or get copied (they would run with this user's access). Follow the skill's other steps, and tell the user that a skill manager can make it a team skill if they need its code.`

/**
 * Called right before an AI-side tool (a chat turn: turnId set) puts `data` at `rel` outside a group's or project's
 * skills folder: refused when it is an exact copy (copyKey) of a group or project skill file that this turn or this
 * chat read (readSkillFiles). Each such file is read again now (it may have changed since). `mayRead`: whether the
 * person may read a path now (the refusal names only such a path). Writes in a skill folder have their own card
 * (skills/guard.ts); people's saves on the file screen pass.
 */
export function refuseSkillScriptCopy(ctx: { turnId: string | null; files: ReadRecords }, root: string, rel: string, data: Uint8Array, mayRead: (rel: string) => boolean): void {
  if (ctx.turnId === null || inOthersSkills(rel)) return
  const candidates = readSkillFiles(ctx.files)
  if (!candidates.length) return
  const key = copyKey(data)
  if (!key) return
  for (const c of candidates) {
    const abs = path.join(root, ...c.split('/'))
    let bytes: Buffer
    try {
      const st = fs.lstatSync(abs)
      if (!st.isFile() || st.size > MAX_BYTES) continue
      bytes = fs.readFileSync(abs)
    } catch { continue }
    if (copyKey(bytes) === key) throw new Denied(scriptCopyRefusal(rel, mayRead(c) ? c : null))
  }
}
