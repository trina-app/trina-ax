// One forwarded mail as a room app event (email into rooms, plan docs/AGENTS/plan/20261123-0421-room-email.md "What a
// card shows"). The raw message comes from the mail service (sealed to this server: mail/feed.ts) and is read here with
// postal-mime (MIT-0): headers, the plain text or the HTML turned into text, the list of attachments.
//
// Rules:
//  - Plain text only on the card (cleanCard): no HTML is ever shown, remote images are never loaded, links stay text and
//    never become the card's link (in mail they are often tracking or phishing links).
//  - The sender is always "(unverified)": forwarding breaks SPF and anyone can write a From. Only the outer From header
//    with exactly one address is the sender; never the envelope sender (forwarders rewrite it).
//  - Attachments are listed (name and size), not kept (phase 2 keeps them as room files).
//  - A reply chain stays in one thread: the thread key is the first Message-ID in References (else In-Reply-To), else
//    the mail's own Message-ID, so a later "Re:" finds the first card.
//  - A provider's forwarding confirmation (Gmail asks before a filter forwards) is not a card: its code goes to the
//    app's settings for the people who manage it (RoomAppMail.confirmation), and the room gets one quiet line.
import crypto from 'node:crypto'
import PostalMime from 'postal-mime'
import { ROOM_APP_MAIL_TEXT_MAX, type Locale, type RoomAppMailConfirmation } from '@mycel/shared/api'
import { line } from '../card'
import type { AppEvent } from '../parse'
import { appText } from '../text'
import { htmlToText } from '../../../tools/web-fetch'

export interface MailParsed {
  event: AppEvent
  /** an out-of-office answer or another automatic reply (the app's auto_replies switch) */
  autoReply: boolean
  /** a provider's forwarding confirmation: not posted as a card */
  confirmation?: Omit<RoomAppMailConfirmation, 'at'>
}

/** Bidi controls, zero-width characters and other format characters: a header or a line must read as it is stored. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu
const clean = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(INVISIBLE, '')).join('\n')
const cleanLine = (s: string, max: number) => line(s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim(), max)

const ADDRESS = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}$/
/** The one sender: exactly one From header with exactly one mailbox, else null. */
function senderOf(headers: { key: string; value: string }[], from: { address?: string; name?: string; group?: unknown[] } | undefined): { address: string; name: string } | null {
  if (headers.filter((h) => h.key === 'from').length !== 1) return null
  if (!from || from.group || typeof from.address !== 'string' || !ADDRESS.test(from.address)) return null
  // a display name that looks like an address or is long is dropped: the address is what counts
  let name = cleanLine(from.name ?? '', 80)
  if (name.includes('@') || name.length > 40) name = ''
  return { address: from.address.toLowerCase(), name }
}

const MESSAGE_ID = /<[^<>\s]{1,250}>/g
const firstId = (v: string | undefined) => (v ?? '').match(MESSAGE_ID)?.[0] ?? null

/** Lines a mail's text starts with that say nothing (quoted mail, separators): the card shows the next ones. */
const QUOTE_START = /^(>|On .+ wrote:$|-{2,}\s*(Original Message|Forwarded message)|-{5,}|_{5,}|20\d\d.+(작성|wrote))/i

/** The mail's readable text: the plain part when it has words, else the HTML turned into text. */
function textOf(text: string | undefined, html: string | undefined): string {
  const plain = clean(text ?? '').trim()
  if (/\p{L}/u.test(plain)) return plain
  if (!html) return plain
  try { return clean(htmlToText(html.slice(0, 4 * 1024 * 1024), new URL('https://mail.invalid/'), { plain: true }).text).trim() } catch { return plain }
}

const GMAIL_CONFIRM_FROM = 'forwarding-noreply@google.com'
const OUTLOOK_CONFIRM_FROM = /^(no-?reply|msonlineservicesteam)@[a-z0-9.-]*(microsoft|outlook)\.com$/
/** Gmail: "(#123456789) Gmail Forwarding Confirmation - Receive Mail from someone@gmail.com" and "Confirmation code:
 * 123456789" in the body (https://support.google.com/mail/answer/10957). */
