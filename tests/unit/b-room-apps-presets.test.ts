// Apps in rooms, part 2 phase 1 (docs/DECISIONS.md "Apps in rooms: presets and JANDI", plan
// docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md; QA TC-1634): Other reads JANDI; the presets Notion,
// Typeform, Tally, Jotform, Stripe, Shopify and Zendesk read their vendors' sample payloads (tests/fixtures/room-apps)
// into cards, threads, switches and delivery keys; each signature scheme good / bad / missing; preset rules (fixed at
// create, no_signing, Zendesk's test secret, an unknown preset); bodies with fields missing or of the wrong type never
// crash.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { roomAppZendeskBody, ZENDESK_TEST_SECRET, type Locale } from '@mycel/shared/api'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { roomAppsOf } from '../../server/src/rooms/apps/service'
import { appText } from '../../server/src/rooms/apps/text'
import { loggablePath } from '../../server/src/http/middleware'
import { tolerantZendesk, zendeskDuplicateKey } from '../../server/src/rooms/apps/presets/zendesk'
import { jotformPretty } from '../../server/src/rooms/apps/presets/forms'
import { money } from '../../server/src/rooms/apps/presets/common'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const settle = () => new Promise((r) => setTimeout(r, 5))
const fixture = (p: string) => readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'room-apps', p), 'utf8')
const hmac = (secret: string, ...parts: string[]) => { const m = crypto.createHmac('sha256', secret); for (const p of parts) m.update(p); return m }

