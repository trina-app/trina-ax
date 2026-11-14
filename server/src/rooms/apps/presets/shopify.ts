// Shopify admin webhooks (Settings › Notifications › Webhooks; https://shopify.dev/docs/apps/build/webhooks/subscribe/https):
// X-Shopify-Topic names the event, X-Shopify-Shop-Domain the store, X-Shopify-Event-Id the event (the same across
// subscriptions; else X-Shopify-Webhook-Id). Signed (optional) X-Shopify-Hmac-SHA256, base64 over the raw bytes. One
// card per order (`order:<id>`): payment edits its status line, a cancellation or refund joins its thread. The customer's
// first name and city only (no street, email or phone). The link is Shopify admin's, built from the store's handle.
import { line } from '../card'
import type { Arrival, Parsed } from '../parse'
import { arr, jsonOf, num, obj, sha, str } from '../read'
import { appText } from '../text'
import { money, type PresetDef } from './common'

/** "acme-shop.myshopify.com" → "acme-shop"; anything else none */
const handleOf = (domain: string) => /^([a-z0-9][a-z0-9-]{0,62})\.myshopify\.com$/i.exec(domain.trim())?.[1]?.toLowerCase() ?? ''

function parse(a: Arrival): Parsed {
  const topic = (a.headers.get('x-shopify-topic') ?? '').trim().toLowerCase()
  const body = obj(jsonOf(a.raw))
  if (!body || !topic) return { refuse: 'format' }
  const L = a.locale
  const delivery = line(a.headers.get('x-shopify-event-id') ?? '', 100) || line(a.headers.get('x-shopify-webhook-id') ?? '', 100)
  const base = { delivery: delivery ? `shopify:${delivery}` : sha(a.raw), ...(delivery ? {} : { deliveryMinutes: 10 }) }
  const handle = handleOf(a.headers.get('x-shopify-shop-domain') ?? '')
  const statusOf = (k: 'statusPaid' | 'statusPending' | 'statusRefunded' | 'statusCancelled' | 'statusFulfilled') => appText('status', L, { status: appText(k, L) })
  const link = (orderId: string) => (handle && /^\d{1,20}$/.test(orderId) ? `https://admin.shopify.com/store/${handle}/orders/${orderId}` : undefined)

  if (topic === 'refunds/create') {
    const orderId = str(body, 'order_id')
    if (!/^\d{1,20}$/.test(orderId)) return { refuse: 'format' }
    let total = 0, currency = ''
    for (const t of arr(body, 50, 'transactions')) {
      if (str(t, 'kind') && str(t, 'kind') !== 'refund') continue
      total += num(t, 'amount') ?? 0
      currency ||= str(t, 'currency')
    }
    const amt = currency ? money(L, currency, { major: total }) : ''
    const title = amt ? appText('refundedAmount', L, { amount: amt }) : appText('refunded', L)
    const status = statusOf('statusRefunded')
    return { event: {
      ...base, switch: 'refund', key: `order:${orderId}`, state: 'refunded', status,
      card: { kind: appText('orderOf', L, { order: orderId }), title, details: [], status, link: link(orderId) },
      reply: { title },
    } }
  }

  // the GraphQL id is a string (a JSON number past 2^53 loses digits); else the number
  const id = /^gid:\/\/shopify\/Order\/(\d{1,20})$/.exec(str(body, 'admin_graphql_api_id'))?.[1] ?? str(body, 'id')
  if (!/^\d{1,20}$/.test(id)) return { refuse: 'format' }
  const number = line(str(body, 'name') || (str(body, 'order_number') ? `#${str(body, 'order_number')}` : ''), 40) || `#${id}`
  const currency = str(body, 'currency') || str(body, 'presentment_currency')
  const total = num(body, 'total_price')
  const items = arr(body, 250, 'line_items')
  const count = items.reduce<number>((n, it) => n + (num(it, 'quantity') ?? 1), 0)
  const totalText = total !== null && currency ? money(L, currency, { major: total }) : ''
  const title = count === 1 ? appText('orderItemsOne', L, { total: totalText }) : appText('orderItemsMany', L, { total: totalText, n: count })
  const details = items.slice(0, 2).map((it) => appText('orderLine', L, { n: num(it, 'quantity') ?? 1, title: line(str(it, 'title') || str(it, 'name'), 120) }))
  const who = [line(str(body, 'customer', 'first_name'), 60), line(str(body, 'shipping_address', 'city') || str(body, 'billing_address', 'city'), 60)].filter(Boolean).join(' · ')
  if (who) details.push(who)
  const financial = str(body, 'financial_status')
  const state = str(body, 'cancelled_at') ? 'cancelled' : financial === 'paid' ? 'paid' : /refunded/.test(financial) ? 'refunded' : 'pending'
  const status = statusOf(state === 'cancelled' ? 'statusCancelled' : state === 'paid' ? 'statusPaid' : state === 'refunded' ? 'statusRefunded' : 'statusPending')
  const card = { kind: appText('newOrder', L, { order: number }), title: totalText ? title : number, details, status, link: link(id), unverified: !a.signed && !!who }
  const key = `order:${id}`
  switch (topic) {
    case 'orders/create': return { event: { ...base, switch: 'order', key, state, status, card, reply: { title: appText('newOrder', L, { order: number }) } } }
    // payment: the order's card changes its status line (no reply of its own)
    case 'orders/paid': return { event: { ...base, switch: 'paid', key, state: 'paid', status: statusOf('statusPaid'), onlyStatus: true, card: { ...card, status: statusOf('statusPaid') }, reply: { title: appText('orderPaid', L) } } }
    case 'orders/cancelled': return { event: { ...base, switch: 'cancelled', key, state: 'cancelled', status: statusOf('statusCancelled'), card: { ...card, status: statusOf('statusCancelled') }, reply: { title: appText('orderCancelled', L) } } }
    case 'orders/fulfilled': return { event: { ...base, switch: 'fulfilled', key, state: 'fulfilled', status: statusOf('statusFulfilled'), card: { ...card, status: statusOf('statusFulfilled') }, reply: { title: appText('orderFulfilled', L) } } }
    default: return { skip: true }
  }
}

export const shopify: PresetDef = {
  preset: 'shopify', types: ['application/json'], bodyMax: 1024 * 1024,
  signature: { scheme: 'b64-body', header: 'x-shopify-hmac-sha256' }, parse,
}
