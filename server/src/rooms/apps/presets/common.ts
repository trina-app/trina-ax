// What the preset readers share (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md "Presets"): the
// preset's definition, money as people read it, dates in the team's zone, and the forms card (Typeform, Tally, Jotform
// make the same card as Google Forms).
import type { Locale, RoomAppPreset } from '@mycel/shared/api'
import { line, lines } from '../card'
import type { Arrival, Parsed } from '../parse'
import type { SignatureScheme } from '../signatures'
import { appText } from '../text'

/** One preset: the content types it takes, its body cap, how its service signs (none: the token only), its reader. */
export interface PresetDef {
  preset: RoomAppPreset
  types: readonly string[]
  bodyMax: number
  signature?: { scheme: SignatureScheme; header?: string; prefix?: string }
  parse(a: Arrival): Parsed
}

/** Stripe's zero- and three-decimal currencies (https://docs.stripe.com/currencies): the smallest unit is not cents. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'])
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd'])

/** An amount in the team's language: `minor` in the currency's smallest unit (Stripe), or `major` as a decimal string
 * (Shopify's "49.00"). A currency that is not three letters shows the number and the code. */
export function money(locale: Locale, currency: string, amount: { minor: number } | { major: number }): string {
  const c = currency.trim().toLowerCase()
  const value = 'minor' in amount ? amount.minor / 10 ** (ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2) : amount.major
  if (!/^[a-z]{3}$/.test(c)) return line(`${value} ${currency}`, 40)
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: c.toUpperCase() }).format(value) } catch { return `${value} ${c.toUpperCase()}` }
}

/** A date or time as the team reads it: a plain date stays as it is; an instant in the team's zone. */
export function dateText(s: string, locale: Locale, timeZone?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return line(s, 40)
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(t)) } catch { return new Date(t).toISOString() }
}

/** At most this many answers of a form, each at most this long (as Google Forms). */
export const FORM_ANSWERS_MAX = 50
export const FORM_ANSWER_MAX = 1000

/** A form's response as a card: the first answer as the title, the next two (and "+n more") as details, every answer
 * in the plain text. `id` is the response (an edited one, where the service sends one, joins its thread). */
export function formEvent(L: Locale, o: { form: string; id: string; delivery: string; deliveryMinutes?: number; answers: { q: string; a: string }[] }): Parsed {
  const answers = o.answers.slice(0, FORM_ANSWERS_MAX)
    .map((x) => ({ q: line(x.q, 200), a: lines(x.a, FORM_ANSWER_MAX).replace(/\n+/g, ' / ') }))
    .filter((x) => x.q || x.a)
  const qa = (x: { q: string; a: string }) => (x.q ? `${x.q}: ${x.a}` : x.a)
  const form = line(o.form, 120) || '…'
  let details = answers.slice(1).map(qa)
  if (details.length > 3) details = [...details.slice(0, 2), appText('formsMore', L, { n: details.length - 2 })]
  return { event: {
    switch: 'response', delivery: o.delivery, ...(o.deliveryMinutes ? { deliveryMinutes: o.deliveryMinutes } : {}), key: `response:${line(o.id, 200)}`,
    card: { kind: appText('formsNew', L, { form }), title: answers[0] ? qa(answers[0]) : form, details },
    reply: { title: appText('formsEdited', L), details: answers[0] ? [qa(answers[0])] : [] },
    extra: lines(answers.map(qa).join('\n')),
  } }
}

/** A reply's lines of a longer text (a Jira comment, a Zendesk update, a Channel Talk message): its first `n` lines, the
 * last one ending in "…" when more follow. The whole text goes with the reply as its `extra` (QA TC-2413). */
export function replyLines(text: string, n = 3): string[] {
  const all = text.split('\n').map((x) => x.trim()).filter(Boolean)
  if (all.length <= n) return all
  const shown = all.slice(0, n)
  shown[n - 1] = `${shown[n - 1]} …`
  return shown
}

/** A file answer: its name only (the service's file address can be a public bucket's: never made a link). */
export function fileName(u: unknown): string {
  if (typeof u !== 'string') return ''
  try { const p = new URL(u).pathname.split('/').filter(Boolean).pop() ?? ''; return line(decodeURIComponent(p), 120) } catch { return line(u.split('/').pop() ?? '', 120) }
}

/** A flat template body (Zendesk, Jira): true when its raw text names any of the template's keys more than once, also
 * written with \uXXXX escapes ("id" is "id"). JSON.parse keeps the last of two equal keys, so text an outsider
 * wrote that closes its quote and adds `"key":…` would otherwise win: such a body is refused. */
export function duplicateKey(text: string, keys: readonly string[]): boolean {
  const plain = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
  return keys.some((k) => (plain.match(new RegExp(`"${k}"\\s*:`, 'g')) ?? []).length > 1)
}
