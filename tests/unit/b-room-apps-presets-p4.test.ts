// Apps in rooms, part 2 phase 4 (docs/DECISIONS.md "Apps in rooms: Jira, HubSpot and more services", plan
// docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md; QA TC-1634): Jira (its Copy body, quote injection, the
// pinned site), HubSpot (custom body and all properties, never email or phone), and the regional services Toss Payments
// (its signature, two events for one transfer), Channel Talk (?token=, the team's own chats skipped) and PortOne
// (Standard Webhooks, both webhook versions). Cards, threads, switches, delivery keys; bodies with fields missing or of
// the wrong type never crash.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { roomAppJiraBody, RoomApp, RoomAppRef, type Locale } from '@mycel/shared/api'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { appText } from '../../server/src/rooms/apps/text'
import { standardKey, verifySignature } from '../../server/src/rooms/apps/signatures'
import { JIRA_KEYS } from '../../server/src/rooms/apps/presets/jira'
import { duplicateKey } from '../../server/src/rooms/apps/presets/common'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const settle = () => new Promise((r) => setTimeout(r, 5))
const fixture = (p: string) => readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'room-apps', p), 'utf8')
const hmac = (secret: string | Buffer, ...parts: string[]) => { const m = crypto.createHmac('sha256', secret); for (const p of parts) m.update(p); return m }

