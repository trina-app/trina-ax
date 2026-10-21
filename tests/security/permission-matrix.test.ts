// PERMANENT permission matrix (design 설계서 tab 2 "폴더와 권한 규칙", tab 7 threats; the owner's #1 requirement:
// nobody sees, learns or changes anything their permissions do not allow, and nobody raises their own privilege).
//
// It boots an isolated server instance (tests/security/lib/instance.ts) with the REAL session service, builds a
// team with owner / admin / member-in-group / other-member-in-group / member-not-in-group / must-change-password /
// logged-out personas and private + group + project + shared resources (tests/security/lib/world.ts), then for
// EVERY HTTP route registered in server/src/routes/*.ts (enumerated from the code, not a hand-picked subset) and
// every ws subscription asserts allow / deny per persona and that no response leaks a canary the caller may not
// see. A failing case is a finding; its name is the evidence. Cases that currently fail carry a TODO referencing
// the finding title instead of being deleted.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import path from 'node:path'
import { CSRF_HEADER, DEV_SESSION_COOKIE, WS_PROTOCOL } from '@mycel/shared/api'
import { startInstance, type Instance } from './lib/instance'
import { buildWorld, freshClient, PW, WHO, type World } from './lib/world'
import { allCases, SPECS } from './lib/cases'
import { enumerateRoutes, judge } from './lib/matrix'

setDefaultTimeout(180_000)
const REPO = path.resolve(import.meta.dir, '..', '..') // worktree root

