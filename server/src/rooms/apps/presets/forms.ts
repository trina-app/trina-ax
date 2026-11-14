// The forms group (plan 20261114-1522 "Forms group"): Typeform, Tally and Jotform responses become the Google Forms
// card (common.ts formEvent). Email answers are shown (the guide says everyone in the room sees them); file answers
// show the file's name only, never the service's file address as a link.
//
// Typeform (https://www.typeform.com/developers/webhooks/example-payload/): event_id, event_type form_response,
//   form_response.{form_id, token, definition.{title, fields[]}, answers[]}; answers matched to fields by field.id.
//   Signed (optional) Typeform-Signature "sha256=<base64>" over the raw bytes.
// Tally (https://tally.so/help/webhooks): eventId, eventType FORM_RESPONSE, createdAt, data.{responseId, formName,
//   fields[{key, label, type, value, options?}]}; choice values are option ids. Signed (optional) Tally-Signature, base64
//   HMAC of JSON.stringify(body) (signatures.ts b64-json): the card is built from the verified parse; a createdAt older
//   than 2 days is refused when signed (the signature has no time); eventId is remembered 7 days (Tally retries a day).
// Jotform (https://www.jotform.com/help/248-webhook-samples): a form post (multipart or urlencoded; inbound.ts reads
//   the fields, files left out): submissionID, formID, formTitle, pretty "Label:Value, …", rawRequest (JSON of q3_name
//   keys). No signature.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line } from '../card'
import type { Arrival, Parsed } from '../parse'
import { arr, get, jsonOf, num, obj, sha, str } from '../read'
import { fileName, FORM_ANSWERS_MAX, formEvent, type PresetDef } from './common'

/** Tally: a signed body whose createdAt is older than this is refused (replay beyond what dedupe remembers). */
export const TALLY_MAX_AGE_MS = 2 * 86_400_000

// ---------------- Typeform ----------------
function typeformAnswer(x: unknown): string {
  const type = str(x, 'type')
  switch (type) {
    case 'choice': return str(x, 'choice', 'label') || str(x, 'choice', 'other')
    case 'choices': return [...arr(x, 50, 'choices', 'labels').filter((l): l is string => typeof l === 'string'), str(x, 'choices', 'other')].filter(Boolean).join(', ')
    case 'boolean': return get(x, 'boolean') === true ? '✓' : get(x, 'boolean') === false ? '–' : ''
    case 'number': { const n = num(x, 'number'); return n === null ? '' : String(n) }
    case 'file_url': return fileName(get(x, 'file_url'))
    // a payment answer: its amount only (never the card's last digits or the holder's name)
    case 'payment': return str(x, 'payment', 'amount')
    case 'multi_format': return ''
    default: return str(x, type)
  }
}
function typeform(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  if (str(body, 'event_type') && str(body, 'event_type') !== 'form_response') return { skip: true }
  const r = obj(body.form_response)
  const token = line(str(r, 'token'), 200)
  if (!r || !token || !Array.isArray(r.answers)) return { refuse: 'format' }
  const titles = new Map<string, string>()
  for (const f of arr(r, 200, 'definition', 'fields')) { const id = str(f, 'id'); if (id) titles.set(id, str(f, 'title')) }
  const answers = arr(r, FORM_ANSWERS_MAX, 'answers').map((x) => ({ q: titles.get(str(x, 'field', 'id')) ?? str(x, 'field', 'ref'), a: typeformAnswer(x) }))
  const eventId = line(str(body, 'event_id'), 200)
  return formEvent(a.locale, { form: str(r, 'definition', 'title') || str(r, 'form_id'), id: token, delivery: eventId ? `typeform:${eventId}` : sha(a.raw), answers })
}

