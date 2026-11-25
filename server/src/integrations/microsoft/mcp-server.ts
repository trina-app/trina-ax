// The Microsoft 365 connection's MCP server, inside this process (docs/decisions/20261125-m365-connector.md): the
// connection's MCP client (connections/mcp.ts) sends its requests here instead of over the network
// (connections/service.ts client), and each tool calls Microsoft Graph (graph.ts) with the access token the request
// carries. It keeps nothing between requests. Runs wherever the server runs (no child process).
//
// Reads are marked readOnlyHint; every change (a draft, a send, an event, an upload, a Teams message) is a change, so
// the connection code asks on a card unless the person chose Always allow, exactly as for any connection. A request
// without a token, or one Graph refuses (401), answers 401: the connection code refreshes once, then asks to sign in
// again. Any other Graph error is the tool's error, in plain words.
import type { NetOptions, NetRequest, NetResponse } from '../connections/net'
import { MCP_PROTOCOL } from '../connections/mcp'
import { Graph, GraphError, graphErrorText, GraphUnauthorized, isNetError } from './graph'

/** reads a downloaded file as text (files/extract.ts with this server's converters), by its name's extension */
export type ExtractText = (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string>
export interface MicrosoftMcpDeps { net: NetOptions; extract?: ExtractText }

/** the longest text one tool answer gives (a mail body, a file's text); past it the answer says it was cut */
export const MAX_TEXT = 100_000
/** the largest file files_read downloads */
export const FILE_MAX_BYTES = 32 * 1024 * 1024
/** the largest upload in one request (Graph's simple upload limit is 250 MB; text from a chat is far smaller) */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024

const INSTRUCTIONS = [
  'Microsoft 365 for the signed-in account: Outlook mail, Outlook calendar, OneDrive and SharePoint files, Teams chats.',
  'mail_search takes Microsoft Search words (KQL): plain words, from:, to:, subject:, hasattachments:true, received>=2026-11-01. Leave the query empty to list the newest mail of a folder.',
  'Read before you answer about a mail, a file or a chat: use the id from a search or list result. Times are ISO 8601; calendar_events and calendar_create_event take an IANA time zone (e.g. Asia/Seoul).',
  'Sending mail, creating events and posting in Teams reach other people: say what you will send. mail_draft writes a draft the user can check in Outlook first.',
].join('\n')

type Args = Record<string, unknown>
interface Tool {
  name: string; title: string; description: string; readOnly: boolean
  inputSchema: Record<string, unknown>
  run: (g: Graph, a: Args, deps: MicrosoftMcpDeps, signal?: AbortSignal) => Promise<unknown>
}

class ArgError extends Error { name = 'ArgError' }
const str = (a: Args, k: string, o: { max?: number; required?: boolean } = {}): string | undefined => {
  const v = a[k]
  if (v === undefined || v === null || v === '') { if (o.required) throw new ArgError(`${k} is required`); return undefined }
  if (typeof v !== 'string') throw new ArgError(`${k} must be text`)
  const t = v.trim()
  if (o.max && t.length > o.max) throw new ArgError(`${k} is longer than ${o.max} characters`)
  if (o.required && !t) throw new ArgError(`${k} is required`)
  return t
}
const int = (a: Args, k: string, def: number, max: number): number => {
  const v = a[k]
  if (v === undefined || v === null) return def
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ArgError(`${k} must be a whole number from 1`)
  return Math.min(n, max)
}
const bool = (a: Args, k: string): boolean => a[k] === true || a[k] === 'true'
/** e-mail addresses from an array or a comma-separated text */
const ADDRESS = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/
function addresses(a: Args, k: string): string[] {
  const v = a[k]
  if (v === undefined || v === null || v === '') return []
  const list = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : null)
  if (!list) throw new ArgError(`${k} must be a list of e-mail addresses`)
  const out = list.map((x) => (typeof x === 'string' ? x.trim().replace(/^.*<([^>]+)>\s*$/, '$1') : '')).filter(Boolean)
  for (const x of out) if (!ADDRESS.test(x)) throw new ArgError(`${k}: "${x.slice(0, 80)}" is not an e-mail address`)
  if (out.length > 100) throw new ArgError(`${k}: at most 100 addresses`)
  return out
}
/** a Graph id as Graph writes them (base64-like, with - _ = and !, :, . in some) */
const id = (a: Args, k: string, o: { required?: boolean } = { required: true }): string | undefined => {
  const v = str(a, k, { max: 1024, required: o.required })
  if (v !== undefined && (!/^[A-Za-z0-9!:._=+/@-]{1,1024}$/.test(v) || /^\.{1,2}$/.test(v) || v.includes('..'))) throw new ArgError(`${k} is not an id from a search or list result`)
  return v
}
const seg = (v: string) => encodeURIComponent(v)
const isoTime = (a: Args, k: string, required = true): string | undefined => {
  const v = str(a, k, { max: 40, required })
  if (v !== undefined && (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v) || Number.isNaN(Date.parse(v.length === 10 ? v + 'T00:00:00Z' : v)))) throw new ArgError(`${k} must be an ISO 8601 date or time (2026-11-25T09:00:00)`)
  return v
}
const TZ = /^[A-Za-z][A-Za-z0-9_+\-/ ]{0,63}$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/
/** A time as the calendar query needs it: with an offset as written, else read in `tz` (an IANA zone) and given in UTC.
 * A date alone is that day's start in `tz`. */
