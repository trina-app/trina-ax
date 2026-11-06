// The welcome steps (pages/Welcome.tsx; docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks", "W2 — AI connection first", "K — 내 스킬 가져오기"): which step to open, what the Home entry counts, what
// leaving the first step installs, which skill the invite under the first answer shares, and where the owner goes
// right after /setup.
import { GENERAL_TASKS_SKILL, WELCOME_COUNTED, WELCOME_STEPS, type Message, type User, type WelcomeProgress, type WelcomeStep } from '@mycel/shared/api'

/** The steps after the AI step, in order (the AI step is a gate, not a place in the order: docs/DECISIONS.md "W2"). */
const AFTER_AI = WELCOME_STEPS.filter((s) => s !== 'ai')

/** A step's state; absent (a row from before 내 스킬 / 팀 파일, an older server) reads as open. */
export const stepState = (p: WelcomeProgress, s: WelcomeStep) => p.steps[s] ?? null

/**
 * Whether a step is open on this device: not done or put off; and 내 스킬 가져오기 put off on a phone (`skillsLater`:
 * skills live on a computer, docs/DECISIONS.md "K") is open again on a computer. `computer` false: a phone.
 */
export const openHere = (p: WelcomeProgress, s: WelcomeStep, computer = true) =>
  stepState(p, s) === null || (s === 'skills' && computer && !!p.skillsLater && p.steps.skills !== 'done')

/** Where the steps resume once AI answers: the first step after the AI step still open here; with none left, the first
 * counted step that was put off ("later" is now; on a phone not 내 스킬, which waits for a computer); null when
 * everything is done (or finished). */
function resumeWithAi(p: WelcomeProgress | null, computer: boolean): WelcomeStep | null {
  if (p?.finishedAt) return null
  if (!p) return AFTER_AI[0]!
  const open = AFTER_AI.find((s) => openHere(p, s, computer))
  if (open) return open
  return WELCOME_COUNTED.find((s) => stepState(p, s) !== 'done' && !(s === 'skills' && !computer && p.skillsLater)) ?? null
}

/** The steps the AI step holds back: 회사 소개 and the intro deck need AI; 내 스킬 (its checks work without AI), 팀 파일
 * and the invite do not. */
const needsAi = (s: WelcomeStep | null) => s === 'profile' || s === 'result'

/**
 * Where the steps resume. Without an AI that answers the owner (`aiReady` false: GET /api/me/ai-access), the AI step
 * in front of 회사 소개 and the intro deck, never in front of the later steps. `computer` false on a phone.
 */
export function resumeStep(p: WelcomeProgress | null, aiReady = true, computer = true): WelcomeStep | null {
  const s = resumeWithAi(p, computer)
  return !aiReady && needsAi(s) ? 'ai' : s
}

/** After a step: the next one in order that is still open here; null (back to Home) when none is left after it, so a
 * step put off never comes straight back. */
export function nextStep(p: WelcomeProgress, from: WelcomeStep, computer = true): WelcomeStep | null {
  const order: readonly WelcomeStep[] = from === 'ai' ? AFTER_AI : AFTER_AI.slice(AFTER_AI.indexOf(from) + 1)
  return order.find((s) => openHere(p, s, computer)) ?? null
}

/** The step before (the AI step is never gone back to: it is over once AI answers). The intro deck is not gone back to
 * from the steps after it once it started (it builds on the server; its chat is a click away on the status line). */
export function prevStep(from: WelcomeStep, p?: WelcomeProgress | null): WelcomeStep | null {
  if (from === 'ai') return null
  const before = AFTER_AI[AFTER_AI.indexOf(from) - 1] ?? null
  if (before === 'result' && p?.resultChatId && p.steps.result === 'done') return null
  return before
}

/** The steps the progress counts: the AI step while it is needed (the steps would open on it) or once it was shown
 * (recorded), then 회사 소개, the intro deck, 내 스킬 and 팀 파일; an owner whose AI answered from the start never sees it
 * (four steps). */
export function countedSteps(p: WelcomeProgress | null, aiReady = true): WelcomeStep[] {
  const ai = (p?.steps.ai ?? null) !== null || resumeStep(p, aiReady) === 'ai'
  return ai ? ['ai', ...WELCOME_COUNTED] : [...WELCOME_COUNTED]
}

/** "1/4" on the Home entry: the counted steps done */
export const doneCount = (p: WelcomeProgress | null, aiReady = true) => (p ? countedSteps(p, aiReady).filter((s) => p.steps[s] === 'done').length : 0)