function confirmationOf(sender: { address: string } | null, subject: string, text: string): MailParsed['confirmation'] | undefined {
  if (!sender) return undefined
  if (sender.address === GMAIL_CONFIRM_FROM && /forwarding confirmation/i.test(subject)) {
    const code = /confirmation code:\s*(\d{6,12})/i.exec(text)?.[1] ?? /\(#(\d{6,12})\)/.exec(subject)?.[1] ?? null
    const from = /receive (?:mail|email) from\s+(\S+@\S+)/i.exec(subject)?.[1] ?? ''
    return { provider: 'gmail', from: line(from.replace(/[<>]/g, ''), 320), code }
  }
  if (OUTLOOK_CONFIRM_FROM.test(sender.address) && /forward/i.test(subject) && /confirm|verify/i.test(subject + text)) {
    const code = /\b(\d{6,10})\b/.exec(text)?.[1] ?? null
    return { provider: 'outlook', from: '', code }
  }
  return undefined
}

/** RFC 3834 Auto-Submitted, and the headers out-of-office answers carry. Bulk mail (shop notices) is not one. */
function autoReplyOf(headers: { key: string; value: string }[], subject: string): boolean {
  const h = (k: string) => headers.find((x) => x.key === k)?.value?.trim().toLowerCase()
  const auto = h('auto-submitted')
  if (auto && auto !== 'no') return true
  if (h('x-autoreply') || h('x-autorespond') || h('x-auto-response-suppress')?.includes('oof')) return true
  return /^(auto(matic)? ?reply|out of (the )?office|부재중|自動応答|不在|respuesta automática)/i.test(subject)
}

const size = (n: number) => n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/** Read one mail. `itemId`: the mail service's id (the delivery key when the mail has no Message-ID). Throws nothing:
 * a mail Trina cannot read is null. */
export async function parseMail(raw: Uint8Array, o: { locale: Locale; itemId: string }): Promise<MailParsed | null> {
  let mail: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    mail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 20, maxHeadersSize: 256 * 1024 } as Parameters<typeof PostalMime.parse>[1])
  } catch { return null }
  const headers = (mail.headers ?? []).map((h) => ({ key: String(h.key).toLowerCase(), value: String(h.value ?? '') }))
  const sender = senderOf(headers, mail.from as { address?: string; name?: string; group?: unknown[] } | undefined)
  const subject = cleanLine(mail.subject ?? '', 300)
  let text = textOf(mail.text, mail.html)
  const confirmation = confirmationOf(sender, subject, text)
  let cut = false
  if (text.length > ROOM_APP_MAIL_TEXT_MAX) { text = text.slice(0, ROOM_APP_MAIL_TEXT_MAX); cut = true }
  const L = o.locale
  const fromText = sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address) : appText('mailNoSender', L)
  // the first lines that say something (no quoted mail, no separators, no empty lines)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const shown: string[] = []
  for (const l of lines) {
    if (QUOTE_START.test(l)) break
    shown.push(cleanLine(l, 300))
    if (shown.length >= 2) break
  }
  const files = (mail.attachments ?? []).filter((a) => a.disposition !== 'inline' || !a.contentId)
  if (files.length) {
    const names = files.slice(0, 5).map((a) => `${cleanLine(a.filename || 'file', 60)} (${size(a.content instanceof ArrayBuffer ? a.content.byteLength : typeof a.content === 'string' ? a.content.length : 0)})`).join(', ')
    shown.push(line(appText('mailAttachments', L, { n: files.length, names: files.length > 5 ? `${names}, …` : names }), 300))
  }
  const own = firstId(mail.messageId)
  const root = firstId(mail.references) ?? firstId(mail.inReplyTo)
  const body = crypto.createHash('sha256').update(text).digest('hex')
  const event: AppEvent = {
    switch: 'mail',
    // a resend of the same mail posts once; a reused Message-ID with another body still posts
    delivery: own ? `mail:${own}:${body}` : `item:${o.itemId}`,
    ...(root ?? own ? { key: `thread:${root ?? own}` } : {}),
    card: { kind: appText('mailKind', L, { from: fromText }), title: subject || appText('mailNoSubject', L), details: shown, unverified: true },
    reply: { title: subject || appText('mailNoSubject', L), details: shown.slice(0, 1), unverified: true },
    extra: `${appText('mailKind', L, { from: fromText })}\n${text}${cut ? `\n${appText('mailCut', L)}` : ''}`,
  }
  return { event, autoReply: autoReplyOf(headers, subject), ...(confirmation ? { confirmation } : {}) }
}
