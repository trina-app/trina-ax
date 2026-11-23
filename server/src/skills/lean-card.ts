// The skill card in plain words (AskUserRequest.batch; docs/AGENTS/plan/20261123-0339-batch-cards.md). The owner,
// 2026-11-23: "스킬 여러개 만들라고 하니깐 한번에 저렇게 다 띄워 버리네". A skill put into a skill folder (skill_files) or
// moved / copied to another level (move_skill) leads with what happens, the skill's name and its description, and one
// line for who follows it; the paths, the names, the whole SKILL.md and the file sizes are behind "자세히". Several such
// cards of one answer to the same place show as one card with one set of buttons (web AskCard.tsx BatchCard).
import type { Locale, TurnRequest } from '@mycel/shared/api'
import { parseSkill } from '../chat/skills'
import type { Level } from './move'
import { levelRef } from './move'
import { st } from './text'

type Batch = NonNullable<Extract<TurnRequest, { kind: 'ask_user' }>['batch']>

const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n - 1).join('') + '…' : t }

/** The skills of a level, in words that always end in "스킬" (so "로" fits in Korean): 팀 스킬, 리드 부서 스킬, 내 스킬. */
export function placeWords(l: Level, L: Locale): string {
  if (l.level === 'group') return st('batchPlaceGroup', L, { group: oneLine(l.group.name, 40) })
  if (l.level === 'project') return st('batchPlaceProject', L, { project: oneLine(l.project.name, 40) })
  return st(l.level === 'team' ? 'batchPlaceTeam' : 'batchPlacePersonal', L)
}

/** A skill's description from its SKILL.md text, one line (null: none). */
export function skillAbout(text: string | undefined): string | null {
  if (!text) return null
  try { const d = parseSkill(text)?.description?.trim(); return d ? oneLine(d, 280) : null } catch { return null }
}

/**
 * The lean batch of a skill card: `to` the level it goes to, `copy` a copy, `followers` who follows it there, `warn` a
 * line the card must not hide (a same-name skill it replaces or hides, code that can run), joined on one line.
 */
export function skillBatch(o: { tool: string; to: Level; copy: boolean; save?: boolean; name: string; text?: string; followers: number; warn?: string[] }, L: Locale): Batch {
  const where = placeWords(o.to, L)
  const ref = levelRef(o.to)
  const team = o.to.level === 'team'
  const n = String(o.followers)
  const about = skillAbout(o.text)
  const warn = (o.warn ?? []).map((x) => x.trim()).filter(Boolean).join(' ')
  return {
    key: `skill:${o.save ? 'save' : o.copy ? 'copy' : 'move'}:${JSON.stringify(ref)}`,
    one: st(o.save ? 'batchSaveOne' : o.copy ? 'batchCopyOne' : 'batchMoveOne', L, { where }).slice(0, 300),
    many: st(o.save ? 'batchSaveMany' : o.copy ? 'batchCopyMany' : 'batchMoveMany', L, { where, n: '{n}' }).slice(0, 300),
    item: oneLine(o.name, 200),
    ...(about ? { about } : {}),
    ...(warn ? { warn: oneLine(warn, 600) } : {}),
    summary: st(team ? 'batchFollowTeam' : 'batchFollow', L, { n }).slice(0, 300),
    summaryMany: st(team ? 'batchFollowTeamMany' : 'batchFollowMany', L, { n }).slice(0, 300),
  }
}