/** How many steps the progress counts (the "/4", "/5" with the AI step): read it from here, never as a number of its own. */
export const stepTotal = (p: WelcomeProgress | null = null, aiReady = true) => countedSteps(p, aiReady).length

/** What Home's row names: the invite alone left (every counted step done), 내 스킬 alone left (the rest done; put off on
 * a phone or here), else the count. */
export function resumeLeft(p: WelcomeProgress, aiReady = true): 'invite' | 'skills' | 'count' {
  const left = countedSteps(p, aiReady).filter((s) => p.steps[s] !== 'done')
  if (!left.length) return 'invite'
  return left.length === 1 && left[0] === 'skills' ? 'skills' : 'count'
}

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

/** The Home entry shows while the steps were started and are neither finished nor hidden, and have a step to open on
 * this device (on a phone, 내 스킬 put off for a computer is not one). */
export const showResume = (p: WelcomeProgress | null, computer = true) => !!p && !p.finishedAt && !p.dismissedAt && resumeStep(p, true, computer) !== null

/**
 * Coming back resumes the steps (docs/DECISIONS.md "W4"): an owner who left them unfinished lands on them instead of
 * Home, once per tab session. Only a landing counts (the tab opened on Home, or a sign-in sent it there:
 * `LANDING_STATE`), never a link to somewhere else or a later click on Home. The steps on screen in this tab (after
 * /setup, this redirect, the Home row) mark the session, so "나중에 하기" goes Home and stays there. The mark is kept per
 * account in sessionStorage, and in this page too when the browser refuses storage.
 */
export const LANDING_STATE = { landing: true } as const
const SEEN_KEY = 'mycel.welcome.seen'
const seenHere = new Set<string>()
export function markStepsSeen(userId: string) {
  seenHere.add(userId)
  try { sessionStorage.setItem(`${SEEN_KEY}:${userId}`, '1') } catch { /* this page's copy holds it */ }
}
export function stepsSeen(userId: string): boolean {
  if (seenHere.has(userId)) return true
  try { return sessionStorage.getItem(`${SEEN_KEY}:${userId}`) === '1' } catch { return false }
}
/** A new tab session: on sign-out (lib/logout.ts), so the next sign-in brings an unfinished owner back; and in tests. */
export const forgetStepsSeen = () => {
  seenHere.clear()
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k?.startsWith(SEEN_KEY)) sessionStorage.removeItem(k)
    }
  } catch { /* none kept */ }
}
/** A landing takes the owner to the steps while they were started, are neither finished nor hidden, and have a step to
 * open (resumeStep: with only a put-off invite left there is none, and the steps would send Home again). */
export const resumesOnLanding = (p: WelcomeProgress | null, computer = true) => showResume(p, computer)
/** Whether a location is a landing: the first entry of the tab (react-router's "default" key) on Home itself, or a
 * sign-in's. A first entry that carries a question or a project (`/?prompt=…`, `/?project=…` from a link opened in a new
 * tab) is not a landing: it is going somewhere, and the steps would lose it. */
export const isLanding = (l: { key: string; state: unknown; search?: string }) =>
  (l.key === 'default' && !l.search) || (l.state as { landing?: unknown } | null)?.landing === true

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

/** The skill the invite carries: the shared skill the owner brought from 내 스킬 가져오기 (`shared.landing`, the first
 * recommended one unless they changed it; docs/DECISIONS.md "K"), else the first result's, the intro deck
 * (docs/DECISIONS.md "D2"), so a teammate's run counts for the 7-day goal; else the promo video or the card news (a row
 * whose first result ran one of them), the marketing pack's ad copy, the meeting notes skill (rows from before them). */
export const inviteSkill = (p: WelcomeProgress): string | null => p.shared?.landing ?? p.general?.introDeckPath ?? p.general?.promoVideoPath ?? p.general?.cardNewsPath ?? p.pack?.skillPath ?? p.general?.tasksPath ?? null

/** The shared skills' names for the invite message, the landing skill first (docs/DECISIONS.md "K"); none: []. */
export function sharedTitles(p: WelcomeProgress | null): string[] {
  const all = p?.shared?.skills ?? []
  const first = all.find((x) => x.path === p?.shared?.landing)
  return [...(first ? [first] : []), ...all.filter((x) => x !== first)].map((x) => x.title)
}

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
