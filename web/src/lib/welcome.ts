// The welcome steps (pages/Welcome.tsx; docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"): which step to
// open, what the Home entry counts, and where the owner goes right after /setup.
import { TEAM_TYPE_PACK, WELCOME_COUNTED, WELCOME_STEPS, type WelcomeProgress, type WelcomeStep } from '@mycel/shared/api'

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

/** Leaving the first step installs the marketing pack: not installed yet, and no other team type was picked (no type
 * reads as marketing). Another type gets the offer on the result step instead (a click, never by itself). */
export const wantsPack = (p: WelcomeProgress | null) => !!p && !p.pack && (p.teamType === null || !!TEAM_TYPE_PACK[p.teamType])

/** The Home entry shows while the steps were started and are neither finished nor hidden. */
export const showResume = (p: WelcomeProgress | null) => !!p && !p.finishedAt && !p.dismissedAt

/** The invite bar on the first-result chat: until the invite is done or put off. */
export const showInviteBar = (p: WelcomeProgress | null, chatId: string) => !!p && p.resultChatId === chatId && p.steps.invite === null

/**
 * Right after /setup made the team: the owner goes to the welcome steps. Set before the session switches to signed
 * in, which re-renders /setup as a signed-in page at once (App.tsx AfterSetup), before the router's own navigation (a
 * transition) lands; the same reason as the team link's AfterJoin.
 */
let afterSetup: string | null = null
export const setAfterSetup = (to: string) => { afterSetup = to }
export const afterSetupTarget = (): string => afterSetup ?? '/'
export const clearAfterSetup = () => { afterSetup = null }
