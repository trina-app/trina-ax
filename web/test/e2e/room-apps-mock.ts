// Apps posting in a room for the e2e specs (docs/DECISIONS.md "Apps posting in rooms"): the room's apps API
// (shared/src/api/room-apps.ts ROOM_APPS) answered through page.route, contract-shaped, with what the screens asked kept
// for the spec to read; and app messages (cards) as the server sends them, for routeRoom's messages.
import type { Page } from '@playwright/test'
import { ROOM_APP_PRESET_SIGNING, ROOM_APP_PRESET_SWITCHES, type RoomAppPreset } from '@mycel/shared/api'
import { ROOM_ID } from './rooms-mock'

export const T0 = Date.parse('2026-11-05T09:00:00.000Z')
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()

type Kind = 'sentry' | 'github' | 'google_forms' | 'other'
export interface MockApp {
  id: string; roomId: string; kind: Kind; preset?: RoomAppPreset; name: string; events: Record<string, boolean>; quiet: boolean; signed: boolean
  createdBy: { id: string; name: string } | null; createdAt: string; firstOkAt: string | null; lastOkAt: string | null
  lastRefusal: { at: string; reason: 'signature' | 'format' | 'too_big' } | null; pausedUntil: string | null; canResume: boolean; today: number; leaverKnows?: true; eventsSeen?: string[]
  pausedBy?: 'app' | 'team'; pausedCap?: number; timeZone?: string; rotatedAt?: string | null; signingPending?: true
}
const SWITCHES: Record<Kind, Record<string, boolean>> = {
  sentry: { new_issue: true, came_back: true, resolved: true, alert: false, assigned: false, metric: false },
  github: { pull_request: true, issue: true, checks_failed: true, release: true, push: false },
  google_forms: { response: true, email: true },
  other: { message: true },
}
const NAMES: Record<Kind, string> = { sentry: 'Sentry', github: 'GitHub', google_forms: 'Google Forms', other: 'Other app' }
const PRESET_NAMES: Record<RoomAppPreset, string> = { notion: 'Notion', typeform: 'Typeform', tally: 'Tally', jotform: 'Jotform', stripe: 'Stripe', shopify: 'Shopify', zendesk: 'Zendesk', jira: 'Jira', hubspot: 'HubSpot', toss_payments: 'Toss Payments', channel_talk: 'Channel Talk', portone: 'PortOne' }

/** An Other app set up as a preset (kind 'other' + preset), with the preset's switches and name. */
export function mockPreset(preset: RoomAppPreset, o: Partial<MockApp> = {}): MockApp {
  return mockApp('other', { id: `app-${preset}`, preset, name: PRESET_NAMES[preset], events: Object.fromEntries(ROOM_APP_PRESET_SWITCHES[preset].map((s) => [s.key, s.on])), ...o })
}
export const ADDRESS = (n: number) => `https://acme.trina.app/in/tax_in_${'A'.repeat(40)}${String(n).padStart(3, '0')}`

export function mockApp(kind: Kind, o: Partial<MockApp> = {}): MockApp {
  return {
    id: `app-${kind}`, roomId: ROOM_ID, kind, name: NAMES[kind], events: { ...SWITCHES[kind] },
    quiet: false, signed: false, createdBy: { id: 'olga', name: 'Olga' }, createdAt: iso(-30), firstOkAt: iso(-20), lastOkAt: iso(-1), lastRefusal: null,
    pausedUntil: null, canResume: false, today: 41, ...o,
  }
}

export interface AppsState {
  apps: MockApp[]
  available: boolean
  /** what the screens asked, in order: "create:other", "patch:<id>:{…}", "rotate:<id>", "delete:<id>", … */
  calls: string[]
  /** the next GET of the list shows this app as connected (the first message arrived) */
  connectNext: () => void
  /** the next GET shows this refusal on the last app */
  refuseNext: (reason: 'signature' | 'format' | 'too_big') => void
}