async function setup() {
  h = await harness('b-room-apps-presets', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const rooms = (await owner.call('GET', '/api/rooms')).items as any[]
  const all = rooms.find((r) => r.kind === 'all')!.id as string
  const L = teamDefaultLocale(h.ctx.db) as Locale
  const add = async (preset: string | null, name?: string, c: Client = owner) => {
    const r = await c.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', ...(preset ? { preset } : {}), ...(name ? { name } : {}) })
    return { app: r.app, token: (r.address as string).split('/in/')[1]! }
  }
  const post = (token: string, body: string | FormData, headers: Record<string, string> = {}) =>
    h.fetch(`/in/${token}`, { method: 'POST', headers: body instanceof FormData ? headers : { 'content-type': 'application/json', ...headers }, body })
  const messages = async () => ((await owner.call('GET', `/api/rooms/${all}/messages`)).items as any[]).filter((m) => !m.event)
  const thread = async (id: string) => (await owner.call('GET', `/api/rooms/${all}/messages/${id}/thread`)).items as any[]
  const secret = (appId: string, body: unknown) => owner.try('PUT', `/api/rooms/${all}/apps/${appId}/secret`, body)
  const status = (s: string) => appText('status', L, { status: s })
  return { owner, mia, all, L, add, post, messages, thread, secret, status }
}

test('Other reads JANDI: body with its links, connectInfo as details, imageUrl never fetched; the first of text/content/body wins; a 300 KB body is refused', async () => {
  const { add, post, messages } = await setup()
  const { token, app } = await add(null, 'Pizza')
  expect(app.preset).toBeUndefined()
  // JANDI sends its own Accept; any is fine
  expect((await post(token, fixture('jandi/example.json'), { accept: 'application/vnd.tosslab.jandi-v2+json' })).status).toBe(200)
  await settle()
  let [m] = await messages()
  // the http link shows its label and links nowhere; connectInfo items are detail lines; nothing of imageUrl anywhere
  expect(m.appCard).toMatchObject({ title: '[PizzaHouse] You have a new Pizza order.', details: ['Topping: Pepperoni', 'Location: Empire State Building, 5th Ave, New York'] })
  expect(m.appCard.link).toBeUndefined()
  expect(JSON.stringify(m)).not.toContain('url_to_text')
  // four connectInfo items: three on the card, all in the plain text; the https link is the card's link
  expect((await post(token, fixture('jandi/three-info.json'))).status).toBe(200)
  await settle()
  m = (await messages()).at(-1)
  expect(m.appCard).toMatchObject({ title: 'Deploy finished on staging', details: ['Branch: main', 'Commit: a1b2c3d Fix the cart total', 'Duration: 3 min 12 s'], link: { url: 'https://ci.example.com/runs/42', host: 'ci.example.com' } })
  expect(m.body).toContain('Runner: linux-2')
  // a label that looks like another address shows the real one
  expect((await post(token, fixture('jandi/misleading-label.json'))).status).toBe(200)
  await settle()
  m = (await messages()).at(-1)
  expect(m.appCard.title).toBe('Please check https://evil.example.net/steal today')
  expect(m.appCard.link.host).toBe('evil.example.net')
  // Slack's text comes first when a body has both
  expect((await post(token, JSON.stringify({ text: 'Slack words', body: 'JANDI words' }))).status).toBe(200)
  await settle()
  expect((await messages()).at(-1).appCard.title).toBe('Slack words')
  // a non-string body is not JANDI (and nothing else to read: refused)
  expect((await post(token, JSON.stringify({ body: { x: 1 } }))).status).toBe(400)
  expect((await post(token, JSON.stringify({ body: 'x'.repeat(300 * 1024) }))).status).toBe(413)
})

test('preset rules: only for Other, fixed at create (no PATCH), the vendor name and the preset\'s switches; setSecret refuses a service that cannot sign; an unknown preset is refused, 401 with a secret', async () => {
  const { owner, all, add, post, secret, messages } = await setup()
  const bad = await owner.try('POST', `/api/rooms/${all}/apps`, { kind: 'sentry', preset: 'stripe' })
  expect(bad.status).toBe(400)
  expect((await owner.try('POST', `/api/rooms/${all}/apps`, { kind: 'other', preset: 'calendly' })).status).toBe(400)
  const { app, token } = await add('stripe')
  expect(app).toMatchObject({ kind: 'other', preset: 'stripe', name: 'Stripe', signed: false, events: { payment: true, refund: true, failed: true, dispute: true, subscription_ended: true, subscription_new: false } })
  // the preset cannot be changed; Other's own switch is not one of Stripe's
  expect((await owner.try('PATCH', `/api/rooms/${all}/apps/${app.id}`, { preset: 'notion' })).status).toBe(400)
  expect((await owner.try('PATCH', `/api/rooms/${all}/apps/${app.id}`, { events: { message: false } })).status).toBe(400)
  expect((await owner.call('PATCH', `/api/rooms/${all}/apps/${app.id}`, { events: { subscription_new: true } })).events.subscription_new).toBe(true)
  // the audit row names the preset
  const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room_app.add' AND target = ?").get(app.id) as { detail: string }
  expect(JSON.parse(row.detail).preset).toBe('stripe')
  // no signing: Notion, Jotform, plain Other
  for (const p of ['notion', 'jotform', null]) {
    const a = await add(p, p ? undefined : `Plain ${p}`)
    const r = await secret(a.app.id, { generate: true })
    expect([r.status, r.body.error.params?.reason]).toEqual([400, 'no_signing'])
  }
  // Stripe makes its own secret: Trina's would never match; a pasted one is checked by its shape
  expect((await secret(app.id, { generate: true })).status).toBe(400)
  const shape = await secret(app.id, { secret: 'not-a-stripe-secret-at-all' })
  expect(shape.status).toBe(400)
  expect(shape.body.error.message).toContain('Stripe')
  // a message from a preset app names its service (the logo), also on the room's messages
  await post(token, fixture('stripe/payment-intent-succeeded.json'))
  await settle()
  expect((await messages()).at(-1).app).toMatchObject({ kind: 'other', preset: 'stripe', name: 'Stripe' })
  // a preset this build does not know (a newer build's row): 400 without a secret, 401 with one; never read as Other
  const z = await add(null, 'Future')
  h.ctx.db.query("UPDATE room_apps SET preset = 'future_service' WHERE id = ?").run(z.app.id)
  expect((await post(z.token, JSON.stringify({ text: 'hi' }))).status).toBe(400)
  const list = (await owner.call('GET', `/api/rooms/${all}/apps`)).items as any[]
  expect(list.find((x) => x.id === z.app.id).preset).toBeUndefined()
  expect((await secret(z.app.id, { generate: true })).status).toBe(400)
  h.ctx.db.query("UPDATE room_apps SET secret_enc = 'x' WHERE id = ?").run(z.app.id)
  expect((await post(z.token, JSON.stringify({ text: 'hi' }))).status).toBe(401)
  // an app's address with a query never logs it
  expect(loggablePath(`/in/${z.token}?token=abc`)).toBe('/in/***')
})

test('Notion: the title, three properties, Status as the status line and Notion\'s link; a later run on the page joins its thread and changes the status; a retry posts once; odd shapes never crash', async () => {
  const { add, post, messages, thread, status, L } = await setup()
  const { token, app } = await add('notion')
  expect(app.events).toEqual({ entry: true })
  const body = fixture('notion/page-added.json')
  expect((await post(token, body)).status).toBe(200)
  expect((await post(token, body)).status).toBe(200) // the same event id: once
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: 'Notion', title: 'Quarterly report', details: ['Owner: Jamie Rivera', 'Due: 2026-11-30', 'Done: –'], status: status('In progress'),
    link: { host: 'www.notion.so' } })
  expect(ms[0].body).toContain(appText('notionLinked', L, { n: 2 }))
  // the next run: another event id, Status Done
  const next = JSON.parse(body)
  next.source.event_id = 'evt-2'; next.source.attempt = 1
  next.data.properties.Status.status.name = 'Done'
  expect((await post(token, JSON.stringify(next))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(status('Done'))
  expect((await thread(ms[0].id))[0].appCard.title).toBe(appText('notionUpdated', L))
  // a link off Notion's hosts is not shown; wrong-typed values are skipped; no properties: 400
  const odd = { data: { id: 'p2', url: 'https://evil.example/x', properties: { Name: { type: 'title', title: 'not an array' }, N: { type: 'number', number: 'x' }, S: { type: 'select', select: 7 }, P: null } } }
  expect((await post(token, JSON.stringify(odd))).status).toBe(200)
  await settle()
  const last = (await messages()).at(-1)
  expect(last.appCard.link).toBeUndefined()
  expect((await post(token, JSON.stringify({ data: { id: 'p3' } }))).status).toBe(400)
  expect((await post(token, '[]')).status).toBe(400)
})

test('Typeform: answers matched by field id, a file\'s name only, a payment\'s amount only; event_id dedupe; Typeform-Signature sha256=<base64> good / bad / missing', async () => {
  const { add, post, messages, secret, L } = await setup()
  const { token, app } = await add('typeform')
  const body = fixture('typeform/response.json')
  expect((await post(token, body)).status).toBe(200)
  expect((await post(token, body)).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: appText('formsNew', L, { form: 'Webhooks example' }), title: "What's it like to be a fan?: It's a lot of fun",
    details: ['What is your email address?: jamie@example.com', 'What is your first name?: Jamie', appText('formsMore', L, { n: 3 })] })
  expect(ms[0].appCard.link).toBeUndefined()
  expect(ms[0].body).toContain('Upload your CV: cv-jamie.pdf')
  expect(ms[0].body).not.toContain('api.typeform.com')
  expect(ms[0].body).not.toContain('4242')
  expect(ms[0].body).toContain('Card: 4.50')
  // a secret Trina makes (Typeform's secret field): then only signed requests
  const s = (await secret(app.id, { generate: true })).body.secret as string
  const other = body.replace('01HXTESTEVENT000000000001', '01HXTESTEVENT000000000002').replace('2026-11-14T09:38:22Z', new Date().toISOString())
  expect((await post(token, other)).status).toBe(401)
  expect((await post(token, other, { 'typeform-signature': `sha256=${hmac('wrong-secret-0000', other).digest('base64')}` })).status).toBe(401)
  expect((await post(token, other, { 'typeform-signature': hmac(s, other).digest('base64') })).status).toBe(401) // no prefix
  expect((await post(token, other, { 'typeform-signature': `sha256=${hmac(s, other).digest('base64')}` })).status).toBe(200)
  // signed without a submission time: refused (its signature has no time of its own); unsigned and unreadable: 400
  expect((await post(token, JSON.stringify({ event_id: 'e3', form_response: { token: 't' } }), { 'typeform-signature': `sha256=${hmac(s, JSON.stringify({ event_id: 'e3', form_response: { token: 't' } })).digest('base64')}` })).status).toBe(401)
})