async function setup() {
  h = await harness('b-room-apps-presets-p4', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const rooms = (await owner.call('GET', '/api/rooms')).items as any[]
  const all = rooms.find((r) => r.kind === 'all')!.id as string
  const L = teamDefaultLocale(h.ctx.db) as Locale
  const add = async (preset: string, c: Client = owner) => {
    const r = await c.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', preset })
    return { app: r.app, token: (r.address as string).split('/in/')[1]! }
  }
  const post = (token: string, body: string, headers: Record<string, string> = {}, query = '') =>
    h.fetch(`/in/${token}${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  const messages = async () => ((await owner.call('GET', `/api/rooms/${all}/messages`)).items as any[]).filter((m) => !m.event)
  const thread = async (id: string) => (await owner.call('GET', `/api/rooms/${all}/messages/${id}/thread`)).items as any[]
  const secret = (appId: string, body: unknown) => owner.try('PUT', `/api/rooms/${all}/apps/${appId}/secret`, body)
  const patch = (appId: string, body: unknown) => owner.call('PATCH', `/api/rooms/${all}/apps/${appId}`, body)
  const status = (s: string) => appText('status', L, { status: s })
  return { owner, mia, all, L, add, post, messages, thread, secret, patch, status }
}

test('Jira: the Copy body escapes what people write and is valid JSON once filled; created, transitioned and commented make one thread; a key named twice is refused; the link is this key on the pinned site', async () => {
  // the template: every person-written smart value through .jsonEncode, quotes around it (jsonEncode adds none)
  for (const ev of ['created', 'transitioned', 'commented'] as const) {
    const b = roomAppJiraBody(ev)
    for (const ph of ['issue.summary', 'issue.status.name', 'issue.assignee.displayName']) expect(b).toContain(`"{{${ph}.jsonEncode}}"`)
    if (ev === 'commented') expect(b).toContain('"{{comment.body.jsonEncode}}"')
    else expect(b).not.toContain('comment')
    // filled in the way Jira does it (jsonEncode escapes, plain values pasted as they are): valid JSON, no key twice
    const filled = b.replace(/\{\{([a-zA-Z.]+)\.jsonEncode\}\}/g, () => 'He said \\"hi\\" \\\\ bye').replace('{{issue.key}}', 'OPS-1').replace('{{issue.url}}', 'https://a.atlassian.net/browse/OPS-1')
    expect(JSON.parse(filled).event).toBe(ev)
    expect(duplicateKey(filled, JIRA_KEYS)).toBe(false)
  }
  const { add, post, messages, thread, patch, L, status } = await setup()
  const { token, app } = await add('jira')
  expect(app).toMatchObject({ preset: 'jira', name: 'Jira', events: { created: true, transitioned: true, commented: false } })
  expect((await post(token, fixture('jira/created.json'))).status).toBe(200)
  // the same body again (two flows, or a retry): once
  expect((await post(token, fixture('jira/created.json'))).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: appText('jiraNew', L, { key: 'OPS-142' }), title: 'Checkout page shows the wrong "total"', details: [appText('sentryAssigned', L, { name: 'Sam Lee' })], status: status('To Do'),
    link: { url: 'https://acme-example.atlassian.net/browse/OPS-142', host: 'acme-example.atlassian.net' } })
  expect(ms[0].app.preset).toBe('jira')
  // transitioned: a reply, the status line follows
  expect((await post(token, fixture('jira/transitioned.json'))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(status('In Progress'))
  let replies = await thread(ms[0].id)
  expect(replies.at(-1).appCard.title).toBe(appText('jiraMoved', L, { status: 'In Progress' }))
  // commented: off by default (skipped); on: a reply with its first line, the whole comment in the text
  expect((await post(token, fixture('jira/commented.json'))).status).toBe(200)
  await settle()
  expect((await thread(ms[0].id)).length).toBe(replies.length)
  await patch(app.id, { events: { commented: true } })
  const c2 = fixture('jira/commented.json').replace('Fix coming today.', 'Fix coming tonight.')
  expect((await post(token, c2)).status).toBe(200)
  await settle()
  replies = await thread(ms[0].id)
  expect(replies.at(-1).appCard).toMatchObject({ title: appText('jiraCommentBy', L, { name: 'Jamie Rivera' }), details: ['Found it: rounding in the tax step.'] })
  // a summary that closed its quote and added keys (a flow without .jsonEncode): refused, nothing posted
  expect((await post(token, fixture('jira/injection.json'))).status).toBe(400)
  const esc = JSON.stringify({ trina: 'jira', event: 'created', key: 'OPS-150', title: 't', status: 'To Do', assignee: '', url: '' }).replace('}', ',"\\u006bey":"OPS-1"}')
  expect(JSON.parse(esc).key).toBe('OPS-1')
  expect((await post(token, esc)).status).toBe(400)
  // not ours, a bad key or event, wrong types: 400, never a crash
  for (const b of ['{"key":"OPS-1"}', '{"trina":"jira","event":"created","key":"not a key"}', '{"trina":"jira","event":"deleted","key":"OPS-1"}', '{"trina":"jira","event":"created","key":7}', '[]', 'x'])
    expect((await post(token, b)).status).toBe(400)
  // another site, another key's page, a lookalike host: no link (the site pinned on first sight is acme-example)
  const one = (key: string, url: string) => JSON.stringify({ trina: 'jira', event: 'created', key, title: `T ${key}`, status: 'To Do', assignee: '', url })
  for (const [k, u] of [['OPS-201', 'https://evil.atlassian.net/browse/OPS-201'], ['OPS-202', 'https://acme-example.atlassian.net/browse/OPS-1'], ['OPS-203', 'https://acme-example.atlassian.net.evil.example/browse/OPS-203'], ['OPS-204', 'https://acme-example.atlassian.net/browse/OPS-204?x=1']])
    expect((await post(token, one(k!, u!))).status).toBe(200)
  await settle()
  const links = new Map((await messages()).map((m) => [m.appCard.title, m.appCard.link?.url]))
  expect(['T OPS-201', 'T OPS-202', 'T OPS-203', 'T OPS-204'].map((t) => links.get(t))).toEqual([undefined, undefined, undefined, undefined])
})

test('Jira and HubSpot take no secret (no_signing); the regional services take their own, checked by shape', async () => {
  const { add, secret } = await setup()
  for (const p of ['jira', 'hubspot']) {
    const { app } = await add(p)
    const r = await secret(app.id, { secret: 'x'.repeat(20) })
    expect(r.status).toBe(400)
    expect(r.body.error.params.reason).toBe('no_signing')
  }
  const toss = await add('toss_payments')
  expect((await secret(toss.app.id, { secret: 'not-hex-'.repeat(8) })).status).toBe(400)
  expect((await secret(toss.app.id, { generate: true })).status).toBe(400)
  expect((await secret(toss.app.id, { secret: 'ab'.repeat(32) })).status).toBe(200)
  const po = await add('portone')
  expect((await secret(po.app.id, { secret: 'hello-not-a-secret-at-all' })).status).toBe(400)
  expect((await secret(po.app.id, { secret: `whsec_${crypto.randomBytes(32).toString('base64')}` })).status).toBe(200)
  expect((await secret(po.app.id, { secret: crypto.randomBytes(32).toString('base64') })).status).toBe(200)
  const ct = await add('channel_talk')
  expect((await secret(ct.app.id, { secret: 'short' })).status).toBe(400)
  expect((await secret(ct.app.id, { secret: 'ct-token-1' })).status).toBe(200)
})

test('HubSpot: the custom body per object and the all-properties shape; email and phone never shown; one thread per record, its stage on the status line; the link only with the account number, pinned', async () => {
  const { add, post, messages, thread, L } = await setup()
  const { token, app } = await add('hubspot')
  expect(app.events).toEqual({ deal: true, contact: true, ticket: true })
  expect((await post(token, fixture('hubspot/deal.json'))).status).toBe(200)
  expect((await post(token, fixture('hubspot/contact.json'))).status).toBe(200)
  expect((await post(token, fixture('hubspot/all-properties.json'))).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(3)
  const deal = ms.find((m) => m.appCard.title === 'Example Co. annual plan')
  expect(deal.appCard).toMatchObject({ kind: appText('hubspotDeal', L), details: ['12000'], status: appText('hubspotStage', L, { stage: 'contractsent' }) })
  expect(deal.appCard.link).toBeUndefined()
  const contact = ms.find((m) => m.appCard.title === 'Jamie Rivera')
  expect(contact.appCard).toMatchObject({ kind: appText('hubspotContact', L), details: ['Example Co.'] })
  // a person's name from an unsigned request (HubSpot can't sign) is marked; a deal's name is not a person
  expect(contact.appCard.unverified).toBe(true)
  expect(deal.appCard.unverified).toBeUndefined()
  expect(JSON.stringify(ms)).not.toContain('jamie@example.com')
  expect(JSON.stringify(ms)).not.toContain('555 0100')
  const all = ms.find((m) => m.appCard.title === 'Spring renewal')
  expect(all.appCard.link.url).toBe('https://app.hubspot.com/contacts/62515/record/0-3/7001')
  // the next stage of the same deal: a reply, the status line follows; another account's number: no link
  expect((await post(token, JSON.stringify({ object: 'deal', id: '18233390012', name: 'Example Co. annual plan', amount: '12000', stage: 'closedwon' }))).status).toBe(200)
  expect((await post(token, JSON.stringify({ object: 'deal', id: '9', name: 'Other account', portal: '1111' }))).status).toBe(200)
  await settle()
  ms = await messages()
  expect(ms.find((m) => m.appCard.title === 'Example Co. annual plan').appCard.status).toBe(appText('hubspotStage', L, { stage: 'closedwon' }))
  expect((await thread(deal.id)).length).toBeGreaterThan(0)
  expect(ms.find((m) => m.appCard.title === 'Other account').appCard.link).toBeUndefined()
  // nothing to tell the object or no record id: 400
  for (const b of ['{"id":"1"}', '{"object":"deal"}', '{"object":"deal","id":"x1"}', '{"object":"company","id":"1"}', 'null']) expect((await post(token, b)).status).toBe(400)
})

test('Toss Payments: a payment card with the amount and order name, never card, phone or secret; a transfer reported by both events shows once; a cancel joins the thread; the signature when a key is saved (text or hex bytes)', async () => {
  const { add, post, messages, thread, patch, secret, L, status } = await setup()
  const { token, app } = await add('toss_payments')
  expect(app.events).toEqual({ payment: true, cancelled: true, waiting: false, failed: false })
  expect((await post(token, fixture('toss_payments/payment-done.json'))).status).toBe(200)
  await settle()
  let [m] = await messages()
  expect(m.appCard).toMatchObject({ kind: appText('paymentReceived', L), details: ['Spring sale tote bag', '카드', appText('orderIdLine', L, { id: 'order-20261114-0001' })], status: status(appText('statusPaid', L)) })
  expect(m.appCard.title).toContain('15,000')
  expect(m.appCard.link).toBeUndefined()
  for (const leak of ['48902300', '01012345678', 'ps_example_secret', 'gift']) expect(JSON.stringify(await messages())).not.toContain(leak)
  // the same event again: once; cancelled: a reply and the status line
  expect((await post(token, fixture('toss_payments/payment-done.json'))).status).toBe(200)
  expect((await post(token, fixture('toss_payments/canceled.json'))).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard.status).toBe(status(appText('statusCancelled', L)))
  expect((await thread(ms[0].id)).at(-1).appCard.title).toBe(appText('paymentCancelled', L))
  // a virtual account: waiting (switch on), then DEPOSIT_CALLBACK and PAYMENT_STATUS_CHANGED both say DONE: the card's
  // status line changes once, no reply
  await patch(app.id, { events: { waiting: true } })
  const waiting = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-14T10:24:00.000000', data: { orderId: 'order-20261114-0002', orderName: 'Gift card', status: 'WAITING_FOR_DEPOSIT', totalAmount: 50000, currency: 'KRW', method: '가상계좌', virtualAccount: { accountNumber: 'X1234567890', customerName: 'Hidden Name' } } })
  expect((await post(token, waiting)).status).toBe(200)
  expect((await post(token, fixture('toss_payments/deposit-callback.json'))).status).toBe(200)
  expect((await post(token, waiting.replace('WAITING_FOR_DEPOSIT', 'DONE').replace('10:24:00', '10:25:01'))).status).toBe(200)
  await settle()
  const va = (await messages()).find((x) => x.appCard.details.some((d: string) => d.includes('order-20261114-0002')))
  expect(va.appCard.status).toBe(status(appText('statusPaid', L)))
  expect(await thread(va.id)).toHaveLength(0)
  expect(JSON.stringify(await messages())).not.toContain('X1234567890')
  expect(JSON.stringify(await messages())).not.toContain('Hidden Name')
  // other events are read and skipped; broken ones 400
  expect((await post(token, JSON.stringify({ eventType: 'BILLING_DELETED', createdAt: 'x', data: { billingKey: 'b', reason: 'r' } }))).status).toBe(200)
  for (const b of ['{}', '{"eventType":"PAYMENT_STATUS_CHANGED"}', '{"eventType":"PAYMENT_STATUS_CHANGED","data":{"orderId":"a b","status":"DONE"}}', '{"eventType":"PAYMENT_STATUS_CHANGED","data":{"orderId":"o1","status":5}}'])
    expect((await post(token, b)).status).toBe(400)
  // a security key saved: only signed requests, the key as text or as its hex bytes
  const key = crypto.randomBytes(32).toString('hex')
  expect((await secret(app.id, { secret: key })).status).toBe(200)
  const body = fixture('toss_payments/payment-done.json').replace('order-20261114-0001', 'order-20261114-0009')
  const time = new Date().toISOString().replace('Z', '+00:00')
  expect((await post(token, body)).status).toBe(401)
  expect((await post(token, body, { 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-signature': `v1:${hmac('wrong', body, `:${time}`).digest('base64')}` })).status).toBe(401)
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  expect((await post(token, body, { 'tosspayments-webhook-transmission-time': old, 'tosspayments-webhook-signature': `v1:${hmac(key, body, `:${old}`).digest('base64')}` })).status).toBe(401)
  expect((await post(token, body, { 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-signature': `v1:${hmac('wrong', body).digest('base64')},v1:${hmac(key, body, `:${time}`).digest('base64')}` })).status).toBe(200)
  const body2 = body.replace('order-20261114-0009', 'order-20261114-0010')
  expect((await post(token, body2, { 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-signature': `v1:${hmac(Buffer.from(key, 'hex'), body2, `:${time}`).digest('base64')}` })).status).toBe(200)
})

test('Channel Talk: a new chat with the customer\'s name and first message, then their messages in its thread; team replies off by default; the team\'s own chats skipped; email and phone never shown; ?token= once a token is saved', async () => {
  const { add, post, messages, thread, patch, secret, L } = await setup()
  const { token, app } = await add('channel_talk')
  expect(app.events).toEqual({ new_chat: true, customer_message: true, manager_message: false })
  expect((await post(token, fixture('channel_talk/user-chat.json'))).status).toBe(200)
  expect((await post(token, fixture('channel_talk/message-user.json'))).status).toBe(200)
  // the same message again: once
  expect((await post(token, fixture('channel_talk/message-user.json'))).status).toBe(200)
  expect((await post(token, fixture('channel_talk/message-manager.json'))).status).toBe(200)
  expect((await post(token, fixture('channel_talk/message-group.json'))).status).toBe(200)
  await settle()
  let ms = await messages()
  expect(ms).toHaveLength(1)
  expect(ms[0].appCard).toMatchObject({ kind: appText('channelChatFrom', L, { name: 'Jamie Rivera' }), title: "Hi, my order hasn't arrived yet." })
  let replies = await thread(ms[0].id)
  expect(replies.map((r: any) => r.appCard.title)).toEqual([appText('channelCustomerFrom', L, { name: 'Jamie Rivera' })])
  expect(replies[0].appCard.details).toEqual(['The order number is 1042.'])
  // names from requests without Channel Talk's token are marked
  expect(ms[0].appCard.unverified).toBe(true)
  expect(replies[0].appCard.unverified).toBe(true)
  const text = JSON.stringify(ms) + JSON.stringify(replies)
  for (const leak of ['jamie@example.com', '+82 10', 'Seoul', 'Team lunch', 'sam@example.com']) expect(text).not.toContain(leak)
  // team replies on: in the thread with the manager's name
  await patch(app.id, { events: { manager_message: true } })
  expect((await post(token, fixture('channel_talk/message-manager.json').replace('msg-002', 'msg-004'))).status).toBe(200)
  // the chat closed: its status line, no reply
  expect((await post(token, fixture('channel_talk/user-chat.json').replace('"opened"', '"closed"'))).status).toBe(200)
  await settle()
  ms = await messages()
  replies = await thread(ms[0].id)
  expect(replies.at(-1).appCard.title).toBe(appText('channelManager', L, { name: 'Sam Lee' }))
  expect(ms[0].appCard.status).toBe(appText('status', L, { status: 'closed' }))
  for (const b of ['{"type":"message"}', '{"type":"message","entity":{"id":"bad id","chatId":"c","personType":"user"}}', '{"entity":{}}']) expect((await post(token, b)).status).toBe(400)
  expect((await post(token, JSON.stringify({ type: 'user', entity: { id: 'u' } }))).status).toBe(200)
  // a token saved: Channel Talk's ?token= must match (the Webhook URL's own token is still needed too)
  expect((await secret(app.id, { secret: 'ct-token-12345' })).status).toBe(200)
  const b = fixture('channel_talk/message-user.json').replace('msg-001', 'msg-010')
  expect((await post(token, b)).status).toBe(401)
  expect((await post(token, b, {}, '?token=wrong-token-0')).status).toBe(401)
  expect((await post(token, b, {}, '?token=ct-token-12345&token=ct-token-12345')).status).toBe(401)
  expect((await post(token, b, {}, '?token=ct-token-12345')).status).toBe(200)
  // with the token: the name is not marked
  await settle()
  const signed = (await thread((await messages())[0].id)).at(-1)
  expect(signed.appCard.details).toEqual(['The order number is 1042.'])
  expect(signed.appCard.unverified).toBeUndefined()
})

test('PortOne: Standard Webhooks (whsec_ or not), the payment id and state without an amount, both webhook versions, webhook-id dedupe; other types skipped', async () => {
  const { add, post, messages, thread, secret, L, status } = await setup()
  const { token, app } = await add('portone')
  expect(app.events).toEqual({ payment: true, cancelled: true, failed: true, virtual_account: false })
  const paid = fixture('portone/paid.json')
  expect((await post(token, paid, { 'webhook-id': 'msg_1' })).status).toBe(200)
  expect((await post(token, paid, { 'webhook-id': 'msg_1' })).status).toBe(200)
  expect((await post(token, fixture('portone/cancelled.json'), { 'webhook-id': 'msg_2' })).status).toBe(200)
  expect((await post(token, fixture('portone/legacy.json'))).status).toBe(200)
  for (const t of ['Transaction.Ready', 'BillingKey.Issued', 'Transaction.DisputeCreated']) expect((await post(token, JSON.stringify({ type: t, timestamp: 'x', data: { paymentId: 'p1', billingKey: 'b' } }))).status).toBe(200)
  await settle()
  const ms = await messages()
  expect(ms).toHaveLength(2)
  const p = ms.find((m) => m.appCard.title === appText('paymentOf', L, { id: 'example-payment-id' }))
  expect(p.appCard).toMatchObject({ kind: appText('paymentReceived', L), details: [], status: status(appText('statusCancelled', L)) })
  expect((await thread(p.id)).at(-1).appCard.title).toBe(appText('paymentCancelled', L))
  expect(ms.find((m) => m.appCard.title === appText('paymentOf', L, { id: 'legacy-payment-id' })).appCard.kind).toBe(appText('paymentFailed', L))
  for (const b of ['{"type":"Transaction.Paid","data":{}}', '{"type":"Transaction.Paid","data":{"paymentId":"has space"}}', '{"status":"Paid"}', '"x"']) expect((await post(token, b)).status).toBe(400)
  // a secret saved: Standard Webhooks' signature over id.timestamp.body with the base64-decoded key
  const raw = crypto.randomBytes(32)
  expect((await secret(app.id, { secret: `whsec_${raw.toString('base64')}` })).status).toBe(200)
  const body = paid.replace('example-payment-id', 'pay-signed-1')
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = (k: Buffer, id: string, t: string, b: string) => `v1,${hmac(k, `${id}.${t}.`, b).digest('base64')}`
  expect((await post(token, body)).status).toBe(401)
  expect((await post(token, body, { 'webhook-id': 'm9', 'webhook-timestamp': ts, 'webhook-signature': sig(crypto.randomBytes(32), 'm9', ts, body) })).status).toBe(401)
  const stale = String(Math.floor(Date.now() / 1000) - 600)
  expect((await post(token, body, { 'webhook-id': 'm9', 'webhook-timestamp': stale, 'webhook-signature': sig(raw, 'm9', stale, body) })).status).toBe(401)
  // the literal "whsec_…" text as the key is wrong (only the decoded bytes are)
  expect((await post(token, body, { 'webhook-id': 'm9', 'webhook-timestamp': ts, 'webhook-signature': `v1,${hmac(`whsec_${raw.toString('base64')}`, `m9.${ts}.`, body).digest('base64')}` })).status).toBe(401)
  expect((await post(token, body, { 'webhook-id': 'm9', 'webhook-timestamp': ts, 'webhook-signature': `v1,AAAA ${sig(raw, 'm9', ts, body)}` })).status).toBe(200)
})

test('signature schemes alone: standard, toss and url-token good / bad / missing', () => {
  const now = Date.now()
  const raw = new TextEncoder().encode('{"a":1}')
  const key = crypto.randomBytes(24)
  const secret = `whsec_${key.toString('base64')}`
  expect(standardKey(secret)?.equals(key)).toBe(true)
  expect(standardKey('whsec_')).toBeNull()
  expect(standardKey('whsec_c2hvcnQ=')).toBeNull() // under 16 bytes
  const ts = String(Math.floor(now / 1000))
  const h1 = new Headers({ 'webhook-id': 'i1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${hmac(key, `i1.${ts}.`, '{"a":1}').digest('base64')}` })
  expect(verifySignature('standard', { secret, raw, headers: h1, now }).ok).toBe(true)
  expect(verifySignature('standard', { secret, raw, headers: new Headers({ 'webhook-id': 'i1', 'webhook-timestamp': ts }), now }).ok).toBe(false)
  expect(verifySignature('standard', { secret, raw, headers: new Headers({ 'webhook-id': 'i1', 'webhook-timestamp': 'abc', 'webhook-signature': 'v1,x' }), now }).ok).toBe(false)
  expect(verifySignature('standard', { secret: 'whsec_!!', raw, headers: h1, now }).ok).toBe(false)
  const time = '2026-11-14T19:20:21+09:00'
  const at = Date.parse(time)
  const h2 = new Headers({ 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-signature': `v1:${hmac('k'.repeat(20), '{"a":1}', `:${time}`).digest('base64')}` })
  expect(verifySignature('toss', { secret: 'k'.repeat(20), raw, headers: h2, now: at }).ok).toBe(true)
  expect(verifySignature('toss', { secret: 'k'.repeat(20), raw, headers: h2, now: at + 6 * 60_000 }).ok).toBe(false)
  expect(verifySignature('toss', { secret: 'k'.repeat(20), raw, headers: new Headers({ 'tosspayments-webhook-transmission-time': 'not a time', 'tosspayments-webhook-signature': 'v1:x' }), now: at }).ok).toBe(false)
  expect(verifySignature('toss', { secret: 'x'.repeat(20), raw, headers: h2, now: at }).ok).toBe(false)
  expect(verifySignature('url-token', { secret: 'tok-123456', raw, headers: new Headers(), now, query: new URLSearchParams('token=tok-123456') }).ok).toBe(true)
  expect(verifySignature('url-token', { secret: 'tok-123456', raw, headers: new Headers(), now, query: new URLSearchParams('token=tok-1234567') }).ok).toBe(false)
  expect(verifySignature('url-token', { secret: 'tok-123456', raw, headers: new Headers(), now, query: new URLSearchParams('') }).ok).toBe(false)
  expect(verifySignature('url-token', { secret: 'tok-123456', raw, headers: new Headers(), now }).ok).toBe(false)
})

test('a client reading a preset it does not know (a newer server): the app and the message still parse, as a plain Other app', () => {
  const ref = RoomAppRef.parse({ id: 'a', name: 'Mail', kind: 'other', preset: 'email' })
  expect(ref.preset).toBeUndefined()
  expect(RoomAppRef.parse({ id: 'a', name: 'Jira', kind: 'other', preset: 'jira' }).preset).toBe('jira')
  const app = RoomApp.parse({ id: 'a', roomId: 'r', kind: 'other', preset: 'future_service', name: 'X', events: {}, quiet: false, signed: false, createdBy: null, createdAt: '2026-11-14T00:00:00.000Z', firstOkAt: null, lastOkAt: null, lastRefusal: null, pausedUntil: null, canResume: false, today: 0 })
  expect(app.preset).toBeUndefined()
})
