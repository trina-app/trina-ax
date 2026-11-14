// The regional services under "Show more services" (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md,
// P4): Toss Payments, Channel Talk and PortOne. Payment cards show an amount and the order's name where the service
// sends them, never a card number, account, phone or the buyer's name; chat cards show the customer's name and what was
// written, never an email or phone. No links: none of the three documents a dashboard address for one payment or chat.
//
// Toss Payments (https://docs.tosspayments.com/guides/v2/webhook,
// https://docs.tosspayments.com/reference/using-api/webhook-events): PAYMENT_STATUS_CHANGED {eventType, createdAt,
// data: Payment} and DEPOSIT_CALLBACK {createdAt, secret, status, transactionKey, orderId} (no eventType; its `secret`
// is checked against the approval answer, which Trina never sees: ignored, and the card says nothing about it). Other
// events are skipped. Signed (optional) "tosspayments-webhook-signature" (signatures.ts toss); which events carry it is
// not documented (live check). One card per order (`order:<orderId>`). Both events registered: a transfer arrives twice
// with the same state, so the second only changes nothing (skipped). Dedupe: eventType + orderId + status + createdAt
// (the transmission id is new on every send).
//
// Channel Talk (https://developers.channel.io/en/articles/Webhook-events-7bd9b8e2): {event, type, entity, refers};
// type "userChat" (a chat opened or changed) or "message" (personType user, manager or bot; chatType userChat or
// group); "user" and group chats (the team's own) are skipped. Auth: the Webhook URL's token, and optionally Channel
// Talk's own `?token=` (signatures.ts url-token). One card per chat (`chat:<id>`).
//
// PortOne V2 (https://developers.portone.io/opi/ko/integration/webhook/readme-v2): Standard Webhooks (signatures.ts
// standard); version 2024-04-25 {type: "Transaction.Paid" …, timestamp, data: {storeId, paymentId, transactionId,
// cancellationId?}}, the older 2024-01-01 {payment_id, tx_id, status} read too. The body has no amount or name: the
// card is the payment id and its state (Trina never calls PortOne). Dedupe on webhook-id (the same on every retry),
// else type + payment id + timestamp. One card per payment (`payment:<paymentId>`).
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line, lines } from '../card'
import type { Arrival, Parsed } from '../parse'
import { get, jsonOf, num, obj, sha, str } from '../read'
import { appText, type AppTextKey } from '../text'
import { money, replyLines, type PresetDef } from './common'

const statusOf = (L: Arrival['locale'], k: AppTextKey) => appText('status', L, { status: appText(k, L) })

// ---------------- Toss Payments ----------------
/** Toss's order ids: 6-64 letters, digits, "-" and "_" (its own rule for orderId). */
const TOSS_ORDER = /^[A-Za-z0-9_-]{6,64}$/

function toss(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  const eventType = str(body, 'eventType')
  // DEPOSIT_CALLBACK has no eventType: its status and orderId at the top
  const deposit = !eventType && typeof body.transactionKey === 'string'
  if (!deposit && eventType !== 'PAYMENT_STATUS_CHANGED') {
    // other Toss events (billing, payouts, overseas cancels…): read, nothing shown
    return eventType ? { skip: true } : { refuse: 'format' }
  }
  const data = deposit ? body : obj(body.data)
  if (!data) return { refuse: 'format' }
  const orderId = str(data, 'orderId')
  const status = str(data, 'status').toUpperCase()
  if (!TOSS_ORDER.test(orderId) || !/^[A-Z_]{2,30}$/.test(status)) return { refuse: 'format' }
  const createdAt = line(str(body, 'createdAt'), 40)
  const delivery = `toss:${sha(JSON.stringify([eventType || 'DEPOSIT_CALLBACK', orderId, status, createdAt]))}`
  // what the card may show: the order's name, the amount, the method. Never card, account, phone, receipt or metadata
  const orderName = line(str(data, 'orderName'), 120)
  const total = num(data, 'totalAmount')
  const currency = str(data, 'currency') || 'KRW'
  const amount = total === null ? '' : money(L, currency, { major: total })
  const method = line(str(data, 'method'), 40)
  const title = amount || orderName || orderId
  const details = [amount ? orderName : '', method, appText('orderIdLine', L, { id: orderId })].filter(Boolean).slice(0, 3)
  const key = `order:${orderId}`
  const base = { delivery, key }
  switch (status) {
    case 'DONE': {
      const kind = appText(deposit ? 'depositReceived' : 'paymentReceived', L)
      const s = statusOf(L, 'statusPaid')
      // a card for the order already (waiting for the transfer, or the other of the two events): its status line only
      return { event: { ...base, switch: 'payment', state: 'paid', status: s, onlyStatus: true, card: { kind, title, details, status: s }, reply: { title: kind } } }
    }
    case 'CANCELED': case 'PARTIAL_CANCELED': {
      const kind = appText(status === 'CANCELED' ? 'paymentCancelled' : 'paymentPartCancelled', L)
      const s = statusOf(L, 'statusCancelled')
      return { event: { ...base, switch: 'cancelled', state: status.toLowerCase(), status: s, card: { kind, title, details, status: s }, reply: { title: kind } } }
    }
    case 'WAITING_FOR_DEPOSIT': {
      const kind = appText('waitingDeposit', L)
      const s = statusOf(L, 'statusPending')
      return { event: { ...base, switch: 'waiting', state: 'waiting', status: s, card: { kind, title, details, status: s }, reply: { title: kind } } }
    }
    case 'ABORTED': case 'EXPIRED': {
      const kind = appText('paymentFailed', L)
      const s = statusOf(L, 'statusFailed')
      return { event: { ...base, switch: 'failed', state: 'failed', status: s, card: { kind, title, details, status: s }, reply: { title: kind } } }
    }
    default: return { skip: true }
  }
}