test('Tally: option ids as their text, ticked boxes once, files by name; signed over JSON.stringify(body), the card from that parse; createdAt older than 2 days refused; eventId dedupe', async () => {
  const { add, post, messages, secret, L } = await setup()
  const { token, app } = await add('tally')
  const s = (await secret(app.id, { generate: true })).body.secret as string
  const obj = JSON.parse(fixture('tally/response.json'))
  obj.createdAt = new Date().toISOString()
  // Tally signs JSON.stringify of the body; it sends it pretty-printed here (other bytes, same parse)
  const raw = JSON.stringify(obj, null, 2)
  const sig = (b: string) => ({ 'tally-signature': hmac(s, b).digest('base64') })
  expect((await post(token, raw)).status).toBe(401)
  expect((await post(token, raw, sig(JSON.stringify(obj)))).status).toBe(200)
  expect((await post(token, raw, sig(JSON.stringify(obj)))).status).toBe(200) // the same eventId: once
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: appText('formsNew', L, { form: 'Webhook payload' }), title: 'Your name: Jamie Rivera', details: ['Email: jamie@example.com', 'Plan: Team', appText('formsMore', L, { n: 2 })] })
  expect(ms[0].body).toContain('Extras: Support, Training')
  expect(ms[0].body).not.toContain('Extras (Support)')
  expect(ms[0].body).toContain('Logo: logo.png')
  expect(ms[0].body).not.toContain('storage.tally.so')
  // duplicate keys: the signed parse (the last "formName") is what the card shows, never a second reading
  const dup = `{"eventId":"dup-1","eventType":"FORM_RESPONSE","createdAt":"${new Date().toISOString()}","data":{"responseId":"r-dup","formName":"Shown","formName":"Signed","fields":[{"label":"Q","type":"INPUT_TEXT","value":"A"}]}}`
  expect((await post(token, dup, sig(JSON.stringify(JSON.parse(dup))))).status).toBe(200)
  await settle()
  expect((await messages()).at(-1).appCard.kind).toBe(appText('formsNew', L, { form: 'Signed' }))
  // a signed body three days old: a replay
  const old = { ...obj, eventId: 'old-1', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }
  expect((await post(token, JSON.stringify(old), sig(JSON.stringify(old)))).status).toBe(401)
})

