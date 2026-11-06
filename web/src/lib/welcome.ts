// The welcome steps (pages/Welcome.tsx; docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks", "W2 — AI connection first", "SK — 내 스킬 가져오기", "W5 — Onboarding v5"): which step to
// open, what the setup row counts, what leaving the first step installs, which skill the invite and the end screen
// point at, and where the owner goes right after /setup. The steps: AI 연결 (only while no AI answers) → 회사 소개 (its
// "저장하고 계속" starts the intro deck once per team) → 내 스킬 → 팀 파일 → 팀원 초대 → the end screen. The intro deck is
// no step: it is an ordinary chat ("우리 회사 소개서") found by its row in the chat list.
import { GENERAL_DECK_SKILL, GENERAL_TASKS_SKILL, WELCOME_COUNTED, type User, type WelcomeProgress, type WelcomeStep } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

/** Where the deck's chat is listed, as the sidebar names that list: the sidebar heading's own message
 * (`sidebar.recents`, Sidebar.tsx), never words of our own. The walk of PR #100 found "트리나 기록" here while the sidebar
 * said "최근 채팅"; when feat/phone-nav renames that list, it changes that one message and these lines follow. */
export const historyName = (t: (key: MessageKey) => string): string => t('sidebar.recents')

/** The steps after the AI step, in order (the AI step is a gate, not a place in the order: docs/DECISIONS.md "W2"). */
const ORDER: readonly WelcomeStep[] = WELCOME_COUNTED

/** A step's state; absent (a row from before 내 스킬 / 팀 파일, an older server) reads as open. */
export const stepState = (p: WelcomeProgress, s: WelcomeStep) => p.steps[s] ?? null

/** 회사 소개 is answered: put off, or saved with the intro deck started (`resultChatId`). A row from before (회사 소개
 * saved, the old "first result" step never answered, no deck: docs/DECISIONS.md "W5", old row (a)) is still open, so it
 * resumes on 회사 소개 and its "저장하고 계속" starts the deck; one whose first result was answered either way (done:
 * just a chat; put off: no deck) is answered. */
export const profileAnswered = (p: WelcomeProgress) =>
  p.steps.profile === 'skipped' || (p.steps.profile === 'done' && (!!p.resultChatId || stepState(p, 'result') !== null))

/**
 * Whether a step is open on this device: not done or put off (회사 소개: profileAnswered); and 내 스킬 가져오기 put off
 * on a phone (`skillsLater`: skills live on a computer, docs/DECISIONS.md "SK") is open again on a computer. `computer`
 * false: a phone.
 */
export const openHere = (p: WelcomeProgress, s: WelcomeStep, computer = true) =>
  s === 'profile' ? !profileAnswered(p)
    : stepState(p, s) === null || (s === 'skills' && computer && !!p.skillsLater && p.steps.skills !== 'done')

/** Where the steps resume once AI answers: the first step still open here; with none left, the first counted step that
 * was put off ("later" is now; on a phone not 내 스킬, which waits for a computer); null when everything is done (or
 * finished). */
function resumeWithAi(p: WelcomeProgress | null, computer: boolean): WelcomeStep | null {
  if (p?.finishedAt) return null
  if (!p) return ORDER[0]!
  const open = ORDER.find((s) => openHere(p, s, computer))
  if (open) return open
  return WELCOME_COUNTED.find((s) => stepState(p, s) !== 'done' && !(s === 'skills' && !computer && p.skillsLater)) ?? null
}

/** The steps the AI step holds back: 회사 소개 (the website reading and the intro deck are AI answers); 내 스킬 (its
 * checks work without AI), 팀 파일 and the invite do not. */
export const needsAi = (s: WelcomeStep | null) => s === 'profile'

/**
 * Where the steps resume. Without an AI that answers the owner (`aiReady` false: GET /api/me/ai-access), the AI step
 * in front of 회사 소개, never in front of the later steps. `computer` false on a phone.
 */
export function resumeStep(p: WelcomeProgress | null, aiReady = true, computer = true): WelcomeStep | null {
  const s = resumeWithAi(p, computer)
  return !aiReady && needsAi(s) ? 'ai' : s
}

/** After a step: the next one in order that is still open here; null (the end) when none is left after it, so a step
 * put off never comes straight back. */
export function nextStep(p: WelcomeProgress, from: WelcomeStep, computer = true): WelcomeStep | null {
  const order = from === 'ai' ? ORDER : ORDER.slice(ORDER.indexOf(from) + 1)
  return order.find((s) => openHere(p, s, computer)) ?? null
}

/** The step before (the AI step is never gone back to: it is over once AI answers). 회사 소개 can be gone back to at
 * any time: once the deck started its "저장하고 계속" only saves (docs/DECISIONS.md "W5"). */
export function prevStep(from: WelcomeStep): WelcomeStep | null {
  if (from === 'ai') return null
  return ORDER[ORDER.indexOf(from) - 1] ?? null
}

/** The steps the progress counts: the AI step while it is needed (the steps would open on it) or once it was shown
 * (recorded), then 회사 소개, 내 스킬, 팀 파일 and 팀원 초대; an owner whose AI answered from the start never sees it
 * ("n/4"). */
export function countedSteps(p: WelcomeProgress | null, aiReady = true): WelcomeStep[] {
  const ai = (p?.steps.ai ?? null) !== null || resumeStep(p, aiReady) === 'ai'
  return ai ? ['ai', ...WELCOME_COUNTED] : [...WELCOME_COUNTED]
}

