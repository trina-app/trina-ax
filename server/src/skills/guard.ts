// skills/ holds the team skills and team rules every teammate's AI follows (docs/DECISIONS.md "팀 스킬 관리"),
// groups/<folder>/skills/ the skills every member of that group's AI follows (docs/DECISIONS.md "Group skills"), and
// projects/<name>/skills/ the skills a team project's chats follow (docs/DECISIONS.md "Project skills"). The AI never
// saves there on its own: before write / edit / make_file (or any other AI tool) places a file in a skill root, the chat
// turn shows the person a server card ("팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요", for a group "부서 '영업팀'의
// 스킬로 저장할까요?", for a project "프로젝트 '견적'의 스킬로 저장할까요?", TurnExec.confirmSkillWrite) and keeps an
// approval for exactly those bytes. The file layer refuses every AI-side write there without a matching approval
// (requireSkillApproval), so a tool that forgets to ask, a scheduled run (nobody to ask) or a changed file between the
// card and the save all end in "nothing written" (fail closed). An approval is good for one save: the check itself uses
// it up, and the chat turn drops it after every call that did not reach the check (chat/tools.ts), so a failed call
// never leaves one behind for a later save without a card. Moves, copies and renames that touch a skill root go
// through skill_files (skills/folder-actions.ts) and its own card: a grant for that one operation (allowSkillAction),
// never an approval. Writes people make on the file screen go through the folder rules only. Every root is decided by
// the path alone, never by the database: any projects/<name>/skills counts, whether or not a project has that folder now.
import crypto from 'node:crypto'
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

/** The file tools' refusal for a skill folder (move, copy, rename; bug 3 of the refusal audit: an admin renaming a
 * project folder that holds skills got a text about moving skills). It says which tool does what: skill_files for the
 * three file actions the person can allow on one card (a group or project folder renamed, files and skills taken out,
 * media and SKILL.md folders put in), move_skill for a whole skill to another level, write / edit for text, and the
 * Files screen for the rest. The AI once answered by leaving a README in a project folder as a stand-in. */
export const SKILL_FILES_REFUSAL = 'Nothing was changed: skill folders (skills/, a group\'s or a project\'s skills: what people\'s AI follows) do not move or copy with the file tools (move_files, copy_files, rename_file). In the user\'s own chat, skill_files does three things behind one card the user answers: rename a group or project folder that holds skills (or a skill\'s own folder), take files, skills or rules out of a skill folder, or put an image, audio, video, font or a SKILL.md folder into one. For a whole skill to another level (the team, a group, a project, the user\'s own), use move_skill: to move it, or with keep: true to copy it when the user asks for a copy. A text file or rule in a skill folder is written with write / edit (the user confirms on a card). Anything else, the user can do on the Files screen. Never leave a README or an empty skills folder as a stand-in.'

/** How the AI is told where a skill root is (refusals). */
export function skillRootWords(root: SkillRoot | null): string {
  if (root?.kind === 'group') return 'in a group\'s skills folder (skills every member of that group\'s AI follows)'
  if (root?.kind === 'project') return 'in a project\'s skills folder (skills the AI follows in that project\'s chats)'
  return 'under skills/ (team skills and team rules every teammate\'s AI follows)'
}

/**
 * Called right before an AI-side tool puts bytes at `rel`: in a skill root there must be an approval (from the card)
 * for exactly `data` (or ANY_CONTENT for a produced file) at `approvalPath` (the path the card showed: a conflict copy
 * next to it counts as the same save). The check uses the approval up, whether or not the save then succeeds: one card,
 * one save. Writes outside a chat turn (people on the file screen, turnId null) pass.
 */
export function requireSkillApproval(ctx: ToolCtx, rel: string, data: Uint8Array | null, approvalPath = rel): void {
  if (ctx.turnId === null || !inSkills(rel)) return
  const ok = ctx.files.skillApprovals.get(approvalPath)
  ctx.files.skillApprovals.delete(approvalPath)
  if (ok !== undefined && (ok === ANY_CONTENT || (data !== null && ok === sha256(data)))) return
  throw new Denied(`saving ${skillRootWords(skillRootOf(rel))} needs the user's confirmation on the server's card, and it was not given for this content, so nothing was saved to '${rel}'`)
}

/** After the save: the approval is used up (the next change asks again). requireSkillApproval already took it; kept so
 * a caller that saves without that check still clears it. */
export function consumeSkillApproval(ctx: ToolCtx, approvalPath: string): void {
  if (ctx.turnId !== null) ctx.files.skillApprovals.delete(approvalPath)
}

// ---------------- skill_files: one grant per call (skills/folder-actions.ts) ----------------

/** What a skill_files card allowed: exactly this operation, by this person in this turn, once. The file service takes
 * it right before the rename or the copy (TeamFiles.move / copy / placeSkillTree) and calls `recheck`, which plans the
 * action again and compares it with the card's token (files and hashes, target, readers, editors): anything that
 * differs refuses it. */
export interface SkillActionGrant {
  userId: string
  turnId: string
  /** move: TeamFiles.move; copy: copy (a file out); place: placeSkillTree (a copy in) */
  action: 'move' | 'copy' | 'place'
  /** the resolved paths, as the service resolves them (`from` null: a placement made from the card's bytes) */
  from: string | null
  to: string
  recheck: () => void
  /** "I" (into a skill root) and a skill's folder renamed: the bytes the card showed, placed as new files where the
   * move goes, in the same step (segments below the moved folder; [] for a single file; `exec`: it may run) */
  fresh?: { segs: string[]; bytes: Uint8Array; exec?: boolean }[]
}
const grants = new WeakMap<object, Map<string, SkillActionGrant>>()

/** Keep a grant for one call; `owner`: the server's file service (one map per server instance). Returns its id. */
export function allowSkillAction(owner: object, g: SkillActionGrant): string {
  let m = grants.get(owner)
  if (!m) { m = new Map(); grants.set(owner, m) }
  const id = crypto.randomUUID()
  m.set(id, g)
  return id
}

/** Drop a grant (the call ended, used or not). */
export function dropSkillAction(owner: object, id: string): void {
  grants.get(owner)?.delete(id)
}

/** The grant `id` for exactly this operation, used up now; Denied without one, or for any other person, turn,
 * action or path. Its recheck is the caller's to run right before the change. */
export function takeSkillAction(owner: object, id: string | undefined, want: { userId: string; turnId: string; action: SkillActionGrant['action']; from: string | null; to: string }): SkillActionGrant {
  const m = grants.get(owner)
  const g = id ? m?.get(id) : undefined
  if (id) m?.delete(id)
  if (!g || g.userId !== want.userId || g.turnId !== want.turnId || g.action !== want.action || g.from !== want.from || g.to !== want.to) throw new Denied(SKILL_FILES_REFUSAL)
  return g
}

/** The edit tool's replacement, shared by the tool and the card (both must produce the same bytes). */
export function editedText(text: string, oldString: string, newString: string, replaceAll?: boolean): string {
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}
