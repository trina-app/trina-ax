// "Sign in with Slack" in the web app (docs/SLACK.md): the outcome the server's callback sends back (?slack=…) in the
// reader's words, and the fixed page that finishes a sign-in that came back to a browser with no session.
import type { MessageKey } from '../i18n'

const OUTCOME: Record<string, MessageKey> = {
  linked: 'slack.signin.linked', signin_expired: 'slack.signin.expired', signin_other_user: 'slack.signin.otherUser',
  signin_cancelled: 'slack.signin.cancelled', outsider: 'slack.signin.outsider', linked_elsewhere: 'slack.link.elsewhere',
  slack_taken: 'slack.signin.taken', signin_off: 'slack.signin.off',
}
/** The words for an outcome; anything else (also a name like "constructor") is the general failure */
export const outcomeText = (code: string): MessageKey => Object.hasOwn(OUTCOME, code) ? OUTCOME[code]! : 'slack.signin.failed'

/** The server's callback, the only place the return page sends a browser */
export const CALLBACK_PATH = '/api/integrations/slack/oauth/callback'
const STATE = /^[A-Za-z0-9_-]{43}$/
const CODE = /^[A-Za-z0-9._-]{8,512}$/
/** The callback again with only the state and the code, both checked; null for anything else */
export function resumeTarget(search: string): string | null {
  const p = new URLSearchParams(search)
  const state = p.get('state') ?? '', code = p.get('code') ?? ''
  if (!STATE.test(state) || !CODE.test(code)) return null
  return `${CALLBACK_PATH}?${new URLSearchParams({ state, code })}`
}
