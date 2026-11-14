// HubSpot workflows, action "Send a webhook" (Data Hub Professional or Enterprise;
// https://knowledge.hubspot.com/workflows/how-do-i-use-webhooks-with-hubspot-workflows): POST with "Customize request
// body", where each key is named by the person and mapped to a property or a static value. The guide asks for one
// workflow per object with these keys: `object` (static: deal, contact or ticket), `id` (Record ID) and, per object,
// deal `name` `amount` `stage`; contact `firstname` `lastname` `company` `stage`; ticket `subject` `stage`. A body sent
// with "Include all properties" is read too, by HubSpot's internal names (hs_object_id, dealname, amount, dealstage;
// firstname, lastname, company, lifecyclestage; subject, hs_pipeline_stage), at the top or under `properties` (a value
// or {value}); its exact shape is a live check (TC-1634). No signature: HubSpot signs only with an app's secret, which a
// workflow made in the UI has none of; the Webhook URL's token is the auth.
//
// Never shown: email, phone or any other property. A contact shows its name and company. HubSpot retries the same body
// for up to 3 days after a failed try: dedupe on the body's hash and on the record and its stage, both 10 minutes.
// One card per record (`deal:<id>`): a later stage joins its thread and the status line follows. The record's link only
// when the body names the HubSpot account (`portal`, numeric), pinned to the app on first sight.
import { ROOM_APP_BODY_MAX } from '@mycel/shared/api'
import { line } from '../card'
import type { Arrival, Parsed } from '../parse'
import { get, jsonOf, num, obj, sha, str } from '../read'
import { appText } from '../text'
import { money, type PresetDef } from './common'

type HubObject = 'deal' | 'contact' | 'ticket'
/** HubSpot's object type ids in record links. */
const TYPE_ID: Record<HubObject, string> = { contact: '0-1', deal: '0-3', ticket: '0-5' }

/** A property: our key, else HubSpot's internal name; at the top or under `properties`; a plain value or {value}. */
function prop(body: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    for (const v of [body[n], get(body, 'properties', n)]) {
      if (typeof v === 'string' || typeof v === 'number') { const s = line(String(v), 200); if (s) return s }
      const inner = str(v, 'value')
      if (inner) return line(inner, 200)
    }
  }
  return ''
}

function parse(a: Arrival): Parsed {
  const body = obj(jsonOf(a.raw))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  const named = prop(body, 'object').toLowerCase()
  const object: HubObject | null = named === 'deal' || named === 'contact' || named === 'ticket' ? named
    : prop(body, 'dealname', 'dealstage') ? 'deal'
    : prop(body, 'hs_pipeline_stage', 'subject') ? 'ticket'
    : prop(body, 'firstname', 'lastname', 'lifecyclestage') ? 'contact'
    : null
  const id = prop(body, 'id', 'hs_object_id', 'objectId', 'vid')
  if (!object || !/^\d{1,20}$/.test(id)) return { refuse: 'format' }
  const portal = prop(body, 'portal', 'portalId', 'portal-id')
  const portalOk = /^\d{1,12}$/.test(portal) ? portal : ''
  const link = portalOk && (!a.pin || a.pin === portalOk) ? `https://app.hubspot.com/contacts/${portalOk}/record/${TYPE_ID[object]}/${id}` : undefined
  const stage = prop(body, 'stage', object === 'deal' ? 'dealstage' : object === 'ticket' ? 'hs_pipeline_stage' : 'lifecyclestage')
  const status = stage ? appText('hubspotStage', L, { stage }) : undefined
  let title = '', kind = '', details: string[] = []
  // a contact's name came from an unsigned request (HubSpot can't sign): marked, as Shopify's customer
  let hasName = false
  if (object === 'deal') {
    title = prop(body, 'name', 'dealname') || `#${id}`
    kind = appText('hubspotDeal', L)
    const amount = num({ v: prop(body, 'amount') }, 'v')
    const currency = prop(body, 'currency', 'deal_currency_code')
    if (amount !== null) details = [currency ? money(L, currency, { major: amount }) : String(amount)]
  } else if (object === 'contact') {
    const name = [prop(body, 'firstname'), prop(body, 'lastname')].filter(Boolean).join(' ')
    hasName = !!name
    title = name || `#${id}`
    kind = appText('hubspotContact', L)
    const company = prop(body, 'company')
    if (company) details = [company]
  } else {
    title = prop(body, 'subject', 'name') || `#${id}`
    kind = appText('hubspotTicket', L)
  }
  return { event: {
    switch: object,
    delivery: `body:${sha(a.raw)}`, alsoDelivery: `${object}:${id}:${sha(JSON.stringify([stage, title]))}`, deliveryMinutes: 10,
    key: `${object}:${id}`,
    ...(stage ? { state: stage.toLowerCase(), status } : {}),
    ...(portalOk && !a.pin ? { pin: portalOk } : {}),
    card: { kind, title, details, status, link, unverified: !a.signed && hasName },
    reply: { title: status ?? appText('hubspotUpdated', L), details: [] },
  } }
}

export const hubspot: PresetDef = { preset: 'hubspot', types: ['application/json'], bodyMax: ROOM_APP_BODY_MAX, parse }
