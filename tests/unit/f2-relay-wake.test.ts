// F2 sleep, relay side without processes: the wake client (signature, one call per team per 10 s with a shared answer,
// the global cap, strictly increasing timestamps, answers it does not trust), the wake settings, which requests are
// browser page loads, and the team server's time-jump detector that reconnects the relay connections after a resume.
import { afterEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WAKE_API_PATH, parseWakeAuthorizationHeader, wakeSigningString } from '@mycel/shared/cloud-protocol/relay-ops'
import { GLOBAL_PER_MIN, TEAM_GAP_MS, WakeClient, type WakeFetch } from '../../relay/src/wake.ts'
import { loadRelayConfig } from '../../relay/src/config.ts'
import { isNavigation, mayWake } from '../../relay/src/relay.ts'
import { htmlPage, noRoomRetrySec, PAGE_DETAIL, PAGE_RETRY_AFTER, PAGE_STATUS, RELAY_ERROR_OF, WAKE_LATE_SEC, wakingRefreshSec } from '../../relay/src/pages.ts'
import { OpsWakeResponseSchema } from '@mycel/shared/cloud-protocol'
import { WORK } from '../lib/env'

const W = path.join(WORK, `f2-relay-wake-${process.pid}`)
afterEach(() => fs.rmSync(W, { recursive: true, force: true }))
const quiet = { info() {}, warn() {}, error() {} }

