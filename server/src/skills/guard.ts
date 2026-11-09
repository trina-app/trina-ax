// skills/ holds the team skills and team rules every teammate's AI follows (docs/DECISIONS.md "팀 스킬 관리"),
// groups/<folder>/skills/ the skills every member of that group's AI follows (docs/DECISIONS.md "Group skills"), and
// projects/<name>/skills/ the skills a team project's chats follow (docs/DECISIONS.md "Project skills"). The AI never
// saves there on its own: before write / edit / make_file (or any other AI tool) places a file in a skill root, the chat
// turn shows the person a server card ("팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요", for a group "그룹 '영업팀'의
// 스킬로 저장할까요?", for a project "프로젝트 '견적'의 스킬로 저장할까요?", TurnExec.confirmSkillWrite) and keeps an
// approval for exactly those bytes. The file layer refuses every AI-side write there without a matching approval
// (requireSkillApproval), so a tool that forgets to ask, a scheduled run (nobody to ask) or a changed file between the
// card and the save all end in "nothing written" (fail closed). Writes people make on the file screen go through the
// folder rules only. Every root is decided by the path alone, never by the database: any projects/<name>/skills counts,
// whether or not a project has that folder now.
import { Denied } from '../policy/errors'
import { sha256 } from '../files/store'
import type { ToolCtx } from '../files/service'

export const SKILLS_DIR = 'skills'
const GROUPS_DIR = 'groups'
export const PROJECTS_DIR = 'projects'
/** An approval for a produced file (make_file, generated media): the bytes are made after the card. */
export const ANY_CONTENT = '*'

const fold = (s: string) => s.normalize('NFC').toLowerCase()

export type SkillRoot = { kind: 'team' } | { kind: 'group'; folder: string } | { kind: 'project'; folder: string }

/** The skill root `rel` is in, by the resolved path: the team's (skills/ and below), a group's (groups/<folder>/
 * skills/ and below, `folder` the group's folder groups/<name>), a project's (projects/<name>/skills/ and below,
 * `folder` the project's folder projects/<name>), or null for every other path. Each name is compared without letter
 * case or Unicode form (a case-insensitive team folder serves 'Skills/x.md' from skills/), so the check never misses
 * the real folder. Any groups/<name>/skills and projects/<name>/skills counts, whether or not a group or a project has
 * that folder now (fail closed: a folder left behind is guarded too). */
export function skillRootOf(rel: string): SkillRoot | null {
  const segs = rel.split('/')
  if (fold(segs[0] ?? '') === SKILLS_DIR) return { kind: 'team' }
  if (segs.length >= 3 && segs[1] && fold(segs[2]!) === SKILLS_DIR) {
    if (fold(segs[0]!) === GROUPS_DIR) return { kind: 'group', folder: `${segs[0]}/${segs[1]}` }
    if (fold(segs[0]!) === PROJECTS_DIR) return { kind: 'project', folder: `${segs[0]}/${segs[1]}` }
  }
  return null
}

/** In a skill root that more than one person's AI follows: skills/ (the team's), groups/<folder>/skills/ (a group's)
 * or projects/<name>/skills/ (a project's), the folder itself or anything below it (skillRootOf). */
export function inSkills(rel: string): boolean {
  return skillRootOf(rel) !== null
}

/** May a project on `folder` have skills of its own (docs/DECISIONS.md "Project skills")? Only a team project whose
 * folder is exactly projects/<name>: not a personal project (users/<me>/projects/…), not an older project on another
 * folder. The one place that rule lives. */
export function projectLevelPossible(folder: string): boolean {
  const segs = folder.split('/')
  return segs.length === 2 && fold(segs[0]!) === PROJECTS_DIR && !!segs[1] && !segs[1].startsWith('.')
}

/** The skills folder of a project on `folder` (projectLevelPossible). */
export const projectSkillsDir = (folder: string) => `${folder}/${SKILLS_DIR}`

/** The file tools' refusal for a skill folder (move, copy, rename): the AI once answered "use write / edit or the
 * Files screen" by leaving a README in a project folder as a stand-in for the skills it could not move. */
export const SKILL_FILES_REFUSAL = 'skill folders (skills/, a group\'s or a project\'s skills: what people\'s AI follows) do not move with files. Skills do not move with files: to put a skill at another level (the team, a group, a project, the user\'s own), ask with move_skill; to change one, write / edit it (the user confirms on a card). Never make a skills folder, a README or a copy somewhere else as a stand-in.'

/** How the AI is told where a skill root is (refusals). */
export function skillRootWords(root: SkillRoot | null): string {
  if (root?.kind === 'group') return 'in a group\'s skills folder (skills every member of that group\'s AI follows)'
  if (root?.kind === 'project') return 'in a project\'s skills folder (skills the AI follows in that project\'s chats)'
  return 'under skills/ (team skills and team rules every teammate\'s AI follows)'
}

/**
 * Called right before an AI-side tool puts bytes at `rel`: in a skill root there must be an approval (from the card)
 * for exactly `data` (or ANY_CONTENT for a produced file) at `approvalPath` (the path the card showed: a conflict copy
 * next to it counts as the same save). Writes outside a chat turn (people on the file screen, turnId null) pass.
 */
export function requireSkillApproval(ctx: ToolCtx, rel: string, data: Uint8Array | null, approvalPath = rel): void {
  if (ctx.turnId === null || !inSkills(rel)) return
  const ok = ctx.files.skillApprovals.get(approvalPath)
  if (ok !== undefined && (ok === ANY_CONTENT || (data !== null && ok === sha256(data)))) return
  throw new Denied(`saving ${skillRootWords(skillRootOf(rel))} needs the user's confirmation on the server's card, and it was not given for this content, so nothing was saved to '${rel}'`)
}

/** After the save: the approval is used up (the next change asks again). */
export function consumeSkillApproval(ctx: ToolCtx, approvalPath: string): void {
  if (ctx.turnId !== null) ctx.files.skillApprovals.delete(approvalPath)
}

/** The edit tool's replacement, shared by the tool and the card (both must produce the same bytes). */
export function editedText(text: string, oldString: string, newString: string, replaceAll?: boolean): string {
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}
