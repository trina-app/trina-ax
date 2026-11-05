// The welcome steps after a team is made (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One
// meeting note, everyone's own tasks"): 회사 소개 → 첫 결과, then the team invite. The first result is the team's own
// meeting notes put into the team's folder and turned into tasks per person; every team gets the general skill pack
// and a group named after the team with its folder (groups/<team>/), once. Route module: server/src/routes/onboarding-welcome.ts. The progress is one settings
// row of the team (`onboarding.welcome`), so the steps resume where they stopped on any device; owners and admins read
// it, only the owner (who walks through the steps) writes it. The team type is no longer asked: the steps never install
// the marketing skill pack by themselves (Team skills offers it on a click); POST …/pack still installs it once and
// records that it ran, never running it again by itself (stream C: installing again restores files someone deleted).
import { z } from 'zod'
import { empty, endpoint } from './endpoint'
import { SkillPackId, SkillPackInstallResult } from './onboarding-packs'

/** In order. `ai` (connect an AI) opens the steps only while the owner has no AI that answers them (docs/DECISIONS.md
 * "W2 — AI connection first"), in front of profile and result, never in front of the invite; it is recorded once it
 * was shown, so the progress keeps showing it. `invite` comes after the counted steps (the progress bar shows ai when
 * it was needed, profile, result). A row written before may still hold a `team` step: it is kept as it is and no
 * longer read. */
export const WELCOME_STEPS = ['ai', 'profile', 'result', 'invite'] as const
export const WelcomeStep = z.enum(WELCOME_STEPS)
export type WelcomeStep = z.infer<typeof WelcomeStep>
/** the steps the progress bar always counts ("1/2"); `ai` is counted too while it is needed or once it was shown
 * (web/src/lib/welcome.ts countedSteps) */
export const WELCOME_COUNTED = ['profile', 'result'] as const satisfies readonly WelcomeStep[]

export const WelcomeStepState = z.enum(['done', 'skipped'])
export type WelcomeStepState = z.infer<typeof WelcomeStepState>

/** 마케팅 / 영업 / 경영지원 / 기타. Only marketing has a skill pack, an addition to the general pack. The welcome steps
 * no longer ask (docs/DECISIONS.md "W2"): rows from before may hold a type, kept and readable; the team skill draft
 * still reads `marketing` to pick its pack folder. null: no answer. */
export const TEAM_TYPES = ['marketing', 'sales', 'operations', 'other'] as const
export const TeamType = z.enum(TEAM_TYPES)
export type TeamType = z.infer<typeof TeamType>
export const TEAM_TYPE_PACK: Partial<Record<TeamType, SkillPackId>> = { marketing: 'marketing' }

/** How many skills the marketing pack puts in ("마케팅 스킬 7개"; a test holds it to the pack). */
export const WELCOME_PACK_SKILLS = 7

/** The first-result skill: the marketing pack's ad copy ("우리 회사 광고 문구 3개"). */
export const WELCOME_RESULT_SKILL = 'skills/marketing/ad-copy/SKILL.md'

/** `brandFolder` (groups/<team>/브랜드, localized): the company intro and the brand images folder in it (docs/DECISIONS.md
 * "N"); absent on rows from before it until the team's start runs again. */
export const TeamGroupRef = z.object({ id: z.string(), name: z.string(), folder: z.string(), notesFolder: z.string(), brandFolder: z.string().optional() })
export type TeamGroupRef = z.infer<typeof TeamGroupRef>

/** A field added later must be optional or have a default: the server reads the stored row field by field (a field
 * that does not read falls back to its default; a recorded pack always counts as installed). */