// ---------------- Channel Talk ----------------
const CT_ID = /^[A-Za-z0-9_-]{1,64}$/

function channel(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  const type = str(body, 'type').toLowerCase()
  const e = obj(body.entity)
  if (!type || !e) return { refuse: 'format' }
  // the customer's name only (a User carries email, phone and location: never read)
  const customer = line(str(body, 'refers', 'user', 'name'), 80)
  if (type === 'userchat') {
    const id = str(e, 'id')
    if (!CT_ID.test(id)) return { refuse: 'format' }
    const state = line(str(e, 'state'), 30).toLowerCase()
    const first = lines(str(body, 'refers', 'message', 'plainText'), 2000)
    const title = line(first, 200) || customer || appText('channelNewChat', L)
    const status = state ? appText('status', L, { status: state }) : undefined
    return { event: {
      switch: 'new_chat', delivery: `body:${sha(a.raw)}`, alsoDelivery: `chat:${id}:${state}`, deliveryMinutes: 10,
      key: `chat:${id}`, ...(state ? { state, status } : {}),
      // a chat that is there already: its status line follows (opened, snoozed, closed), no reply
      onlyStatus: true,
      // a name from a request without Channel Talk's token: marked, as Shopify's customer
      card: { kind: customer ? appText('channelChatFrom', L, { name: customer }) : appText('channelNewChat', L), title, details: [], status, unverified: !a.signed && !!customer },
      ...(first ? { extra: first } : {}),
    } }
  }
  if (type === 'message') {
    // the team's own group chats and direct messages are not the room's business
    if (str(e, 'chatType') && str(e, 'chatType') !== 'userChat') return { skip: true }
    const id = str(e, 'id'), chatId = str(e, 'chatId')
    if (!CT_ID.test(id) || !CT_ID.test(chatId)) return { refuse: 'format' }
    const person = str(e, 'personType')
    if (person !== 'user' && person !== 'manager') return { skip: true }
    const text = lines(str(e, 'plainText'), 2000)
    const manager = line(str(body, 'refers', 'manager', 'name'), 80)
    const fromUser = person === 'user'
    const who = fromUser
      ? (customer ? appText('channelCustomerFrom', L, { name: customer }) : appText('channelCustomer', L))
      : (manager ? appText('channelManager', L, { name: manager }) : appText('channelManagerAnon', L))
    return { event: {
      switch: fromUser ? 'customer_message' : 'manager_message', delivery: `channel-message:${id}`,
      key: `chat:${chatId}`,
      card: { kind: who, title: line(text, 200) || who, details: [], unverified: !a.signed && !!(fromUser ? customer : manager) },
      reply: { title: who, details: replyLines(text), unverified: !a.signed && !!(fromUser ? customer : manager) },
      ...(text ? { extra: text } : {}),
    } }
  }
  return { skip: true }
}

// ---------------- PortOne ----------------
const PORTONE_ID = /^[A-Za-z0-9_.:-]{1,100}$/
const PORTONE_TYPES: Record<string, { switch: string; kind: AppTextKey; status: AppTextKey; state: string; onlyStatus?: boolean }> = {
  Paid: { switch: 'payment', kind: 'paymentReceived', status: 'statusPaid', state: 'paid' },
  Cancelled: { switch: 'cancelled', kind: 'paymentCancelled', status: 'statusCancelled', state: 'cancelled' },
  PartialCancelled: { switch: 'cancelled', kind: 'paymentPartCancelled', status: 'statusCancelled', state: 'partial_cancelled' },
  Failed: { switch: 'failed', kind: 'paymentFailed', status: 'statusFailed', state: 'failed' },
  VirtualAccountIssued: { switch: 'virtual_account', kind: 'virtualAccountIssued', status: 'statusPending', state: 'waiting' },
}

function portone(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  // 2024-04-25: {type: "Transaction.Paid", data: {paymentId}}; 2024-01-01: {status: "Paid", payment_id}
  const type = str(body, 'type')
  const name = type ? (type.startsWith('Transaction.') ? type.slice('Transaction.'.length) : '') : str(body, 'status')
  const paymentId = type ? str(get(body, 'data'), 'paymentId') : str(body, 'payment_id')
  if (!name && type) return { skip: true } // BillingKey.* and anything newer
  if (!PORTONE_ID.test(paymentId) || !name) return { refuse: 'format' }
  const t = PORTONE_TYPES[name]
  if (!t) return { skip: true } // Ready, PayPending, CancelPending, disputes…
  const hookId = line(a.headers.get('webhook-id') ?? '', 200)
  const delivery = hookId ? `portone:${hookId}` : `portone:${sha(JSON.stringify([name, paymentId, str(body, 'timestamp'), str(body, 'tx_id')]))}`
  const kind = appText(t.kind, L)
  const status = statusOf(L, t.status)
  return { event: {
    switch: t.switch, delivery, key: `payment:${paymentId}`, state: t.state, status,
    // paid after a virtual account was issued: the card's status line
    ...(t.state === 'paid' ? { onlyStatus: true } : {}),
    card: { kind, title: appText('paymentOf', L, { id: line(paymentId, 100) }), details: [], status },
    reply: { title: kind },
  } }
}

export const tossPayments: PresetDef = { preset: 'toss_payments', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'toss' }, parse: toss }
export const channelTalk: PresetDef = { preset: 'channel_talk', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'url-token' }, parse: channel }
export const portonePreset: PresetDef = { preset: 'portone', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'standard' }, parse: portone }
