// Phone notifications only when I'm away from Trina (docs/DECISIONS.md "Phone notifications when I'm away"), Slack's
// default: while you are active on the computer, mobile gets no push. Decided once per notice, when its push to the
// phone app would go (push-service.ts): the person at Trina then (realtime/presence.ts inUse: a window in use, which in
// the desktop app also counts the computer's own input and a locked screen; a window closed while in use within the
// grace; nothing silent for over a minute) means the computer showed it, and that phone push is cancelled, not held.
// Away (or no window) means it goes to the phone as before. Nothing waits and nothing catches up later. Settings ›
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
