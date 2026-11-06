// The welcome steps (pages/Welcome.tsx; docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks", "W2 — AI connection first"): which step to open, what the Home entry counts, what
// leaving the first step installs, which skill the invite under the first answer shares, and where the owner goes
// right after /setup.
import { GENERAL_TASKS_SKILL, WELCOME_COUNTED, WELCOME_STEPS, type Message, type User, type WelcomeProgress, type WelcomeStep } from '@mycel/shared/api'

/** The steps after the AI step, in order (the AI step is a gate, not a place in the order: docs/DECISIONS.md "W2"). */
const AFTER_AI = WELCOME_STEPS.filter((s) => s !== 'ai')

/** Where the steps resume once AI answers: the first step after the AI step not yet done or put off; with none left,
 * the first counted step that was put off ("later" is now); null when everything is done (or finished). */
function resumeWithAi(p: WelcomeProgress | null): WelcomeStep | null {
  if (p?.finishedAt) return null
  if (!p) return AFTER_AI[0]!
  const open = AFTER_AI.find((s) => p.steps[s] === null)
  if (open) return open
  return WELCOME_COUNTED.find((s) => p.steps[s] !== 'done') ?? null
}

/** The steps the AI step holds back: 회사 소개 and 첫 결과 need AI, the invite does not. */
const needsAi = (s: WelcomeStep | null) => s === 'profile' || s === 'result'

/**
 * Where the steps resume. Without an AI that answers the owner (`aiReady` false: GET /api/me/ai-access), the AI step
 * in front of 회사 소개 and 첫 결과, never in front of the invite: with only the invite left it is the invite.
 */
export function resumeStep(p: WelcomeProgress | null, aiReady = true): WelcomeStep | null {
  const s = resumeWithAi(p)
  return !aiReady && needsAi(s) ? 'ai' : s
}

/** After a step: the next one in order that is still open; null (back to Home) when none is left after it, so a step
 * put off never comes straight back. */
export function nextStep(p: WelcomeProgress, from: WelcomeStep): WelcomeStep | null {
  const order: readonly WelcomeStep[] = from === 'ai' ? AFTER_AI : AFTER_AI.slice(AFTER_AI.indexOf(from) + 1)
  return order.find((s) => p.steps[s] === null) ?? null
}

/** The step before (the AI step is never gone back to: it is over once AI answers). */
export function prevStep(from: WelcomeStep): WelcomeStep | null {
  return from === 'ai' ? null : AFTER_AI[AFTER_AI.indexOf(from) - 1] ?? null
}

/** The steps the progress counts: the AI step while it is needed (the steps would open on it) or once it was shown
 * (recorded), then 회사 소개 and 첫 결과; an owner whose AI answered from the start never sees it (two steps). */
export function countedSteps(p: WelcomeProgress | null, aiReady = true): WelcomeStep[] {
  const ai = (p?.steps.ai ?? null) !== null || resumeStep(p, aiReady) === 'ai'
  return ai ? ['ai', ...WELCOME_COUNTED] : [...WELCOME_COUNTED]
}

/** "1/2" on the Home entry: the counted steps done */
export const doneCount = (p: WelcomeProgress | null, aiReady = true) => (p ? countedSteps(p, aiReady).filter((s) => p.steps[s] === 'done').length : 0)

/** How many steps the progress counts (the "/2", "/3" with the AI step): read it from here, never as a number of its own. */
export const stepTotal = (p: WelcomeProgress | null = null, aiReady = true) => countedSteps(p, aiReady).length

/** Every team's start (POST /api/onboarding/welcome/team): the general pack and the team's own group with its brand
 * folder, while any is missing (the server installs and creates each once, whatever the page asks; a group recorded
 * before the brand folder existed gets it then). */
export const wantsTeam = (p: WelcomeProgress | null) => !!p && (!p.general || !p.teamGroup || !p.teamGroup.brandFolder)

/** The name a skill is run by ("/meeting-tasks"): the folder of a SKILL.md, else the file name of a legacy skill. */
export function skillNameOf(path: string | null | undefined): string {
  const parts = (path ?? GENERAL_TASKS_SKILL).split('/')
  const file = parts.at(-1) ?? ''
  return file === 'SKILL.md' ? (parts.at(-2) ?? '') : file.replace(/\.md$/, '')
}

