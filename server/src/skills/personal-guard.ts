// What an AI turn may write in a person's own skills folder (docs/decisions/20261125-auto-personal-skills.md): only
// users/<id>/skills/<name>/SKILL.md, UTF-8 text whose header loads, no "#!" first line and no secret. Code blocks are
// text and allowed. Every other file is refused: a personal skill's scripts run in box_shell (chat/prompt.ts
// skillScriptsRun), so a script the AI wrote must never land there. Called by the file layer (skills/guard.ts
// requireSkillApproval) before every AI-side save, and by the turn's gate before any card (chat/personal-skills.ts).
import { isUtf8 } from '@mycel/shared/text-encoding'
import { checkSkill } from '../chat/skills'
import { secretIn } from '../chat/auto-memory'

const fold = (s: string) => s.normalize('NFC').toLowerCase()

/** users/<id>/skills/<name>/SKILL.md (letter case folded as the skill roots are): the skill's name, else null. */
export function personalSkillName(rel: string): string | null {
  const s = rel.split('/')
  return s.length === 5 && fold(s[0]!) === 'users' && fold(s[2]!) === 'skills' && !!s[3] && s[4] === 'SKILL.md' ? s[3] : null
}

export const PERSONAL_SKILL_FILES_REFUSAL = 'Nothing was saved: a personal skill (users/<id>/skills/<name>/) holds only its SKILL.md, as text. Scripts and other files never go into a personal skill from a chat; the user can add them on the Files screen. Put the steps, a form or a table in SKILL.md itself.'

/** Why `data` cannot be saved at `rel` by an AI turn, or null. `data` null: a produced file (make_file): refused. */
export function personalSkillProblem(rel: string, data: Uint8Array | null): string | null {
  if (!personalSkillName(rel)) return PERSONAL_SKILL_FILES_REFUSAL
  if (data === null || !isUtf8(data)) return 'Nothing was saved: a personal skill\'s SKILL.md is plain text. Write it with write or edit.'
  const text = Buffer.from(data).toString('utf8')
  const check = checkSkill(text, rel)
  if (!check.ok) return `Nothing was saved: this SKILL.md would not load (${check.problem}). Start with a header: "---", "name: <the folder name>", "description: <one sentence>", "---", then the steps.`
  if (/^\s*#!/.test(check.body)) return 'Nothing was saved: a personal skill is steps in words, not a script: no "#!" line at its start.'
  if (secretIn(text)) return 'Nothing was saved: it holds a password, key, token, card number or code. Skills are plain text, so secrets never go in one; keys belong in Settings › Connections.'
  return null
}