function keyFile() {
  fs.mkdirSync(W, { recursive: true })
  const k = crypto.generateKeyPairSync('ed25519')
  const f = path.join(W, `wake-${Math.random().toString(36).slice(2)}.pem`)
  fs.writeFileSync(f, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { file: f, pub: k.publicKey }
}

describe('wake client', () => {
  test('signed request; one call per team per 10 s (the answer is shared); strictly increasing ts', async () => {
    const k = keyFile()
    let now = 1_000_000
    const seen: { url: string; body: string; auth: string }[] = []
    const fetch: WakeFetch = async (url, i) => { seen.push({ url, body: i.body, auth: i.headers.authorization! }); return { ok: true, status: 200, json: async () => ({ state: 'waking', retryAfterSec: 4 }) } }
    const w = new WakeClient({ url: 'https://cp.example', keyFile: k.file, keyId: 'relay-1', log: quiet, fetch, now: () => now })
    const [a, b] = await Promise.all([w.wake('T1', 'http'), w.wake('T1', 'ws')])
    expect(a).toEqual({ state: 'waking', retryAfterSec: 4 })
    expect(b).toBe(a)
    expect(seen.length).toBe(1)
    expect(seen[0]!.url).toBe('https://cp.example' + WAKE_API_PATH)
    expect(JSON.parse(seen[0]!.body)).toEqual({ teamId: 'T1', reason: 'http' })
    const h = parseWakeAuthorizationHeader(seen[0]!.auth)!
    expect(h.keyId).toBe('relay-1')
    expect(crypto.verify(null, Buffer.from(wakeSigningString(WAKE_API_PATH, h.ts, seen[0]!.body)), k.pub, Buffer.from(h.sig, 'base64'))).toBe(true)
    await w.wake('T2', 'http')
    expect(parseWakeAuthorizationHeader(seen[1]!.auth)!.ts).toBe(h.ts + 1) // same millisecond: ts + 1
    now += TEAM_GAP_MS
    await w.wake('T1', 'http')
    expect(seen.length).toBe(3)
  })

  test('global cap per minute; a bad or failed answer is an error, never trusted', async () => {
    const k = keyFile()
    let now = 5_000_000
    let answer: unknown = { state: 'awake', retryAfterSec: 0 }
    let status = 200
    let fail = false
    const fetch: WakeFetch = async () => { if (fail) throw new Error('net'); return { ok: status === 200, status, json: async () => answer } }
    const w = new WakeClient({ url: 'https://cp.example', keyFile: k.file, keyId: 'k', log: quiet, fetch, now: () => now })
    for (let i = 0; i < GLOBAL_PER_MIN; i++) expect((await w.wake(`A${i}`, 'http')).state).toBe('awake')
    expect((await w.wake('over', 'http')).state).toBe('limited')
    expect(w.counters.wakeLimited).toBe(1)
    now += 60_000
    answer = { state: 'asleep-ish', retryAfterSec: 1 }
    expect((await w.wake('B1', 'http')).state).toBe('error')
    answer = { state: 'busy', retryAfterSec: 99_999 }
    expect(await w.wake('B2', 'http')).toEqual({ state: 'busy', retryAfterSec: 3600 })
    // the optional busy hint: kept only as no_room with busy; any other value or state is the plain answer
    answer = { state: 'busy', retryAfterSec: 300, reason: 'no_room' }
    expect(await w.wake('B5', 'http')).toEqual({ state: 'busy', retryAfterSec: 300, reason: 'no_room' })
    answer = { state: 'busy', retryAfterSec: 300, reason: 'later_maybe' }
    expect(await w.wake('B6', 'http')).toEqual({ state: 'busy', retryAfterSec: 300 })
    answer = { state: 'waking', retryAfterSec: 20, reason: 'no_room' }
    expect(await w.wake('B7', 'http')).toEqual({ state: 'waking', retryAfterSec: 20 })
    status = 401
    expect((await w.wake('B3', 'http')).state).toBe('error')
    fail = true
    expect((await w.wake('B4', 'http')).state).toBe('error')
    expect(w.counters.wakeErrors).toBe(3)
  })

  test('only an Ed25519 key', () => {
    fs.mkdirSync(W, { recursive: true })
    const f = path.join(W, 'rsa.pem')
    fs.writeFileSync(f, crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
    expect(() => new WakeClient({ url: 'https://cp.example', keyFile: f, keyId: 'k', log: quiet })).toThrow(/Ed25519/)
  })
})

describe('wake settings', () => {
  const base = { RELAY_DOMAIN: 'trina.app' }
  test('off without RELAY_WAKE_URL; defaults 20 s / 2.5 s; https, or http to loopback / Tailscale only', () => {
    expect(loadRelayConfig([], base).wake).toBeNull()
    const on = loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'https://cp.trina.app/', RELAY_WAKE_KEY_FILE: '/k.pem', RELAY_WAKE_KEY_ID: 'relay-kr1' }).wake
    expect(on).toEqual({ url: 'https://cp.trina.app', keyFile: '/k.pem', keyId: 'relay-kr1', holdMs: 20_000, pageMs: 2500 })
    expect(loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'http://100.87.15.118:8443', RELAY_WAKE_KEY_FILE: '/k', RELAY_WAKE_KEY_ID: 'k' }).wake?.url).toBe('http://100.87.15.118:8443')
    expect(() => loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'http://cp.trina.app', RELAY_WAKE_KEY_FILE: '/k', RELAY_WAKE_KEY_ID: 'k' })).toThrow(/https/)
    expect(() => loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'https://cp.trina.app' })).toThrow(/KEY_FILE/)
  })
})

