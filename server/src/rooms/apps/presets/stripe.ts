// Stripe event destinations, "Webhook endpoint" (https://docs.stripe.com/webhooks): an Event {id, type, livemode,
// data.object}. Signed (optional) Stripe-Signature "t=…,v1=…" (signatures.ts stripe; the secret is the literal whsec_
// string). One card per payment: the thread is the payment intent (`pi:<id>`), so a Checkout session and its payment
// intent are one card, and a refund or dispute joins it. A customer's name is shown, never an email or card data. The
// link is built on Stripe's dashboard host from the id, never taken from the body.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line } from '../card'
import type { AppEvent, Arrival, Parsed } from '../parse'
import { arr, get, jsonOf, num, obj, str } from '../read'
import { appText } from '../text'
import { money, type PresetDef } from './common'

const ID = /^[A-Za-z0-9_]{3,100}$/
const idOf = (v: string, prefix: string) => (v.startsWith(prefix) && ID.test(v) ? v : '')
/** a payment intent named by the object (an id string, or an expanded object) */
const piOf = (o: unknown) => idOf(str(o, 'payment_intent') || str(o, 'payment_intent', 'id'), 'pi_')

function parse(a: Arrival): Parsed {
  const ev = obj(jsonOf(a.raw))
  if (!ev) return { refuse: 'format' }
  const id = line(str(ev, 'id'), 100)
  const type = str(ev, 'type')
  const o = obj(get(ev, 'data', 'object'))
  if (!id || !type || !o) return { refuse: 'format' }
  const L = a.locale
  const test = get(ev, 'livemode') === false
  const dash = `https://dashboard.stripe.com${test ? '/test' : ''}`
  const kindOf = (k: string) => (test ? `${k} · ${appText('testMode', L)}` : k)
  const statusOf = (s: string) => appText('status', L, { status: s })
  const amount = (minor: number | null, currency: string) => (minor === null ? '' : money(L, currency, { minor }))
  const titleOf = (amt: string, name: string) => (amt && name ? appText('amountFrom', L, { amount: amt, name }) : amt || name)
  const unverified = !a.signed
  const base = { delivery: `stripe:${id}` }

  const payment = (pi: string, k: string, amt: string, name: string, details: string[], state: 'succeeded' | 'refunded' | 'failed' | 'disputed', sw: string, reply: string, back = false): Parsed => {
    const status = statusOf(appText(state === 'succeeded' ? 'statusSucceeded' : state === 'refunded' ? 'statusRefunded' : state === 'failed' ? 'statusFailed' : 'statusDisputed', L))
    const event: AppEvent = {
      ...base, switch: sw, ...(pi ? { key: `pi:${pi}` } : {}), state, status, back,
      // a Checkout session and its payment intent are one payment: the second only changes the status line
      ...(state === 'succeeded' ? { onlyStatus: true } : {}),
      card: { kind: kindOf(k), title: titleOf(amt, name) || k, details, status, link: pi ? `${dash}/payments/${pi}` : undefined, unverified: unverified && !!name },
      reply: { title: reply, details: details.slice(0, 1) },
    }
    return { event }
  }

  switch (type) {
    case 'checkout.session.completed': {
      if (str(o, 'mode') === 'setup') return { skip: true }
      const name = line(str(o, 'customer_details', 'name'), 80)
      const amt = amount(num(o, 'amount_total'), str(o, 'currency'))
      const pi = piOf(o)
      // a subscription's first payment: the invoice and subscription follow; the session is the card
      return payment(pi, appText('paymentReceived', L), amt, name, [], 'succeeded', 'payment', appText('paymentReceived', L))
    }
    case 'payment_intent.succeeded': {
      const pi = idOf(str(o, 'id'), 'pi_')
      const name = line(str(o, 'shipping', 'name'), 80)
      const amt = amount(num(o, 'amount_received') ?? num(o, 'amount'), str(o, 'currency'))
      const desc = line(str(o, 'description'), 200)
      return payment(pi, appText('paymentReceived', L), amt, name, desc ? [desc] : [], 'succeeded', 'payment', appText('paymentReceived', L))
    }
    case 'charge.refunded': {
      const pi = piOf(o)
      const name = line(str(o, 'billing_details', 'name'), 80)
      const amt = amount(num(o, 'amount_refunded'), str(o, 'currency'))
      const desc = line(str(o, 'description'), 200)
      return payment(pi, appText('refunded', L), amt, name, desc ? [desc] : [], 'refunded', 'refund', amt ? appText('refundedAmount', L, { amount: amt }) : appText('refunded', L))
    }
    case 'payment_intent.payment_failed': {
      const pi = idOf(str(o, 'id'), 'pi_')
      const amt = amount(num(o, 'amount'), str(o, 'currency'))
      const msg = line(str(o, 'last_payment_error', 'message'), 200)
      const name = line(str(o, 'shipping', 'name') || str(o, 'last_payment_error', 'payment_method', 'billing_details', 'name'), 80)
      return payment(pi, appText('paymentFailed', L), amt, name, msg ? [msg] : [], 'failed', 'failed', appText('paymentFailed', L))
    }
    case 'invoice.payment_failed': {
      const pi = piOf(o)
      const inv = idOf(str(o, 'id'), 'in_')
      const amt = amount(num(o, 'amount_due'), str(o, 'currency'))
      const name = line(str(o, 'customer_name'), 80)
      const item = line(str(arr(o, 1, 'lines', 'data')[0], 'description'), 200)
      const r = payment(pi, appText('paymentFailed', L), amt, name, item ? [item] : [], 'failed', 'failed', appText('paymentFailed', L))
      // no payment intent: the invoice is the thing (its own thread and link)
      if (!pi && 'event' in r && inv) { r.event.key = `in:${inv}`; r.event.card.link = `${dash}/invoices/${inv}` }
      return r
    }
    case 'charge.dispute.created': {
      const pi = piOf(o)
      const amt = amount(num(o, 'amount'), str(o, 'currency'))
      const reason = line(str(o, 'reason').replace(/_/g, ' '), 80)
      // a dispute is shown in the room too (also when it joins the payment's thread)
      return payment(pi, appText('disputeOpened', L), amt, '', reason ? [appText('reason', L, { reason })] : [], 'disputed', 'dispute', appText('disputeOpened', L), true)
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.created': {
      const sub = idOf(str(o, 'id'), 'sub_')
      if (!sub) return { refuse: 'format' }
      const ended = type === 'customer.subscription.deleted'
      const item = arr(o, 1, 'items', 'data')[0]
      const plan = line(str(item, 'price', 'nickname') || str(item, 'plan', 'nickname') || str(o, 'plan', 'nickname') || str(o, 'description'), 120)
      const price = num(item, 'price', 'unit_amount')
      const amt = price === null ? '' : amount(price, str(item, 'price', 'currency') || str(o, 'currency'))
      const k = appText(ended ? 'subscriptionEnded' : 'subscriptionNew', L)
      const status = statusOf(appText(ended ? 'statusEnded' : 'statusActive', L))
      return { event: {
        ...base, switch: ended ? 'subscription_ended' : 'subscription_new', key: `sub:${sub}`, state: ended ? 'ended' : 'active', status,
        card: { kind: kindOf(k), title: plan || amt || sub, details: plan && amt ? [amt] : [], status, link: `${dash}/subscriptions/${sub}` },
        reply: { title: k },
      } }
    }
    default: return { skip: true }
  }
}

export const stripe: PresetDef = {
  preset: 'stripe', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, signature: { scheme: 'stripe' }, parse,
}
