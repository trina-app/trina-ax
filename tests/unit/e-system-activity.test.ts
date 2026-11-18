// The desktop app's word on the computer's own use (desktop/src/common/system-activity.ts): idle time and a locked
// screen from Electron's powerMonitor, for the team page's "in use" and so for holding phone pushes
// (docs/DECISIONS.md "Phone notifications when I'm away").
import { expect, test } from 'bun:test'
import { ComputerReporter, readSystemActivity, SYSTEM_IDLE_THRESHOLD_S, UNSUPPORTED_RETRY_MS, type SystemActivity } from '../../desktop/src/common/system-activity'

test('idle seconds become ms; locked is told; the 10-minute threshold is asked', () => {
  let asked = 0
  expect(readSystemActivity({ getSystemIdleState: (t) => { asked = t; return 'active' }, getSystemIdleTime: () => 42 })).toEqual({ locked: false, idleMs: 42_000 })
  expect(asked).toBe(SYSTEM_IDLE_THRESHOLD_S)
  expect(readSystemActivity({ getSystemIdleState: () => 'locked', getSystemIdleTime: () => 5 })).toEqual({ locked: true, idleMs: 5000 })
  expect(readSystemActivity({ getSystemIdleState: () => 'idle', getSystemIdleTime: () => 700 })).toEqual({ locked: false, idleMs: 700_000 })
})

test('a system that cannot tell (unknown, a throw, a bad number): nothing, the page counts only its own input', () => {
  expect(readSystemActivity({ getSystemIdleState: () => 'unknown', getSystemIdleTime: () => 0 })).toBeNull()
  expect(readSystemActivity({ getSystemIdleState: () => { throw new Error('no') }, getSystemIdleTime: () => 0 })).toBeNull()
  expect(readSystemActivity({ getSystemIdleState: () => 'active', getSystemIdleTime: () => Number.NaN })).toBeNull()
})

// The main process tells the open team's server itself (docs/decisions/20261116-away-os-idle.md): a window in the back
// is throttled and its page may say nothing for minutes.
function reporter(team: { origin: string; signedIn: boolean } | null, status = 204) {
  const posts: { origin: string; body: SystemActivity }[] = []
  let signedOut = 0
  const o = { team, status }
  const r = new ComputerReporter({
    team: () => o.team,
    post: async (origin, body) => { posts.push({ origin, body }); return o.status },
    signedOut: () => { signedOut++ },
  })
  return { r, posts, o, signedOut: () => signedOut }
}

test('reporter: posts idle and lock to the open team while signed in', async () => {
  const m = reporter({ origin: 'https://acme.example', signedIn: true })
  await m.r.report({ locked: false, idleMs: 1234.4 })
  await m.r.report({ locked: true, idleMs: 0 })
  expect(m.posts).toEqual([{ origin: 'https://acme.example', body: { locked: false, idleMs: 1234 } }, { origin: 'https://acme.example', body: { locked: true, idleMs: 0 } }])
})

test('reporter: nothing while signed out, with no team open, or when the system cannot tell', async () => {
  const m = reporter({ origin: 'https://acme.example', signedIn: false })
  await m.r.report({ locked: false, idleMs: 0 })
  m.o.team = null
  await m.r.report({ locked: false, idleMs: 0 })
  m.o.team = { origin: 'https://acme.example', signedIn: true }
  await m.r.report(null)
  expect(m.posts).toEqual([])
})

test('reporter: an older server (404) or a refusal (403) is not asked again until a team is opened; a 401 asks the app to check its session', async () => {
  const m = reporter({ origin: 'https://old.example', signedIn: true }, 404)
  await m.r.report({ locked: false, idleMs: 0 })
  await m.r.report({ locked: false, idleMs: 0 })
  expect(m.posts).toHaveLength(1)
  m.r.reset()
  m.o.status = 403
  await m.r.report({ locked: false, idleMs: 0 })
  await m.r.report({ locked: false, idleMs: 0 })
  expect(m.posts).toHaveLength(2)
  expect(m.signedOut()).toBe(0)
  m.r.reset()
  m.o.status = 401
  await m.r.report({ locked: false, idleMs: 0 })
  expect(m.posts).toHaveLength(3)
  expect(m.signedOut()).toBe(1)
})

test('reporter: a server that updates itself under an open app (404, then the call) is asked again after a while, with no team opened (QA TC-4834)', async () => {
  let now = 1_000_000
  const posts: number[] = []
  const o = { status: 404 }
  const r = new ComputerReporter({ team: () => ({ origin: 'https://acme.example', signedIn: true }), post: async () => { posts.push(now); return o.status }, now: () => now })
  await r.report({ locked: false, idleMs: 0 })
  // the older server: not asked on every 30 s tick
  for (let i = 0; i < 9; i++) { now += 30_000; await r.report({ locked: false, idleMs: 0 }) }
  r.farewell()
  expect(posts).toHaveLength(1)
  // it updated itself (at night, the app left open): asked again once the wait is over, and reported to from then on
  o.status = 204
  now = 1_000_000 + UNSUPPORTED_RETRY_MS
  await r.report({ locked: false, idleMs: 0 })
  now += 30_000
  await r.report({ locked: false, idleMs: 0 })
  expect(posts).toHaveLength(3)
  // a refusal (403) waits the same way
  o.status = 403
  now += 30_000
  await r.report({ locked: false, idleMs: 0 })
  now += 30_000
  await r.report({ locked: false, idleMs: 0 })
  expect(posts).toHaveLength(4)
  now += UNSUPPORTED_RETRY_MS
  await r.report({ locked: false, idleMs: 0 })
  expect(posts).toHaveLength(5)
})

test('reporter: a lock while a tick is on its way is not lost: the newest word goes right after', async () => {
  const posts: SystemActivity[] = []
  let release!: () => void
  const r = new ComputerReporter({
    team: () => ({ origin: 'https://acme.example', signedIn: true }),
    post: async (_o, body) => { posts.push(body); if (posts.length === 1) await new Promise<void>((ok) => { release = ok }); return 204 },
  })
  const first = r.report({ locked: false, idleMs: 1000 })
  await r.report({ locked: false, idleMs: 2000 })
  await r.report({ locked: true, idleMs: 0 })
  release()
  await first
  expect(posts).toEqual([{ locked: false, idleMs: 1000 }, { locked: true, idleMs: 0 }])
})

test('reporter: leaving the team tells it at once that this computer is not at it (idle at the threshold)', async () => {
  const m = reporter({ origin: 'https://acme.example', signedIn: true })
  m.r.farewell()
  await Promise.resolve()
  expect(m.posts).toEqual([{ origin: 'https://acme.example', body: { locked: false, idleMs: SYSTEM_IDLE_THRESHOLD_S * 1000 } }])
  m.o.team = { origin: 'https://acme.example', signedIn: false }
  m.r.farewell()
  expect(m.posts).toHaveLength(1)
})

test('reporter: an unreachable server is no error, and the next tick tries again', async () => {
  let n = 0
  const r = new ComputerReporter({ team: () => ({ origin: 'https://acme.example', signedIn: true }), post: async () => { n++; throw new Error('offline') } })
  await r.report({ locked: false, idleMs: 0 })
  await r.report({ locked: false, idleMs: 0 })
  expect(n).toBe(2)
})
