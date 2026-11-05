// The welcome steps (pages/Welcome.tsx; docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks"): which step to open, what the Home entry counts, what leaving the first step installs,
// what the invite under the first answer carries, and where the owner goes right after /setup.
import { GENERAL_TASKS_SKILL, LOCALE_ORDER, WELCOME_COUNTED, WELCOME_STEPS, type Message, type StarterKind, type User, type WelcomeProgress, type WelcomeStep } from '@mycel/shared/api'
import { translate } from '../i18n'

/** Where the steps resume: the first step not yet done or put off; with none left, the first counted step that was
 * put off ("later" is now); null when everything is done (or finished). */
export function resumeStep(p: WelcomeProgress | null): WelcomeStep | null {
  if (!p) return WELCOME_STEPS[0]
  if (p.finishedAt) return null
  const open = WELCOME_STEPS.find((s) => p.steps[s] === null)
  if (open) return open
  return WELCOME_COUNTED.find((s) => p.steps[s] !== 'done') ?? null
}

/** After a step: the next one in order that is still open; null (back to Home) when none is left after it, so a step
 * put off never comes straight back. */
export function nextStep(p: WelcomeProgress, from: WelcomeStep): WelcomeStep | null {
  return WELCOME_STEPS.slice(WELCOME_STEPS.indexOf(from) + 1).find((s) => p.steps[s] === null) ?? null
}

export function prevStep(from: WelcomeStep): WelcomeStep | null {
  return WELCOME_STEPS[WELCOME_STEPS.indexOf(from) - 1] ?? null
}

/** "1/2" on the Home entry: the counted steps done */
export const doneCount = (p: WelcomeProgress | null) => (p ? WELCOME_COUNTED.filter((s) => p.steps[s] === 'done').length : 0)

/** How many steps the progress counts (the "/2"): read it from here, never as a number of its own. */
export const stepTotal = () => WELCOME_COUNTED.length

/** Leaving the first step installs the marketing pack only when the owner said "마케팅팀이에요" and it is not in yet.
 * No answer (null) is the general pack only; a type from before (영업, 기타 …) reads as "not marketing". */
export const wantsPack = (p: WelcomeProgress | null) => !!p && p.teamType === 'marketing' && !p.pack

/** Every team's start (POST /api/onboarding/welcome/team): the general pack and the team's own group with its brand
 * folder, while any is missing (the server installs and creates each once, whatever the page asks; a group recorded
 * before the brand folder existed gets it then). */
export const wantsTeam = (p: WelcomeProgress | null) => !!p && (!p.general || !p.teamGroup || !p.teamGroup.brandFolder)

/** The line above the first step goes once what it promised is recorded: the general pack, and the marketing pack when
 * the owner asked for it. */
export const packsRecorded = (p: WelcomeProgress) => !!p.general && (p.teamType !== 'marketing' || !!p.pack)

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

/** Letters and digits only, lower case: the switch sentence is found whatever the punctuation, spaces or apostrophes. */
const bare = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The meeting-tasks skill's own words when the files were not meeting notes ("회의록이 아니라서 핵심만 정리했어요", "These
 * aren't meeting notes …"): it then gave a brief instead, and the invite says so. Looked for near the start of the
 * answer (its first line by the skill's rule), in every language the skill may answer in.
 */
export function isBriefSwitch(text: string): boolean {
  const head = bare(text.slice(0, 300))
  return LOCALE_ORDER.some((l) => {
    const sentence = bare(translate(l, 'welcome.files.briefSwitch'))
    return !!sentence && head.includes(sentence)
  })
}

/**
 * What the first answer's invite carries: the team files the lead put in (the first question's team-file references
 * that are still there) and what people who join get from them: their own tasks, or a brief when the skill said the
 * files were not meeting notes. null: no team files (the ad copy, or anything else).
 */
export function resultStarter(messages: Pick<Message, 'role' | 'content' | 'attachments'>[]): { kind: StarterKind; files: string[] } | null {
  const question = messages.find((m) => m.role === 'user')
  const files = [...new Set((question?.attachments ?? []).filter((a) => a.source === 'team' && !a.unavailable && a.path).map((a) => a.path))]
  if (!files.length) return null
  const answer = messages.filter((m) => m.role === 'assistant').at(-1)
  return { kind: answer && isBriefSwitch(answer.content) ? 'brief' : 'tasks', files }
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
