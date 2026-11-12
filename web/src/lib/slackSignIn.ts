// "Sign in with Slack" and "Add to Slack" in the web app (docs/SLACK.md): the outcome the server's callback sends back
// (?slack=…) in the reader's words, and the fixed page that finishes a sign-in or an install that came back to a
// browser with no session.
import type { MessageKey } from '../i18n'

const OUTCOME: Record<string, MessageKey> = {
  linked: 'slack.signin.linked', signin_expired: 'slack.signin.expired', signin_other_user: 'slack.signin.otherUser',
  signin_cancelled: 'slack.signin.cancelled', outsider: 'slack.signin.outsider', linked_elsewhere: 'slack.link.elsewhere',
  slack_taken: 'slack.signin.taken', signin_off: 'slack.signin.off',
  // "Add to Slack" (the hosting service's official app)
  installed: 'slack.install.done', install_expired: 'slack.install.expired', install_cancelled: 'slack.install.cancelled',
  install_failed: 'slack.install.failed', workspace_taken: 'slack.install.taken', enterprise_install: 'slack.install.enterprise',
  missing_scope: 'slack.install.failed', own_app_saved: 'slack.install.ownApp', broker_unreachable: 'slack.install.unreachable',
}
/** The words for an outcome; anything else (also a name like "constructor") is the general failure */
export const outcomeText = (code: string): MessageKey => Object.hasOwn(OUTCOME, code) ? OUTCOME[code]! : 'slack.signin.failed'
/** an outcome of "Add to Slack" (Admin › Slack and the done page say it in those words) */
export const installOutcome = (code: string) => code === 'installed' || code.startsWith('install_') || ['workspace_taken', 'enterprise_install', 'missing_scope', 'own_app_saved', 'broker_unreachable'].includes(code)

/** The server's callbacks, the only places the return page sends a browser */
export const CALLBACK_PATH = '/api/integrations/slack/oauth/callback'
export const INSTALL_CALLBACK_PATH = '/api/integrations/slack/official/callback'
const STATE = /^[A-Za-z0-9_-]{43}$/
const CODE = /^[A-Za-z0-9._-]{8,512}$/
/** the hosting service's one-time handoff (the official app), in place of Slack's code */
const HANDOFF = /^[A-Za-z0-9_-]{43}$/
/** The callback again with only the state and the code (or the handoff), all checked; `to=install`: the install's
 * callback, with a handoff only. null for anything else. */
export function resumeTarget(search: string): string | null {
  const p = new URLSearchParams(search)
  const state = p.get('state') ?? '', code = p.get('code'), handoff = p.get('handoff'), to = p.get('to')
  if (!STATE.test(state) || (code !== null && handoff !== null)) return null
  if (to === 'install') return handoff !== null && HANDOFF.test(handoff) ? `${INSTALL_CALLBACK_PATH}?${new URLSearchParams({ state, handoff })}` : null
  if (to !== null) return null
  if (code !== null) return CODE.test(code) ? `${CALLBACK_PATH}?${new URLSearchParams({ state, code })}` : null
  if (handoff !== null) return HANDOFF.test(handoff) ? `${CALLBACK_PATH}?${new URLSearchParams({ state, handoff })}` : null
  return null
}