export const WelcomeProgress = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  teamType: TeamType.nullable(),
  steps: z.object({
    /** absent on rows from before the AI step, and for an owner whose AI answered from the start; `skipped` once it was
     * shown (no AI answered), `done` when AI answered after that */
    ai: WelcomeStepState.nullable().optional(),
    profile: WelcomeStepState.nullable(), result: WelcomeStepState.nullable(), invite: WelcomeStepState.nullable(),
  }),
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
  /** profile and result done, and the invite done or skipped; or the owner finished without files ("자료 없이") */
  finishedAt: z.string().nullable(),
  /** the general pack (할 일 정리, 핵심 정리) these steps installed, once; absent or null: not yet. `tasksPath` /
   * `briefPath`: the skills "/meeting-tasks" and "/doc-brief" run for the team (the pack's own files, or another team
   * skill of that name already there); null when neither is there */
  general: z.object({
    at: z.string(), tasksPath: z.string().nullable(), briefPath: z.string().nullable(),
    /** "/card-news" (the first result, docs/DECISIONS.md "N"): installed with the pack, or once on its own by the first
     * result for a row recorded before the skill existed; absent: not tried yet, null: blocked */
    cardNewsPath: z.string().nullable().optional(),
  }).nullable().optional(),
  /** the team's own group (named after the team), its folder groups/<name>/ (its members read and write) and the
   * meeting notes folder in it; made once by these steps, the owner in it, the team link's default group. Absent or
   * null: not yet */
  teamGroup: TeamGroupRef.nullable().optional(),
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
  /** "자료 없이 해 볼게요" without the marketing pack: the steps end here (the result and the invite are put off, and the
   * steps count as finished); Home says where meeting notes go */
  finish: z.literal(true).optional(),
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

/** POST /api/onboarding/welcome/team: the general pack (once) and the team's own group and folders (once). */
export const WelcomeTeamResult = z.object({
  progress: WelcomeProgress,
  /** what the general pack's install did; null when nothing ran now */
  install: SkillPackInstallResult.nullable(),
  /** installed / already: as for the marketing pack · blocked: the folder rules kept "할 일 정리" out (nothing recorded) */
  outcome: z.enum(['installed', 'already', 'blocked']),
})
export type WelcomeTeamResult = z.infer<typeof WelcomeTeamResult>

/** POST /api/onboarding/welcome/first-result: the company card news (docs/DECISIONS.md "N"). `files`: the team files the
 * owner just put into the brand folder (their company intro or team deck); none: the server writes 회사 소개.md there
 * from the saved profile and the pages the website reading opened. */
export const FIRST_RESULT_FILES_MAX = 10
export const StartFirstResult = z.object({ files: z.array(z.string().min(1).max(1000)).max(FIRST_RESULT_FILES_MAX) }).strict()
export type StartFirstResult = z.infer<typeof StartFirstResult>
export const FirstResultStarted = z.object({
  /** a new chat of the owner's, titled after the result ("우리 회사 홍보 카드뉴스") */
  chatId: z.string(),
  title: z.string(),
  /** the skill to run ("/card-news") */
  skillPath: z.string(),
  /** the team files to attach to the first message: the owner's files, or the 회사 소개.md just written */
  files: z.array(z.string()),
  /** the 회사 소개.md written now (no files), else null */
  intro: z.string().nullable(),
  /** the brand images folder and the images placed there now (from the website reading) */
  imagesFolder: z.string(),
  images: z.array(z.string()),
})
export type FirstResultStarted = z.infer<typeof FirstResultStarted>

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
  setupWelcomeTeam: endpoint({ method: 'POST', path: '/api/onboarding/welcome/team', auth: 'owner', owner: 'B', response: WelcomeTeamResult,
    summary: 'Every team\'s start, once: the general skill pack (meeting notes → tasks, a document\'s brief) and a group named after the team with its folder groups/<name>/ and a meeting notes folder in it, the owner in it.' }),
  startFirstResult: endpoint({ method: 'POST', path: '/api/onboarding/welcome/first-result', auth: 'owner', owner: 'B', body: StartFirstResult, response: FirstResultStarted, status: 201,
    summary: 'Start the welcome steps\' first result, the company card news (owner): the website\'s images into the brand folder, a company intro file (named in the team\'s language) when no file was given, and a new chat of the owner for it.' }),
  getResultSuggestion: endpoint({ method: 'GET', path: '/api/onboarding/suggestion', auth: 'user', owner: 'B',
    query: z.object({ chatId: z.string().min(1).max(64), messageId: z.string().min(1).max(64) }), response: z.object({ suggestion: ResultSuggestion.nullable() }),
    summary: 'The one suggestion under an answer of the caller\'s own chat (schedule a skill run for the 2nd time, or a report as a PPT), or null; none the caller closed.' }),
  dismissSuggestion: endpoint({ method: 'POST', path: '/api/onboarding/suggestion/dismiss', auth: 'user', owner: 'B', body: z.object({ key: SuggestionKey }).strict(), response: empty, status: 204,
    summary: 'Close a suggestion under answers for good (for the caller only).' }),
} as const
