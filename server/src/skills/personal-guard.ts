// What an AI turn may write in a person's own skills folder (docs/decisions/20261125-auto-personal-skills.md): only
// users/<id>/skills/<name>/SKILL.md, UTF-8 text whose header loads, no "#!" first line and no secret. Code blocks are
// text and allowed. Every other file is refused: a personal skill's scripts run in box_shell (chat/prompt.ts
// skillScriptsRun), so a script the AI wrote must never land there. Called by the file layer (skills/guard.ts
// requireSkillApproval) before every AI-side save, and by the turn's gate before any card (chat/personal-skills.ts).
import { isUtf8 } from '@mycel/shared/text-encoding'
import { checkSkill } from '../chat/skills'
import { secretIn } from '../chat/auto-memory'

// NFKC as policy/names.ts foldKey: "ſkills" is skills on a folding disk
const fold = (s: string) => s.normalize('NFKC').toLowerCase().normalize('NFKC')

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

// ---------------- origin: auto (in the header's metadata) ----------------

const HEADER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/
export const ORIGIN_LINE = /^[ \t]+origin:[ \t]*["']?auto["']?[ \t]*\r?$/m

/** The skill was made by the AI on its own: `metadata:` holds `origin: auto`. */
export function originAuto(text: string | null): boolean {
  const h = text ? HEADER.exec(text) : null
  if (!h) return false
  const meta = /^metadata:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(h[2]!)
  return !!meta && ORIGIN_LINE.test(meta[1]!)
}

/** `text` with `origin: auto` in its metadata (`auto`) or without it. Text without a header stays as it is. */
export function withOrigin(text: string, auto: boolean): string {
  const h = HEADER.exec(text)
  if (!h || originAuto(text) === auto) return text
  let head = h[2]!
  if (auto) head = /^metadata:[ \t]*$/m.test(head) ? head.replace(/^metadata:[ \t]*$/m, 'metadata:\n  origin: auto') : `${head}\nmetadata:\n  origin: auto`
  else head = head.replace(/^[ \t]+origin:[ \t]*["']?auto["']?[ \t]*(?:\r?\n|$)/gm, '').replace(/^metadata:[ \t]*\r?\n(?![ \t])/gm, '').replace(/\r?\nmetadata:[ \t]*$/, '').replace(/\n+$/, '')
  // (a CRLF file keeps CRLF: the lines put back together use its own line ending)
  const nl = h[1]!.endsWith('\r\n') ? '\r\n' : '\n'
  if (nl === '\r\n') head = head.replace(/\r?\n/g, '\r\n')
  const out = h[1] + head + h[3] + text.slice(h[0].length)
  // every origin line is gone (review of #594: only the first one was taken out)
  if (originAuto(out) !== auto) throw new Error('origin line not changed')
  return out
}