// ---------------------------------------------------------------- route coverage
describe('coverage', () => {
  test('every route in server/src/routes/*.ts has a matrix case', () => {
    const routes = enumerateRoutes(REPO)
    const covered = new Set(Object.keys(SPECS))
    // the two raw routes are exercised separately (ws subscriptions test, web app shell)
    const rawCovered = new Set(['RAW GET WS_PATH', 'RAW GET \'*\''])
    const missing = routes.filter((r) => (r.startsWith('RAW') ? !rawCovered.has(r) : !covered.has(r)))
    expect(missing, `routes with no matrix case: ${missing.join(', ')}`).toEqual([])
  })
  test('no matrix case targets a route the code does not register', () => {
    const routes = new Set(enumerateRoutes(REPO))
    const extra = Object.keys(SPECS).filter((r) => !routes.has(r))
    expect(extra, `cases for unregistered routes: ${extra.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------- the matrix (deny + no-leak + custom checks)
// A shared world: deny cases are rejected (no mutation), GET cases don't mutate, so the world stays pristine for
// every case. Allowed mutating writes are checked on a separate world below.
let W: World
let inst: Instance
beforeAll(async () => { inst = await startInstance('matrix'); W = await buildWorld(inst) })
afterAll(async () => { for (const s of Object.values(W?.sockets ?? {})) s.close(); await inst?.close() })

// Every case runs once, in two phases on the pristine world:
//   phase 1 (read-only + every deny): GETs don't mutate and denies are rejected, so the world stays pristine while
//            the whole deny/no-leak matrix is judged.
//   phase 2 (allowed writes + any case carrying a custom check or a TODO/finding): run after, order no longer
//            matters because each asserts only on its own response.
// judge(): deny -> 4xx + no leak; allow GET -> 2xx + no leak; allow write -> passed the permission check (not
//          401/403), tolerating a 404/409 from an earlier allowed write; a TODO case that still fails documents a
//          finding instead of failing the suite.
const isGet = (k: { run: Function }) => k.run.toString().includes('c.get(')
describe('permission matrix: every route x every persona', () => {
  const cases = allCases()
  const phase1 = cases.filter((k) => isGet(k) || k.exp === 'deny')
  const phase2 = cases.filter((k) => !(isGet(k) || k.exp === 'deny'))
  const run = (k: (typeof cases)[number]) => test(`${k.label} [${k.exp}]`, async () => {
    // auth-flow / session-mutating routes run on a throwaway client so they cannot swap or destroy the shared
    // persona's session (login, accept-invite, logout, reauth); everything else uses the shared persona client.
    const client = k.skipPositive ? await freshClient(W, k.who) : W.as[k.who]
    const r = await k.run(client, W)
    const problems = judge(k, r)
    if (k.exp === 'allow' && !isGet(k) && !k.skipPositive && (r.status === 401 || r.status === 403)) problems.push(`legit ${k.who} refused by the permission check: ${r.status} ${r.text.slice(0, 160)}`)
    // for an allowed write, a non-permission failure (404/409 from an earlier write, reauth) is not a matrix problem
    if (k.exp === 'allow' && !isGet(k)) { const i = problems.indexOf(problems.find((p) => p.startsWith('expected allow')) ?? ''); if (i >= 0) problems.splice(i, 1) }
    try { await k.check?.(r, W) } catch (e) { problems.push((e as Error).message) }
    if (k.todo) { expect(problems, `this case should be failing (documents finding: ${k.todo})`).not.toEqual([]); return }
    expect(problems, problems.join(' | ')).toEqual([])
  })
  describe('phase 1: reads + denies (pristine world)', () => { for (const k of phase1) run(k) })
  describe('phase 2: allowed writes + finding checks', () => { for (const k of phase2) run(k) })
})

// ---------------------------------------------------------------- findings: known gaps vs the design source of truth
// Each test here asserts the DESIGNED behaviour and currently FAILS, documenting a finding (kept, not deleted, per
// the review rule). Fixing the server should turn it green.
describe('findings (asserts the 설계서; currently failing)', () => {
  // TODO finding "admin-can-delete-account": the 설계서 (tab 4 "DELETE /api/admin/users/:id ... owner만", DECISIONS.md
  // A "계정 삭제는 owner만") reserves account deletion to the OWNER, but API.deleteUser is auth:'admin' and
  // server/src/admin/users.ts deleteUser()->guard() never enforces owner-only for a member target, so a non-owner
  // admin can tombstone a member (ends their sessions, purges chats/memories, moves their personal folder).
  test('an admin (not owner) cannot delete a member account [TODO admin-can-delete-account]', async () => {
    // a fresh member so the matrix's own deleteUser cases don't race this one
    const u = await W.as.owner.ok('POST', '/api/admin/users', { username: 'victim' + crypto.randomUUID().slice(0, 6), name: 'Victim', role: 'member' })
    const r = await W.as.admin.del(`/api/admin/users/${u.user.id}`)
    expect(r.status, `admin deleted a member (design: owner only): ${r.status}`).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------- WebSocket subscription scoping
describe('ws subscriptions', () => {
  test('cookie socket needs an allowed Origin (no cross-site hijack)', async () => {
    const bad = await W.as.memberIn.ws({ origin: 'https://evil.example' })
    const c = await bad.closedWith()
    expect(c?.code, 'cross-site Origin must be refused (4403)').toBe(4403)
  })
  test('a socket with no cookie and no bearer is refused', async () => {
    const q = new URLSearchParams({ windowId: 'win-anon' })
    const sock = new WebSocket(`${inst.url.replace('http', 'ws')}/api/ws?${q}`, { headers: { origin: inst.url }, protocols: [WS_PROTOCOL] } as unknown as string[])
    const s = new (await import('./lib/instance')).Socket(sock, 'anon')
    const c = await s.closedWith()
    expect(c?.code, 'unauthenticated socket must close 4401').toBe(4401)
  })
  test("realtime events for one person never carry another person's data", async () => {
    // alice is subscribed (W.sockets.alice). bob writes in the finance folder and sends a chat turn; alice's
    // socket must receive none of bob's file paths, chat or message content.
    const before = W.sockets.alice.raw.length
    await W.as.memberOut.put('/api/files/content', { path: `${W.groups.finFolder}/burst.md`, content: 'SEC-WS-FIN-LEAK-777', baseSha256: null })
    await W.as.memberOut.post(`/api/chats/${W.ids.bobChat}/messages`, { clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], content: '@fake ' + JSON.stringify({ say: 'SEC-WS-BOBMSG-888' }) })
    await Bun.sleep(1500)
    const got = W.sockets.alice.raw.slice(before).join('\n')
    expect(got.includes('SEC-WS-FIN-LEAK-777'), 'alice saw a finance file path over realtime').toBe(false)
    expect(got.includes('SEC-WS-BOBMSG-888'), "alice saw bob's message over realtime").toBe(false)
    expect(got.includes('burst.md'), 'alice saw a finance file name over realtime').toBe(false)
  })
  test('a file change alice CAN read reaches her socket (sharing works)', async () => {
    const before = W.sockets.alice.raw.length
    await W.as.owner.put('/api/files/content', { path: 'shared/ping.md', content: 'SEC-WS-SHARED-321', baseSha256: null })
    await Bun.sleep(1200)
    const got = W.sockets.alice.raw.slice(before).join('\n')
    expect(got.includes('shared/ping.md'), 'alice did not get a shared/ file change she can read').toBe(true)
  })
})

// ---------------------------------------------------------------- privilege escalation (nobody raises their own rights)
describe('no self-escalation', () => {
  test('a member cannot make themselves admin or owner', async () => {
    const a = await W.as.memberIn.patch('/api/admin/users/alice', { role: 'admin' })
    expect(a.status, 'member PATCH own role must be forbidden').toBeGreaterThanOrEqual(400)
    const me = await W.as.memberIn.get('/api/me')
    expect(me.json.user.role).toBe('member')
  })
  test('an admin cannot promote anyone (including self) to admin/owner — owner only', async () => {
    const r = await W.as.admin.patch('/api/admin/users/bob', { role: 'admin' })
    expect(r.status, 'only the owner may create admins').toBeGreaterThanOrEqual(400)
  })
  test('an admin cannot grant themselves rules on another person\'s private folder', async () => {
    const r = await W.as.admin.post('/api/admin/folders', { path: 'users/alice', create: false, rules: [{ subjectType: 'user', subjectId: 'carol', access: 'read' }] })
    expect(r.status, 'rules under users/ must be refused').toBeGreaterThanOrEqual(400)
    const read = await W.as.admin.get('/api/files/content?path=users%2Falice%2Ftodo.md')
    expect(read.status, 'admin still cannot read users/alice after trying to add a rule').toBeGreaterThanOrEqual(400)
  })
})
