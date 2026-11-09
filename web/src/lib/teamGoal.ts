// The 7-day team goal on the web side (contract shared/src/api/onboarding-goal.ts): pure text helpers, so they are
// tested without a browser. The card is web/src/components/onboarding/GoalCard.tsx.
import type { InboxNotification, TeamGoal } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

type T = (key: MessageKey, params?: Params) => string

/** Whether a word ends in a vowel as read in Korean (a Hangul syllable without a final consonant, or a digit read as
 * 영 일 이 삼 사 오 육 칠 팔 구); null when it cannot be told (Latin letters, signs). */
function endsInVowel(word: string): boolean | null {
  const last = [...word.trim()].pop() ?? ''
  const c = last.codePointAt(0) ?? 0
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0
  if (/[0-9]/.test(last)) return '2459'.includes(last)
  return null
}

/** Korean object particle for a word: 을 after a final consonant, 를 after a vowel. None when it cannot be told (a
 * name ending in Latin letters or a sign: "'quote maker' 처음 써 봤어요"): a quoted name without its particle reads
 * as spoken Korean, "을(를)" reads as a form. */
export function objectParticle(word: string): string {
  const v = endsInVowel(word)
  return v === null ? '' : v ? '를' : '을'
}

/** Korean topic particle for a word: 은 after a final consonant, 는 after a vowel; none when it cannot be told (as
 * objectParticle). */
export function topicParticle(word: string): string {
  const v = endsInVowel(word)
  return v === null ? '' : v ? '는' : '은'
}

/** A skill's name quoted in this language, without a particle: '광고 문구' · 「広告コピー」 · 'Ad copy'. */
export const skillQuote = (locale: string, name: string): string => locale === 'ja' ? `「${name}」` : `'${name}'`

/** A skill's name quoted as the object of a sentence in this language: '광고 문구'를 · 「広告コピー」 · 'Ad copy'. */
export function quotedSkill(locale: string, name: string): string {
  if (locale === 'ko') return `'${name}'${objectParticle(name)}`
  if (locale === 'ja') return `「${name}」`
  return `'${name}'`
}

/** A skill's name quoted as the topic ("'광고 문구'는 아직이에요"), or the words for any team skill when there is none
 * (`any`, "팀 스킬은"); the other languages' sentences carry their own words. */
export function skillTopic(locale: string, name: string | null, any: string): string {
  if (name === null) return locale === 'ko' ? `${any}${topicParticle(any)}` : any
  if (locale === 'ko') return `'${name}'${topicParticle(name)}`
  return locale === 'ja' ? `「${name}」` : `'${name}'`
}

/** "아직 아무도 안 들어왔어요" waits this many days from the goal's start (docs/DECISIONS.md "W5"): on day 0 the owner
 * has not invited anyone yet, and the line would only scold them; until then the card says how many more. */
export const NOBODY_AFTER_DAYS = 3
const DAY_MS = 86_400_000

/** The goal card's one line while the goal is open, in order: someone joined and has not run the skill yet (one name
 * and a count) · one more person · nobody joined yet (from NOBODY_AFTER_DAYS after the start) · how many more. */
export type GoalNext = { kind: 'waiting'; first: string; more: number } | { kind: 'oneMore' } | { kind: 'nobody' } | { kind: 'more'; n: number }
export function goalNext(g: TeamGoal, now = Date.now()): GoalNext {
  if (g.waiting) return { kind: 'waiting', first: g.waiting.first, more: g.waiting.more }
  const left = Math.max(1, g.target - (g.skill?.runners ?? 0))
  if (left === 1) return { kind: 'oneMore' }
  if (g.joined === 0 && now - Date.parse(g.startedAt) >= NOBODY_AFTER_DAYS * DAY_MS) return { kind: 'nobody' }
  return { kind: 'more', n: left }
}

/** The line itself. `skill`: the top skill's name, else the team link's, else null (any team skill). */
export function goalNextText(t: T, locale: string, next: GoalNext, skill: string | null): string {
  if (next.kind === 'waiting') {
    const params = { name: next.first, skill: skillTopic(locale, skill, t('goal.anySkill')) }
    return next.more ? t('goal.waitingMany', { ...params, n: next.more }) : t('goal.waitingOne', params)
  }
  if (next.kind === 'oneMore') return t('goal.oneMore')
  if (next.kind === 'nobody') return t('goal.nobody')
  return t('goal.more', { n: next.n })
}

/** Where a member runs the skill: its form on the team's address (`/skills?run=<path>`), or the team skills. */
export const skillRunUrl = (base: string, path: string | null) => `${base.replace(/\/+$/, '')}/skills${path ? `?run=${encodeURIComponent(path)}` : ''}`

/** [다시 보내기]: "민지님, '광고 문구' 한 번 눌러 보세요: <link>"; to several people, without a name. */
export function resendText(t: T, locale: string, o: { first: string; more: number; skill: string | null; url: string }): string {
  const skill = o.skill === null ? t('goal.anySkill') : locale === 'ja' ? `「${o.skill}」` : `'${o.skill}'`
  return o.more ? t('goal.resendMany', { skill, url: o.url }) : t('goal.resendOne', { name: o.first, skill, url: o.url })
}

/** "2/3" up to the target, then "4명" (more people than the goal needs). */
export function goalProgressText(t: T, count: number, target: number): string {
  return count <= target ? t('goal.progress', { count, target }) : t('goal.people', { n: count })
}

/** Names in a short line, "민지·지훈·Olga": the first three, then "+N" for the rest (deleted accounts are counted, never
 * named). */
export function runnerNames(names: string[], runners: number): string {
  const shown = names.slice(0, 3)
  const more = Math.max(0, runners - shown.length)
  return shown.join('·') + (more ? `${shown.length ? ' ' : ''}+${more}` : '')
}

/** The owners' inbox line for 'onboarding.first_run': "○○님이 '광고 문구'를 처음 써 봤어요 (2/3)". */
export function firstRunText(t: T, locale: string, item: Pick<InboxNotification, 'firstRun'>): string {
  const f = item.firstRun
  if (!f) return t('goal.firstRunPlain')
  const params = { skill: quotedSkill(locale, f.skill), progress: goalProgressText(t, f.runners, f.target) }
  return f.member ? t('goal.firstRun', { ...params, name: f.member }) : t('goal.firstRunGone', params)
}
