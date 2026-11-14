// Zendesk triggers → "Notify webhook" with the JSON body Trina gives (shared roomAppZendeskBody: Zendesk's
// placeholders; https://support.zendesk.com/hc/en-us/articles/4408839108378). Signed (optional)
// X-Zendesk-Webhook-Signature, base64 HMAC of timestamp + raw body (signatures.ts zendesk). Zendesk sends no delivery
// id: dedupe on the body's hash (a retry has the same body) and on ticket id + status + title + latest comment (two
// triggers sending the same change post once), both for 10 minutes. One card per ticket (`ticket:<id>`); a solved or closed ticket opened again
// shows in the room too.
//
// Zendesk does not JSON-escape placeholder values (security review of #854): a comment `x","id":"123",...` would make
// valid JSON whose later duplicate keys win (another ticket's thread, its status, a link to another tenant). So:
//   - the Copy body passes everything an outsider writes through Liquid's `escape` (title, requester, assignee,
//     comment); those fields are HTML-entity-decoded here;
//   - a body whose raw text names any template key more than once is refused (also in the tolerant read);
//   - the link is built only as https://<sub>.zendesk.com/agent/tickets/<the same id>, and the subdomain is pinned to
//     the app on first sight (room_apps.preset_pin): another one gets no link.
// A body whose JSON is broken anyway (an older, unescaped copy of the body) is read key by key between the known keys.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line, lines, safeLink } from '../card'
import type { Arrival, Parsed } from '../parse'
import { jsonOf, obj, sha, str, textOf } from '../read'
import { appText } from '../text'
import type { PresetDef } from './common'

const KEYS = ['trina', 'event', 'id', 'title', 'status', 'priority', 'requester', 'assignee', 'url', 'update'] as const
type Body = Partial<Record<(typeof KEYS)[number], string>>

/** A template key named more than once anywhere in the raw text: an injected key (refused). */
export function zendeskDuplicateKey(text: string): boolean {
  // a key may be written with \uXXXX escapes ("id" is "id"): checked on a copy with them decoded (an escaped
  // backslash before a "u" decodes too: stricter, never looser)
  const plain = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
  return KEYS.some((k) => (plain.match(new RegExp(`"${k}"\\s*:`, 'g')) ?? []).length > 1)
}

/** The HTML entities Liquid's `escape` writes, decoded (&amp; last, so "&amp;quot;" stays "&quot;"). */
export const unescapeHtml = (s: string) => s
  .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The template's flat body when it is not valid JSON: each known key's value runs to the next known key. Needs the
 * "trina": "zendesk" mark (only our template is read this way) and every key at most once. */
export function tolerantZendesk(text: string): Body | null {
  if (text.length > ROOM_APP_BODY_MAX || !/"trina"\s*:\s*"zendesk"/.test(text) || zendeskDuplicateKey(text)) return null
  const at: { key: (typeof KEYS)[number]; start: number; end: number }[] = []
  for (const key of KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
    if (m) at.push({ key, start: m.index, end: m.index + m[0].length })
  }
  at.sort((x, y) => x.start - y.start)
  const out: Body = {}
  for (let i = 0; i < at.length; i++) {
    const cur = at[i]!, next = at[i + 1]
    let v = text.slice(cur.end, next ? next.start : text.length)
    v = next ? v.replace(/"\s*,\s*$/, '') : v.replace(/"\s*}\s*$/, '')
    out[cur.key] = v.replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return out
}

const CLOSED = ['solved', 'closed'] as const

/** The ticket's link: exactly https://<sub>.zendesk.com/agent/tickets/<id> for this ticket ({{ticket.url}} has no
 * scheme), and its subdomain; else none. */
function ticketLink(raw: string, id: string): { url: string; sub: string } | null {
  const u = safeLink(/^https:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`)
  if (!u) return null
  const m = /^([a-z0-9][a-z0-9-]{0,62})\.zendesk\.com$/.exec(u.host.toLowerCase())
  let path = ''
  try { const x = new URL(u.url); if (x.search || x.hash || x.port) return null; path = x.pathname } catch { return null }
  if (!m || path !== `/agent/tickets/${id}`) return null
  return { url: `https://${m[1]}.zendesk.com/agent/tickets/${id}`, sub: m[1]! }
}

function parse(a: Arrival): Parsed {
  const text = textOf(a.raw)
  if (zendeskDuplicateKey(text)) return { refuse: 'format' }
  const j = obj(jsonOf(a.raw))
  const b: Body = j ? Object.fromEntries(KEYS.map((k) => [k, str(j, k)])) : tolerantZendesk(text) ?? {}
  const id = line(b.id ?? '', 20)
  if (!/^\d{1,20}$/.test(id)) return { refuse: 'format' }
  const L = a.locale
  // what an outsider wrote arrives HTML-escaped (the template's `escape`)
  const title = line(unescapeHtml(b.title ?? ''), 200) || `#${id}`
  const statusWord = line(b.status ?? '', 40)
  const state = statusWord.toLowerCase()
  const priority = line(b.priority ?? '', 40)
  const requester = line(unescapeHtml(b.requester ?? ''), 80)
  const assignee = line(unescapeHtml(b.assignee ?? ''), 80)
  const update = lines(unescapeHtml(b.update ?? ''), 2000)
  // the link: this ticket's page, on the subdomain pinned to the app (pinned on first sight)
  const t = ticketLink((b.url ?? '').trim(), id)
  const link = t && (!a.pin || a.pin === t.sub) ? t.url : undefined
  const status = statusWord ? appText('status', L, { status: statusWord }) : undefined
  const details = [requester ? appText('fromName', L, { name: requester }) : '', assignee ? appText('sentryAssigned', L, { name: assignee }) : ''].filter(Boolean)
  const updated = (b.event ?? '').trim().toLowerCase() === 'updated'
  return { event: {
    switch: updated ? 'updated' : 'new_ticket',
    // the same change (two triggers sending it): everything the card shows, not which trigger
    delivery: `body:${sha(a.raw)}`, alsoDelivery: `ticket:${id}:${sha(JSON.stringify([state, title, update, assignee, priority]))}`, deliveryMinutes: 10,
    key: `ticket:${id}`, ...(state ? { state, status } : {}), backFrom: CLOSED,
    ...(t && !a.pin ? { pin: t.sub } : {}),
    card: { kind: [appText('newTicket', L, { id }), priority].filter(Boolean).join(' · '), title, details, status, link, unverified: !a.signed && details.length > 0 },
    reply: { title: appText('ticketUpdated', L, { id }), details: [status ?? '', update.split('\n')[0] ?? ''].filter(Boolean).slice(0, 2) },
    ...(update ? { extra: update } : {}),
  } }
}

export const zendesk: PresetDef = { preset: 'zendesk', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'zendesk' }, parse }
