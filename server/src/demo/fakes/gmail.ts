// The demo's Gmail (demo/fakes/index.ts): the Google Workspace MCP library's Gmail tools, answered in this process
// from a mailbox in the demo's content folder (gmail.json) or the built-in one below. The tool names are the catalog's
// (integrations/google-apps/catalog.ts), so the tool list, the confirm card before a send and the "external data" marks
// are the product's own. A send or a draft is stored in the instance's state (state.ts) and answered with an id like
// Gmail's; nothing is ever sent. Calendar, Docs and Sheets tools are not offered (they answer "not in the demo").
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { catalog } from '../../integrations/google-apps/catalog'
import type { NetRequest, NetResponse } from '../../integrations/connections/net'
import type { FakeState, StoredMail } from './state'
import { answerMcp, list, str, text, type FakeTool } from './mcp'

export const GMAIL_FILE = 'gmail.json'

const Person = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) }).strict()
const SeedMail = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  from: z.string().min(1).max(400),
  to: z.string().min(1).max(4000),
  cc: z.string().max(4000).optional(),
  subject: z.string().max(1000),
  /** ISO time, or "-<n>d" / "-<n>h" (that long before the instance started) */
  date: z.string().min(1).max(64),
  body: z.string().max(200_000),
  labels: z.array(z.string().max(100)).max(50).optional(),
  attachments: z.array(z.string().max(300)).max(50).optional(),
}).strict()
export const GmailContent = z.object({ me: Person, messages: z.array(SeedMail).max(2000) }).strict()
export type GmailContent = z.infer<typeof GmailContent>

