// The welcome steps after a team is made (docs/DECISIONS.md "W — Welcome steps"): 팀 유형 → 회사 소개 → 첫 결과, then
// the team invite. Route module: server/src/routes/onboarding-welcome.ts. The progress is one settings row of the team
// (`onboarding.welcome`), so the steps resume where they stopped on any device; owners and admins read it, only the
// owner (who walks through the steps) writes it. Choosing 마케팅 installs the marketing skill pack once: the server
// records that it ran and never runs it again by itself (stream C: installing again restores files someone deleted).
import { z } from 'zod'
import { endpoint } from './endpoint'
import { SkillPackId, SkillPackInstallResult } from './onboarding-packs'

/** In order. `invite` comes after the three counted steps (the progress bar shows team, profile, result). */
export const WELCOME_STEPS = ['team', 'profile', 'result', 'invite'] as const
export const WelcomeStep = z.enum(WELCOME_STEPS)
export type WelcomeStep = z.infer<typeof WelcomeStep>
/** the steps the progress bar counts ("2/3") */
export const WELCOME_COUNTED = ['team', 'profile', 'result'] as const satisfies readonly WelcomeStep[]

export const WelcomeStepState = z.enum(['done', 'skipped'])
export type WelcomeStepState = z.infer<typeof WelcomeStepState>

/** 마케팅 / 영업 / 경영지원 / 기타. Only marketing has a skill pack today. */
export const TEAM_TYPES = ['marketing', 'sales', 'operations', 'other'] as const
export const TeamType = z.enum(TEAM_TYPES)
export type TeamType = z.infer<typeof TeamType>
export const TEAM_TYPE_PACK: Partial<Record<TeamType, SkillPackId>> = { marketing: 'marketing' }

/** The first-result skill: the marketing pack's ad copy ("우리 회사 광고 문구 3개"). */
export const WELCOME_RESULT_SKILL = 'skills/marketing/ad-copy/SKILL.md'

export const WelcomeProgress = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  teamType: TeamType.nullable(),
  steps: z.object({ team: WelcomeStepState.nullable(), profile: WelcomeStepState.nullable(), result: WelcomeStepState.nullable(), invite: WelcomeStepState.nullable() }),
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
  /** team, profile and result done, and the invite done or skipped */
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
  /** what the install did; null when these steps had installed the pack before (nothing ran now) */
  install: SkillPackInstallResult.nullable(),
})
export type WelcomePackResult = z.infer<typeof WelcomePackResult>

export const WELCOME = {
  getWelcome: endpoint({ method: 'GET', path: '/api/onboarding/welcome', auth: 'admin', owner: 'B', response: WelcomeState,
    summary: 'Where the welcome steps stopped (owners and admins read it): which steps are done or skipped, the pack they installed, the first-result chat.' }),
  updateWelcome: endpoint({ method: 'PATCH', path: '/api/onboarding/welcome', auth: 'owner', owner: 'B', body: WelcomeUpdate, response: WelcomeState,
    summary: 'Record a welcome step (owner): start, the team type, a step done or skipped, the first-result chat, the invite shown, hide the Home entry.' }),
  installWelcomePack: endpoint({ method: 'POST', path: '/api/onboarding/welcome/pack', auth: 'owner', owner: 'B', response: WelcomePackResult,
    summary: 'Install the marketing skill pack for the welcome steps, once: when these steps installed it before, nothing runs again.' }),
} as const
