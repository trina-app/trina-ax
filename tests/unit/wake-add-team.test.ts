// QA wake gap 1: adding a sleeping free trial team in the desktop or phone app. The address check (GET /api/health)
// never wakes a team (relay/src/relay.ts mayWake: no cookie, no token, not a page load), so the relay answered "offline"
// (team_offline_cloud) and the app said "can't reach". Now the check sees a team that may be asleep, wakes it with the
// person's page load (GET / with Sec-Fetch-Mode: navigate), says "Resuming your team…" and goes on when it answers.
import { describe, expect, test } from 'bun:test'
import * as shared from '../../shared/src/team-link'
import * as phone from '../../mobile/src/team-link'
import { checkTeam, healthVerdict, type HealthAnswer, TEAM_DOMAIN } from '../../desktop/src/common/address'
import { checkTeamWith } from '../../mobile/src/team-check'
import { httpFailure, probeAnswer } from '../../mobile/src/reconnect'
import { stringsFor } from '../../mobile/src/strings'
import { t } from '../../desktop/src/common/i18n'
import { mayWake } from '../../relay/src/relay'

/** A fake clock: sleep moves time forward at once. */
function clock() {
  let now = 1_000_000
  const slept: number[] = []
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms }, slept }
}
const WAKING = { status: 503, relayError: 'team_waking', retryAfter: 20 }

describe('the relay answers that may be a sleeping team', () => {
  test('team_offline_cloud and team_waking from the relay; a self-hosted team that is off is not asleep', () => {
    for (const m of [shared, phone]) {
      expect(m.mayBeAsleep(503, 'team_offline_cloud')).toBe(true)
      expect(m.mayBeAsleep(503, 'team_waking')).toBe(true)
      expect(m.relayAnswer(503, 'team_waking')).toBe('waking')
      for (const k of ['team_offline', 'team_busy', 'team_maintenance', null]) expect(m.mayBeAsleep(503, k)).toBe(false)
      expect(m.mayBeAsleep(200, 'team_offline_cloud')).toBe(false)
    }
  })
  test('the wake request is one the relay lets wake a team; the health check is not', () => {
    expect(mayWake({ method: 'GET', url: '/', headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })).toBe(true)
    expect(mayWake({ method: 'GET', url: '/api/health', headers: { accept: 'application/json' } })).toBe(false)
  })
})

describe('wakeTeam (shared by both apps)', () => {
  test('starting: told once, asks again after Retry-After, done when the team answers its page', async () => {
    for (const m of [shared, phone]) {
      const c = clock()
      const answers = [WAKING, WAKING, { status: 503, relayError: 'team_waking', retryAfter: 1 }, { status: 200, relayError: null, retryAfter: null }]
      let told = 0
      const r = await m.wakeTeam({ wake: async () => answers.shift()!, onWaking: () => told++, ...c })
      expect(r).toBe('awake')
      expect(told).toBe(1)
      // Retry-After kept to 3-20 s
      expect(c.slept).toEqual([20_000, 20_000, 3_000])
    }
  })
  test('a team that is off for another reason: "notAsleep" at once, nothing told', async () => {
    const c = clock()
    let told = 0
    expect(await shared.wakeTeam({ wake: async () => ({ status: 503, relayError: 'team_offline_cloud', retryAfter: 5 }), onWaking: () => told++, ...c })).toBe('notAsleep')
    expect(await shared.wakeTeam({ wake: async () => null, onWaking: () => told++, ...c })).toBe('notAsleep')
    expect(told).toBe(0)
    expect(c.slept).toEqual([])
  })
  test('starting but never answering: "timeout" after about 3 minutes; a failed request meanwhile keeps waiting', async () => {
    const c = clock()
    const start = c.now()
    let n = 0
    const r = await shared.wakeTeam({ wake: async () => (n++ === 1 ? null : WAKING), onWaking: () => {}, ...c })
    expect(r).toBe('timeout')
    expect(c.now() - start).toBeLessThanOrEqual(shared.WAKE_LIMIT_MS)
    expect(c.now() - start).toBeGreaterThan(shared.WAKE_LIMIT_MS - 20_000)
  })
})

