// Jira automation, action "Send web request" with the custom body Trina gives (shared roomAppJiraBody;
// https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/). One flow per trigger ("Work item
// created", "Work item transitioned", optionally "Work item commented"), each with its own body naming it in "event"
// (Jira has no documented smart value for the trigger). No signature: the Webhook URL's token only.
//
// Smart values are pasted into the body as they are (no JSON escaping), so everything a person writes (summary, names,
// the comment; the status name too) goes through `.jsonEncode`, which escapes quotes and backslashes without adding the
// surrounding quotes (https://support.atlassian.com/cloud-automation/docs/jira-smart-values-text-fields/). As with
// Zendesk (security review of #854), a body whose raw text names any template key twice is refused anyway (a flow that
// was edited to drop `.jsonEncode` must not let a summary add `"key":…`), and the link is built only as
// https://<site>.atlassian.net/browse/<the same key>, the site pinned to the app on first sight.
//
// Jira sends no delivery id: dedupe on the body's hash and on key + event + what the card shows, both 10 minutes. One
// card per work item (`issue:<key>`): a transition edits its status line and joins the thread, a comment joins it.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line, lines, safeLink } from '../card'
import type { Arrival, Parsed } from '../parse'
import { jsonOf, obj, sha, str, textOf } from '../read'
import { appText } from '../text'
import { duplicateKey, replyLines, type PresetDef } from './common'

export const JIRA_KEYS = ['trina', 'event', 'key', 'title', 'status', 'assignee', 'url', 'comment', 'by'] as const
const EVENTS = ['created', 'transitioned', 'commented'] as const
/** A work item key: the space's key, "-", a number (KEY-123). */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,29}-\d{1,9}$/

/** The work item's page: exactly https://<site>.atlassian.net/browse/<key> for this key, and its site; else none. */
function issueLink(raw: string, key: string): { url: string; site: string } | null {
  const u = safeLink(raw)
  if (!u) return null
  const m = /^([a-z0-9][a-z0-9-]{0,62})\.atlassian\.net$/.exec(u.host.toLowerCase())
  let path = ''
  try { const x = new URL(u.url); if (x.search || x.hash || x.port) return null; path = x.pathname } catch { return null }
  if (!m || path !== `/browse/${key}`) return null
  return { url: `https://${m[1]}.atlassian.net/browse/${key}`, site: m[1]! }
}

function parse(a: Arrival): Parsed {
  const text = textOf(a.raw)
  if (duplicateKey(text, JIRA_KEYS)) return { refuse: 'format' }
  const j = obj(jsonOf(a.raw))
  if (!j || str(j, 'trina') !== 'jira') return { refuse: 'format' }
  const key = line(str(j, 'key'), 40)
  const event = str(j, 'event').trim().toLowerCase() as (typeof EVENTS)[number]
  if (!ISSUE_KEY.test(key) || !EVENTS.includes(event)) return { refuse: 'format' }
  const L = a.locale
  const title = line(str(j, 'title'), 200) || key
  const statusWord = line(str(j, 'status'), 60)
  const assignee = line(str(j, 'assignee'), 80)
  const comment = lines(str(j, 'comment'), 2000)
  const by = line(str(j, 'by'), 80)
  const t = issueLink(str(j, 'url').trim(), key)
  const link = t && (!a.pin || a.pin === t.site) ? t.url : undefined
  const status = statusWord ? appText('status', L, { status: statusWord }) : undefined
  const details = [assignee ? appText('sentryAssigned', L, { name: assignee }) : ''].filter(Boolean)
  const reply = event === 'commented'
    ? { title: by ? appText('jiraCommentBy', L, { name: by }) : appText('jiraComment', L), details: replyLines(comment) }
    : event === 'transitioned'
      ? { title: statusWord ? appText('jiraMoved', L, { status: statusWord }) : appText('jiraUpdated', L), details: [] }
      : { title: appText('jiraNew', L, { key }), details: [] }
  return { event: {
    switch: event,
    delivery: `body:${sha(a.raw)}`, alsoDelivery: `issue:${key}:${sha(JSON.stringify([event, statusWord, title, assignee, comment]))}`, deliveryMinutes: 10,
    key: `issue:${key}`,
    // a comment leaves the status line as it is
    ...(statusWord && event !== 'commented' ? { state: statusWord.toLowerCase(), status } : {}),
    ...(t && !a.pin ? { pin: t.site } : {}),
    card: { kind: appText(event === 'created' ? 'jiraNew' : 'jiraItem', L, { key }), title, details, status, link, unverified: !a.signed && (details.length > 0 || !!by) },
    reply: { ...reply, unverified: !a.signed && !!by },
    ...(comment ? { extra: comment } : {}),
  } }
}

export const jira: PresetDef = { preset: 'jira', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, parse }
