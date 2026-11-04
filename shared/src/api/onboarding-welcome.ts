// The welcome steps after a team is made (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"): 회사 소개 →
// 첫 결과, then the team invite. Route module: server/src/routes/onboarding-welcome.ts. The progress is one settings
// row of the team (`onboarding.welcome`), so the steps resume where they stopped on any device; owners and admins read
// it, only the owner (who walks through the steps) writes it. The team type is no longer a step: the first step says
// "마케팅 스킬 7개를 넣어 둘게요 · 다른 팀이에요", and leaving it installs the marketing skill pack once (unless another
// team type was picked): the server records that it ran and never runs it again by itself (stream C: installing again
// restores files someone deleted).
import { z } from 'zod'
import { empty, endpoint } from './endpoint'
import { SkillPackId, SkillPackInstallResult } from './onboarding-packs'

/** In order. `invite` comes after the two counted steps (the progress bar shows profile, result). A row written before
 * may still hold a `team` step: it is kept as it is and no longer read. */
export const WELCOME_STEPS = ['profile', 'result', 'invite'] as const
export const WelcomeStep = z.enum(WELCOME_STEPS)
export type WelcomeStep = z.infer<typeof WelcomeStep>
/** the steps the progress bar counts ("1/2") */
export const WELCOME_COUNTED = ['profile', 'result'] as const satisfies readonly WelcomeStep[]

export const WelcomeStepState = z.enum(['done', 'skipped'])
export type WelcomeStepState = z.infer<typeof WelcomeStepState>

/** 마케팅 / 영업 / 경영지원 / 기타. Only marketing has a skill pack today (the default: null reads as marketing). */
export const TEAM_TYPES = ['marketing', 'sales', 'operations', 'other'] as const
export const TeamType = z.enum(TEAM_TYPES)
export type TeamType = z.infer<typeof TeamType>
export const TEAM_TYPE_PACK: Partial<Record<TeamType, SkillPackId>> = { marketing: 'marketing' }

/** How many skills the marketing pack puts in ("마케팅 스킬 7개를 넣어 둘게요"; a test holds it to the pack). */
export const WELCOME_PACK_SKILLS = 7

/** The first-result skill: the marketing pack's ad copy ("우리 회사 광고 문구 3개"). */
export const WELCOME_RESULT_SKILL = 'skills/marketing/ad-copy/SKILL.md'

/** A field added later must be optional or have a default: the server reads the stored row field by field (a field
 * that does not read falls back to its default; a recorded pack always counts as installed). */
export const WelcomeProgress = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  teamType: TeamType.nullable(),
  steps: z.object({ profile: WelcomeStepState.nullable(), result: WelcomeStepState.nullable(), invite: WelcomeStepState.nullable() }),
  /** the pack these steps installed, once (never again by themselves), and the path of its first-result skill */
  pack: z.object({ id: SkillPackId, at: z.string(), skillPath: z.string() }).nullable(),
  /** the chat the first result ran in (one of the owner's): it shows the invite bar */
  resultChatId: z.string().nullable(),
  /** when the invite step was first opened */
  inviteShownAt: z.string().nullable(),
  /** the company website the setup link carried (the profile step starts from it on any device) */
  site: z.string().nullable(),
  /** the owner hid the "continue" entry on Home */
  dismissedAt: z.string().nullable(),
  /** a row from the three-step version whose team step was put off ("나중에") and no team type picked since: the
   * marketing pack is not installed by itself when the first step is left (the earlier choice stands); absent = no */
  teamSkipped: z.boolean().optional(),
  /** profile and result done, and the invite done or skipped */
  finishedAt: z.string().nullable(),
})
export type WelcomeProgress = z.infer<typeof WelcomeProgress>

/** null: the steps were never opened (teams from before them, or the owner went straight elsewhere) */
export const WelcomeState = z.object({ progress: WelcomeProgress.nullable() })
export type WelcomeState = z.infer<typeof WelcomeState>

