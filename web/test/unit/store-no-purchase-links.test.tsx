// Store apps show no purchase-steering links (docs/DECISIONS.md "Store apps show no purchase links"): inside the Mac App
// Store / Microsoft Store desktop build or the phone app, the plan card has no "Manage plan" link, a full plan is said
// as a fact with no "change the plan", and the server's seat refusal (which names the account page) gets the app's own
// words. The web and the dmg/exe desktop builds are unchanged.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { PlanStatus } from '@mycel/shared/api'
import { DESKTOP_BRIDGE_GLOBAL, type DesktopBridge } from '@mycel/shared'
import { DICTS, LOCALES, translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { noPurchaseLinks } from '../../src/lib/desktop'
import { storeSafeError } from '../../src/lib/api'
import { PlanDetails } from '../../src/pages/admin/System'
import { noSeatsKey } from '../../src/components/onboarding/TeamLinkPanel'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'

const ACCOUNT = 'https://account.acme.example/billing'
const plan = (o: Partial<NonNullable<PlanStatus['plan']>> = {}): NonNullable<PlanStatus['plan']> => ({
  name: 'Team', maxConcurrency: 3, maxActiveMembers: 5, activeMembers: 5, diskGiB: 50, localBackupRetentionDays: 7,
  links: { account: ACCOUNT, status: 'https://status.acme.example', support: 'support@acme.example' },
  ...o,
} as NonNullable<PlanStatus['plan']>)
const render = (store: boolean) => renderToStaticMarkup(<MemoryRouter><PlanDetails plan={plan()} store={store} /></MemoryRouter>)
const STORE_KEYS: MessageKey[] = ['plan.membersFullStore', 'plan.seatLimitStore', 'teamLink.noSeatsStore']

const g = globalThis as Record<string, unknown>
const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  delete g[DESKTOP_BRIDGE_GLOBAL]
  if (hadWindow) Object.defineProperty(globalThis, 'window', hadWindow); else Reflect.deleteProperty(globalThis, 'window')
  useLocaleStore.setState({ locale: 'en' })
})

describe('which apps are store apps', () => {
  test('a store desktop build is, a dmg/exe build and a browser are not', () => {
    expect(noPurchaseLinks({ bridgeVersion: 1, store: true } as DesktopBridge)).toBe(true)
    expect(noPurchaseLinks({ bridgeVersion: 1, store: false } as DesktopBridge)).toBe(false)
    expect(noPurchaseLinks({ bridgeVersion: 1 } as DesktopBridge)).toBe(false)
    expect(noPurchaseLinks(null)).toBe(false)
    g[DESKTOP_BRIDGE_GLOBAL] = { bridgeVersion: 1, store: true }
    expect(noPurchaseLinks()).toBe(true)
  })
  test('the phone app is', () => {
    const config: MobileConfig = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
    const win = { mycelMobile: { ...config }, ReactNativeWebView: { postMessage: () => {} } } as Record<string, unknown>
    win.self = win; win.top = win
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
    expect(noPurchaseLinks(null)).toBe(true)
  })
})

describe('Admin › System, the plan card', () => {
  test('on the web: Manage plan, and a full plan says to change it', () => {
    const html = render(false)
    expect(html).toContain(`href="${ACCOUNT}"`)
    expect(html).toContain(translate('en', 'plan.manage'))
    expect(html).toContain(translate('en', 'plan.membersFull').replace(/'/g, '&#x27;'))
  })
  test('in a store app: no Manage plan, the fact only; status and support stay', () => {
    const html = render(true)
    expect(html).not.toContain(ACCOUNT)
    expect(html).not.toContain(translate('en', 'plan.manage'))
    expect(html).not.toMatch(/change the plan/i)
    expect(html).toContain(translate('en', 'plan.membersFullStore').replace(/'/g, '&#x27;'))
    expect(html).toContain('href="https://status.acme.example/"')
    expect(html).toContain('href="mailto:support@acme.example"')
  })
})

describe('the team link with no seats left', () => {
  test('the store app drops "or change the plan"', () => {
    expect(noSeatsKey(false)).toBe('teamLink.noSeats')
    expect(noSeatsKey(true)).toBe('teamLink.noSeatsStore')
    expect(translate('en', noSeatsKey(true))).not.toMatch(/change the plan/i)
  })
})

describe("the server's seat refusal", () => {
  const seatRefusal = (params: Record<string, unknown>) => new Response(JSON.stringify({ error: { code: 'plan_limit', message: `The plan's member limit (5) is reached. Disable an account that is no longer used, or change the plan. Change the plan: ${ACCOUNT}`, params } }), { status: 409, headers: { 'content-type': 'application/json' } })
  test('in a store app: the app\'s words, no account page', async () => {
    const res = await storeSafeError(seatRefusal({ reason: 'seat_limit', limit: 5, changePlan: true, manageUrl: ACCOUNT }), true)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('plan_limit')
    expect(body.error.message).toBe(translate('en', 'plan.seatLimitStore', { limit: 5 }))
    expect(body.error.params).toEqual({ reason: 'seat_limit', limit: 5, changePlan: true })
    expect(JSON.stringify(body)).not.toContain(ACCOUNT)
  })
  test('in the language on screen', async () => {
    useLocaleStore.setState({ locale: 'ko' })
    const body = await (await storeSafeError(seatRefusal({ reason: 'seat_limit', limit: 5, changePlan: true }), true)).json()
    expect(body.error.message).toBe(translate('ko', 'plan.seatLimitStore', { limit: 5 }))
  })
  test('on the web, or a refusal without the flag (an invitee\'s "full"): as it came', async () => {
    const web = seatRefusal({ reason: 'seat_limit', limit: 5, changePlan: true, manageUrl: ACCOUNT })
    expect(await storeSafeError(web, false)).toBe(web)
    const invitee = seatRefusal({ reason: 'seat_limit', limit: 5 })
    expect(await storeSafeError(invitee, true)).toBe(invitee)
    const conflict = new Response(JSON.stringify({ error: { code: 'conflict', message: 'x', params: { changePlan: true } } }), { status: 409 })
    expect(await storeSafeError(conflict, true)).toBe(conflict)
    const other = new Response('not json', { status: 409 })
    expect(await storeSafeError(other, true)).toBe(other)
    const ok = new Response('{}', { status: 200 })
    expect(await storeSafeError(ok, true)).toBe(ok)
  })
})

describe('the store wording in every language', () => {
  test('no link, no price, the owner manages the plan on the web', () => {
    for (const { id } of LOCALES) for (const k of STORE_KEYS) {
      const s = DICTS[id][k]
      expect({ id, k, link: /https?:|www\.|\.app\b/.test(s), price: /[$€₩¥]|\d+\s?(usd|krw|idr)/i.test(s) }).toEqual({ id, k, link: false, price: false })
    }
    // none says to change the plan
    const change: Record<string, RegExp> = { en: /change/i, ko: /올리|바꿔|바꾸/, id: /ubah/i, ja: /変更/, es: /cambi/i }
    for (const { id } of LOCALES) for (const k of STORE_KEYS) expect({ id, k, steer: change[id].test(DICTS[id][k]) }).toEqual({ id, k, steer: false })
  })
})