/** The built-in mailbox: fictional people at fictional .example companies only. */
export const DEFAULT_GMAIL: GmailContent = {
  me: { name: 'Mina Lee', email: 'mina.lee@steepling.example' },
  messages: [
    { id: 'chris-reply', threadId: 'banner', from: 'Chris Walker <chris.walker@fieldnote.example>', to: 'Mina Lee <mina.lee@steepling.example>', subject: 'Re: Final banner for Monday\'s launch', date: '-1h',
      body: 'Hi Mina,\n\nLooks great, running it Monday. Welcome to Steepling!\n\nWe will send the first numbers on Wednesday.\n\nChris\nFieldnote', labels: ['INBOX', 'UNREAD', 'IMPORTANT'] },
    { id: 'banner-sent', threadId: 'banner', from: 'Mina Lee <mina.lee@steepling.example>', to: 'Chris Walker <chris.walker@fieldnote.example>', subject: 'Final banner for Monday\'s launch', date: '-3h',
      body: 'Hi Chris,\n\nI\'m Mina, I just joined Marketing at Steepling. I\'ll be your contact for banners from now on.\n\nAttached: the final launch banner (1200×628) and the Instagram square. Daniel has signed off. Can you run them from Monday?\n\nThanks!\nMina',
      labels: ['SENT'], attachments: ['launch-banner-new.jpg', 'instagram-square.jpg'] },
    { id: 'welcome', threadId: 'welcome', from: 'Sara Jensen <sara.jensen@steepling.example>', to: 'Mina Lee <mina.lee@steepling.example>', subject: 'Welcome to Marketing!', date: '-6h',
      body: 'Hi Mina,\n\nSo glad you are here. Your first task: Leo\'s banner for the Yuzu Ginger launch needs a fresh look. Everything is in the launch project.\n\nLunch at 12:30?\n\nSara', labels: ['INBOX'] },
    { id: 'it-setup', threadId: 'it-setup', from: 'Tom Becker <tom.becker@steepling.example>', to: 'Mina Lee <mina.lee@steepling.example>', subject: 'Your laptop and accounts', date: '-1d',
      body: 'Hi Mina,\n\nYour laptop is on your desk. Your accounts are ready, and the Wi-Fi password is on the card next to the coffee machine.\n\nTom, Operations', labels: ['INBOX'] },
    { id: 'shop-numbers', threadId: 'shop-numbers', from: 'Omar Haddad <omar.haddad@steepling.example>', to: 'Marketing <marketing@steepling.example>', subject: 'Online shop: last week\'s numbers', date: '-2d',
      body: 'Hi all,\n\nLast week: 1,240 orders (+8%), top seller Classic Oolong, Yuzu Ginger pre-orders 312.\n\nOmar', labels: ['INBOX'] },
    { id: 'fieldnote-plan', threadId: 'fieldnote-plan', from: 'Chris Walker <chris.walker@fieldnote.example>', to: 'Sara Jensen <sara.jensen@steepling.example>', cc: 'Marketing <marketing@steepling.example>', subject: 'Winter media plan', date: '-4d',
      body: 'Hi Sara,\n\nHere is the plan for the winter launch: display banners from launch Monday for three weeks, Instagram from the Wednesday after. Banner sizes: 1200×628 and 1080×1080.\n\nChris', labels: ['INBOX'] },
    { id: 'aiko-lead', threadId: 'aiko-lead', from: 'Aiko Tanaka <aiko.tanaka@steepling.example>', to: 'Marketing <marketing@steepling.example>', subject: 'Café chain asking about Yuzu Ginger', date: '-3d',
      body: 'Hi Marketing,\n\nA café chain (Northbank Coffee) wants samples and a one-pager about Yuzu Ginger before the launch. Can someone send me the product sheet?\n\nAiko, Sales', labels: ['INBOX'] },
    { id: 'printer', threadId: 'printer', from: 'Printwell <orders@printwell.example>', to: 'Mina Lee <mina.lee@steepling.example>', subject: 'Your proof is ready', date: '-5d',
      body: 'Hello,\n\nThe proof for order #4471 (500 postcards, Yuzu Ginger) is ready to approve. Reply to this mail with OK to print.\n\nPrintwell', labels: ['INBOX'] },
    { id: 'ceo-note', threadId: 'ceo-note', from: 'Daniel Okoye <daniel.okoye@steepling.example>', to: 'All <all@steepling.example>', subject: 'Yuzu Ginger launch: thank you', date: '-6d',
      body: 'Team,\n\nThe Winter Yuzu Ginger launch is on Monday. Thank you for the push this month. Questions about the launch go to Sara.\n\nDaniel', labels: ['INBOX'] },
    { id: 'newsletter', threadId: 'newsletter', from: 'Tea Trade Weekly <news@teatrade.example>', to: 'Mina Lee <mina.lee@steepling.example>', subject: 'This week: winter flavours are back', date: '-2d',
      body: 'Winter flavours lead the shelves again: ginger, yuzu and cinnamon. Read the full issue on our site.', labels: ['INBOX', 'CATEGORY_UPDATES'] },
  ],
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH', 'CATEGORY_UPDATES']

/** the mailbox from the content folder, or the built-in one (a broken file is logged and the built-in one used) */
export function loadGmail(content: string | null, warn: (m: string) => void): GmailContent {
  if (!content) return DEFAULT_GMAIL
  const file = path.join(content, GMAIL_FILE)
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return DEFAULT_GMAIL }
  try { return GmailContent.parse(JSON.parse(raw)) } catch (e) {
    warn(`demo fakes: ${GMAIL_FILE} is not a mailbox (${String((e as Error).message).slice(0, 200)}); the built-in one is used`)
    return DEFAULT_GMAIL
  }
}

/** "-3d" / "-2h" / an ISO time → an RFC 2822 date like Gmail shows */
function dateOf(d: string, start: number): string {
  const m = /^-(\d{1,4})([dhm])$/.exec(d)
  const ms = m ? start - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000) : Date.parse(d)
  return new Date(Number.isFinite(ms) ? ms : start).toUTCString()
}

export class FakeGmail {
  private seeded: StoredMail[]
  readonly me: { name: string; email: string }
  constructor(content: GmailContent, private state: FakeState, start = Date.now()) {
    this.me = content.me
    this.seeded = content.messages.map((m, i) => {
      const id = m.id ?? `seed${i}`
      const mine = m.from.toLowerCase().includes(content.me.email.toLowerCase())
      return { id, threadId: m.threadId ?? id, from: m.from, to: m.to, ...(m.cc ? { cc: m.cc } : {}), subject: m.subject, date: dateOf(m.date, start), body: m.body,
        labels: m.labels ?? (mine ? ['SENT'] : ['INBOX']), ...(m.attachments ? { attachments: m.attachments } : {}) }
    })
  }