const ORIGIN = `https://acme.${TEAM_DOMAIN}`
const HEALTH_OK: HealthAnswer = { status: 200, location: null, relayError: null, bodyOk: true }
const ASLEEP: HealthAnswer = { status: 503, location: null, relayError: 'team_offline_cloud', bodyOk: false }

describe('desktop: the add-team check', () => {
  test('a cloud team the relay calls offline may be asleep (not "can\'t reach" yet)', () => {
    expect(healthVerdict(ORIGIN, ASLEEP)).toEqual({ ok: false, error: 'asleep' })
    expect(healthVerdict(ORIGIN, { ...ASLEEP, relayError: 'team_waking' })).toEqual({ ok: false, error: 'asleep' })
    expect(healthVerdict(ORIGIN, { ...ASLEEP, relayError: 'team_offline' })).toEqual({ ok: false, error: 'unreachable' })
  })
  test('a sleeping trial team: woken by a page load, "starting" shown, and added when it answers', async () => {
    const c = clock()
    const health = [ASLEEP, HEALTH_OK]
    const wakes = [WAKING, WAKING, WAKING, { status: 200, relayError: null, retryAfter: null }]
    const woke: string[] = []
    let told = 0
    const r = await checkTeam(ORIGIN, { health: async () => health.shift()!, wake: async (o) => { woke.push(o); return wakes.shift()! }, onWaking: () => told++, ...c })
    expect(r).toEqual({ ok: true, origin: ORIGIN })
    expect(told).toBe(1)
    expect(woke).toEqual([ORIGIN, ORIGIN, ORIGIN, ORIGIN])
  })
  test('a team that is really off still says "can\'t reach"; one that never starts says it did not start', async () => {
    const c = clock()
    expect(await checkTeam(ORIGIN, { health: async () => ASLEEP, wake: async () => ({ status: 503, relayError: 'team_offline_cloud', retryAfter: 5 }), onWaking: () => {}, ...c })).toEqual({ ok: false, error: 'unreachable' })
    expect(await checkTeam(ORIGIN, { health: async () => ASLEEP, wake: async () => WAKING, onWaking: () => {}, ...c })).toEqual({ ok: false, error: 'wakeTimeout' })
  })
  test('an awake team is not woken', async () => {
    let woke = 0
    const r = await checkTeam(ORIGIN, { health: async () => HEALTH_OK, wake: async () => { woke++; return null }, onWaking: () => {}, ...clock() })
    expect(r).toEqual({ ok: true, origin: ORIGIN })
    expect(woke).toBe(0)
  })
  test('the words, in every language', () => {
    expect(t('en', 'welcome.waking')).toBe('Resuming your team…')
    expect(t('en', 'welcome.wakingDetail')).toBe('This takes about a minute. It opens by itself when it is ready.')
    expect(t('en', 'err.wakeTimeout')).toBe("Your team didn't start. Try again in a minute, or contact support.")
    for (const l of ['ko', 'id', 'ja', 'es', 'zh'] as const) expect(t(l, 'welcome.waking')).not.toBe(t('en', 'welcome.waking'))
  })
})

/** A fake expo/fetch: answers by path; records the headers of each request. */
function fakeFetch(answers: Record<string, { status: number; headers?: Record<string, string>; body?: string }[]>) {
  const seen: { path: string; headers: Record<string, string> }[] = []
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    const path = new URL(url).pathname
    seen.push({ path, headers: init.headers })
    const a = answers[path]!.length > 1 ? answers[path]!.shift()! : answers[path]![0]!
    const r = new Response(a.body ?? '', { status: a.status, headers: a.headers ?? {} })
    return r as unknown as Awaited<ReturnType<Parameters<typeof checkTeamWith>[0]['fetch']>>
  }
  return { fetch, seen }
}
const offlineCloud = { status: 503, headers: { 'x-relay-error': 'team_offline_cloud', 'content-type': 'application/json' }, body: '{"error":{"code":"unavailable"}}' }
const waking = { status: 503, headers: { 'x-relay-error': 'team_waking', 'retry-after': '20' }, body: '<html></html>' }
const healthy = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }

