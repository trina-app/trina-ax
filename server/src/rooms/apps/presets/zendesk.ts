// Zendesk triggers → "Notify webhook" with the JSON body Trina gives (shared roomAppZendeskBody: Zendesk's
// placeholders; https://support.zendesk.com/hc/en-us/articles/4408839108378). Signed (optional)
// X-Zendesk-Webhook-Signature, base64 HMAC of timestamp + raw body (signatures.ts zendesk). Zendesk sends no delivery
// id: dedupe on the body's hash (a retry has the same body) and on ticket id + status + title + latest comment (two
// triggers sending the same change post once), both for 10 minutes. One card per ticket (`ticket:<id>`); a solved or closed ticket opened again
// shows in the room too.
//
// Placeholders are text inside quotes: if Zendesk does not escape a quote in a title, the JSON breaks. The tolerant
// read then takes this body's flat shape key by key (between the known keys; live check whether it is needed).
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line, lines, safeLink } from '../card'
import type { Arrival, Parsed } from '../parse'
import { jsonOf, obj, sha, str, textOf } from '../read'
import { appText } from '../text'
import type { PresetDef } from './common'

const KEYS = ['trina', 'event', 'id', 'title', 'status', 'priority', 'requester', 'assignee', 'url', 'update'] as const
type Body = Partial<Record<(typeof KEYS)[number], string>>

/** The template's flat body when it is not valid JSON: each known key's value runs to the next known key. Needs the
 * "trina": "zendesk" mark (only our template is read this way). */
export function tolerantZendesk(text: string): Body | null {
  if (text.length > ROOM_APP_BODY_MAX || !/"trina"\s*:\s*"zendesk"/.test(text)) return null
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

function parse(a: Arrival): Parsed {
  const text = textOf(a.raw)
  const j = obj(jsonOf(a.raw))
  const b: Body = j ? Object.fromEntries(KEYS.map((k) => [k, str(j, k)])) : tolerantZendesk(text) ?? {}
  const id = line(b.id ?? '', 20)
  if (!/^\d{1,20}$/.test(id)) return { refuse: 'format' }
  const L = a.locale
  const title = line(b.title ?? '', 200) || `#${id}`
  const statusWord = line(b.status ?? '', 40)
  const state = statusWord.toLowerCase()
  const priority = line(b.priority ?? '', 40)
  const requester = line(b.requester ?? '', 80)
  const assignee = line(b.assignee ?? '', 80)
  const update = lines(b.update ?? '', 2000)
  // {{ticket.url}} has no scheme: https is added; only a Zendesk host is a link
  const rawUrl = (b.url ?? '').trim()
  const u = safeLink(/^https:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl.replace(/^\/+/, '')}`)
  const link = u && u.host.toLowerCase().endsWith('.zendesk.com') ? u.url : undefined
  const status = statusWord ? appText('status', L, { status: statusWord }) : undefined
  const details = [requester ? appText('fromName', L, { name: requester }) : '', assignee ? appText('sentryAssigned', L, { name: assignee }) : ''].filter(Boolean)
  const updated = (b.event ?? '').trim().toLowerCase() === 'updated'
  return { event: {
    switch: updated ? 'updated' : 'new_ticket',
    // the same change (two triggers sending it): the ticket, its status, title and latest comment, not which trigger
    delivery: `body:${sha(a.raw)}`, alsoDelivery: `ticket:${id}:${sha(JSON.stringify([state, title, update]))}`, deliveryMinutes: 10,
    key: `ticket:${id}`, ...(state ? { state, status } : {}), backFrom: CLOSED,
    card: { kind: [appText('newTicket', L, { id }), priority].filter(Boolean).join(' · '), title, details, status, link, unverified: !a.signed && details.length > 0 },
    reply: { title: appText('ticketUpdated', L, { id }), details: [status ?? '', update.split('\n')[0] ?? ''].filter(Boolean).slice(0, 2) },
    ...(update ? { extra: update } : {}),
  } }
}

export const zendesk: PresetDef = { preset: 'zendesk', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'zendesk' }, parse }