/** The Home entry shows while the steps were started and are neither finished nor hidden. */
export const showResume = (p: WelcomeProgress | null) => !!p && !p.finishedAt && !p.dismissedAt

/** The invite bar on the first-result chat: until the invite is done or put off. */
export const showInviteBar = (p: WelcomeProgress | null, chatId: string) => !!p && p.resultChatId === chatId && p.steps.invite === null

/**
 * The skill that made the first result, to share as it is (docs/DECISIONS.md "W2 — AI connection first"): the run the
 * server recorded for the answer (`receipt`: the path the 7-day goal counts), else the first question's "/name" among
 * the skills these steps recorded (the intro deck, the promo video, the card news, the meeting notes skills, the ad
 * copy); null when neither says.
 */
export function resultSkill(messages: Pick<Message, 'role' | 'content' | 'receipt'>[], p: WelcomeProgress | null): string | null {
  const ran = messages.find((m) => m.role === 'assistant' && m.receipt)?.receipt?.skill.path
  if (ran) return ran
  const name = /^\/([^\s/]+)/.exec(messages.find((m) => m.role === 'user')?.content.trim() ?? '')?.[1]
  if (!name || !p) return null
  const recorded = [p.general?.introDeckPath, p.general?.promoVideoPath, p.general?.cardNewsPath, p.general?.tasksPath, p.general?.briefPath, p.pack?.skillPath]
  return recorded.find((path): path is string => !!path && skillNameOf(path) === name) ?? null
}

/** The skill the welcome steps' own invite step carries (no chat to read it from): the first result's, the intro deck
 * (docs/DECISIONS.md "D2"), so a teammate's run counts for the 7-day goal; else the promo video or the card news (a row
 * whose first result ran one of them), the marketing pack's ad copy, the meeting notes skill (rows from before them). */
export const inviteSkill = (p: WelcomeProgress): string | null => p.general?.introDeckPath ?? p.general?.promoVideoPath ?? p.general?.cardNewsPath ?? p.pack?.skillPath ?? p.general?.tasksPath ?? null

/** Home's one line after "자료 없이 해 볼게요" (router state): where meeting notes go. */
export interface NotesHint { folder: string; team: string }
export function readNotesHint(state: unknown): NotesHint | null {
  const h = (state as { welcomeNotes?: unknown } | null)?.welcomeNotes as Partial<NotesHint> | undefined
  return h && typeof h.folder === 'string' && h.folder && typeof h.team === 'string' ? { folder: h.folder, team: h.team } : null
}

/**
 * Right after /setup made the team: the owner goes to the welcome steps. Set before the session switches to signed
 * in, which re-renders /setup as a signed-in page at once (App.tsx AfterSetup), before the router's own navigation (a
 * transition) lands; the same reason as the team link's AfterJoin.
 */
let afterSetup: string | null = null
export const setAfterSetup = (to: string) => { afterSetup = to }
export const afterSetupTarget = (): string => afterSetup ?? '/'
export const clearAfterSetup = () => { afterSetup = null }

/**
 * Who sees the team's folder (groups/<team>/): its group's members and the owners and admins (they read every team
 * folder), active accounts only; and the active members outside the group, whom "지금 있는 팀원 n명도 넣기" adds (people
 * who joined before the group was made: an older team resuming the steps, or single-use invites). Folder rules an admin
 * changed by hand are not read here: the steps made the folder with the group's own rule.
 */
export function teamReach(users: Pick<User, 'id' | 'role' | 'status'>[], memberIds: readonly string[]): { viewers: number; outside: string[] } {
  const active = users.filter((u) => u.status === 'active')
  const inGroup = new Set(memberIds)
  return {
    viewers: active.filter((u) => inGroup.has(u.id) || u.role === 'owner' || u.role === 'admin').length,
    outside: active.filter((u) => u.role === 'member' && !inGroup.has(u.id)).map((u) => u.id),
  }
}
