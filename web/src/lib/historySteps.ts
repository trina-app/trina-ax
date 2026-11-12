// Steps through the browser history that the app's own code has started and is waiting on: the phone's screen history
// going back to a screen already in the stack, or putting a tab's stack in place of another (lib/screenHistory.ts).
// The contract with lib/backCloses.ts (the overlays' entries): while a step is on its way, backCloses starts no back of
// its own off an overlay's entry (the step goes past those entries, and the popstate it brings closes their overlays as
// for a Back), and the popstates the step brings are not the person's. Before it steps, the screen history gives an
// overlay closing on the same tap (a sheet's item that opens a screen) its moment to back off its own entry first, so the
// two never go back at once (Chromium, Android's WebView, applies both and lands one entry too far).

// The same news as a window event, for code that does not import this file (either PR can land first):
// `mycel:history-steps` with `detail.stepping` true when the first step starts and false when the last one ends.
export const HISTORY_STEPS_EVENT = 'mycel:history-steps'

let steps = 0
let waiting: (() => void)[] = []

function tell(stepping: boolean) {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(HISTORY_STEPS_EVENT, { detail: { stepping } }))
  } catch { /* no events here (a test's window) */ }
}

/** Is a step of ours on its way? */
export const historyStepping = () => steps > 0

/** Run `task` (its history.go calls and the popstates they bring) as a step of ours. */
export async function stepping<T>(task: () => Promise<T>): Promise<T> {
  steps += 1
  if (steps === 1) tell(true)
  try {
    return await task()
  } finally {
    steps -= 1
    if (!steps) {
      tell(false)
      const then = waiting
      waiting = []
      for (const f of then) f()
    }
  }
}

/** `then` once no step of ours is on its way (at once when none is). */
export function whenStepsDone(then: () => void) {
  if (!steps) then()
  else waiting.push(then)
}