  /** every message: seeded, then the visitor's sends; labels as the visitor changed them; newest first */
  messages(): StoredMail[] {
    const s = this.state.get()
    const all = [...this.seeded, ...s.sent].map((m) => (s.labels[m.id] ? { ...m, labels: s.labels[m.id]! } : m))
    return all.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  }
  sent(): StoredMail[] { return this.state.get().sent }
  drafts(): StoredMail[] { return this.state.get().drafts }
  private find(id: string): StoredMail | undefined { return this.messages().find((m) => m.id === id) ?? this.drafts().find((m) => m.id === id) }

  /** Gmail's search words, the common ones: from: to: subject: in: is: label: has:attachment, and plain words */
  search(query: string): StoredMail[] {
    const terms = query.match(/(?:[a-z]+:)?(?:"[^"]*"|\S+)/gi) ?? []
    const drafts = /\bin:drafts?\b/i.test(query)
    return (drafts ? this.drafts() : this.messages()).filter((m) => terms.every((raw) => {
      const t = raw.replace(/"/g, '').toLowerCase()
      const [k, v = ''] = t.includes(':') ? [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)] : ['', t]
      const has = (s?: string) => (s ?? '').toLowerCase().includes(v)
      switch (k) {
        case 'from': return has(m.from)
        case 'to': return has(m.to) || has(m.cc)
        case 'subject': return has(m.subject)
        case 'in': return v === 'anywhere' || v === 'drafts' || v === 'draft' || m.labels.some((l) => l.toLowerCase() === v)
        case 'label': return m.labels.some((l) => l.toLowerCase() === v)
        case 'is': return v === 'unread' ? m.labels.includes('UNREAD') : v === 'read' ? !m.labels.includes('UNREAD') : v === 'starred' ? m.labels.includes('STARRED') : v === 'important' ? m.labels.includes('IMPORTANT') : true
        case 'has': return v === 'attachment' ? !!m.attachments?.length : true
        case 'newer_than': case 'older_than': case 'after': case 'before': case 'category': return true
        default: return has(m.from) || has(m.to) || has(m.subject) || has(m.body) || has(m.cc)
      }
    }))
  }

  private show(m: StoredMail): string {
    return [`Subject: ${m.subject}`, `From: ${m.from}`, `To: ${m.to}`, ...(m.cc ? [`Cc: ${m.cc}`] : []), `Date: ${m.date}`, `Message ID: ${m.id}`, `Thread ID: ${m.threadId}`, `Labels: ${m.labels.join(', ')}`,
      ...(m.attachments?.length ? [`Attachments: ${m.attachments.join(', ')}`] : []), '', '--- BODY ---', m.body].join('\n')
  }

  private store(kind: 'sent' | 'drafts', a: Record<string, any>): StoredMail {
    const to = list(a.to).join(', ')
    const thread = str(a.thread_id, 64)
    const mail: StoredMail = {
      id: this.state.nextId(kind === 'sent' ? 'm' : 'r'),
      threadId: /^[A-Za-z0-9_-]{1,64}$/.test(thread) ? thread : '',
      from: `${this.me.name} <${this.me.email}>`, to, subject: str(a.subject, 1000), date: new Date().toUTCString(), body: str(a.body, 200_000),
      labels: kind === 'sent' ? ['SENT'] : ['DRAFT'],
      ...(list(a.cc).length ? { cc: list(a.cc).join(', ') } : {}), ...(list(a.bcc).length ? { bcc: list(a.bcc).join(', ') } : {}),
      ...(Array.isArray(a.attachments) && a.attachments.length ? { attachments: a.attachments.slice(0, 50).map((x: any) => str(x?.filename ?? x?.name ?? 'attachment', 300) || 'attachment') } : {}),
    }
    if (!mail.threadId) mail.threadId = mail.id
    this.state.update((d) => { d[kind].push(mail) })
    return mail
  }

  private relabel(ids: string[], add: string[], remove: string[]): string[] {
    const done: string[] = []
    this.state.update((d) => {
      for (const id of ids) {
        const m = this.messages().find((x) => x.id === id)
        if (!m) continue
        const labels = new Set(d.labels[id] ?? m.labels)
        for (const l of add) labels.add(l)
        for (const l of remove) labels.delete(l)
        d.labels[id] = [...labels]
        done.push(id)
      }
    })
    return done
  }

  readonly tools: FakeTool[] = buildTools(this)
  /** the calls behind the tools (for buildTools) */
  readonly ops = {
    search: (q: string) => this.search(q),
    show: (m: StoredMail) => this.show(m),
    find: (id: string) => this.find(id),
    store: (k: 'sent' | 'drafts', a: Record<string, any>) => this.store(k, a),
    relabel: (ids: string[], add: string[], remove: string[]) => this.relabel(ids, add, remove),
    thread: (id: string) => this.messages().filter((m) => m.threadId === id).reverse(),
    userLabels: () => this.state.get().userLabels,
    addLabel: (name: string) => { const id = this.state.nextId('Label_'); this.state.update((d) => { d.userLabels.push({ id, name }) }); return id },
    dropLabel: (id: string) => { let found = false; this.state.update((d) => { const n = d.userLabels.length; d.userLabels = d.userLabels.filter((l) => l.id !== id); found = d.userLabels.length !== n }); return found },
  }

  /** one request to the fake library (google-apps/transport.ts) */
  request(r: NetRequest): Promise<NetResponse> {
    return answerMcp('workspace', this.tools, r, { needsAuth: true, unavailable: (t) => `${t} isn't available in the demo. Gmail works here; Calendar, Docs and Sheets do not.` })
  }
}

const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) })
const strP = (description: string) => ({ type: 'string', description })
const listP = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

