// The welcome steps after a team is made (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "W5 —
// Onboarding v5", "W6 — Onboarding v6"): every team gets a group named after the team with its folder (groups/<team>/)
// and the brand folder in it, once. Route module: server/src/routes/onboarding-welcome.ts. The progress is one settings
// row of the team (`onboarding.welcome`), so the steps resume where they stopped on any device; owners and admins read
// it, only the owner (who walks through the steps) writes it. No skill goes in by itself (docs/DECISIONS.md "DS3",
// "W6"): a skill goes in only on a press that names it. A row written before may hold `pack` (the marketing pack an
// earlier version's steps installed): kept as it is and no longer read.
import { z } from 'zod'
import { empty, endpoint } from './endpoint'
import { SkillPackInstallResult } from './onboarding-packs'

/** `ai` (connect an AI) opens the steps only while the owner has no AI that answers them (docs/DECISIONS.md "W2 — AI
 * connection first"), in front of the steps that need it, never in front of the later ones; it is recorded once it was
 * shown, so the progress keeps showing it. Then (docs/DECISIONS.md "W6 — Onboarding v6"): `profile` (회사 소개; its
 * "저장하고 계속" saves the profile and puts the website's pictures and 회사 소개.md into the brand folder: no deck, no
 * chat, no skill), `skills` (내 스킬), `files` (팀 파일), `tools` (도구 연결: Google Drive where this server has it, and
 * one line to add any connection; every team, skipped on a phone) and `invite` (팀원 초대), then the end screen ("준비
 * 끝났어요"). `result` is no longer a step: it is kept for rows written before ("first result"), read but never walked.
 * A row written before may still hold a `team` step: it is kept as it is and no longer read; a row from before
 * `skills`, `files` or `tools` reads them as open. */
export const WELCOME_STEPS = ['ai', 'profile', 'result', 'skills', 'files', 'tools', 'invite'] as const
export const WelcomeStep = z.enum(WELCOME_STEPS)
export type WelcomeStep = z.infer<typeof WelcomeStep>
/** the steps the progress bar always counts, in the order they are walked ("1/5"); `ai` is counted too while it is
 * needed or once it was shown (web/src/lib/welcome.ts countedSteps). The setup is finished when each of them is done or
 * put off (server/src/onboarding/welcome.ts welcomeFinished). */
export const WELCOME_COUNTED = ['profile', 'skills', 'files', 'tools', 'invite'] as const satisfies readonly WelcomeStep[]
/** The step a phone skips and records as put off (docs/DECISIONS.md "W6"): the sign-ins it starts do not come back to
 * the phone app yet. A computer's setup row reaches it while the setup is unfinished. */
export const WELCOME_COMPUTER_ONLY = ['tools'] as const satisfies readonly WelcomeStep[]

export const WelcomeStepState = z.enum(['done', 'skipped'])
export type WelcomeStepState = z.infer<typeof WelcomeStepState>

/** 마케팅 / 영업 / 경영지원 / 기타. The welcome steps no longer ask (docs/DECISIONS.md "W2"): rows from before may hold
 * a type, kept and readable; nothing depends on it. null: no answer. */
export const TEAM_TYPES = ['marketing', 'sales', 'operations', 'other'] as const
export const TeamType = z.enum(TEAM_TYPES)
export type TeamType = z.infer<typeof TeamType>

/** `brandFolder` (groups/<team>/브랜드, localized): the company intro and the brand images folder in it (docs/DECISIONS.md
 * "N"); absent on rows from before it until the team's start runs again. */
export const TeamGroupRef = z.object({ id: z.string(), name: z.string(), folder: z.string(), notesFolder: z.string(), brandFolder: z.string().optional() })
export type TeamGroupRef = z.infer<typeof TeamGroupRef>

/** A field added later must be optional or have a default: the server reads the stored row field by field (a field
 * that does not read falls back to its default; a recorded general pack always counts as installed). */