/** Answer /api/rooms/<room>/apps…; everything else goes on to the room's own routes (routeRoom, registered before). */
export async function routeRoomApps(page: Page, o: { apps?: MockApp[]; available?: boolean; createdAgoMs?: number } = {}): Promise<AppsState> {
  let n = 0
  let pending: ((a: MockApp) => void) | null = null
  const state: AppsState = {
    apps: o.apps ?? [], available: o.available ?? true, calls: [],
    connectNext: () => { pending = (a) => { a.firstOkAt = new Date().toISOString(); a.lastOkAt = a.firstOkAt } },
    refuseNext: (reason) => { pending = (a) => { a.lastRefusal = { at: new Date().toISOString(), reason } } },
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms\/[^/]+\/apps(\/|$)/, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    const base = `/api/rooms/${ROOM_ID}/apps`
    if (path === base && method === 'GET') {
      const last = state.apps.at(-1)
      if (pending && last) { pending(last); pending = null }
      return route.fulfill(json({ items: state.apps, available: state.available, max: 10 }))
    }
    if (path === base && method === 'POST') {
      const b = req.postDataJSON() as { kind: Kind; preset?: RoomAppPreset; name?: string }
      state.calls.push(`create:${b.kind}${b.preset ? `+${b.preset}` : ''}${b.name ? `:${b.name}` : ''}`)
      if (!state.available) return route.fulfill(json({ error: { code: 'conflict', message: 'no address', params: { reason: 'no_public_address' } } }, 409))
      const fresh = { id: `019a5f00-0000-7000-8000-0000000b${String(++n).padStart(4, '0')}`, createdAt: new Date(Date.now() - (o.createdAgoMs ?? 0)).toISOString(), firstOkAt: null, lastOkAt: null, today: 0, ...(b.name ? { name: b.name } : {}) }
      const app = b.preset ? mockPreset(b.preset, fresh) : mockApp(b.kind, fresh)
      state.apps.push(app)
      return route.fulfill(json({ app, address: ADDRESS(n) }, 201))
    }
    const m = /^\/api\/rooms\/[^/]+\/apps\/([^/]+)(?:\/(address|secret|rotate|resume|example))?$/.exec(path)
    const app = m && state.apps.find((a) => a.id === m[1])
    if (!m || !app) return route.fulfill(json({ error: { code: 'not_found', message: 'not found' } }, 404))
    const what = m[2]
    if (what === 'address' && method === 'GET') { state.calls.push(`address:${app.id}`); return route.fulfill(json({ address: ADDRESS(state.apps.indexOf(app) + 1), ...((app.signed || app.signingPending) && (app.kind === 'github' || (app.preset && ROOM_APP_PRESET_SIGNING[app.preset].signing === 'trina_makes')) ? { secret: `tax_whs_${'s'.repeat(43)}` } : {}) })) }
    if (what === 'secret' && method === 'PUT') {
      const b = req.postDataJSON() as { generate?: true; secret?: string | null }
      state.calls.push(`secret:${app.id}:${b.generate ? 'generate' : b.secret === null ? 'off' : 'set'}`)
      const signing = app.preset ? ROOM_APP_PRESET_SIGNING[app.preset] : null
      if (signing?.signing === 'none') return route.fulfill(json({ error: { code: 'validation', message: 'This service cannot sign.', params: { reason: 'no_signing' } } }, 400))
      if (b.secret && !app.preset && !/^[0-9a-f]{64}$/i.test(b.secret)) return route.fulfill(json({ error: { code: 'validation', message: "That doesn't look like a Sentry Client Secret." } }, 400))
      // the shape the server checks (shared ROOM_APP_PRESET_SIGNING), with its words
      // (Toss Payments and PortOne name their own field)
      const shapeText = app.preset === 'toss_payments' ? "That doesn't look like a Toss Payments security key." : app.preset === 'portone' ? "That doesn't look like a PortOne webhook secret." : `That doesn't look like ${PRESET_NAMES[app.preset!]}'s signing secret.`
      if (b.secret && signing?.signing === 'paste' && signing.shape && !signing.shape.test(b.secret)) return route.fulfill(json({ error: { code: 'validation', message: shapeText } }, 400))
      // a secret Trina makes waits for the first signed message (signingPending); a pasted one is on at once
      app.signed = !!b.secret
      if (b.generate) app.signingPending = true
      else delete app.signingPending
      // the old "didn't match" line goes with the old secret
      if (app.lastRefusal?.reason === 'signature') app.lastRefusal = null
      return route.fulfill(json({ app, ...(b.generate ? { secret: `tax_whs_${'s'.repeat(43)}` } : {}) }))
    }
    if (what === 'rotate' && method === 'POST') { state.calls.push(`rotate:${app.id}`); app.rotatedAt = new Date().toISOString(); return route.fulfill(json({ app, address: ADDRESS(90 + ++n) })) }
    if (what === 'resume' && method === 'POST') { state.calls.push(`resume:${app.id}`); app.pausedUntil = null; app.canResume = false; return route.fulfill(json(app)) }
    if (what === 'example' && method === 'POST') { state.calls.push(`example:${app.id}`); return route.fulfill({ status: 204, body: '' }) }
    if (!what && method === 'PATCH') {
      const b = req.postDataJSON() as { events?: Record<string, boolean>; quiet?: boolean; name?: string }
      state.calls.push(`patch:${app.id}:${JSON.stringify(b)}`)
      if (b.events) app.events = { ...app.events, ...b.events }
      if (b.quiet !== undefined) app.quiet = b.quiet
      if (b.name !== undefined) app.name = b.name
      return route.fulfill(json(app))
    }
    if (!what && method === 'DELETE') {
      state.calls.push(`delete:${app.id}`)
      state.apps = state.apps.filter((a) => a.id !== app.id)
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return state
}

/** A message an app posted, as routeRoom's `extra` (author null, the app and its card). */
export function appMessage(app: Pick<MockApp, 'id' | 'kind' | 'name' | 'preset'> & { by?: { id: string; name: string } | null; quiet?: boolean; example?: boolean }, card: { kind?: string; title: string; details?: string[]; status?: string; link?: { url: string; host: string } }, more: Record<string, unknown> = {}) {
  const text = [[card.kind, card.title].filter(Boolean).join(' · '), ...(card.details ?? []), card.status ?? ''].filter(Boolean).join('\n')
  return {
    author: null,
    app: { id: app.id, name: app.name, kind: app.kind, ...(app.preset ? { preset: app.preset } : {}), by: app.by === undefined ? { id: 'mina', name: 'Mina' } : app.by, ...(app.quiet ? { quiet: true } : {}), ...(app.example ? { example: true } : {}) },
    appCard: { details: [], ...card },
    body: `${app.name}: ${text}`,
    ...more,
  }
}