/** One change; an empty body only starts the progress. */
export const WelcomeUpdate = z.object({
  teamType: TeamType.optional(),
  step: z.object({ id: WelcomeStep, state: WelcomeStepState }).optional(),
  /** a chat of the caller's own (others are refused) */
  resultChatId: z.string().min(1).max(64).optional(),
  inviteShown: z.literal(true).optional(),
  site: z.string().max(300).optional(),
  dismissed: z.boolean().optional(),
}).strict()
export type WelcomeUpdate = z.infer<typeof WelcomeUpdate>

export const WelcomePackResult = z.object({
  progress: WelcomeProgress,
  /** what the install did; null when nothing ran now */
  install: SkillPackInstallResult.nullable(),
  /** installed: it ran now and is recorded · already: recorded before, or the team already had the pack's skills
   * (recorded now without installing, so nothing deleted on purpose comes back) · blocked: it ran but the
   * first-result skill could not be written (folder rules): nothing recorded */
  outcome: z.enum(['installed', 'already', 'blocked']),
})
export type WelcomePackResult = z.infer<typeof WelcomePackResult>

/**
 * One suggestion under a result (docs/DECISIONS.md "X — Lean onboarding"), at most one line, chosen by state (the
 * lead's first result has the invite bar instead, decided in the web app):
 * - `schedule`: the person ran this team skill for at least the 2nd time (successful answers, not scheduled runs) and
 *   has no scheduled task that runs it: "매주 이 시간에 자동으로 받을까요?" [예약하기];
 * - `ppt`: a long report-like answer (the weekly report, or over PPT_SUGGEST_CHARS of prose): [PPT로 만들기].
 * A suggestion the person closed never comes back for them (`key`, stored per person on the server).
 */
export const SuggestionKey = z.string().max(500).regex(/^(ppt|schedule:skills\/[^\r\n]+)$/)
export const ResultSuggestion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), key: SuggestionKey, skill: z.object({ path: z.string(), name: z.string() }) }),
  z.object({ kind: z.literal('ppt'), key: z.literal('ppt') }),
])
export type ResultSuggestion = z.infer<typeof ResultSuggestion>
/** an answer of this much prose (code blocks left out) or more reads as a report */
export const PPT_SUGGEST_CHARS = 2000
/** the pack's report skill: its answers are report-like whatever their length */
export const REPORT_SKILLS = ['weekly-report'] as const

export const WELCOME = {
  getWelcome: endpoint({ method: 'GET', path: '/api/onboarding/welcome', auth: 'admin', owner: 'B', response: WelcomeState,
    summary: 'Where the welcome steps stopped (owners and admins read it): which steps are done or skipped, the pack they installed, the first-result chat.' }),
  updateWelcome: endpoint({ method: 'PATCH', path: '/api/onboarding/welcome', auth: 'owner', owner: 'B', body: WelcomeUpdate, response: WelcomeState,
    summary: 'Record a welcome step (owner): start, the team type, a step done or skipped, the first-result chat, the invite shown, hide the Home entry.' }),
  installWelcomePack: endpoint({ method: 'POST', path: '/api/onboarding/welcome/pack', auth: 'owner', owner: 'B', response: WelcomePackResult,
    summary: 'Install the marketing skill pack for the welcome steps, once: nothing runs when these steps installed it before or the team already has its skills.' }),
  getResultSuggestion: endpoint({ method: 'GET', path: '/api/onboarding/suggestion', auth: 'user', owner: 'B',
    query: z.object({ chatId: z.string().min(1).max(64), messageId: z.string().min(1).max(64) }), response: z.object({ suggestion: ResultSuggestion.nullable() }),
    summary: 'The one suggestion under an answer of the caller\'s own chat (schedule a skill run for the 2nd time, or a report as a PPT), or null; none the caller closed.' }),
  dismissSuggestion: endpoint({ method: 'POST', path: '/api/onboarding/suggestion/dismiss', auth: 'user', owner: 'B', body: z.object({ key: SuggestionKey }).strict(), response: empty, status: 204,
    summary: 'Close a suggestion under answers for good (for the caller only).' }),
} as const