export const WelcomeProgress = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  teamType: TeamType.nullable(),
  steps: z.object({
    /** absent on rows from before the AI step, and for an owner whose AI answered from the start; `skipped` once it was
     * shown (no AI answered), `done` when AI answered after that */
    ai: WelcomeStepState.nullable().optional(),
    profile: WelcomeStepState.nullable(), result: WelcomeStepState.nullable(),
    /** 내 스킬 가져오기 and 팀 파일 가져오기 (docs/DECISIONS.md "SK"): the server sends null for rows from before them;
     * absent (an older server) reads as null */
    skills: WelcomeStepState.nullable().optional(), files: WelcomeStepState.nullable().optional(),
    /** 도구 연결 (docs/DECISIONS.md "W6"): null for rows from before it (open); absent (an older server) reads as null */
    tools: WelcomeStepState.nullable().optional(),
    invite: WelcomeStepState.nullable(),
  }),
  /** the intro deck's chat ("우리 회사 소개서") of a row whose deck started on an earlier version (v6.1 or before),
   * once its "/intro-deck" message is in; rows from before that: the first result's chat. Nothing new writes it
   * (docs/DECISIONS.md "W6": 회사 소개 starts no deck) */
  resultChatId: z.string().nullable(),
  /** when the invite step was first opened */
  inviteShownAt: z.string().nullable(),
  /** the company website the setup link carried (the profile step starts from it on any device) */
  site: z.string().nullable(),
  /** the owner hid the "continue" entry on Home */
  dismissedAt: z.string().nullable(),
  /** a row from the three-step version whose team step was put off ("나중에") and no team type picked since; absent =
   * no. Read for those rows only: nothing installs a pack because of the team type any more */
  teamSkipped: z.boolean().optional(),
  /** 회사 소개 answered (saved or put off) and 내 스킬, 팀 파일, 도구 연결 and the invite each done or put off, not while
   * 내 스킬 waits for a computer (`skillsLater`); or a row of the three-step version that finished without files ("자료
   * 없이"). Once set it stays: a step added later never reopens a finished setup */
  finishedAt: z.string().nullable(),
  /** the end screen ("준비 끝났어요") was shown: it shows once; finishing later (내 스킬 on a computer after a phone)
   * goes Home with "설정을 마쳤어요". Absent or null: not yet */
  doneShownAt: z.string().nullable().optional(),
  /** the general pack as earlier versions' steps recorded it (they installed it); these steps install nothing and write
   * the record with no paths, `{ at, tasksPath: null, briefPath: null }`, so an older build after a rollback reads the
   * pack as handled and installs nothing (docs/DECISIONS.md "W6"). Absent: the team's start has not run; nothing reads
   * that as "not set up" (the team group says that). A row from before may hold `tasksPath` / `briefPath` (skills that
   * no longer ship, docs/DECISIONS.md "DS3"): not read */
  general: z.object({
    at: z.string(),
    /** "/card-news" (the first result of docs/DECISIONS.md "N", before the promo video; still installed with the pack):
     * installed with the pack, or recorded when it was there; absent: not recorded, null: blocked */
    cardNewsPath: z.string().nullable().optional(),
    /** "/promo-video" (the first result of docs/DECISIONS.md "V", before the intro deck; still installed with the pack):
     * installed with the pack, or recorded when it was there; absent: not recorded, null: blocked */
    promoVideoPath: z.string().nullable().optional(),
    /** "/intro-deck" (the first result of earlier versions, docs/DECISIONS.md "D2"): installed with the pack, or once on
     * its own by that first result; absent: never recorded (every row these steps start now), null: blocked */
    introDeckPath: z.string().nullable().optional(),
  }).nullable().optional(),
  /** 내 스킬 가져오기 was put off on a phone ("다음": skills live on a computer): the step reads as skipped there and as
   * open on a computer, so Home's row says "남은 일: 내 스킬 가져오기" and the steps resume on it there; the steps are
   * not finished while it is set. Absent = no */
  skillsLater: z.boolean().optional(),
  /** the skills the owner shared to the team from 내 스킬 가져오기 (docs/DECISIONS.md "SK"), in the order they were
   * added, and the one the invite opens (`landing`: the first recommended one, which the owner may change on the
   * invite; the 7-day goal names it). Absent or null: none */
  shared: z.object({ at: z.string(), skills: z.array(z.object({ path: z.string(), title: z.string() })), landing: z.string().nullable() }).nullable().optional(),
  /** the team's own group (named after the team), its folder groups/<name>/ (its members read and write) and the
   * meeting notes folder in it; made once by these steps, the owner in it, the team link's default group. Absent or
   * null: not yet */
  teamGroup: TeamGroupRef.nullable().optional(),
  /** facts the server reads for the screens (docs/DECISIONS.md "W5"), never stored in the row: `deckStarted`, an intro
   * deck really started on an earlier version (the deck's chat holds the "/intro-deck" message, or a deck build exists
   * for it; a first result of a row from before is no deck), for the end screen's one line; `landingSkill`, the skill everything points
   * at as the server decides it (server/src/onboarding/welcome.ts landingSkill: the first shared skill while it is
   * there, never the intro deck; null: none, and the invite link lands on Home), for the invite and "'{skill}' 먼저 써
   * 보기". Absent: an older server */
  deckStarted: z.boolean().optional(),
  landingSkill: z.string().nullable().optional(),
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
  /** "자료 없이 해 볼게요": the steps end here (the result and the invite are put off, and the steps count as finished);
   * Home says where meeting notes go */
  finish: z.literal(true).optional(),
  /** 내 스킬 가져오기 put off on a phone (`skillsLater`): resumed on a computer */
  skillsLater: z.literal(true).optional(),
  /** the shared skill the invite opens (바꾸기 on the invite): one of `shared.skills` */
  landing: z.string().min(1).max(1000).optional(),
  /** the end screen was shown (once) */
  doneShown: z.literal(true).optional(),
}).strict()
export type WelcomeUpdate = z.infer<typeof WelcomeUpdate>

