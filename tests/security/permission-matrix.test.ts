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
import { allCases } from './lib/cases'
import { routeCoverage } from './lib/coverage'
import { judge } from './lib/matrix'

setDefaultTimeout(180_000)
const REPO = path.resolve(import.meta.dir, '..', '..') // worktree root

// ---------------------------------------------------------------- route coverage (also a unit test, run in CI:
// tests/unit/security-route-coverage.test.ts)
describe('coverage', () => {
  test('every route in server/src/routes/*.ts has a matrix case', () => {
    const { missing } = routeCoverage(REPO)
    expect(missing, `routes with no matrix case: ${missing.join(', ')}`).toEqual([])
  })
  test('no matrix case targets a route the code does not register', () => {
    const { extra } = routeCoverage(REPO)
    expect(extra, `cases for unregistered routes: ${extra.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------- the matrix (deny + no-leak + custom checks)
// A shared world: deny cases are rejected (no mutation), GET cases don't mutate, so the world stays pristine for
// every case. Allowed mutating writes are checked on a separate world below.
let W: World
let inst: Instance
beforeAll(async () => { inst = await startInstance('matrix'); W = await buildWorld(inst, { sharedSubscriptions: true, connectCard: true }) })
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

// ---------------------------------------------------------------- account deletion by role
// 설계서 4번 탭 / DECISIONS.md 역할 규칙: the owner deletes anyone but themselves; an admin deletes a plain member only,
// with their own password in the body. Never the owner, another admin or themselves.
describe('account deletion by role', () => {
  // the matrix above sent wrong passwords for the admin-reauth case (the API engine) as the admin and the
  // owner: their re-entry limit (5 wrong passwords per person) is used up, which these tests are not about
  beforeAll(() => { inst.ctx.db.query("DELETE FROM login_attempts WHERE key LIKE 'reauth:%'").run() })
  const fresh = async (role: 'member' | 'admin') => (await W.as.owner.ok('POST', '/api/admin/users', { username: 'victim' + crypto.randomUUID().slice(0, 6), name: 'Victim', role })).user.id as string
  test('an admin cannot delete a member without the password, nor with a wrong one', async () => {
    const id = await fresh('member')
    for (const body of [undefined, { password: 'wrong-password-1' }]) {
      const r = await W.as.admin.del(`/api/admin/users/${id}`, body)
      expect(r.status, `admin deleted a member with no valid password: ${r.status}`).toBe(403)
    }
  })
  test('an admin cannot delete another admin or the owner, even with the password', async () => {
    const other = await fresh('admin')
    expect((await W.as.admin.del(`/api/admin/users/${other}`, { password: PW.carol })).status).toBe(403)
    expect((await W.as.admin.del('/api/admin/users/dana', { password: PW.carol })).status).toBe(403)
  })
  test('an admin deletes a member with the password', async () => {
    const id = await fresh('member')
    expect((await W.as.admin.del(`/api/admin/users/${id}`, { password: PW.carol })).status).toBe(204)
  })
  test('a member cannot delete anyone', async () => {
    const id = await fresh('member')
    expect((await W.as.memberIn.del(`/api/admin/users/${id}`, { password: PW.alice })).status).toBe(403)
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

// ---------------------------------------------------------------- shared project chats (docs/DECISIONS.md "Shared project chats")
// A shared chat of projects/falcon: its people (alice who made it, bob who reads the folder, the owner and an admin)
// see it and continue it; erin (not in its audience), a person who still has to change their password and a signed-out
// caller get nothing. Run last: it turns the project's setting on for one chat and off again.
describe('shared project chat x every persona', () => {
  let chat = ''
  const CANARY = 'SEC-SHARED-MATRIX-6610'
  beforeAll(async () => {
    // the matrix's allowed writes reset bob's password (resetPassword): his own one again, so he can sign in below
    const { hashPassword } = await import('../../server/src/auth/passwords')
    inst.ctx.db.query('UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, temp_password_failures = 0 WHERE id = ?').run(await hashPassword(PW.bob), 'bob')
    inst.ctx.db.query("DELETE FROM login_attempts WHERE key LIKE '%bob%'").run()
    // ...and the writes may have changed the finance group: bob reads projects/falcon by a rule of his own here
    const falcon = inst.ctx.db.query("SELECT id FROM folders WHERE path = 'projects/falcon'").get() as { id: string }
    if (!inst.ctx.db.query("SELECT 1 FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = 'bob'").get(falcon.id))
      inst.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'bob', 'read')").run(crypto.randomUUID(), falcon.id)
    await W.as.memberIn.ok('PATCH', `/api/projects/${W.ids.projFalcon}`, { shareChats: true })
    chat = (await W.as.memberIn.ok('POST', '/api/chats', { projectId: W.ids.projFalcon })).id
    await W.as.memberIn.ok('PATCH', `/api/projects/${W.ids.projFalcon}`, { shareChats: false })
    await W.as.memberIn.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], content: `${CANARY}\n@fake ` + JSON.stringify({ say: 'shared ok' }) })
    for (let i = 0; i < 100 && (await W.as.memberIn.get(`/api/chats/${chat}`)).json.runState !== 'idle'; i++) await Bun.sleep(100)
  })
  // its audience: who reads projects/falcon (alice, bob); the owner and admins only as members (docs/DECISIONS.md
  // "Project contents only for members")
  const sees = new Set(['memberIn', 'memberOut'])
  for (const who of WHO) {
    test(`${who}: view ${sees.has(who) ? 'allowed' : 'refused'}, continue and manage as the design says`, async () => {
      // a fresh sign-in: the matrix's writes above may have ended a persona's shared session
      const c = await freshClient(W, who)
      const get = await c.get(`/api/chats/${chat}`)
      const msgs = await c.get(`/api/chats/${chat}/messages`)
      if (!sees.has(who)) {
        expect([get.status >= 400, msgs.status >= 400], `${who} reached a shared chat outside its audience`).toEqual([true, true])
        expect(get.text.includes(CANARY) || msgs.text.includes(CANARY), `${who} saw the shared chat's words`).toBe(false)
        const send = await c.post(`/api/chats/${chat}/messages`, { clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], content: 'x' })
        expect(send.status, `${who} wrote in a shared chat outside its audience`).toBeGreaterThanOrEqual(400)
        return
      }
      expect([get.status, msgs.status]).toEqual([200, 200])
      expect(msgs.text.includes(CANARY)).toBe(true)
      expect(get.json.shared.by.id).toBe('alice')
      // the name and the engine are the creator's; deleting is the creator's or a project editor's
      const rename = await c.patch(`/api/chats/${chat}`, { title: `by ${who}` })
      expect(rename.status, `${who} rename`).toBe(who === 'memberIn' ? 200 : 403)
      expect(get.json.shared.canDelete, `${who} canDelete`).toBe(who !== 'memberOut')
      if (who === 'memberOut') expect((await c.del(`/api/chats/${chat}`)).status).toBe(403)
    })
  }
})
