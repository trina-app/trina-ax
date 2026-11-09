// Skills that switch on (docs/DECISIONS.md "Project skills"): a project's folder that comes to be projects/<name> (a
// person moving it there on the Files screen, an admin pointing a project at such a folder, a personal project shared
// into projects/) makes the SKILL.md folders in its skills/ live in that project's chats. Each of those asks first with
// their names (409 `project_skills_on`, then `skillsOk`), and each skill is recorded as a skill change.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { fail } from '../http/errors'
import { st } from './text'

/** The SKILL.md folders in `<folder>/skills` on disk (at most three levels down, no dot folders), by name, with their
 * paths below `folder`. */
export function skillsUnder(teamRoot: string, folder: string): { names: string[]; paths: string[] } {
  const names: string[] = [], paths: string[] = []
  const walk = (abs: string, rel: string, depth: number) => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    if (depth > 1 && ents.some((e) => e.name === 'SKILL.md' && e.isFile())) { names.push(rel.split('/').pop()!); paths.push(`${rel}/SKILL.md`); return }
    if (depth >= 3) return
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(abs, e.name), `${rel}/${e.name}`, depth + 1)
  }
  walk(path.join(teamRoot, ...folder.split('/').filter(Boolean), 'skills'), 'skills', 1)
  const order = names.map((n, i) => [n, paths[i]!] as const).sort((a, b) => a[0].localeCompare(b[0]))
  return { names: order.map((x) => x[0]), paths: order.map((x) => x[1]) }
}

/** The skill entries of the skills folder at `abs` (on disk; never through a link), relative to it: every SKILL.md
 * folder (at most three levels down, no dot folders), and with `files` every .md directly in it (a group's single-file
 * skills). Sorted. */
export function skillEntriesIn(abs: string, files: boolean): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (depth > 0 && ents.some((e) => e.name === 'SKILL.md' && e.isFile())) { out.push(`${rel}/SKILL.md`); return }
    if (depth === 0 && files) for (const e of ents) if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')) out.push(e.name)
    if (depth >= 3) return
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1)
  }
  walk(abs, '', 0)
  return out.sort()
}

/** Refuse (409 project_skills_on) unless the person said yes to these skills switching on. */
export function askSkillsOn(names: readonly string[], ok: boolean | undefined, locale: Locale): void {
  if (!names.length || ok) return
  fail('conflict', st('skillsSwitchOn', locale, { n: String(names.length), names: names.slice(0, 20).join(', ') }), { params: { reason: 'project_skills_on', skills: names.slice(0, 20).join('\n'), count: names.length } })
}

/** Each skill that switched on, as a skill change of the project (the "최근 변경" list and the audit log). */
export function recordSkillsOn(db: Database, actor: string, folder: string, paths: readonly string[], project: { id: string | null; name: string }, how: string): void {
  for (const p of paths) audit(db, { actor, action: 'skills.change', target: `${folder}/${p}`, detail: { change: 'create', from: null, byAi: false, turnId: null, kind: 'skill', tool: null, project, switchedOn: how } })
}