/** POST /api/onboarding/welcome/team: the team's own group and folders (once). No pack is installed (docs/DECISIONS.md
 * "W6"): `install` is null and `outcome` "already" from this version on; both stay for clients of earlier versions
 * (`installed` and `blocked` were the pack install's outcomes). */
export const WelcomeTeamResult = z.object({
  progress: WelcomeProgress,
  install: SkillPackInstallResult.nullable(),
  outcome: z.enum(['installed', 'already', 'blocked']),
})
export type WelcomeTeamResult = z.infer<typeof WelcomeTeamResult>

/** POST /api/onboarding/welcome/brand (docs/DECISIONS.md "W6"): what 회사 소개's "저장하고 계속" puts into the team's
 * brand folder, with no AI: the team group and brand folder when missing, the pictures the website reading collected
 * (into the brand images folder, each once) and, when the owner gave no intro files, 회사 소개.md written from the saved
 * profile and the pages read (each part under its source; one already there is kept). Safe to repeat: it writes only
 * what is missing (고치기 saves call it again). `files`: the team files the owner added on 회사 소개 ("소개 자료가 있으면
 * 같이 넣기", already uploaded into the brand folder): they are the intro, so no 회사 소개.md is written. */
export const WELCOME_BRAND_FILES_MAX = 10
export const WelcomeBrand = z.object({ files: z.array(z.string().min(1).max(1000)).max(WELCOME_BRAND_FILES_MAX) }).strict()
export type WelcomeBrand = z.infer<typeof WelcomeBrand>
export const WelcomeBrandResult = z.object({
  progress: WelcomeProgress,
  /** the brand folder and its images folder */
  brandFolder: z.string(),
  imagesFolder: z.string(),
  /** the website's pictures there (placed now or before) */
  images: z.array(z.string()),
  /** 회사 소개.md when it is there (written now or kept), else null (the owner's files are the intro) */
  intro: z.string().nullable(),
})
export type WelcomeBrandResult = z.infer<typeof WelcomeBrandResult>

/**
 * One suggestion under a result (docs/DECISIONS.md "X — Lean onboarding"), at most one line, chosen by state (the
 * lead's first result has the invite bar instead, decided in the web app):
 * - `schedule`: the person ran this team skill for at least the 2nd time (successful answers, not scheduled runs) and
 *   has no scheduled task that runs it: "매주 이 시간에 자동으로 받을까요?" [예약하기];
 * - `team-skill`: an owner's or admin's answer that used team files and ran no team skill, which S's rules let become a
 *   team skill (not the welcome steps' first result, not confidential, nothing from the web or an outside service,
 *   every file readable by the team): "이 방식대로 팀 스킬로 만들까요?" [팀 스킬로 만들기] opens the skill card
 *   (docs/DECISIONS.md "S", "W3");
 * - `ppt`: a long report-like answer (over PPT_SUGGEST_CHARS of prose): [PPT로 만들기];
 * - `deck-video`: under the first intro deck, "이 소개서로 10초 홍보 영상도 만들어 둘까요? 끝나면 알려 드려요" [만들어 두기]
 *   (docs/DECISIONS.md "D2"): the hook is in the contract, never sent while DECK_VIDEO_SUGGESTION is off;
 * - `contribute` (members only, docs/DECISIONS.md "MC"): under a member's first successful run of the team's landing
 *   skill, before `ppt`: "내가 쓰던 스킬이나 파일도 팀에 올릴래요?" [올리기] opens the member's skill folder pick (a
 *   computer) and, when they can write it, a link to the team folder (`folder`; a phone gets only that, and nothing
 *   when it is null: the web app asks with `phone=1`, and the server then answers what comes next).
 * A suggestion the person closed never comes back for them (`key`, stored per person on the server).
 */
