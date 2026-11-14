// The signature schemes of room apps (server/src/rooms/apps/signatures.ts; plan 20261114-1522 "Signature schemes"):
// each one good, wrong and missing, and its edges (Stripe's several v1 and its 5-minute window, Zendesk's strict
// timestamp, Tally's raw-bytes-first then JSON.stringify, base64 of a wrong length).
import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { parseSignedTime, verifySignature, type SignatureInput } from '../../server/src/rooms/apps/signatures'

const enc = (s: string) => new TextEncoder().encode(s)
const mac = (k: string, ...p: string[]) => { const h = crypto.createHmac('sha256', k); for (const x of p) h.update(x); return h.digest() }
const NOW = Date.parse('2026-11-14T10:00:00Z')
const input = (raw: string, headers: Record<string, string>, o: Partial<SignatureInput> = {}): SignatureInput => ({ secret: 'k'.repeat(20), raw: enc(raw), headers: new Headers(headers), now: NOW, ...o })

test('hex-body and b64-body: the right header and prefix, constant length; wrong or missing fail', () => {
  const k = 'k'.repeat(20), body = '{"a":1}'
  expect(verifySignature('hex-body', input(body, { 'x-hub-signature-256': `sha256=${mac(k, body).toString('hex')}` }, { header: 'x-hub-signature-256', prefix: 'sha256=' })).ok).toBe(true)
  expect(verifySignature('hex-body', input(body, { 'x-hub-signature-256': mac(k, body).toString('hex') }, { header: 'x-hub-signature-256', prefix: 'sha256=' })).ok).toBe(false)
  expect(verifySignature('b64-body', input(body, { 'x-shopify-hmac-sha256': mac(k, body).toString('base64') }, { header: 'x-shopify-hmac-sha256' })).ok).toBe(true)
  // url-safe base64 of the same digest is taken too
  expect(verifySignature('b64-body', input(body, { 'typeform-signature': `sha256=${mac(k, body).toString('base64url')}` }, { header: 'typeform-signature', prefix: 'sha256=' })).ok).toBe(true)
  expect(verifySignature('b64-body', input(body, { 'x-shopify-hmac-sha256': mac(k, `${body} `).toString('base64') }, { header: 'x-shopify-hmac-sha256' })).ok).toBe(false)
  expect(verifySignature('b64-body', input(body, { 'x-shopify-hmac-sha256': 'AAAA' }, { header: 'x-shopify-hmac-sha256' })).ok).toBe(false)
  expect(verifySignature('b64-body', input(body, {}, { header: 'x-shopify-hmac-sha256' })).ok).toBe(false)
})

test('b64-json (Tally): the raw bytes first, then JSON.stringify of the parse, which is returned; not JSON fails', () => {
  const k = 'k'.repeat(20)
  const pretty = '{\n  "eventId": "e",\n  "b": [1, 2]\n}'
  const r = verifySignature('b64-json', input(pretty, { 'tally-signature': mac(k, JSON.stringify(JSON.parse(pretty))).toString('base64') }))
  expect(r).toEqual({ ok: true, json: { eventId: 'e', b: [1, 2] } })
  expect(verifySignature('b64-json', input(pretty, { 'tally-signature': mac(k, pretty).toString('base64') })).ok).toBe(true)
  expect(verifySignature('b64-json', input(pretty, { 'tally-signature': mac('other-key-other-key', pretty).toString('base64') })).ok).toBe(false)
  expect(verifySignature('b64-json', input('not json', { 'tally-signature': mac(k, 'not json').toString('base64') })).ok).toBe(false)
})

test('stripe: t + "." + raw, any v1, v0 ignored, the literal whsec_ secret, 5 minutes either way', () => {
  const k = 'whsec_' + 'A'.repeat(32), body = '{"id":"evt_1"}'
  const t = Math.floor(NOW / 1000)
  const v1 = (ts: number, key = k) => mac(key, `${ts}.`, body).toString('hex')
  const s = (h: string) => verifySignature('stripe', input(body, { 'stripe-signature': h }, { secret: k })).ok
  expect(s(`t=${t},v1=${v1(t)}`)).toBe(true)
  expect(s(`t=${t},v0=${v1(t)},v1=${'f'.repeat(64)},v1=${v1(t)}`)).toBe(true)
  expect(s(`t=${t},v0=${v1(t)}`)).toBe(false)
  // the secret base64-decoded (Standard Webhooks' way) is not Stripe's
  expect(s(`t=${t},v1=${mac(Buffer.from('A'.repeat(32), 'base64').toString('latin1'), `${t}.`, body).toString('hex')}`)).toBe(false)
  expect(s(`t=${t - 301},v1=${v1(t - 301)}`)).toBe(false)
  expect(s(`t=${t + 301},v1=${v1(t + 301)}`)).toBe(false)
  expect(s(`t=${t - 299},v1=${v1(t - 299)}`)).toBe(true)
  expect(s(`v1=${v1(t)}`)).toBe(false)
  expect(s(`t=abc,v1=${v1(t)}`)).toBe(false)
})

test('zendesk: timestamp + raw, ISO-8601 or Unix seconds within 5 minutes; anything else 401', () => {
  const k = 'z'.repeat(32), body = '{"id":"1"}'
  const z = (ts: string, key = k) => verifySignature('zendesk', input(body, { 'x-zendesk-webhook-signature': mac(key, ts, body).toString('base64'), 'x-zendesk-webhook-signature-timestamp': ts }, { secret: k })).ok
  expect(z('2026-11-14T10:00:00Z')).toBe(true)
  expect(z('2026-11-14T10:02:00.123+00:00')).toBe(true)
  expect(z(String(NOW / 1000))).toBe(true)
  expect(z('2026-11-14T09:54:00Z')).toBe(false)
  expect(z('tomorrow')).toBe(false)
  expect(z('2026-11-14 10:00:00')).toBe(false)
  expect(z('2026-11-14T10:00:00Z', 'other-other-other')).toBe(false)
  expect(parseSignedTime('1794646800')).toBe(1794646800000)
  expect(parseSignedTime('17946468000000')).toBeNull()
})