describe('phone: the add-team check', () => {
  test('a sleeping trial team: woken by a page load, "starting" shown, and added when it answers', async () => {
    const c = clock()
    const f = fakeFetch({ '/api/health': [offlineCloud, healthy], '/': [waking, waking, { status: 200, body: '<html>app</html>' }] })
    let told = 0
    const r = await checkTeamWith({ fetch: f.fetch, onWaking: () => told++, ...c }, ORIGIN, TEAM_DOMAIN)
    expect(r).toEqual({ ok: true, origin: ORIGIN, renamed: false })
    expect(told).toBe(1)
    const wakes = f.seen.filter((x) => x.path === '/')
    expect(wakes.length).toBe(3)
    // the request the relay lets wake a team (a person's page load), never the health check
    for (const w of wakes) expect(mayWake({ method: 'GET', url: '/', headers: w.headers })).toBe(true)
    for (const h of f.seen.filter((x) => x.path === '/api/health')) expect(mayWake({ method: 'GET', url: '/api/health', headers: h.headers })).toBe(false)
  })
  test('a team that is really off: "unreachable"; one that never starts: "wakeTimeout"; an awake one is not woken', async () => {
    expect(await checkTeamWith({ fetch: fakeFetch({ '/api/health': [offlineCloud], '/': [offlineCloud] }).fetch, ...clock() }, ORIGIN)).toEqual({ ok: false, reason: 'unreachable' })
    expect(await checkTeamWith({ fetch: fakeFetch({ '/api/health': [offlineCloud], '/': [waking] }).fetch, ...clock() }, ORIGIN)).toEqual({ ok: false, reason: 'wakeTimeout' })
    const f = fakeFetch({ '/api/health': [healthy], '/': [waking] })
    expect(await checkTeamWith({ fetch: f.fetch, ...clock() }, ORIGIN)).toEqual({ ok: true, origin: ORIGIN, renamed: false })
    expect(f.seen.map((x) => x.path)).toEqual(['/api/health'])
    // the relay's other answers are unchanged
    expect(await checkTeamWith({ fetch: fakeFetch({ '/api/health': [{ status: 404, headers: { 'x-relay-error': 'team_unknown' } }] }).fetch, ...clock() }, ORIGIN)).toEqual({ ok: false, reason: 'unknown' })
    expect(await checkTeamWith({ fetch: fakeFetch({ '/api/health': [{ status: 503, headers: { 'x-relay-error': 'team_offline' } }] }).fetch, ...clock() }, ORIGIN)).toEqual({ ok: false, reason: 'unreachable' })
  })
  test('Cancel while the team starts: the wait stops ("cancelled"), no more page loads', async () => {
    const c = clock()
    const f = fakeFetch({ '/api/health': [offlineCloud], '/': [waking] })
    const stop = new AbortController()
    const r = await checkTeamWith({ fetch: f.fetch, onWaking: () => {}, ...c, sleep: async (ms) => { await c.sleep(ms); if (f.seen.filter((x) => x.path === '/').length === 2) stop.abort() }, signal: stop.signal }, ORIGIN, TEAM_DOMAIN)
    expect(r).toEqual({ ok: false, reason: 'cancelled' })
    expect(f.seen.filter((x) => x.path === '/').length).toBe(2)
  })
  test('a stop that comes while a request is on its way aborts that request too, and answers "cancelled"', async () => {
    const stop = new AbortController()
    const fetch = (async (_url: string, init: { signal: AbortSignal }) => {
      stop.abort()
      if (init.signal.aborted) throw new Error('aborted')
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as Parameters<typeof checkTeamWith>[0]['fetch']
    expect(await checkTeamWith({ fetch, ...clock(), signal: stop.signal }, ORIGIN)).toEqual({ ok: false, reason: 'cancelled' })
  })
  test('the words, in the phone\'s three languages', () => {
    expect(stringsFor('en').waking).toBe('Resuming your team…')
    expect(stringsFor('en').wakeTimeout).toBe("Your team didn't start. Try again in a minute, or contact support.")
    expect(stringsFor('ko').waking).toBe('팀을 다시 켜고 있어요…')
    expect(stringsFor('zh').wakingDetail).toBe('大约需要一分钟。准备好后会自动打开。')
  })
})

// QA TC-1952: a saved hosted team that sleeps. The phone app's cold start opens the team page; the relay holds it about
// 2.5 s and answers 503 with its own waking page (team_waking). The app showed "Could not reach your team" and Try again
// (every 5xx was a failure), and Try again started the wait again. Now a 503 makes the app check the team at once: the
// check wakes it and waits, with "Resuming your team…" on screen, and the page loads when the team answers.
describe('phone: a saved team that sleeps (the team page answered 503)', () => {
  test('a 503 asks the team; other 5xx stay "Could not reach your team"; 4xx is not a failure', () => {
    expect(httpFailure(503)).toBe('check')
    for (const s of [500, 502, 504, 520]) expect(httpFailure(s)).toBe('unreachable')
    for (const s of [200, 302, 403, 404, 429]) expect(httpFailure(s)).toBeNull()
  })
  test('the page load woke it already (team_waking): told once, page loads when the team answers', async () => {
    const c = clock()
    const f = fakeFetch({ '/api/health': [waking, healthy], '/': [waking, waking, { status: 200, body: '<html>app</html>' }] })
    let told = 0
    const r = await checkTeamWith({ fetch: f.fetch, onWaking: () => told++, ...c }, ORIGIN, TEAM_DOMAIN)
    expect(r).toEqual({ ok: true, origin: ORIGIN, renamed: false })
    expect(probeAnswer(r)).toBe('load')
    expect(told).toBe(1)
    for (const w of f.seen.filter((x) => x.path === '/')) expect(mayWake({ method: 'GET', url: '/', headers: w.headers })).toBe(true)
  })
  test('still asleep (team_offline_cloud): the check wakes it', async () => {
    const f = fakeFetch({ '/api/health': [offlineCloud, healthy], '/': [waking, { status: 200, body: '<html>app</html>' }] })
    let told = 0
    const r = await checkTeamWith({ fetch: f.fetch, onWaking: () => told++, ...clock() }, ORIGIN, TEAM_DOMAIN)
    expect(probeAnswer(r)).toBe('load')
    expect(told).toBe(1)
  })
  test('other 503s are not woken: Trina updating says so, a self-hosted team that is off keeps trying', async () => {
    const maintenance = fakeFetch({ '/api/health': [{ status: 503, headers: { 'x-relay-error': 'team_maintenance' } }], '/': [waking] })
    let told = 0
    const r = await checkTeamWith({ fetch: maintenance.fetch, onWaking: () => told++, ...clock() }, ORIGIN)
    expect(r).toEqual({ ok: false, reason: 'unreachable', updating: true })
    expect(probeAnswer(r)).toBe('updating')
    expect(maintenance.seen.map((x) => x.path)).toEqual(['/api/health'])
    const updating = await checkTeamWith({ fetch: fakeFetch({ '/api/health': [{ status: 503, headers: { 'x-mycel-updating': '1' } }] }).fetch, ...clock() }, ORIGIN)
    expect(probeAnswer(updating)).toBe('updating')
    const off = await checkTeamWith({ fetch: fakeFetch({ '/api/health': [{ status: 503, headers: { 'x-relay-error': 'team_offline' } }] }).fetch, onWaking: () => told++, ...clock() }, ORIGIN)
    expect(probeAnswer(off)).toBe('wait')
    expect(told).toBe(0)
  })
  test('what a check means for the failure screen', () => {
    expect(probeAnswer({ ok: true, origin: ORIGIN, renamed: false })).toBe('load')
    expect(probeAnswer({ ok: false, reason: 'cancelled' })).toBe('wait')
    expect(probeAnswer({ ok: false, reason: 'unreachable' })).toBe('wait')
    // the relay's own page explains these, or the page asks again (a wake that took too long)
    for (const reason of ['unknown', 'suspended', 'notTeam', 'wakeTimeout'] as const) expect(probeAnswer({ ok: false, reason })).toBe('load')
  })
})
