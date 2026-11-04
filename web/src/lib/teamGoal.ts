// The 7-day team goal on the web side (contract shared/src/api/onboarding-goal.ts): pure text helpers, so they are
// tested without a browser. The card is web/src/components/onboarding/GoalCard.tsx.
import type { InboxNotification } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

type T = (key: MessageKey, params?: Params) => string

/** Korean object particle for a word: 을 after a final consonant, 를 after a vowel (a Hangul syllable or a digit as
 * read in Korean); "을(를)" when it cannot be told (Latin letters, signs). */
export function objectParticle(word: string): string {
  const last = [...word.trim()].pop() ?? ''
  const c = last.codePointAt(0) ?? 0
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? '를' : '을'
  // 영 일 이 삼 사 오 육 칠 팔 구
  if (/[0-9]/.test(last)) return '2459'.includes(last) ? '를' : '을'
  return '을(를)'
}

/** A skill's name quoted as the object of a sentence in this language: '광고 문구'를 · 「広告コピー」 · 'Ad copy'. */
export function quotedSkill(locale: string, name: string): string {
  if (locale === 'ko') return `'${name}'${objectParticle(name)}`
  if (locale === 'ja') return `「${name}」`
  return `'${name}'`
}

/** "2/3" up to the target, then "4명" (more people than the goal needs). */
export function goalProgressText(t: T, count: number, target: number): string {
  return count <= target ? t('goal.progress', { count, target }) : t('goal.people', { n: count })
}

/** Names in a short line: the first three, then "+N" for the rest (deleted accounts are counted, never named). */
export function runnerNames(names: string[], runners: number): string {
  const shown = names.slice(0, 3)
  const more = Math.max(0, runners - shown.length)
  return shown.join(', ') + (more ? `${shown.length ? ' ' : ''}+${more}` : '')
}

/** The owners' inbox line for 'onboarding.first_run': "○○님이 '광고 문구'를 처음 써 봤어요 (2/3)". */
export function firstRunText(t: T, locale: string, item: Pick<InboxNotification, 'firstRun'>): string {
  const f = item.firstRun
  if (!f) return t('goal.firstRunPlain')
  const params = { skill: quotedSkill(locale, f.skill), progress: goalProgressText(t, f.runners, f.target) }
  return f.member ? t('goal.firstRun', { ...params, name: f.member }) : t('goal.firstRunGone', params)
}