export const SuggestionKey = z.string().max(500).regex(/^(ppt|team-skill|deck-video|contribute|schedule:skills\/[^\r\n]+)$/)
export const ResultSuggestion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), key: SuggestionKey, skill: z.object({ path: z.string(), name: z.string() }) }),
  z.object({ kind: z.literal('team-skill'), key: z.literal('team-skill') }),
  z.object({ kind: z.literal('ppt'), key: z.literal('ppt') }),
  z.object({ kind: z.literal('deck-video'), key: z.literal('deck-video') }),
  /** `folder`: the team folder the member can write (groups/<team>/), else null (no files part) */
  z.object({ kind: z.literal('contribute'), key: z.literal('contribute'), folder: z.string().nullable() }),
])
export type ResultSuggestion = z.infer<typeof ResultSuggestion>
/** The promo video made from the first intro deck in the background (docs/DECISIONS.md "D2"): off until that run is
 * built. While false the server never suggests `deck-video`. Once on, under the first deck the video line comes first
 * and the [팀에 공유] bar takes its place after it is answered, so it stays one line ("X"). */
export const DECK_VIDEO_SUGGESTION: boolean = false
/** an answer of this much prose (code blocks left out) or more reads as a report */
export const PPT_SUGGEST_CHARS = 2000

export const WELCOME = {
  getWelcome: endpoint({ method: 'GET', path: '/api/onboarding/welcome', auth: 'admin', owner: 'B', response: WelcomeState,
    summary: 'Where the welcome steps stopped (owners and admins read it): which steps are done or skipped, the team group they set up, the deck chat of a row whose deck started on an earlier version.' }),
  updateWelcome: endpoint({ method: 'PATCH', path: '/api/onboarding/welcome', auth: 'owner', owner: 'B', body: WelcomeUpdate, response: WelcomeState,
    summary: 'Record a welcome step (owner): start, the team type, a step done or skipped, the invite shown, hide the Home entry.' }),
  setupWelcomeTeam: endpoint({ method: 'POST', path: '/api/onboarding/welcome/team', auth: 'owner', owner: 'B', response: WelcomeTeamResult,
    summary: 'Every team\'s start, once: a group named after the team with its folder groups/<name>/, a meeting notes folder and a brand folder in it, the owner in it. No skill is installed.' }),
  welcomeBrand: endpoint({ method: 'POST', path: '/api/onboarding/welcome/brand', auth: 'owner', owner: 'B', body: WelcomeBrand, response: WelcomeBrandResult,
    summary: 'Put the website\'s pictures and a company intro file (named in the team\'s language, unless the owner gave intro files) into the team\'s brand folder, with no AI (owner). Writes only what is missing.' }),
  getResultSuggestion: endpoint({ method: 'GET', path: '/api/onboarding/suggestion', auth: 'user', owner: 'B',
    query: z.object({ chatId: z.string().min(1).max(64), messageId: z.string().min(1).max(64), phone: z.enum(['0', '1']).optional() }), response: z.object({ suggestion: ResultSuggestion.nullable() }),
    summary: 'The one suggestion under an answer of the caller\'s own chat (schedule a skill run for the 2nd time, make a team skill of an owner\'s or admin\'s work with team files, a member\'s own skills and files after their first run of the landing skill, or a report as a PPT), or null; none the caller closed. phone=1: a member who can write no team folder gets no contribute line there.' }),
  dismissSuggestion: endpoint({ method: 'POST', path: '/api/onboarding/suggestion/dismiss', auth: 'user', owner: 'B', body: z.object({ key: SuggestionKey }).strict(), response: empty, status: 204,
    summary: 'Close a suggestion under answers for good (for the caller only).' }),
} as const