export function zonedToUtc(v: string, tz: string): string {
  if (HAS_OFFSET.test(v)) return new Date(Date.parse(v)).toISOString()
  const local = DATE_ONLY.test(v) ? `${v}T00:00:00` : v
  const asUtc = Date.parse(`${local}Z`)
  if (tz === 'UTC') return new Date(asUtc).toISOString()
  let fmt: Intl.DateTimeFormat
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { throw new ArgError('time_zone must be an IANA time zone such as Asia/Seoul') }
  // the zone's offset at a moment: what its wall clock shows there, read as UTC, minus the moment
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000
  }
  let ms = asUtc - offsetAt(asUtc)
  ms = asUtc - offsetAt(ms)
  return new Date(ms).toISOString()
}
const timeZone = (a: Args): string => { const v = str(a, 'time_zone', { max: 64 }) ?? 'UTC'; if (!TZ.test(v)) throw new ArgError('time_zone must be a time zone name such as Asia/Seoul'); return v }

/** text cut to MAX_TEXT, saying so */
const cut = (t: string, max = MAX_TEXT) => (t.length > max ? `${t.slice(0, max)}\n(cut at ${max} of ${t.length} characters)` : t)
/** Teams' HTML message bodies as plain text */
export const plainText = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]{0,1000}>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()

const who = (r: any) => (r?.emailAddress ? (r.emailAddress.name && r.emailAddress.name !== r.emailAddress.address ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address) : undefined)
const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }))
const mailSummary = (m: any) => ({
  id: m.id, subject: m.subject, from: who(m.from), to: (m.toRecipients ?? []).map(who), received: m.receivedDateTime,
  preview: typeof m.bodyPreview === 'string' ? m.bodyPreview.slice(0, 300) : undefined, unread: m.isRead === false ? true : undefined,
  hasAttachments: m.hasAttachments || undefined, webLink: m.webLink,
})
const MAIL_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink'
const FOLDERS = new Set(['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'])
const mailMessage = (a: Args) => {
  const to = addresses(a, 'to'), cc = addresses(a, 'cc'), bcc = addresses(a, 'bcc')
  return {
    to, message: {
      subject: str(a, 'subject', { max: 1000 }) ?? '',
      body: { contentType: bool(a, 'html') ? 'HTML' : 'Text', content: str(a, 'body', { max: 1_000_000 }) ?? '' },
      toRecipients: recipients(to), ccRecipients: recipients(cc), bccRecipients: recipients(bcc),
    },
  }
}
const eventSummary = (e: any) => ({
  id: e.id, subject: e.subject, start: e.start, end: e.end, location: e.location?.displayName || undefined,
  organizer: who(e.organizer), attendees: (e.attendees ?? []).map(who).filter(Boolean),
  online: e.onlineMeeting?.joinUrl ?? undefined, allDay: e.isAllDay || undefined, webLink: e.webLink,
})
const fileSummary = (f: any) => ({
  id: f.id, driveId: f.parentReference?.driveId, name: f.name, folder: f.folder ? true : undefined, size: f.size,
  modified: f.lastModifiedDateTime, path: f.parentReference?.path?.replace(/^\/drive(s\/[^/]+)?\/root:?/, '') || undefined, webUrl: f.webUrl,
})