function buildTools(g: FakeGmail): FakeTool[] {
  const o = () => g.ops
  const listing = (found: ReturnType<FakeGmail['search']>, query: string, size: number) => {
    if (!found.length) return `No messages found for query: '${query}'`
    const shown = found.slice(0, size)
    return [`Found ${found.length} message${found.length === 1 ? '' : 's'} matching '${query}'${found.length > shown.length ? ` (showing ${shown.length})` : ''}:`, '',
      ...shown.map((m, i) => `${i + 1}. Message ID: ${m.id}\n   Thread ID: ${m.threadId}\n   From: ${m.from}\n   Subject: ${m.subject}\n   Date: ${m.date}`),
      '', 'Use get_gmail_message_content with a Message ID to read one.'].join('\n')
  }
  const impl: Record<string, (a: Record<string, any>) => ReturnType<FakeTool['call']>> = {
    search_gmail_messages: (a) => {
      const q = str(a.query, 500)
      const size = Math.max(1, Math.min(50, Number(a.page_size) || 10))
      return text(listing(o().search(q), q, size))
    },
    get_gmail_message_content: (a) => {
      const m = o().find(str(a.message_id, 64))
      return m ? text(o().show(m)) : text(`Message ${str(a.message_id, 64)} was not found.`, true)
    },
    get_gmail_messages_content_batch: (a) => {
      const ids = list(a.message_ids).slice(0, 25)
      return text(ids.map((id) => { const m = o().find(id); return m ? o().show(m) : `Message ${id} was not found.` }).join('\n\n---\n\n') || 'No message ids given.')
    },
    get_gmail_thread_content: (a) => {
      const t = o().thread(str(a.thread_id, 64))
      return t.length ? text([`Thread ID: ${str(a.thread_id, 64)} (${t.length} message${t.length === 1 ? '' : 's'})`, '', ...t.map((m) => o().show(m))].join('\n\n---\n\n')) : text(`Thread ${str(a.thread_id, 64)} was not found.`, true)
    },
    get_gmail_threads_content_batch: (a) => {
      const ids = list(a.thread_ids).slice(0, 25)
      return text(ids.map((id) => { const t = o().thread(id); return t.length ? t.map((m) => o().show(m)).join('\n\n') : `Thread ${id} was not found.` }).join('\n\n=====\n\n') || 'No thread ids given.')
    },
    get_gmail_attachment_content: () => text('Attachments can\'t be opened in the demo mailbox.', true),
    list_gmail_labels: () => text(['System labels:', ...SYSTEM_LABELS.map((l) => `- ${l} (ID: ${l})`), '', 'Your labels:', ...(o().userLabels().length ? o().userLabels().map((l) => `- ${l.name} (ID: ${l.id})`) : ['(none)'])].join('\n')),
    list_gmail_filters: () => text('No filters.'),
    send_gmail_message: (a) => {
      if (!list(a.to).length) return text('A message needs at least one address in "to".', true)
      const m = o().store('sent', a)
      return text(`Email sent! Message ID: ${m.id}`)
    },
    draft_gmail_message: (a) => {
      const m = o().store('drafts', a)
      return text(`Draft created! Draft ID: ${m.id}`)
    },
    modify_gmail_message_labels: (a) => {
      const done = o().relabel([str(a.message_id, 64)], list(a.add_label_ids), list(a.remove_label_ids))
      return done.length ? text(`Message labels updated for message ${done[0]}.`) : text(`Message ${str(a.message_id, 64)} was not found.`, true)
    },
    batch_modify_gmail_message_labels: (a) => {
      const done = o().relabel(list(a.message_ids), list(a.add_label_ids), list(a.remove_label_ids))
      return text(`Labels updated for ${done.length} message${done.length === 1 ? '' : 's'}.`)
    },
    manage_gmail_label: (a) => {
      const action = str(a.action, 20)
      if (action === 'create') { const name = str(a.name, 200); return name ? text(`Label created: ${name} (ID: ${o().addLabel(name)})`) : text('A new label needs a name.', true) }
      if (action === 'delete') return o().dropLabel(str(a.label_id, 64)) ? text('Label deleted.') : text('Label not found.', true)
      return text('Labels can be created or deleted in the demo.', true)
    },
    manage_gmail_filter: () => text('Filters can\'t be changed in the demo.', true),
  }
  const schema: Record<string, Record<string, unknown>> = {
    search_gmail_messages: S({ query: strP('Gmail search words, e.g. "from:chris is:unread"'), page_size: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']),
    get_gmail_message_content: S({ message_id: strP('the Message ID') }, ['message_id']),
    get_gmail_messages_content_batch: S({ message_ids: listP('Message IDs'), format: strP('"full" or "metadata"') }, ['message_ids']),
    get_gmail_thread_content: S({ thread_id: strP('the Thread ID') }, ['thread_id']),
    get_gmail_threads_content_batch: S({ thread_ids: listP('Thread IDs') }, ['thread_ids']),
    get_gmail_attachment_content: S({ message_id: strP('the Message ID'), attachment_id: strP('the attachment ID'), return_base64: { type: 'boolean' } }, ['message_id', 'attachment_id']),
    list_gmail_labels: S({}),
    list_gmail_filters: S({}),
    send_gmail_message: S({ to: strP('recipients, comma-separated'), subject: strP('subject'), body: strP('the message'), cc: strP('cc'), bcc: strP('bcc'), body_format: strP('"plain" or "html"'),
      thread_id: strP('to reply in a thread'), in_reply_to: strP('Message-ID header replied to'), references: strP('References header'), attachments: { type: 'array', items: { type: 'object' } } }, ['to', 'subject', 'body']),
    draft_gmail_message: S({ subject: strP('subject'), body: strP('the message'), to: strP('recipients, comma-separated'), cc: strP('cc'), bcc: strP('bcc'), body_format: strP('"plain" or "html"'),
      thread_id: strP('to reply in a thread'), in_reply_to: strP('Message-ID header replied to'), references: strP('References header'), attachments: { type: 'array', items: { type: 'object' } } }, ['subject', 'body']),
    modify_gmail_message_labels: S({ message_id: strP('the Message ID'), add_label_ids: listP('label IDs to add'), remove_label_ids: listP('label IDs to remove') }, ['message_id']),
    batch_modify_gmail_message_labels: S({ message_ids: listP('Message IDs'), add_label_ids: listP('label IDs to add'), remove_label_ids: listP('label IDs to remove') }, ['message_ids']),
    manage_gmail_label: S({ action: strP('"create", "update" or "delete"'), name: strP('label name'), label_id: strP('label ID') }, ['action']),
    manage_gmail_filter: S({ action: strP('"create" or "delete"'), filter_id: strP('filter ID') }, ['action']),
  }
  return catalog('gmail').map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: !t.changes, inputSchema: schema[t.name] ?? S({}), call: impl[t.name] ?? (() => text(`${t.name} isn't available in the demo.`, true)) }))
}