/** A counted step is done: 회사 소개 saved and answered (profileAnswered), the others (the AI step too) recorded done.
 * Put off is not done. */
const stepDone = (p: WelcomeProgress, s: WelcomeStep) => (s === 'profile' ? p.steps.profile === 'done' && profileAnswered(p) : stepState(p, s) === 'done')

/** "2/4" in the setup row: the counted steps done (the AI step once AI answered). A step put off is not counted: with
 * steps put off the row read "4/4" while something was left (the recheck of onboarding v5). */
export function doneCount(p: WelcomeProgress | null, aiReady = true): number {
  if (!p) return 0
  return countedSteps(p, aiReady).filter((s) => stepDone(p, s)).length
}

/** What is left here, in order: the counted steps not done (open or put off), except 내 스킬 on a phone while it waits
 * for a computer (`skillsLater`: nothing to do there). One left: the setup row names it ("남은 일: 팀 파일"). */
export function stepsLeft(p: WelcomeProgress | null, aiReady = true, computer = true): WelcomeStep[] {
  const counted = countedSteps(p, aiReady)
  if (!p) return counted
  return counted.filter((s) => !stepDone(p, s) && !(s === 'skills' && !computer && p.skillsLater))
}

/** How many steps the progress counts (the "/4", "/5" with the AI step): read it from here, never as a number of its own. */
export const stepTotal = (p: WelcomeProgress | null = null, aiReady = true) => countedSteps(p, aiReady).length

/** A step by its name on the progress bar ("팀 파일"). */
const STEP_NAME: Partial<Record<WelcomeStep, MessageKey>> = { ai: 'welcome.progress.ai', profile: 'welcome.progress.profile', skills: 'welcome.progress.skills', files: 'welcome.progress.files', invite: 'welcome.progress.invite' }

/** The words of the way back to the steps, one rule for the sidebar's (and the ☰ drawer's) setup row and a phone Home's
 * quiet row, so the two agree: one step left here, it is named ("남은 일: 팀 파일", no count); else "설정 이어서 하기"
 * with "n/4", the steps done. */
export function setupRowWords(t: (key: MessageKey, params?: Params) => string, p: WelcomeProgress | null, aiReady = true, computer = true): { text: string; count: string | null } {
  const left = stepsLeft(p, aiReady, computer)
  const name = left.length === 1 ? STEP_NAME[left[0]!] : undefined
  if (name) return { text: t('setupRow.left', { step: t(name) }), count: null }
  return { text: t('setupRow.resume'), count: `${doneCount(p, aiReady)}/${stepTotal(p, aiReady)}` }
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

/** The setup is unfinished here: the steps were started, are neither finished nor hidden, and have a step to open on
 * this device (on a phone, 내 스킬 put off for a computer is not one). */
export const showResume = (p: WelcomeProgress | null, computer = true) => !!p && !p.finishedAt && !p.dismissedAt && resumeStep(p, true, computer) !== null

/** On a phone, all that is left is 내 스킬 put off for a computer (`skillsLater`; the steps unfinished, not hidden): the
 * phone keeps the step's promise "컴퓨터에서 이어서 해요" with one quiet line on Home (WelcomeResume.tsx SkillsOnComputer),
 * since nothing there can be resumed (the walk of PR #100: the phone showed nothing at all). */
export const skillsWaitForComputer = (p: WelcomeProgress | null) =>
  !!p && !p.finishedAt && !p.dismissedAt && !!p.skillsLater && p.steps.skills !== 'done' && !showResume(p, false)

/**
 * The setup row (components/onboarding/SetupRow.tsx; docs/DECISIONS.md "W5"), the owner's one way back to the steps
 * from every page: `hidden`, `resume` ("설정 이어서 하기 · 2/4", or "남은 일: 팀 파일" with one step left: setupRowWords;
 * → /welcome at its step) or `ai` (while no AI answers: "AI 연결하기", the connect dialog). Never on /welcome itself;
 * while unfinished and not hidden (showResume). Without AI it hides on Home, where the no-AI card stands. On a phone it
 * hides on Home, whose own quiet row under the message box says the same; on a computer it replaces that row.
 * `aiReady`: AI answers the owner (or not known yet).
 */
export function setupRowState(p: WelcomeProgress | null, o: { path: string; aiReady: boolean; computer: boolean }): 'hidden' | 'resume' | 'ai' {
  if (o.path === '/welcome' || !showResume(p, o.computer)) return 'hidden'
  const home = o.path === '/'
  if (!o.aiReady) return home ? 'hidden' : 'ai'
  return home && !o.computer ? 'hidden' : 'resume'
}

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

/** The skill everything points at (the invite, the end screen's "먼저 써 보기", the 7-day goal: docs/DECISIONS.md "W5"):
 * the server's own choice, sent with the progress (`landingSkill`, server/src/onboarding/welcome.ts landingSkill: the
 * skill the owner shared first from 내 스킬 가져오기 while it is there, else the general pack's 할 일 정리 while it is
 * there; never the intro deck), so the invite, the end screen, the goal card and the link agree. An older server without
 * it: the shared one, else 할 일 정리, unless that is the deck. null: none (the team's start was blocked, the skills
 * deleted). */
export function inviteSkill(p: WelcomeProgress): string | null {
  if (p.landingSkill !== undefined) return p.landingSkill
  const deck = p.general?.introDeckPath ?? GENERAL_DECK_SKILL
  return [p.shared?.landing, p.general?.tasksPath].find((x): x is string => !!x && x !== deck && x !== GENERAL_DECK_SKILL) ?? null
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