describe('browser page loads (the waking page)', () => {
  const r = (method: string, url: string, headers: Record<string, string>) => ({ method, url, headers })
  test('GET/HEAD for HTML outside /api/, plus the two provider callbacks', () => {
    expect(isNavigation(r('GET', '/', { accept: 'text/html,*/*' }))).toBe(true)
    expect(isNavigation(r('HEAD', '/x', { 'sec-fetch-mode': 'navigate' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/integrations/oauth/callback?code=1', { accept: 'text/html' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/integrations/google-drive/callback?code=1', { 'sec-fetch-mode': 'navigate' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/me', { accept: 'text/html' }))).toBe(false)
    expect(isNavigation(r('POST', '/', { accept: 'text/html' }))).toBe(false)
    expect(isNavigation(r('GET', '/', { accept: 'application/json' }))).toBe(false)
  })
})

describe('the waking page (a stopped hosted server starts in about a minute)', () => {
  test('reloads after the control plane\'s retryAfterSec, kept to 3-20 s', () => {
    expect(wakingRefreshSec(20)).toBe(20)
    expect(wakingRefreshSec(5)).toBe(5)
    expect(wakingRefreshSec(1)).toBe(3)
    expect(wakingRefreshSec(300)).toBe(20)
    expect(wakingRefreshSec(null)).toBe(PAGE_RETRY_AFTER.team_waking!)
    expect(htmlPage('team_waking', 'en', null, undefined, 20)).toContain('<meta http-equiv="refresh" content="20">')
    expect(htmlPage('team_waking', 'en')).toContain(`<meta http-equiv="refresh" content="${PAGE_RETRY_AFTER.team_waking}">`)
    expect(htmlPage('team_offline_cloud', 'en')).not.toContain('http-equiv')
    expect(PAGE_STATUS.team_waking).toBe(503)
  })

  test('says it takes about a minute, in every language', () => {
    const en = htmlPage('team_waking', 'en', null, undefined, 20)
    expect(en).toContain('Resuming your team…')
    expect(en).toContain('about a minute')
    for (const lang of ['ko', 'id', 'ja', 'es', 'zh'] as const) {
      const h = htmlPage('team_waking', lang, null, undefined, 20)
      expect(h).toContain(`lang="${lang}"`)
      expect(h).not.toContain('Resuming your team')
    }
  })
})

describe('the waking page shows that it is working', () => {
  test('a spinner without script, the seconds counted by a tiny inline script, in every language', () => {
    for (const lang of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      const h = htmlPage('team_waking', lang, null, undefined, 20)
      expect(h).toContain('class="sp"')
      expect(h).toContain('@keyframes sp')
      expect(h).toContain('prefers-reduced-motion')
      expect(h).toContain('prefers-color-scheme:dark')
      expect(h).toContain('id="w"')
      expect(h).toContain('name="viewport"')
      expect(h).toContain('<meta http-equiv="refresh"')
      // the label is in the page language and the script holds no other text
      expect(h).toContain('%N%')
    }
    expect(htmlPage('team_waking', 'en')).toContain('Waiting: %N% s')
    expect(htmlPage('team_waking', 'ko')).toContain('기다린 시간')
  })
  test('the other pages have no spinner and no script', () => {
    for (const k of ['team_offline_cloud', 'team_busy', 'team_maintenance'] as const) {
      const h = htmlPage(k, 'en')
      expect(h).not.toContain('class="sp"')
      expect(h).not.toContain('<script')
    }
  })
  /** runs the page's inline script against a tiny fake page; returns the elements and a clock */
  function runPage(lang: 'en' | 'ko' = 'en', store: Record<string, string> = {}) {
    const h = htmlPage('team_waking', lang, null, undefined, 20)
    const code = /<script>([\s\S]*?)<\/script>/.exec(h)![1]!
    const els: Record<string, { hidden: boolean; textContent: string; onclick?: () => void }> = {
      w: { hidden: true, textContent: '' }, wf: { hidden: true, textContent: '' }, sp: { hidden: false, textContent: '' }, wr: { hidden: false, textContent: '' },
    }
    let tick: (() => void) | null = null
    let reloads = 0
    const cleared: unknown[] = []
    const win: { mycelWakeReload?: unknown } = { mycelWakeReload: 'reload-timer' }
    new Function('document', 'sessionStorage', 'setInterval', 'clearInterval', 'clearTimeout', 'window', 'location', code)(
      { getElementById: (id: string) => els[id] ?? null },
      { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: unknown) => { store[k] = String(v) }, removeItem: (k: string) => { delete store[k] } },
      (f: () => void) => { tick = f; return 'tick-timer' },
      (id: unknown) => { cleared.push(id); if (id === 'tick-timer') tick = null },
      (id: unknown) => { cleared.push(id) },
      win,
      { reload: () => { reloads++ } },
    )
    // a stopped timer never fires again; tick() then does nothing, like a browser
    return { h, els, store, tick: () => tick?.(), stopped: () => tick === null, cleared, reloads: () => reloads }
  }
  test('the inline script runs: counts from the first load, keeps counting over reloads, starts over after 10 minutes or a gap', () => {
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const a = runPage()
      expect(a.els.w!.hidden).toBe(false)
      expect(a.els.w!.textContent).toBe('Waiting: 0 s')
      now += 42_000
      a.tick()
      expect(a.els.w!.textContent).toBe('Waiting: 42 s')
      // a reload of the page keeps counting
      now += 3_000
      const b = runPage('en', a.store)
      expect(b.els.w!.textContent).toBe('Waiting: 45 s')
      // a page of the team in between (no count for over a minute): a new wait starts at 0, not at the old count
      now += 90_000
      expect(runPage('en', b.store).els.w!.textContent).toBe('Waiting: 0 s')
      // an old count (the stored number of an older page) starts over too
      expect(runPage('en', { mycelWakeSince: String(now - 5_000) }).els.w!.textContent).toBe('Waiting: 0 s')
    } finally { Date.now = realNow }
  })
  test(`after ${WAKE_LATE_SEC} s the spinner gives way to a real answer and Try again, in every language`, () => {
    for (const lang of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      const h = htmlPage('team_waking', lang, null, undefined, 20)
      expect(h).toContain('id="wf" role="alert" hidden')
      expect(h).toContain('<button id="wr" type="button">')
    }
    expect(htmlPage('team_waking', 'en')).toContain('taking longer than usual')
    expect(htmlPage('team_waking', 'ko')).toContain('다시 시도')
    let now = 2_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const p = runPage()
      now += (WAKE_LATE_SEC - 1) * 1000
      p.tick()
      expect(p.els.wf!.hidden).toBe(true)
      expect(p.els.sp!.hidden).toBe(false)
      now += 1000
      p.tick()
      expect(p.els.wf!.hidden).toBe(false)
      expect(p.els.sp!.hidden).toBe(true)
      // a reload while late shows the answer at once (the count goes on)
      now += 10_000
      expect(runPage('en', p.store).els.wf!.hidden).toBe(false)
      // Try again: the count starts over and the page reloads
      p.els.wr!.onclick!()
      expect(p.reloads()).toBe(1)
      expect(p.store.mycelWakeSince).toBeUndefined()
    } finally { Date.now = realNow }
  })
  test('Try again stops the old page first: its timer cannot write the old start back while the relay holds the reload (TC-8973)', () => {
    let now = 3_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const p = runPage()
      now += 196_000
      p.tick()
      expect(p.els.w!.textContent).toBe('Waiting: 196 s')
      p.els.wr!.onclick!()
      // the 1-second timer and the #fragment reload timer are stopped before the start time is forgotten
      expect(p.cleared).toEqual(['tick-timer', 'reload-timer'])
      expect(p.stopped()).toBe(true)
      expect(p.reloads()).toBe(1)
      // the relay holds the next load ~2.5 s; the old page stays and its timer would have fired twice
      now += 2_500
      p.tick()
      p.tick()
      expect(p.store.mycelWakeSince).toBeUndefined()
      // the new page counts from 0, not on from 196 s (QA saw 210 s)
      expect(runPage('en', p.store).els.w!.textContent).toBe('Waiting: 0 s')
    } finally { Date.now = realNow }
  })
})

describe('a page with a #fragment reloads too (the setup link /setup#token=…)', () => {
  // a browser does not reload for <meta http-equiv="refresh"> when the address has a fragment (it jumps inside the
  // page): the waking page on the owner's setup link counted on for ever (owner 2026-11-22). Checked in Chrome.
  const scripts = (h: string) => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  const run = (code: string, hash: string) => {
    const timers: number[] = []
    let reloads = 0
    new Function('location', 'setTimeout', 'window', code)({ hash, reload: () => { reloads++ } }, (f: () => void, ms: number) => { timers.push(ms); f() }, {})
    return { timers, reloads }
  }
  test('the waking and the no-room page reload a fragment address after their own refresh time; without one the meta tag does it', () => {
    for (const [h, sec] of [[htmlPage('team_waking', 'en', null, undefined, 20), 20], [htmlPage('team_no_room', 'ko', null, undefined, 120), 120]] as const) {
      const code = scripts(h).find((c) => c.includes('location.hash'))!
      expect(code).toBeDefined()
      expect(run(code, '#token=abc')).toEqual({ timers: [sec * 1000], reloads: 1 })
      expect(run(code, '')).toEqual({ timers: [], reloads: 0 })
      expect(h).toContain(`<meta http-equiv="refresh" content="${sec}">`)
    }
    for (const k of ['team_offline_cloud', 'team_busy', 'team_maintenance'] as const) expect(htmlPage(k, 'en')).not.toContain('location.hash')
  })
})

describe('who may wake a sleeping team (trial auto-stop, 2026-11-14)', () => {
  const req = (method: string, url: string, headers: Record<string, string> = {}) => ({ method, url, headers })
  test('a browser page load, a cookie or a token wakes it', () => {
    expect(mayWake(req('GET', '/', { 'sec-fetch-mode': 'navigate', accept: 'text/html' }))).toBe(true)
    expect(mayWake(req('GET', '/api/me', { cookie: 'sid=x' }))).toBe(true)
    expect(mayWake(req('POST', '/mcp', { authorization: 'Bearer tax_mcp_a_x' }))).toBe(true)
  })
  test('scanners, link previews, uptime checks and probes do not', () => {
    expect(mayWake(req('GET', '/', { accept: 'text/html', 'user-agent': 'Slackbot-LinkExpanding 1.0' }))).toBe(false)
    expect(mayWake(req('GET', '/wp-login.php'))).toBe(false)
    expect(mayWake(req('HEAD', '/', { 'sec-fetch-mode': 'navigate' }))).toBe(false)
    expect(mayWake(req('GET', '/robots.txt', { 'sec-fetch-mode': 'navigate' }))).toBe(false)
    expect(mayWake(req('GET', '/favicon.ico', { cookie: 'sid=x' }))).toBe(false)
  })
})

describe('wake answer: the optional no_room hint (contract)', () => {
  test('the schema: optional, only no_room, only with busy; an old answer without it still parses', () => {
    expect(OpsWakeResponseSchema.safeParse({ state: 'busy', retryAfterSec: 300 }).success).toBe(true)
    expect(OpsWakeResponseSchema.safeParse({ state: 'busy', retryAfterSec: 300, reason: 'no_room' }).success).toBe(true)
    expect(OpsWakeResponseSchema.safeParse({ state: 'busy', retryAfterSec: 300, reason: 'full' }).success).toBe(false)
    expect(OpsWakeResponseSchema.safeParse({ state: 'waking', retryAfterSec: 20, reason: 'no_room' }).success).toBe(false)
  })
  test('the page: calm text in 6 languages, reloads after 60-300 s, still team_busy for the apps', () => {
    expect([noRoomRetrySec(5), noRoomRetrySec(300), noRoomRetrySec(1800), noRoomRetrySec(null)]).toEqual([60, 300, 300, 60])
    expect([PAGE_STATUS.team_no_room, PAGE_RETRY_AFTER.team_no_room, RELAY_ERROR_OF.team_no_room, PAGE_DETAIL.team_no_room]).toEqual([503, 60, 'team_busy', 'no_room'])
    const ko = htmlPage('team_no_room', 'ko', null, undefined, 5)
    expect(ko).toContain('지금 서버 자리가 잠깐 모자라요. 자리가 나는 대로 바로 깨워서 팀 관리자에게 이메일로 알려 드려요.')
    expect(ko).toContain('<meta http-equiv="refresh" content="60">')
    expect(htmlPage('team_no_room', 'en', null, undefined, 900)).toContain('<meta http-equiv="refresh" content="300">')
    expect(htmlPage('team_no_room', 'en')).toContain('let the team&#39;s owners know by email')
    const titles = new Set<string>()
    for (const lang of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      const h = htmlPage('team_no_room', lang, null, undefined, 300)
      expect(h).toContain(`lang="${lang}"`)
      // one script only: the reload of a #fragment address (no spinner, no counter)
      expect(h.match(/<script>/g)).toHaveLength(1)
      expect(h).toContain('if(location.hash)')
      expect(h).not.toContain('class="sp"')
      expect(h).not.toContain('Please try again shortly')
      titles.add(/<h1>(.*?)<\/h1>/.exec(h)![1]!)
    }
    expect(titles.size).toBe(6)
  })
})
