// Phone notifications only when I'm away from Trina (docs/DECISIONS.md "Phone notifications when I'm away"), Slack's
// default: while you are active on the computer, mobile gets no push. Decided once per notice, when its push to the
// phone app would go (push-service.ts): the person at Trina then (realtime/presence.ts inUse) means the computer showed
// it, and that phone push is cancelled, not held. "Using Trina" (docs/decisions/20261116-away-os-idle.md):
// - the desktop app running and signed in to this team, and the computer had input within 10 minutes (its main
//   process reports the system's idle time every 30 s: the Trina window may be behind other apps or minimized);
// - or a window in use (a browser tab: visible and within 10 minutes of its own input; nothing silent for over a
//   minute), or one closed while in use within the grace.
// A locked screen is away (the phone rings), and so are an idle computer and no app or window at all. Nothing waits and nothing catches up later. Settings ›
// Notifications › "Phone notifications only when I'm away": 'away' (default) or 'always' (at once, as before). The
// owner's locked password check is never cancelled (a security warning).
import type { AppContext } from '../context'
import { presenceFor } from '../realtime/presence'
import { getPreferences } from './preferences'

/** What a phone push is now: 'send' (as before), 'cancel' (the person is at Trina: the computer showed it) or 'wait'
 * with when to ask again (right after a start, while windows reconnect: once, at the warm-up's end). No presence
 * running (a server without the chat runtime): send. */
export type PhoneDecision = { kind: 'send' } | { kind: 'cancel' } | { kind: 'wait'; until: number }

export function phoneDecision(ctx: AppContext, userId: string): PhoneDecision {
  try {
    if (getPreferences(ctx.db, userId).phoneWhen === 'always') return { kind: 'send' }
    const p = presenceFor(ctx)
    if (!p) return { kind: 'send' }
    const warm = p.warmingUntil()
    if (warm !== null) return { kind: 'wait', until: warm }
    return p.inUse(userId) ? { kind: 'cancel' } : { kind: 'send' }
  } catch { return { kind: 'send' } }
}