// ---------------- Tally ----------------
function tallyValue(f: unknown): string {
  const v = get(f, 'value')
  if (v === null || v === undefined) return ''
  const opts = new Map<string, string>()
  for (const o of arr(f, 200, 'options')) { const id = str(o, 'id'); if (id) opts.set(id, str(o, 'text')) }
  const one = (x: unknown): string => {
    if (typeof x === 'string') return opts.get(x) ?? x
    if (typeof x === 'number' && Number.isFinite(x)) return String(x)
    if (typeof x === 'boolean') return x ? '✓' : '–'
    // a file upload: {name, url, …}
    const o = obj(x)
    if (o) return line(str(o, 'name'), 120) || fileName(o.url)
    return ''
  }
  return Array.isArray(v) ? v.slice(0, 50).map(one).filter(Boolean).join(', ') : one(v)
}
function tally(a: Arrival): Parsed {
  // signed: the parse that was verified (signatures.ts); else the raw bytes
  const body = obj(a.json !== undefined ? a.json : jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  if (str(body, 'eventType') && str(body, 'eventType') !== 'FORM_RESPONSE') return { skip: true }
  const data = obj(body.data)
  const id = line(str(data, 'responseId') || str(data, 'submissionId'), 200)
  if (!data || !id || !Array.isArray(data.fields)) return { refuse: 'format' }
  const answers = arr(data, FORM_ANSWERS_MAX * 2, 'fields')
    // Tally also sends each ticked checkbox option as its own true/false field: those are in the list's value already
    .filter((f) => !(str(f, 'type') === 'CHECKBOXES' && typeof get(f, 'value') === 'boolean'))
    .map((f) => ({ q: str(f, 'label'), a: tallyValue(f) }))
    .filter((x) => x.a)
  const eventId = line(str(body, 'eventId'), 200)
  return formEvent(a.locale, { form: str(data, 'formName') || str(data, 'formId'), id, delivery: eventId ? `tally:${eventId}` : sha(a.raw), answers })
}
/** Tally's createdAt when it is older than allowed (signed requests only, inbound.ts): true to refuse. */
export function tallyTooOld(json: unknown, now: number): boolean {
  const at = Date.parse(str(json, 'createdAt'))
  return !Number.isFinite(at) || now - at > TALLY_MAX_AGE_MS
}

// ---------------- Jotform ----------------
/** "q3_fullName" → "Full Name" */
const labelOf = (key: string) => line(key.replace(/^q\d+_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), 200)
const jotValue = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (Array.isArray(v)) return v.slice(0, 50).map(jotValue).filter(Boolean).join(', ')
  const o = obj(v)
  // a name {first, last}, an address, a date {month, day, year}: its parts in order
  return o ? Object.values(o).slice(0, 20).map(jotValue).filter(Boolean).join(' ') : ''
}
/** "Name:Mina Kim, Email:mina@example.com": split before each "Label:" (a comma inside a value stays with it). */
export function jotformPretty(s: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = []
  for (const part of s.split(/, (?=[^,:]{1,200}:)/).slice(0, FORM_ANSWERS_MAX)) {
    const i = part.indexOf(':')
    if (i <= 0) { if (out.length) out[out.length - 1]!.a += `, ${part}`; continue }
    out.push({ q: part.slice(0, i).trim(), a: part.slice(i + 1).trim() })
  }
  return out
}
function jotform(a: Arrival): Parsed {
  const fields = new Map<string, string>()
  for (const [k, v] of a.form ?? []) if (!fields.has(k)) fields.set(k, v)
  const id = line(fields.get('submissionID') ?? '', 100)
  if (!id) return { refuse: 'format' }
  let answers: { q: string; a: string }[] = []
  const pretty = fields.get('pretty')
  if (pretty) answers = jotformPretty(pretty)
  else {
    const raw = obj(jsonOf(new TextEncoder().encode(fields.get('rawRequest') ?? '')))
    if (raw) {
      answers = Object.entries(raw).filter(([k]) => /^q\d+_/.test(k))
        .sort(([x], [y]) => Number(/^q(\d+)/.exec(x)![1]) - Number(/^q(\d+)/.exec(y)![1]))
        .slice(0, FORM_ANSWERS_MAX).map(([k, v]) => ({ q: labelOf(k), a: jotValue(v) }))
    }
  }
  return formEvent(a.locale, { form: fields.get('formTitle') || fields.get('formID') || 'Jotform', id, delivery: `jotform:${id}`, answers })
}

export const typeformPreset: PresetDef = {
  preset: 'typeform', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX,
  signature: { scheme: 'b64-body', header: 'typeform-signature', prefix: 'sha256=' }, parse: typeform,
}
export const tallyPreset: PresetDef = { preset: 'tally', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'b64-json' }, parse: tally }
export const jotformPreset: PresetDef = {
  preset: 'jotform', types: ['multipart/form-data', 'application/x-www-form-urlencoded'], bodyMax: 512 * 1024, parse: jotform,
}
