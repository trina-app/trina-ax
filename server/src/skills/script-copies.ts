// Group and project skill scripts never run (QA TC-4911, TC-4932; docs/decisions/20261119-skill-script-copies.md).
// A group skill is written by any member of the group and a project skill by anyone who may write the project folder,
// and a script runs with the reading person's access and allowed sites: a script one member planted could take another
// member's files out. The prompt says so (chat/prompt.ts skillScriptsRun); the server holds it in two places:
//   - box_shell: every run hides the group and project skills folders (devenv/srt/access.ts RunWrites.othersSkills,
//     the folders from othersSkillRoots below), so a command cannot read, copy or run a file there; a command that
//     names such a folder is refused before it runs (devenv/tool.ts).
//   - the file tools: an AI-side save outside those folders whose content is a copy of a file in one of them (the AI
//     read it, then wrote or edited it elsewhere to run it from there) is refused (refuseSkillScriptCopy, called by
//     files/service.ts next to requireSkillApproval). Copy and move of a skill folder's files are refused already
//     (skills/guard.ts SKILL_FILES_REFUSAL).
// Text is compared after line endings and trailing spaces are evened out, so a copy with other line endings or a
// final newline is the same copy. A rewritten script is not caught here; the AI's rule says never to copy one.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Denied } from '../policy/errors'
import { skillRootOf } from '@mycel/shared/skill-roots'

/** files looked at per skills folder walk, and the largest one compared (a script, not a data file) */
const MAX_FILES = 2000
const MAX_BYTES = 1 << 20
/** shorter normalised text is never taken as a copy (an empty __init__.py, "print(1)") */
const MIN_TEXT = 24

/** The group and project skills folders on disk, team-relative (groups/<folder>/skills and projects/<name>/skills, in
 * any letter case: skillRootOf). Only groups/ and projects/ are walked, two levels down. */
export function othersSkillRoots(root: string): string[] {
  const out: string[] = []
  const dirs = (abs: string) => { try { return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }
  const holder = (t: string) => { const k = skillRootOf(`${t}/x/skills`)?.kind; return k === 'group' || k === 'project' }
  for (const top of dirs(root).filter(holder)) {
    for (const name of dirs(path.join(root, top))) {
      for (const sub of dirs(path.join(root, top, name))) {
        const rel = `${top}/${name}/${sub}`
        const r = skillRootOf(rel)
        if (r && r.kind !== 'team' && rel.split('/').length === 3) out.push(rel)
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

/** per absolute path: what was read last time (size and mtime decide whether it is read again) */
const cache = new Map<string, { size: number; mtimeMs: number; key: string | null }>()

/** The copy keys of every file in the group and project skills folders but their SKILL.md and other Markdown (the
 * instructions themselves, which the AI may quote), each with where it is. */
export function othersScriptKeys(root: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const top of othersSkillRoots(root)) {
    let n = 0
    const walk = (rel: string, d: number) => {
      if (d > 6 || n >= MAX_FILES) return
      let ents: fs.Dirent[] = []
      try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (n >= MAX_FILES) return
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) { walk(r, d + 1); continue }
        if (!e.isFile() || /\.md$/i.test(e.name)) continue
        n++
        const abs = path.join(root, r)
        let st: fs.Stats
        try { st = fs.statSync(abs) } catch { continue }
        if (st.size > MAX_BYTES) continue
        const c = cache.get(abs)
        let key = c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.key : undefined
        if (key === undefined) {
          try { key = copyKey(fs.readFileSync(abs)) } catch { continue }
          cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, key })
        }
        if (key) out.set(key, r)
      }
    }
    walk(top, 0)
  }
  return out
}

/** The refusal of a copy (exported for tests). */
export const scriptCopyRefusal = (rel: string, from: string) =>
  `nothing was saved to '${rel}': it is a copy of ${from}, a file of a group's or project's skill. Other members wrote it, and the scripts of group and project skills never run or get copied (they would run with this user's access). Follow the skill's other steps, and tell the user that a skill manager can make it a team skill if they need its script.`

/**
 * Called right before an AI-side tool (a chat turn: turnId set) puts `data` at `rel` outside a group's or project's
 * skills folder: refused when it is a copy of a file in one of them (othersScriptKeys). Writes in a skill folder have
 * their own card (skills/guard.ts); people's saves on the file screen pass.
 */
export function refuseSkillScriptCopy(ctx: { turnId: string | null }, root: string, rel: string, data: Uint8Array): void {
  if (ctx.turnId === null || inOthersSkills(rel)) return
  const key = copyKey(data)
  if (!key) return
  const from = othersScriptKeys(root).get(key)
  if (from) throw new Denied(scriptCopyRefusal(rel, from))
}