test('Jotform: multipart and urlencoded posts, labels from pretty or rawRequest, file parts ignored; submissionID dedupe; no secret possible', async () => {
  const { add, post, messages, L } = await setup()
  const { token } = await add('jotform')
  const fd = new FormData()
  fd.set('submissionID', '5781234567890')
  fd.set('formID', '231234567')
  fd.set('formTitle', 'Contact us')
  fd.set('pretty', 'Full Name:Jamie Rivera, E-mail:jamie@example.com, Message:Hello, I need a quote')
  fd.set('rawRequest', JSON.stringify({ q3_fullName: { first: 'Jamie', last: 'Rivera' } }))
  fd.set('upload', new File([new Uint8Array(1000)], 'evil.exe'))
  expect((await post(token, fd)).status).toBe(200)
  expect((await post(token, fd)).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: appText('formsNew', L, { form: 'Contact us' }), title: 'Full Name: Jamie Rivera', details: ['E-mail: jamie@example.com', 'Message: Hello, I need a quote'] })
  expect(ms[0].body).not.toContain('evil.exe')
  // urlencoded with rawRequest only
  const u = new URLSearchParams({ submissionID: '5781234567891', formTitle: 'Order', rawRequest: JSON.stringify({ q4_email: 'a@example.com', q3_fullName: { first: 'Sam', last: 'Lee' }, slug: 'x' }) })
  expect((await post(token, u.toString(), { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms.at(-1).appCard).toMatchObject({ title: 'Full Name: Sam Lee', details: ['Email: a@example.com'] })
  // JSON is not Jotform's; no submissionID: 400
  expect((await post(token, '{}')).status).toBe(415)
  expect((await post(token, 'formTitle=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(400)
  expect(jotformPretty('A:1, B:x, y, C:3')).toEqual([{ q: 'A', a: '1' }, { q: 'B', a: 'x, y' }, { q: 'C', a: '3' }])
})

test('Stripe: one card per payment (Checkout then its intent edits nothing new), refund and dispute join it, test mode, the dashboard link, zero-decimal JPY; Stripe-Signature t/v1 good, bad, stale, missing', async () => {
  const { add, post, messages, thread, secret, status, L } = await setup()
  const { token, app } = await add('stripe')
  expect((await post(token, fixture('stripe/checkout-session-completed.json'))).status).toBe(200)
  expect((await post(token, fixture('stripe/payment-intent-succeeded.json'))).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  const amount = money(L, 'usd', { minor: 4900 })
  expect(ms[0].appCard).toMatchObject({ kind: `${appText('paymentReceived', L)} · ${appText('testMode', L)}`, title: appText('amountFrom', L, { amount, name: 'Jamie Rivera' }),
    status: status(appText('statusSucceeded', L)), link: { url: 'https://dashboard.stripe.com/test/payments/pi_3TestPayment0001', host: 'dashboard.stripe.com' }, unverified: true })
  expect(ms[0].thread?.replyCount ?? 0).toBe(0)
  expect(JSON.stringify(ms[0])).not.toContain('jamie@example.com')
  // refund: a reply, the status line Refunded
  expect((await post(token, fixture('stripe/charge-refunded.json'))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms[0].appCard.status).toBe(status(appText('statusRefunded', L)))
  expect((await thread(ms[0].id))[0].appCard.title).toBe(appText('refundedAmount', L, { amount }))
  expect(JSON.stringify(ms)).not.toContain('4242')
  // a dispute joins the thread and shows in the room too
  expect((await post(token, fixture('stripe/dispute-created.json'))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms.at(-1)).toMatchObject({ threadRootId: ms[0].id, alsoInRoom: true, appCard: { title: appText('disputeOpened', L) } })
  // JPY is not divided; failed shows the failure message; subscription_new is off; ended is on
  expect((await post(token, fixture('stripe/payment-failed-jpy.json'))).status).toBe(200)
  expect((await post(token, fixture('stripe/subscription-created.json'))).status).toBe(200)
  expect((await post(token, fixture('stripe/subscription-deleted.json'))).status).toBe(200)
  await settle()
  ms = await messages()
  const failed = ms.find((m) => m.appCard.kind === appText('paymentFailed', L))
  expect(failed.appCard).toMatchObject({ title: money(L, 'jpy', { minor: 5000 }), details: ['Your card was declined.'], link: { url: 'https://dashboard.stripe.com/payments/pi_3TestFailed0001' } })
  expect(money('en', 'jpy', { minor: 5000 })).toBe('¥5,000')
  expect(ms.some((m) => m.appCard.kind === appText('subscriptionNew', L))).toBe(false)
  expect(ms.find((m) => m.appCard.kind === appText('subscriptionEnded', L)).appCard).toMatchObject({ title: 'Pro plan (monthly)', link: { url: 'https://dashboard.stripe.com/subscriptions/sub_1TestSub0001' } })
  // other events: skipped; no data.object: 400
  expect((await post(token, JSON.stringify({ id: 'evt_x', type: 'customer.updated', data: { object: {} } }))).status).toBe(200)
  expect((await post(token, JSON.stringify({ id: 'evt_y', type: 'charge.refunded' }))).status).toBe(400)
  expect((await post(token, JSON.stringify({ id: 'evt_z', type: 'charge.refunded', data: { object: { amount_refunded: 'lots', currency: 7, payment_intent: { evil: 1 } } } }))).status).toBe(200)
  // the signing secret, pasted as Stripe shows it (used literally, never base64-decoded)
  const whsec = 'whsec_' + crypto.randomBytes(24).toString('base64')
  expect((await secret(app.id, { secret: whsec })).status).toBe(200)
  const ev = JSON.stringify({ id: 'evt_sig1', type: 'payment_intent.succeeded', livemode: true, data: { object: { id: 'pi_sig1', amount: 100, currency: 'eur' } } })
  const sign = (t: number, b = ev, s = whsec) => `t=${t},v1=${hmac(s, `${t}.`, b).digest('hex')}`
  const now = Math.floor(Date.now() / 1000)
  expect((await post(token, ev)).status).toBe(401)
  expect((await post(token, ev, { 'stripe-signature': sign(now, ev, 'whsec_other') })).status).toBe(401)
  expect((await post(token, ev, { 'stripe-signature': sign(now - 600) })).status).toBe(401)
  expect((await post(token, ev, { 'stripe-signature': `t=${now},v1=${'0'.repeat(64)},v0=abc,${sign(now).split(',')[1]}` })).status).toBe(200)
  await settle()
  const signed = (await messages()).find((m) => m.appCard.link?.url?.endsWith('pi_sig1'))
  expect(signed.appCard.kind).toBe(appText('paymentReceived', L))
  expect(signed.appCard.unverified).toBeUndefined()
})

test('Shopify: the order card without email, phone or street; payment edits its status line; a refund joins it; the admin link from the shop domain; X-Shopify-Event-Id dedupe; X-Shopify-Hmac-SHA256', async () => {
  const { add, post, messages, thread, secret, status, L } = await setup()
  const { token, app } = await add('shopify')
  const hdr = (topic: string, id: string) => ({ 'x-shopify-topic': topic, 'x-shopify-shop-domain': 'acme-shop.myshopify.com', 'x-shopify-event-id': id })
  const order = fixture('shopify/orders-create.json')
  expect((await post(token, order, hdr('orders/create', 'e1'))).status).toBe(200)
  expect((await post(token, order, hdr('orders/create', 'e1'))).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  const total = money(L, 'USD', { major: 403 })
  expect(ms[0].appCard).toMatchObject({ kind: appText('newOrder', L, { order: '#9999' }), title: appText('orderItemsMany', L, { total, n: 4 }),
    details: [appText('orderLine', L, { n: 1, title: 'Aviator sunglasses' }), appText('orderLine', L, { n: 2, title: 'Mid-century lounger' }), 'Jamie · Ottawa'],
    status: status(appText('statusPending', L)), link: { url: 'https://admin.shopify.com/store/acme-shop/orders/5820982911946154' } })
  for (const leak of ['jamie@example.com', '555', 'Fake Street', 'Rivera']) expect(JSON.stringify(ms[0])).not.toContain(leak)
  // paid: the status line only, no reply
  const paid = JSON.stringify({ ...JSON.parse(order), financial_status: 'paid' })
  expect((await post(token, paid, hdr('orders/paid', 'e2'))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(status(appText('statusPaid', L)))
  expect(ms[0].thread?.replyCount ?? 0).toBe(0)
  // a refund: a reply in the order's thread
  expect((await post(token, fixture('shopify/refunds-create.json'), hdr('refunds/create', 'e3'))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms[0].appCard.status).toBe(status(appText('statusRefunded', L)))
  expect((await thread(ms[0].id))[0].appCard.title).toBe(appText('refundedAmount', L, { amount: money(L, 'USD', { major: 89.99 }) }))
  // fulfilled is off by default; an unknown topic: skipped; no topic: 400; a shop domain that is not myshopify: no link
  expect((await post(token, order, hdr('orders/fulfilled', 'e4'))).status).toBe(200)
  expect((await post(token, order, hdr('products/update', 'e5'))).status).toBe(200)
  expect((await post(token, order)).status).toBe(400)
  const other = JSON.stringify({ ...JSON.parse(order), id: 1, admin_graphql_api_id: null, name: '#1' })
  expect((await post(token, other, { ...hdr('orders/create', 'e6'), 'x-shopify-shop-domain': 'evil.example' })).status).toBe(200)
  await settle()
  expect((await messages()).at(-1).appCard.link).toBeUndefined()
  // the signing key, base64 over the raw bytes
  const key = 'shpss_' + crypto.randomBytes(16).toString('hex')
  expect((await secret(app.id, { secret: key })).status).toBe(200)
  const b2 = JSON.stringify({ ...JSON.parse(order), id: 2, admin_graphql_api_id: null, name: '#2' })
  expect((await post(token, b2, hdr('orders/create', 'e7'))).status).toBe(401)
  expect((await post(token, b2, { ...hdr('orders/create', 'e7'), 'x-shopify-hmac-sha256': hmac('nope-nope-nope-nope', b2).digest('base64') })).status).toBe(401)
  expect((await post(token, b2, { ...hdr('orders/create', 'e7'), 'x-shopify-hmac-sha256': hmac(key, b2).digest('base64') })).status).toBe(200)
})

test('Zendesk: the ticket card from the Copy body; an update changes the status, a solved ticket opened again shows in the room; dedupe by body and by id+status; tolerant read; signature with a strict timestamp; the public test secret is refused', async () => {
  const { add, post, messages, thread, secret, status, L } = await setup()
  const { token, app } = await add('zendesk')
  // the Copy body is what Zendesk sends, with its placeholders filled
  const tpl = roomAppZendeskBody('updated')
  expect(tpl).toContain('"event":"updated"')
  expect(JSON.parse(tpl.replace(/\{\{[^}]+\}\}/g, 'x'))).toMatchObject({ trina: 'zendesk', event: 'updated' })
  const created = fixture('zendesk/created.json')
  expect((await post(token, created)).status).toBe(200)
  expect((await post(token, created)).status).toBe(200) // a retry: the same body
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: `${appText('newTicket', L, { id: '35436' })} · Urgent`, title: 'Printer is on fire',
    details: [appText('fromName', L, { name: 'Jamie Rivera' }), appText('sentryAssigned', L, { name: 'Sam Lee' })], status: status('Open'),
    link: { url: 'https://acme.zendesk.com/agent/tickets/35436', host: 'acme.zendesk.com' } })
  const upd = (st: string, extra: Record<string, string> = {}) => JSON.stringify({ trina: 'zendesk', event: 'updated', id: '35436', title: 'Printer is on fire', status: st, priority: 'Urgent', requester: 'Jamie Rivera', assignee: 'Sam Lee', url: 'acme.zendesk.com/agent/tickets/35436', update: 'Replaced the fuse.', ...extra })
  expect((await post(token, upd('Solved'))).status).toBe(200)
  // the same change from a second trigger (another body: its event): once
  expect((await post(token, upd('Solved', { event: 'created' }))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(status('Solved'))
  expect((await thread(ms[0].id))).toHaveLength(1)
  // opened again: in the room too
  expect((await post(token, upd('Open', { update: 'It is smoking again.' }))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms.at(-1)).toMatchObject({ threadRootId: ms[0].id, alsoInRoom: true, appCard: { title: appText('ticketUpdated', L, { id: '35436' }) } })
  // updated switch off: skipped
  // a title with an unescaped quote breaks the JSON: the tolerant read of our template
  const broken = '{"trina":"zendesk","event":"created","id":"777","title":"The "big" one","status":"New","priority":"","requester":"A","assignee":"","url":"https://evil.example/x","update":""}'
  expect(tolerantZendesk(broken)).toMatchObject({ id: '777', title: 'The "big" one', status: 'New' })
  expect((await post(token, broken)).status).toBe(200)
  await settle()
  const big = (await messages()).at(-1)
  expect(big.appCard.title).toBe('The "big" one')
  expect(big.appCard.link).toBeUndefined()
  expect((await post(token, '{"id": broken')).status).toBe(400)
  expect((await post(token, JSON.stringify({ trina: 'zendesk', id: 'abc' }))).status).toBe(400)
  // the public test secret is refused; a real one is used: base64 HMAC of timestamp + body
  const t = await secret(app.id, { secret: ZENDESK_TEST_SECRET })
  expect(t.status).toBe(400)
  expect(t.body.error.message).toBe(appText('zendeskTestSecret', L))
  const key = crypto.randomBytes(24).toString('base64')
  expect((await secret(app.id, { secret: key })).status).toBe(200)
  const b = upd('Pending')
  const sig = (ts: string, body = b, k = key) => ({ 'x-zendesk-webhook-signature': hmac(k, ts, body).digest('base64'), 'x-zendesk-webhook-signature-timestamp': ts })
  const iso = new Date().toISOString()
  expect((await post(token, b)).status).toBe(401)
  expect((await post(token, b, sig('soon'))).status).toBe(401) // not a time
  expect((await post(token, b, sig(new Date(Date.now() - 10 * 60_000).toISOString()))).status).toBe(401)
  expect((await post(token, b, sig(iso, b, 'another-key-another-key'))).status).toBe(401)
  expect((await post(token, b, sig(String(Math.floor(Date.now() / 1000))))).status).toBe(200)
  expect((await post(token, b, sig(iso))).status).toBe(200) // the same body again: once (no new message)
  await settle()
  const replies = await thread(ms[0].id)
  expect(replies.filter((r) => r.appCard.details?.includes(status('Pending')))).toHaveLength(1)
})

test('a preset row\'s switches and name show in the list; the room\'s Other and preset apps keep their kinds for older readers', async () => {
  const { owner, all, add } = await setup()
  await add('tally')
  await add(null)
  const items = (await owner.call('GET', `/api/rooms/${all}/apps`)).items as any[]
  expect(items.map((i) => [i.kind, i.preset ?? null, Object.keys(i.events)])).toEqual([['other', 'tally', ['response']], ['other', null, ['message']]])
  // the row itself: kind 'other', preset 'tally'
  const rows = h.ctx.db.query('SELECT kind, preset FROM room_apps ORDER BY created_at').all()
  expect(rows).toEqual([{ kind: 'other', preset: 'tally' }, { kind: 'other', preset: null }])
  expect(roomAppsOf(h.ctx).presetOf({ kind: 'other', preset: 'future' })).toBeNull()
})

test('security review of #854, Zendesk: a comment that closes its quote and adds keys is refused; the Copy body escapes what outsiders write and the server decodes it; the link is this ticket on the pinned subdomain', async () => {
  const { add, post, messages, L } = await setup()
  const { token, app } = await add('zendesk')
  // the injected comment: valid JSON whose later keys would win (ticket 123, solved, another tenant)
  const inj = fixture('zendesk/quote-injection.json')
  expect(JSON.parse(inj).id).toBe('123')
  expect((await post(token, inj)).status).toBe(400)
  // the tolerant reader refuses a duplicated key too
  expect(tolerantZendesk(inj.replace('"update":"x"', '"update":"x"x"'))).toBeNull()
  // the same keys written with \u escapes ("id" is "id"): JSON.parse reads them as the keys, so they are refused too
  const esc = '{"trina":"zendesk","event":"updated","id":"777","title":"t","status":"Open","priority":"","requester":"","assignee":"","url":"acme.zendesk.com/agent/tickets/777","update":"x","\\u0069d":"123","\\u0073tatus":"solved"}'
  expect(JSON.parse(esc).id).toBe('123')
  expect(zendeskDuplicateKey(esc)).toBe(true)
  expect((await post(token, esc)).status).toBe(400)
  expect(await messages()).toHaveLength(0)
  // every outsider-written placeholder is escaped in the Copy body; id, status, priority and url are Zendesk's own
  for (const ph of ['ticket.title', 'ticket.requester.name', 'ticket.assignee.name', 'ticket.latest_public_comment']) expect(roomAppZendeskBody('created')).toContain(`{{${ph} | escape}}`)
  // an escaped body: decoded for the card, still its own ticket
  expect((await post(token, fixture('zendesk/escaped.json'))).status).toBe(200)
  await settle()
  let [m] = await messages()
  expect(m.appCard).toMatchObject({ kind: `${appText('newTicket', L, { id: '778' })} · Normal`, title: 'Say "hi" & <bye>', details: [appText('fromName', L, { name: "O'Brien" })], status: appText('status', L, { status: 'Open' }),
    link: { url: 'https://acme.zendesk.com/agent/tickets/778' } })
  expect(m.body).toContain('"id":"123"')
  // pinned to acme on first sight: another subdomain, or another ticket's path, gets no link
  expect((h.ctx.db.query('SELECT preset_pin FROM room_apps WHERE id = ?').get(app.id) as { preset_pin: string }).preset_pin).toBe('acme')
  const one = (id: string, url: string) => JSON.stringify({ trina: 'zendesk', event: 'created', id, title: `T${id}`, status: 'Open', priority: '', requester: '', assignee: '', url, update: '' })
  for (const [id, url] of [['801', 'evil.zendesk.com/agent/tickets/801'], ['802', 'acme.zendesk.com/agent/tickets/1'], ['803', 'acme.zendesk.com/agent/tickets/803?x=1'], ['804', 'acme.zendesk.com.evil.example/agent/tickets/804']]) {
    expect((await post(token, one(id!, url!))).status).toBe(200)
  }
  expect((await post(token, one('805', 'acme.zendesk.com/agent/tickets/805'))).status).toBe(200)
  await settle()
  const byTitle = new Map((await messages()).map((x) => [x.appCard.title, x.appCard.link?.url]))
  expect([byTitle.get('T801'), byTitle.get('T802'), byTitle.get('T803'), byTitle.get('T804')]).toEqual([undefined, undefined, undefined, undefined])
  expect(byTitle.get('T805')).toBe('https://acme.zendesk.com/agent/tickets/805')
  // the dedupe key covers the assignee and priority: a reassignment is a new change
  const upd = (assignee: string, priority: string) => JSON.stringify({ trina: 'zendesk', event: 'updated', id: '805', title: 'T805', status: 'Open', priority, requester: '', assignee, url: 'acme.zendesk.com/agent/tickets/805', update: '' })
  expect((await post(token, upd('Sam', ''))).status).toBe(200)
  expect((await post(token, upd('Sam', 'High'))).status).toBe(200)
  await settle()
  m = (await messages()).find((x) => x.appCard.title === 'T805')
  expect(m.thread.replyCount).toBe(2)
})

test('security review of #854, Shopify and Typeform: the unsigned topic must agree with the body; a signed body replayed under a new event id posts nothing; the store is pinned; a signed Typeform response older than 2 days is refused', async () => {
  const { add, post, messages, secret } = await setup()
  const { token, app } = await add('shopify')
  const key = 'shpss_' + crypto.randomBytes(16).toString('hex')
  expect((await secret(app.id, { secret: key })).status).toBe(200)
  const signed = (b: string, topic: string, id: string, shop = 'acme-shop.myshopify.com') => post(token, b, { 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-event-id': id, 'x-shopify-hmac-sha256': hmac(key, b).digest('base64') })
  const order = fixture('shopify/orders-create.json')
  expect((await signed(order, 'orders/create', 'a1')).status).toBe(200)
  await settle()
  expect(await messages()).toHaveLength(1)
  // a pending order's signed body relabelled as paid / cancelled / fulfilled: nothing changes
  for (const t of ['orders/paid', 'orders/cancelled', 'orders/fulfilled']) expect((await signed(order, t, `t-${t}`)).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].thread?.replyCount ?? 0).toBe(0)
  expect(ms[0].appCard.status).toBe(appText('status', 'ko', { status: appText('statusPending', 'ko') }))
  // the same signed body under a new event id: once
  const b2 = JSON.stringify({ ...JSON.parse(order), id: 2, admin_graphql_api_id: null, name: '#2' })
  expect((await signed(b2, 'orders/create', 'b1')).status).toBe(200)
  expect((await signed(b2, 'orders/create', 'b2')).status).toBe(200)
  // another store's name: the store pinned first (acme-shop) keeps its link, another gets none
  const b3 = JSON.stringify({ ...JSON.parse(order), id: 3, admin_graphql_api_id: null, name: '#3' })
  expect((await signed(b3, 'orders/create', 'c1', 'evil-shop.myshopify.com')).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms.filter((m) => m.appCard.kind.includes('#2'))).toHaveLength(1)
  expect(ms.find((m) => m.appCard.kind.includes('#3')).appCard.link).toBeUndefined()
  expect(ms.find((m) => m.appCard.kind.includes('#2')).appCard.link.url).toBe('https://admin.shopify.com/store/acme-shop/orders/2')

  const tf = await add('typeform')
  const s = (await secret(tf.app.id, { generate: true })).body.secret as string
  const old = JSON.parse(fixture('typeform/response.json'))
  old.event_id = 'old-tf'; old.form_response.submitted_at = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const ob = JSON.stringify(old)
  expect((await post(tf.token, ob, { 'typeform-signature': `sha256=${hmac(s, ob).digest('base64')}` })).status).toBe(401)
  old.event_id = 'new-tf'; old.form_response.submitted_at = new Date().toISOString()
  const nb = JSON.stringify(old)
  expect((await post(tf.token, nb, { 'typeform-signature': `sha256=${hmac(s, nb).digest('base64')}` })).status).toBe(200)
})

test('the pinned service account: Regenerate clears it; saving a secret clears it; with a secret only a signed request pins it (Zendesk and Shopify)', async () => {
  const { owner, all, add, post, secret } = await setup()
  const pinOf = (id: string) => (h.ctx.db.query('SELECT preset_pin FROM room_apps WHERE id = ?').get(id) as { preset_pin: string | null }).preset_pin
  const ticket = (id: string, sub: string) => JSON.stringify({ trina: 'zendesk', event: 'created', id, title: `T${id}`, status: 'Open', priority: '', requester: '', assignee: '', url: `${sub}.zendesk.com/agent/tickets/${id}`, update: '' })
  const z = await add('zendesk')
  // an unsigned request pins first (someone who knows the URL)
  expect((await post(z.token, ticket('1', 'evil'))).status).toBe(200)
  expect(pinOf(z.app.id)).toBe('evil')
  // Regenerate forgets it; the next request pins its own
  const rotated = await owner.call('POST', `/api/rooms/${all}/apps/${z.app.id}/rotate`)
  expect(pinOf(z.app.id)).toBeNull()
  const token = rotated.address.split('/in/')[1] as string
  expect((await post(token, ticket('2', 'evil'))).status).toBe(200)
  expect(pinOf(z.app.id)).toBe('evil')
  // saving a secret forgets it too; an unsigned request is then refused and pins nothing; a signed one pins
  const key = crypto.randomBytes(24).toString('base64')
  expect((await secret(z.app.id, { secret: key })).status).toBe(200)
  expect(pinOf(z.app.id)).toBeNull()
  expect((await post(token, ticket('3', 'evil'))).status).toBe(401)
  expect(pinOf(z.app.id)).toBeNull()
  const b = ticket('4', 'acme'), ts = new Date().toISOString()
  expect((await post(token, b, { 'x-zendesk-webhook-signature': hmac(key, ts, b).digest('base64'), 'x-zendesk-webhook-signature-timestamp': ts })).status).toBe(200)
  expect(pinOf(z.app.id)).toBe('acme')
  // taking the secret away keeps the pin (nothing new to trust)
  expect((await secret(z.app.id, { secret: null })).status).toBe(200)
  expect(pinOf(z.app.id)).toBe('acme')

  // Shopify: the same rules for the store handle
  const s = await add('shopify')
  const order = fixture('shopify/orders-create.json')
  expect((await post(s.token, order, { 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': 'evil-shop.myshopify.com', 'x-shopify-event-id': 'p1' })).status).toBe(200)
  expect(pinOf(s.app.id)).toBe('evil-shop')
  await owner.call('POST', `/api/rooms/${all}/apps/${s.app.id}/rotate`)
  expect(pinOf(s.app.id)).toBeNull()
})

test('eventsSeen: the switch keys an event has arrived for, also with the switch off; keys only; nothing before the first event', async () => {
  const { owner, all, add, post } = await setup()
  const { token, app } = await add('shopify')
  expect(app.eventsSeen).toEqual([])
  const hdr = (topic: string, id: string) => ({ 'x-shopify-topic': topic, 'x-shopify-shop-domain': 'acme-shop.myshopify.com', 'x-shopify-event-id': id })
  const order = fixture('shopify/orders-create.json')
  expect((await post(token, order, hdr('orders/create', 's1'))).status).toBe(200)
  // fulfilled is off by default: it still counts as arrived (the settings must not say "Not set up")
  const fulfilled = JSON.stringify({ ...JSON.parse(order), fulfillment_status: 'fulfilled' })
  expect((await post(token, fulfilled, hdr('orders/fulfilled', 's2'))).status).toBe(200)
  // a skipped topic and an unreadable body add nothing
  expect((await post(token, order, hdr('products/update', 's3'))).status).toBe(200)
  expect((await post(token, '{', hdr('orders/paid', 's4'))).status).toBe(400)
  const item = ((await owner.call('GET', `/api/rooms/${all}/apps`)).items as any[]).find((i) => i.id === app.id)
  expect(item.eventsSeen).toEqual(['order', 'fulfilled'])
  // only switch keys ever: a stored value that is not one is not shown
  h.ctx.db.query(`UPDATE room_apps SET events_seen = '["order","jamie@example.com",7]' WHERE id = ?`).run(app.id)
  expect(((await owner.call('GET', `/api/rooms/${all}/apps`)).items as any[]).find((i) => i.id === app.id).eventsSeen).toEqual(['order'])
})
