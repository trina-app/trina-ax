// skills/ holds the team skills and team rules every teammate's AI follows (docs/DECISIONS.md "팀 스킬 관리"), and
// groups/<folder>/skills/ the skills every member of that group's AI follows (docs/DECISIONS.md "Group skills"). The AI
// never saves there on its own: before write / edit / make_file (or any other AI tool) places a file in a skill root,
// the chat turn shows the person a server card ("팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요", for a group "그룹
// '영업팀'의 스킬로 저장할까요?", TurnExec.confirmSkillWrite) and keeps an approval for exactly those bytes. The file layer
// refuses every AI-side write there without a matching approval (requireSkillApproval), so a tool that forgets to ask,
// a scheduled run (nobody to ask) or a changed file between the card and the save all end in "nothing written" (fail
// closed). Writes people make on the file screen go through the folder rules only.
import { Denied } from '../policy/errors'
import { sha256 } from '../files/store'
import type { ToolCtx } from '../files/service'

export const SKILLS_DIR = 'skills'
const GROUPS_DIR = 'groups'
/** An approval for a produced file (make_file, generated media): the bytes are made after the card. */
export const ANY_CONTENT = '*'

const fold = (s: string) => s.normalize('NFC').toLowerCase()

/** The skill root `rel` is in, by the resolved path: the team's (skills/ and below) or a group's (groups/<folder>/
 * skills/ and below, `folder` the group's folder groups/<name>), or null for every other path. Each name is compared
 * without letter case or Unicode form (a case-insensitive team folder serves 'Skills/x.md' from skills/), so the check
 * never misses the real folder. Any groups/<name>/skills counts, whether or not a group has that folder now (fail
 * closed: a folder left behind by a deleted group is guarded too). */
export function skillRootOf(rel: string): { kind: 'team' } | { kind: 'group'; folder: string } | null {
  const segs = rel.split('/')
  if (fold(segs[0] ?? '') === SKILLS_DIR) return { kind: 'team' }
  if (segs.length >= 3 && fold(segs[0]!) === GROUPS_DIR && segs[1] && fold(segs[2]!) === SKILLS_DIR) return { kind: 'group', folder: `${segs[0]}/${segs[1]}` }
  return null
}

/** In a skill root that more than one person's AI follows: skills/ (the team's) or groups/<folder>/skills/ (a
 * group's), the folder itself or anything below it (skillRootOf). */
export function inSkills(rel: string): boolean {
  return skillRootOf(rel) !== null
}

/**
 * Called right before an AI-side tool puts bytes at `rel`: under skills/ there must be an approval (from the card)
 * for exactly `data` (or ANY_CONTENT for a produced file) at `approvalPath` (the path the card showed: a conflict copy
 * next to it counts as the same save). Writes outside a chat turn (people on the file screen, turnId null) pass.
 */
export function requireSkillApproval(ctx: ToolCtx, rel: string, data: Uint8Array | null, approvalPath = rel): void {
  if (ctx.turnId === null || !inSkills(rel)) return
  const ok = ctx.files.skillApprovals.get(approvalPath)
  if (ok !== undefined && (ok === ANY_CONTENT || (data !== null && ok === sha256(data)))) return
  const where = skillRootOf(rel)?.kind === 'group' ? 'in a group\'s skills folder (skills every member of that group\'s AI follows)' : 'under skills/ (team skills and team rules every teammate\'s AI follows)'
  throw new Denied(`saving ${where} needs the user's confirmation on the server's card, and it was not given for this content, so nothing was saved to '${rel}'`)
}

/** After the save: the approval is used up (the next change asks again). */
export function consumeSkillApproval(ctx: ToolCtx, approvalPath: string): void {
  if (ctx.turnId !== null) ctx.files.skillApprovals.delete(approvalPath)
}

/** The edit tool's replacement, shared by the tool and the card (both must produce the same bytes). */
export function editedText(text: string, oldString: string, newString: string, replaceAll?: boolean): string {
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}
