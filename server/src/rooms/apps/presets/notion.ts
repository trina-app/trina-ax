// Notion database automations, action "Send webhook" (https://www.notion.com/help/webhook-actions): paid plans only,
// POST, the properties the person ticked (never page content), no signature (the token only). The envelope is
// documented by third parties only (live check, TC-1634): {source: {type: 'automation', automation_id, event_id,
// attempt}, data: {object: 'page', id, url, properties}}; `data` alone, or a page object at the top, are read too.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line, lines, safeLink } from '../card'
import type { Arrival, Parsed } from '../parse'
import { arr, get, jsonOf, num, obj, sha, str } from '../read'
import { appText } from '../text'
import { dateText, type PresetDef } from './common'

/** properties read, at most */
const PROPS_MAX = 25

/** Notion's link hosts: notion.so (and www.), notion.site and its subdomains. Anything else is not shown. */
const notionLink = (u: string) => {
  const s = safeLink(u)
  if (!s) return undefined
  const h = s.host.toLowerCase()
  return h === 'notion.so' || h === 'www.notion.so' || h === 'notion.site' || h.endsWith('.notion.site') ? s.url : undefined
}

const richText = (v: unknown) => arr(v, 100).map((t) => str(t, 'plain_text') || str(t, 'text', 'content')).join('')

/** One property's value as text, by its type (unknown types: their plain text if any, else nothing). */
function propText(p: Record<string, unknown>, a: Arrival): string {
  const L = a.locale
  const type = str(p, 'type')
  const v = p[type]
  const names = (x: unknown) => arr(x, 20).map((i) => line(str(i, 'name'), 80)).filter(Boolean).join(', ')
  switch (type) {
    case 'title': case 'rich_text': return richText(v)
    case 'number': { const n = num(p, 'number'); return n === null ? '' : String(n) }
    case 'select': case 'status': return str(v, 'name')
    case 'multi_select': return names(v)
    case 'people': return names(v)
    case 'created_by': case 'last_edited_by': return str(v, 'name')
    case 'date': {
      const s = str(v, 'start'), e = str(v, 'end')
      if (!s) return ''
      return e ? `${dateText(s, L, a.timeZone)} → ${dateText(e, L, a.timeZone)}` : dateText(s, L, a.timeZone)
    }
    case 'created_time': case 'last_edited_time': return typeof v === 'string' ? dateText(v, L, a.timeZone) : ''
    case 'checkbox': return v === true ? '✓' : v === false ? '–' : ''
    case 'url': case 'email': case 'phone_number': return typeof v === 'string' ? v : ''
    case 'relation': { const n = Array.isArray(v) ? v.length : 0; return n ? appText('notionLinked', L, { n }) : '' }
    case 'files': return arr(v, 20).map((f) => line(str(f, 'name'), 120)).filter(Boolean).join(', ')
    case 'unique_id': { const n = num(v, 'number'); return n === null ? '' : `${str(v, 'prefix') ? `${str(v, 'prefix')}-` : ''}${n}` }
    case 'formula': {
      const ft = str(v, 'type')
      if (ft === 'boolean') return get(v, 'boolean') === true ? '✓' : get(v, 'boolean') === false ? '–' : ''
      if (ft === 'date') return str(v, 'date', 'start') ? dateText(str(v, 'date', 'start'), L, a.timeZone) : ''
      return str(v, ft)
    }
    case 'rollup': { const rt = str(v, 'type'); return rt === 'number' ? str(v, 'number') : '' }
    default: return richText(get(p, 'plain_text')) || (typeof v === 'string' ? v : '')
  }
}

function parse(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  const page = obj(body.data) ?? body
  const id = line(str(page, 'id'), 100)
  const props = obj(page.properties)
  if (!id || !props) return { refuse: 'format' }
  const L = a.locale
  let title = ''
  let status = ''
  const rest: string[] = []
  for (const [name, raw] of Object.entries(props).slice(0, PROPS_MAX)) {
    const p = obj(raw)
    if (!p) continue
    const value = line(propText(p, a), 300)
    const label = line(name, 80)
    if (str(p, 'type') === 'title') { if (!title) title = value; continue }
    if (!status && (str(p, 'type') === 'status' || /^(status|상태)$/i.test(name.trim()))) { status = value; continue }
    if (value) rest.push(`${label}: ${value}`)
  }
  const eventId = line(str(body, 'source', 'event_id'), 200)
  const statusLine = status ? appText('status', L, { status }) : undefined
  return { event: {
    switch: 'entry',
    // a retry of the same run has the same event id (its `attempt` grows, so it is not part of the key)
    delivery: eventId ? `notion:${eventId}` : sha(a.raw), ...(eventId ? {} : { deliveryMinutes: 10 }),
    key: `page:${id}`,
    card: { kind: 'Notion', title: title || '…', details: rest.slice(0, 3), status: statusLine, link: notionLink(str(page, 'url')) ?? notionLink(str(page, 'public_url')) },
    reply: { title: appText('notionUpdated', L), details: [title, ...(statusLine ? [statusLine] : [])].filter(Boolean).slice(0, 2) },
    ...(status ? { state: status, status: statusLine } : {}),
    ...(rest.length > 3 ? { extra: lines(rest.join('\n')) } : {}),
  } }
}

export const notion: PresetDef = { preset: 'notion', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, parse }
