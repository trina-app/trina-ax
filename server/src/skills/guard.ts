// skills/ holds the team skills and team rules every teammate's AI follows (docs/DECISIONS.md "팀 스킬 관리"). The AI
// never saves there on its own: before write / edit / make_file (or any other AI tool) places a file under skills/,
// the chat turn shows the person a server card ("팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따릅니다", TurnExec
// .confirmSkillWrite) and keeps an approval for exactly those bytes. The file layer refuses every AI-side write under
// skills/ without a matching approval (requireSkillApproval), so a tool that forgets to ask, a scheduled run (nobody
// to ask) or a changed file between the card and the save all end in "nothing written" (fail closed). Writes people
// make on the file screen go through the folder rules only.
import { Denied } from '../policy/errors'
import { sha256 } from '../files/store'
import type { ToolCtx } from '../files/service'

export const SKILLS_DIR = 'skills'
/** An approval for a produced file (make_file, generated media): the bytes are made after the card. */
export const ANY_CONTENT = '*'

/**
 * skills/ or anything below it. The first name is compared without letter case or Unicode form (a case-insensitive
 * team folder serves 'Skills/x.md' from skills/), so the check never misses the real folder.
 */
export function inSkills(rel: string): boolean {
  const first = rel.split('/')[0] ?? ''
  return first.normalize('NFC').toLowerCase() === SKILLS_DIR
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
  throw new Denied(`saving under skills/ (team skills and team rules every teammate's AI follows) needs the user's confirmation on the server's card, and it was not given for this content, so nothing was saved to '${rel}'`)
}

/** After the save: the approval is used up (the next change asks again). */
export function consumeSkillApproval(ctx: ToolCtx, approvalPath: string): void {
  if (ctx.turnId !== null) ctx.files.skillApprovals.delete(approvalPath)
}

/** The edit tool's replacement, shared by the tool and the card (both must produce the same bytes). */
export function editedText(text: string, oldString: string, newString: string, replaceAll?: boolean): string {
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}