const SEARCH_TOP = 25
const TOOLS: Tool[] = [
  {
    name: 'mail_search', title: 'Search mail', readOnly: true,
    description: 'Find Outlook mail. query: Microsoft Search words (from:, to:, subject:, hasattachments:true, received>=2026-11-01, or plain words); empty lists the newest mail of the folder. Answers ids to read with mail_read.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 500 }, folder: { type: 'string', enum: [...FOLDERS], description: 'a folder when the query is empty (default inbox)' }, top: { type: 'integer', minimum: 1, maximum: 50 } } },
    async run(g, a) {
      const q = str(a, 'query', { max: 500 }), top = int(a, 'top', SEARCH_TOP, 50)
      const folder = str(a, 'folder') ?? 'inbox'
      if (!FOLDERS.has(folder)) throw new ArgError(`folder must be one of ${[...FOLDERS].join(', ')}`)
      const r = q
        ? await g.call({ path: '/me/messages', query: { search: `"${q.replace(/["\\]/g, ' ')}"`, top: top, select: MAIL_FIELDS } })
        : await g.call({ path: `/me/mailFolders/${folder}/messages`, query: { top: top, orderby: 'receivedDateTime desc', select: MAIL_FIELDS } })
      const items = (r?.value ?? []).map(mailSummary)
      return { messages: items, ...(r?.['@odata.nextLink'] ? { more: true } : {}) }
    },
  },
  {
    name: 'mail_read', title: 'Read mail', readOnly: true,
    description: 'Read one Outlook mail by its id (from mail_search): sender, recipients, the whole body as text, and its attachments listed by name and size.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(g, a) {
      const m = await g.call({ path: `/me/messages/${seg(id(a, 'id')!)}`, query: { select: `${MAIL_FIELDS},ccRecipients,body,conversationId` }, headers: [['Prefer', 'outlook.body-content-type="text"']] })
      const out: Record<string, unknown> = { ...mailSummary(m), preview: undefined, cc: (m?.ccRecipients ?? []).map(who), conversationId: m?.conversationId, body: cut(String(m?.body?.content ?? '')) }
      if (m?.hasAttachments) {
        const at = await g.call({ path: `/me/messages/${seg(m.id)}/attachments`, query: { select: 'name,size,contentType' } })
        out.attachments = (at?.value ?? []).map((x: any) => ({ name: x.name, size: x.size, type: x.contentType }))
      }
      return out
    },
  },
  {
    name: 'mail_draft', title: 'Write mail draft', readOnly: false,
    description: 'Write an Outlook draft the user can check and send later (or send with mail_send_draft). reply_to: a mail id to answer (the draft replies to its sender, or everyone with reply_all; to, cc and bcc add people; subject replaces the reply\'s "RE:" subject). body is plain text unless html is true.',
    inputSchema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' }, html: { type: 'boolean' }, reply_to: { type: 'string' }, reply_all: { type: 'boolean' } } },
    async run(g, a) {
      const replyTo = id(a, 'reply_to', { required: false })
      let d: any
      if (replyTo) {
        d = await g.call({ method: 'POST', path: `/me/messages/${seg(replyTo)}/${bool(a, 'reply_all') ? 'createReplyAll' : 'createReply'}`, json: { comment: str(a, 'body', { max: 1_000_000 }) ?? '' } })
        // more people: added to the ones the reply has (a PATCH replaces the whole list)
        const extra = { to: addresses(a, 'to'), cc: addresses(a, 'cc'), bcc: addresses(a, 'bcc') }
        const subject = str(a, 'subject', { max: 1000 })
        const merged = (have: any[] | undefined, more: string[]) => [...(have ?? []), ...recipients(more.filter((x) => !(have ?? []).some((r: any) => r?.emailAddress?.address?.toLowerCase() === x.toLowerCase())))]
        const patch = {
          ...(extra.to.length ? { toRecipients: merged(d?.toRecipients, extra.to) } : {}), ...(extra.cc.length ? { ccRecipients: merged(d?.ccRecipients, extra.cc) } : {}),
          ...(extra.bcc.length ? { bccRecipients: merged(d?.bccRecipients, extra.bcc) } : {}), ...(subject ? { subject } : {}),
        }
        if (Object.keys(patch).length) d = await g.call({ method: 'PATCH', path: `/me/messages/${seg(d.id)}`, json: patch })
      } else {
        const { message } = mailMessage(a)
        d = await g.call({ method: 'POST', path: '/me/messages', json: message })
      }
      return { draft: { id: d?.id, subject: d?.subject, to: (d?.toRecipients ?? []).map(who), webLink: d?.webLink }, note: 'Saved in Drafts; nothing was sent.' }
    },
  },
  {
    name: 'mail_send_draft', title: 'Send mail draft', readOnly: false,
    description: 'Send an Outlook draft by its id (from mail_draft or mail_search in drafts).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(g, a) {
      const d = id(a, 'id')!
      const m = await g.call({ path: `/me/messages/${seg(d)}`, query: { select: 'id,subject,toRecipients,ccRecipients,bccRecipients,isDraft' } })
      if (m && m.isDraft === false) throw new ArgError('that mail is not a draft')
      await g.call({ method: 'POST', path: `/me/messages/${seg(d)}/send` })
      return { sent: true, subject: m?.subject, to: (m?.toRecipients ?? []).map(who), cc: (m?.ccRecipients ?? []).map(who) }
    },
  },
  {
    name: 'mail_send', title: 'Send mail', readOnly: false,
    description: 'Send an Outlook mail now (kept in Sent Items). reply_to: a mail id to answer (to its sender, or everyone with reply_all; to, when given, are the recipients of the reply instead; cc, bcc and subject go with it). body is plain text unless html is true.',
    inputSchema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' }, html: { type: 'boolean' }, reply_to: { type: 'string' }, reply_all: { type: 'boolean' } } },
    async run(g, a) {
      const replyTo = id(a, 'reply_to', { required: false })
      if (replyTo) {
        // everything the card showed goes with the reply: to (the recipients instead of the sender's), cc, bcc, subject
        const to = addresses(a, 'to'), cc = addresses(a, 'cc'), bcc = addresses(a, 'bcc'), subject = str(a, 'subject', { max: 1000 })
        const message = { ...(to.length ? { toRecipients: recipients(to) } : {}), ...(cc.length ? { ccRecipients: recipients(cc) } : {}), ...(bcc.length ? { bccRecipients: recipients(bcc) } : {}), ...(subject ? { subject } : {}) }
        await g.call({ method: 'POST', path: `/me/messages/${seg(replyTo)}/${bool(a, 'reply_all') ? 'replyAll' : 'reply'}`, json: { comment: str(a, 'body', { max: 1_000_000 }) ?? '', ...(Object.keys(message).length ? { message } : {}) } })
        return { sent: true, replyTo, ...(to.length ? { to } : {}), ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) }
      }
      const { to, message } = mailMessage(a)
      if (!to.length) throw new ArgError('to needs at least one address')
      await g.call({ method: 'POST', path: '/me/sendMail', json: { message, saveToSentItems: true } })
      return { sent: true, subject: message.subject, to }
    },
  },
  {
    name: 'calendar_events', title: 'List calendar events', readOnly: true,
    description: 'Events of the Outlook calendar between start and end (ISO 8601 dates or times; without an offset they are local times in time_zone; default: the next 7 days). time_zone: IANA, e.g. Asia/Seoul (default UTC); answers are in it too.',
    inputSchema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, time_zone: { type: 'string' }, top: { type: 'integer', minimum: 1, maximum: 100 } } },
    async run(g, a) {
      // a time without an offset is the user's local time in time_zone (Graph would read it as UTC)
      const tz = timeZone(a)
      const s0 = isoTime(a, 'start', false), e0 = isoTime(a, 'end', false)
      const start = s0 ? zonedToUtc(s0, tz) : new Date().toISOString()
      const end = e0 ? zonedToUtc(e0, tz) : new Date(Date.parse(start) + 7 * 86_400_000).toISOString()
      const r = await g.call({
        path: '/me/calendarView', headers: [['Prefer', `outlook.timezone="${tz}"`]],
        query: { startDateTime: start, endDateTime: end, top: int(a, 'top', 50, 100), orderby: 'start/dateTime', select: 'id,subject,start,end,location,organizer,attendees,onlineMeeting,isAllDay,webLink' },
      })
      return { events: (r?.value ?? []).map(eventSummary), ...(r?.['@odata.nextLink'] ? { more: true } : {}) }
    },
  },
  {
    name: 'calendar_create_event', title: 'Create calendar event', readOnly: false,
    description: 'Create an Outlook calendar event (attendees get an invitation). start and end: local times like 2026-11-26T14:00:00 in time_zone (IANA, e.g. Asia/Seoul); dates alone (2026-11-26) make an all-day event, end being the day after the last day (or left out for one day). teams_meeting: add a Teams meeting link.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, time_zone: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, location: { type: 'string' }, body: { type: 'string' }, teams_meeting: { type: 'boolean' } }, required: ['subject', 'start'] },
    async run(g, a) {
      const tz = timeZone(a), attendees = addresses(a, 'attendees')
      const start = isoTime(a, 'start')!, endIn = isoTime(a, 'end', false)
      const allDay = DATE_ONLY.test(start)
      let end: string
      if (allDay) {
        if (endIn !== undefined && !DATE_ONLY.test(endIn)) throw new ArgError('an all-day event takes dates for both start and end (2026-11-26)')
        end = endIn ?? new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
        if (end <= start) throw new ArgError('end must be after start (for an all-day event, the day after the last day)')
      } else {
        if (endIn === undefined) throw new ArgError('end is required for an event with a time')
        if (DATE_ONLY.test(endIn)) throw new ArgError('give end as a time like start (2026-11-26T15:00:00)')
        end = endIn
      }
      const at = (v: string) => (allDay ? `${v}T00:00:00` : v)
      const e = await g.call({
        method: 'POST', path: '/me/events', json: {
          subject: str(a, 'subject', { max: 255, required: true }), start: { dateTime: at(start), timeZone: tz }, end: { dateTime: at(end), timeZone: tz },
          ...(allDay ? { isAllDay: true } : {}),
          ...(str(a, 'location', { max: 255 }) ? { location: { displayName: str(a, 'location') } } : {}),
          ...(str(a, 'body', { max: 100_000 }) ? { body: { contentType: 'Text', content: str(a, 'body') } } : {}),
          attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
          ...(bool(a, 'teams_meeting') ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
        },
      })
      return { event: eventSummary(e) }
    },
  },
  {
    name: 'files_search', title: 'Search files', readOnly: true,
    description: 'Find files in OneDrive and SharePoint (the user\'s own and those shared with them) by words in their name or content. Answers ids and driveIds to read with files_read.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 500 }, top: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
    async run(g, a) {
      const q = str(a, 'query', { max: 500, required: true })!, top = int(a, 'top', SEARCH_TOP, 50)
      try {
        const r = await g.call({ method: 'POST', path: '/search/query', json: { requests: [{ entityTypes: ['driveItem'], query: { queryString: q }, from: 0, size: top }] } })
        const hits = (r?.value?.[0]?.hitsContainers ?? []).flatMap((c: any) => c.hits ?? [])
        return { files: hits.map((h: any) => ({ ...fileSummary(h.resource ?? {}), match: typeof h.summary === 'string' ? plainText(h.summary).slice(0, 300) : undefined })) }
      } catch (e) {
        // an account whose organization has no Microsoft Search for it: its own OneDrive only
        if (!(e instanceof GraphError) || e.status !== 400) throw e
        // path characters (/ \ ? # %) would change the address even encoded (some servers decode %2F): words only
        const words = q.replace(/[\/\\?#%]/g, ' ').replace(/\s+/g, ' ').trim() || 'a'
        const r = await g.call({ path: `/me/drive/root/search(q='${encodeURIComponent(words.replace(/'/g, "''"))}')`, query: { top: top } })
        return { files: (r?.value ?? []).map(fileSummary), note: 'Only the user\'s own OneDrive was searched.' }
      }
    },
  },
  {
    name: 'files_read', title: 'Read file', readOnly: true,
    description: 'Read a OneDrive or SharePoint file as text (Word, Excel, PowerPoint, PDF, Hangul, text) by its id and driveId from files_search, or a path in the user\'s own OneDrive ("Documents/plan.docx"). Long text: read on with offset.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, drive_id: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } } },
    async run(g, a, deps, signal) {
      const item = await g.call(itemPath(a))
      if (!item) throw new GraphError(404, 'itemNotFound', 'no such file')
      if (item.folder) {
        const drive = item.parentReference?.driveId
        const kids = await g.call({ path: `${drive ? `/drives/${seg(drive)}` : '/me/drive'}/items/${seg(item.id)}/children`, query: { top: 100 } })
        return { folder: fileSummary(item), children: (kids?.value ?? []).map(fileSummary) }
      }
      const url = item['@microsoft.graph.downloadUrl']
      if (typeof url !== 'string') throw new GraphError(403, 'notDownloadable', 'this file cannot be downloaded')
      if (typeof item.size === 'number' && item.size > FILE_MAX_BYTES) throw new GraphError(413, 'tooLarge', `the file is larger than ${FILE_MAX_BYTES / 1024 / 1024} MB; open it in OneDrive`)
      const bytes = await g.download(url, FILE_MAX_BYTES)
      const name = String(item.name ?? 'file')
      let text: string
      if (TEXT_EXT.test(name)) text = bytes.toString('utf8')
      else if (deps.extract) {
        try { text = await deps.extract(name, bytes, signal) } catch { throw new GraphError(415, 'unreadable', 'this kind of file could not be read as text') }
      } else throw new GraphError(415, 'unreadable', 'this kind of file cannot be read here')
      const o = a.offset === undefined || a.offset === null ? 0 : Number(a.offset)
      if (!Number.isInteger(o) || o < 0) throw new ArgError('offset must be a whole number from 0')
      const offset = Math.min(o, text.length)
      const part = text.slice(offset, offset + MAX_TEXT)
      const more = offset + MAX_TEXT < text.length
      return { file: fileSummary(item), text: part, ...(more || offset ? { offset, totalChars: text.length } : {}), ...(more ? { next: `call files_read again with offset ${offset + MAX_TEXT} to read on` } : {}) }
    },
  },
  {
    name: 'files_upload', title: 'Upload file', readOnly: false,
    description: 'Save text as a file in the user\'s OneDrive (or a SharePoint drive with drive_id): folder path and file name, e.g. folder "Documents/Reports", name "summary.md". A file of that name is kept and the new one gets a new name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, folder: { type: 'string' }, content: { type: 'string' }, drive_id: { type: 'string' } }, required: ['name', 'content'] },
    async run(g, a) {
      const name = str(a, 'name', { max: 255, required: true })!
      if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new ArgError('name must be a file name without / \\ : * ? " < > |')
      const folder = (str(a, 'folder', { max: 1000 }) ?? '').replace(/^\/+|\/+$/g, '')
      if (folder.split('/').some((p) => p === '..' || p === '.' || /[\\:*?"<>|\u0000-\u001f]/.test(p))) throw new ArgError('folder must be a path like Documents/Reports')
      const content = typeof a.content === 'string' ? a.content : ''
      const data = Buffer.from(content, 'utf8')
      if (data.length > UPLOAD_MAX_BYTES) throw new ArgError(`content is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`)
      const drive = id(a, 'drive_id', { required: false })
      const at = [...(folder ? folder.split('/') : []), name].map(seg).join('/')
      const f = await g.call({ method: 'PUT', path: `${drive ? `/drives/${seg(drive)}` : '/me/drive'}/root:/${at}:/content`, query: { '@microsoft.graph.conflictBehavior': 'rename' }, bytes: { data, type: 'text/plain; charset=utf-8' } })
      return { file: fileSummary(f ?? {}) }
    },
  },
  {
    name: 'teams_chats', title: 'List Teams chats', readOnly: true,
    description: 'The user\'s Microsoft Teams chats (one-on-one, group and meeting chats), newest first, with members and the last message. Answers chat ids for teams_read_chat and teams_send.',
    inputSchema: { type: 'object', properties: { top: { type: 'integer', minimum: 1, maximum: 50 } } },
    async run(g, a) {
      const top = int(a, 'top', 25, 50)
      let r: any
      try { r = await g.call({ path: '/me/chats', query: { top, expand: 'members,lastMessagePreview', orderby: 'lastMessagePreview/createdDateTime desc' } }) } catch (e) {
        // a tenant or version that takes one expansion at a time: the last messages, newest first, without the members
        if (!(e instanceof GraphError) || e.status !== 400) throw e
        r = await g.call({ path: '/me/chats', query: { top, expand: 'lastMessagePreview', orderby: 'lastMessagePreview/createdDateTime desc' } })
      }
      return {
        chats: (r?.value ?? []).map((c: any) => ({
          id: c.id, topic: c.topic ?? undefined, type: c.chatType, members: (c.members ?? []).map((m: any) => m.displayName).filter(Boolean).slice(0, 20),
          last: c.lastMessagePreview ? { from: c.lastMessagePreview.from?.user?.displayName, at: c.lastMessagePreview.createdDateTime, text: plainText(String(c.lastMessagePreview.body?.content ?? '')).slice(0, 200) } : undefined,
          webUrl: c.webUrl,
        })),
      }
    },
  },
  {
    name: 'teams_read_chat', title: 'Read Teams chat', readOnly: true,
    description: 'The latest messages of one Teams chat by its id (from teams_chats), newest first.',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, top: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['chat_id'] },
    async run(g, a) {
      const r = await g.call({ path: `/me/chats/${seg(id(a, 'chat_id')!)}/messages`, query: { top: int(a, 'top', 30, 50), orderby: 'createdDateTime desc' } })
      return {
        messages: (r?.value ?? []).filter((m: any) => m.messageType === 'message' || !m.messageType).map((m: any) => ({
          from: m.from?.user?.displayName ?? m.from?.application?.displayName, at: m.createdDateTime, text: cut(plainText(String(m.body?.content ?? '')), 4000),
          ...(m.attachments?.length ? { attachments: m.attachments.map((x: any) => x.name).filter(Boolean) } : {}),
        })),
      }
    },
  },
  {
    name: 'teams_send', title: 'Send Teams message', readOnly: false,
    description: 'Post a message in one Teams chat by its id (from teams_chats). text is plain text.',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] },
    async run(g, a) {
      const chat = id(a, 'chat_id')!
      const t = str(a, 'text', { max: 28_000, required: true })!
      const m = await g.call({ method: 'POST', path: `/chats/${seg(chat)}/messages`, json: { body: { contentType: 'text', content: t } } })
      return { sent: true, id: m?.id, at: m?.createdDateTime }
    },
  },
]
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|ini|toml|js|ts|py|sql|css)$/i

/** where files_read finds the item: a drive and an id, an id in the user's own drive, or a path in it */
function itemPath(a: Args): { path: string } {
  const item = id(a, 'id', { required: false }), drive = id(a, 'drive_id', { required: false }), p = str(a, 'path', { max: 1000 })
  if (item) return { path: drive ? `/drives/${seg(drive)}/items/${seg(item)}` : `/me/drive/items/${seg(item)}` }
  if (p) {
    const parts = p.replace(/^\/+|\/+$/g, '').split('/')
    if (!parts[0] || parts.some((x) => x === '..' || x === '.')) throw new ArgError('path must be like Documents/plan.docx')
    return { path: `/me/drive/root:/${parts.map(seg).join('/')}` }
  }
  throw new ArgError('give id (and drive_id) from files_search, or path')
}

/** The tools' names, titles and whether they change something: what Discover shows before anyone connects. */
export const MICROSOFT_TOOLS = TOOLS.map((t) => ({ name: t.name, title: t.title, readOnly: t.readOnly }))

const json = (status: number, body: unknown, headers: Record<string, string> = {}): NetResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)), truncated: false })
const unauthorized = (body?: Buffer) => ({ status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' }, body: body?.length ? body : Buffer.from('{"error":"invalid_token"}'), truncated: false })
const result = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

/**
 * One MCP request of the connection (the NetRequest the MCP client would have sent over the network). JSON answers
 * to initialize, tools/list (which asks Graph who is signed in, so a check finds a refused sign-in at once) and
 * tools/call; 202 to notifications.
 */
export async function answerMicrosoftMcp(r: NetRequest, deps: MicrosoftMcpDeps): Promise<NetResponse> {
  if (r.method !== 'POST') return json(405, { error: 'method not allowed' })
  const auth = r.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? ''
  const token = /^Bearer ([\x21-\x7e]{1,16384})$/.exec(auth)?.[1]
  if (!token) return unauthorized()
  let msg: { id?: unknown; method?: unknown; params?: any }
  try { msg = JSON.parse(r.body?.toString('utf8') ?? '') } catch { return json(400, { error: 'not JSON' }) }
  if (msg.id === undefined || msg.id === null) return { status: 202, headers: {}, body: Buffer.alloc(0), truncated: false }
  const reply = (res: unknown) => json(200, { jsonrpc: '2.0', id: msg.id, result: res })
  const g = new Graph(token, deps.net, r.signal)
  try {
    if (msg.method === 'initialize') return reply({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'microsoft-365', version: '1' }, instructions: INSTRUCTIONS })
    if (msg.method === 'tools/list') {
      // whose token it is: a refused one answers 401 here, so the connection asks to sign in again at its check
      await g.call({ path: '/me', query: { select: 'id' } })
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, ...(t.readOnly ? {} : { destructiveHint: true }), openWorldHint: true },
        })),
      })
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? msg.params.arguments as Args : {}
      const t = TOOLS.find((x) => x.name === name)
      if (!t) return reply(result(`Microsoft 365 has no tool ${JSON.stringify(name.slice(0, 80))}.`, true))
      try {
        return reply(result(JSON.stringify(await t.run(g, args, deps, r.signal))))
      } catch (e) {
        if (e instanceof ArgError) return reply(result(`${name}: ${e.message}.`, true))
        if (e instanceof GraphError) return reply(result(graphErrorText(e), true))
        if (isNetError(e)) return reply(result('Microsoft 365 is not reachable right now, try again in a minute.', true))
        throw e
      }
    }
    return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  } catch (e) {
    if (e instanceof GraphUnauthorized) return unauthorized(e.body)
    // tools/list: Microsoft unreachable or failing is the connection's check failing for now (net.ts reasons)
    if (isNetError(e)) throw e
    if (e instanceof GraphError) return json(e.status >= 500 || e.status === 429 ? 503 : 502, { error: graphErrorText(e) })
    throw e
  }
}
