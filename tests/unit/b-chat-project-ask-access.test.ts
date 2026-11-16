// "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
// 20261116-chat-project-ask-access.md; migration 411; server/src/chat/access-requests.ts). Covered: what the link page
// reads (open / no_access / unknown, never the title or a name), the ask and its limits (one waiting, the file
// requests' daily limit per owner, counted together with them), the Activity row with Share and Decline (the chat's
// creator; a project's creator, else the owner and admins), Share through the dialogs' own saves (a chat's first share
// asks to confirm the check), Decline saying nothing, a team project chat's link asking for its project, the chats that
// can never be shared (no ask), guests and switched-off askers, a request settled by access given another way, and the
// push (ids only; the day's cap shared with the file requests; the "File sharing" switch).
// Fixture: olga = owner, adam = admin; alice, bob, carl, dina members.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { FILE_REQUESTS_PER_OWNER_DAY } from '@mycel/shared/api'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { pushMessages } from '../../server/src/notifications/text'
import { FILE_REQUEST_PUSHES_PER_DAY } from '../../server/src/files/share-push'
import { accessRequestPushWanted } from '../../server/src/chat/access-requests'
import { savePreferences } from '../../server/src/notifications/preferences'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client, dina: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl' | 'dina', string>
const TITLE = 'Q3 layoffs draft'

const view = (c: Client, kind: string, id: string) => c.try('GET', `/api/link-access/${kind}/${id}`)
const ask = (c: Client, kind: string, id: string, message?: string) => c.try('POST', `/api/link-access/${kind}/${id}/request`, message ? { message } : {})
const answer = (c: Client, requestId: string, a: 'approve' | 'decline', confirmKey?: string) => c.try('POST', `/api/access-requests/${requestId}`, { answer: a, ...(confirmKey ? { confirmKey } : {}) })
/** Share, agreeing to the check of a first share when it asks */
async function approve(c: Client, requestId: string) {
  let r = await answer(c, requestId, 'approve')
  if (r.body?.state === 'confirm') r = await answer(c, requestId, 'approve', r.body.confirmKey)
  return r
}
const requestOf = (kind: string, target: string, asker: string) => h.ctx.db.query('SELECT id, state FROM access_requests WHERE kind = ? AND target_id = ? AND requester_id = ? ORDER BY created_at DESC LIMIT 1').get(kind, target, asker) as { id: string; state: string } | null
const noticeOf = (userId: string, event: string, source: string) => h.ctx.db.query('SELECT id, read_at FROM access_request_notices WHERE user_id = ? AND event_type = ? AND source_id = ?').get(userId, event, source) as { id: string } | null
const activity = async (c: Client) => ((await c.call('GET', '/api/notifications?limit=100')).items as any[])
async function chatOf(c: Client, title = TITLE, body: Record<string, unknown> = {}) {
  const chat = await c.call('POST', '/api/chats', body)
  await c.call('PATCH', `/api/chats/${chat.id}`, { title })
  return chat.id as string
}
async function shareChat(c: Client, chatId: string, subjects: { subjectType: 'user' | 'group'; subjectId: string }[]) {
  let r = await c.call('PUT', `/api/chats/${chatId}/audience`, { subjects })
  if (r.status === 'confirm') r = await c.call('PUT', `/api/chats/${chatId}/audience`, { subjects, confirmKey: r.confirmKey })
  expect(r.status).toBe('saved')
}
const teamProject = async (c: Client, name: string, people: string[]) => (await c.call('POST', '/api/projects', { name, scope: 'team', instructions: '', participants: people.map((p) => ({ subjectType: 'user', subjectId: p })) })).id as string
/** nothing of the chat or project in an answer: the title, the creator's or the members' names */
const nothing = (text: string, ...words: string[]) => { for (const w of [TITLE, 'ALICE', 'BOB', ...words]) expect(text).not.toContain(w) }

beforeAll(async () => {
  h = await harness('b-chat-project-ask-access')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  const al = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl' })
  const d = await addMember(h, owner, { username: 'dina' })
  admin = a.client; alice = al.client; bob = b.client; carl = c.client; dina = d.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id, dina: d.id }
}, 60_000)
afterAll(() => h.close())

describe('a chat link', () => {
  test('someone it does not open for: no_access with nothing of the chat; a missing chat: unknown; its people: open', async () => {
    const chatId = await chatOf(alice)
    await shareChat(alice, chatId, [{ subjectType: 'user', subjectId: ids.bob }])
    for (const c of [alice, bob]) expect((await view(c, 'chat', chatId)).body).toEqual({ status: 'open' })
    // carl (a member) and olga (the owner): the same answer, nothing of the chat
    for (const c of [carl, owner]) {
      const r = await view(c, 'chat', chatId)
      expect(r.body).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
      nothing(JSON.stringify(r.body))
    }
    expect((await view(carl, 'chat', crypto.randomUUID())).body).toEqual({ status: 'unknown' })
    // a bad kind: 400; an id of another shape: 404
    expect((await view(carl, 'room', chatId)).status).toBe(400)
    expect((await view(carl, 'chat', 'a/b')).status).toBe(404)
  })

  test('the ask: sent, then already; the creator gets one Activity row with Share and Decline; Decline tells the asker nothing', async () => {
    const chatId = await chatOf(alice)
    await shareChat(alice, chatId, [{ subjectType: 'user', subjectId: ids.bob }])
    const sent = await ask(carl, 'chat', chatId, 'Need it for the review')
    expect(sent.status).toBe(200)
    expect(sent.body.status).toBe('sent')
    expect((await ask(carl, 'chat', chatId)).body).toEqual({ status: 'already', askedAt: sent.body.askedAt })
    expect((await view(carl, 'chat', chatId)).body).toEqual({ status: 'no_access', canAsk: true, askedAt: sent.body.askedAt })
    // alice (its creator) only: bob, who is in it, gets nothing
    const row = (await activity(alice)).find((x) => x.eventType === 'access.requested' && x.sourceId === `chat:${chatId}:${ids.carl}`)
    expect(row.accessRequest).toMatchObject({ kind: 'chat', by: 'CARL', name: TITLE, targetId: chatId, note: 'Need it for the review', state: 'pending', canAnswer: true })
    expect((await activity(bob)).some((x) => x.eventType === 'access.requested')).toBe(false)
    // someone it did not go to cannot answer it, nor learn it is there
    const q = requestOf('chat', chatId, ids.carl)!
    for (const c of [bob, dina, owner]) expect((await answer(c, q.id, 'approve')).status).toBe(404)
    expect((await answer(alice, q.id, 'decline')).body).toEqual({ state: 'declined' })
    expect((await answer(alice, q.id, 'approve')).body).toEqual({ state: 'declined' })
    // carl: one row, "declined", without the chat's name or a link; he may ask again
    const told = (await activity(carl)).find((x) => x.eventType === 'access.answered')
    expect(told).toMatchObject({ link: null, accessRequest: { kind: null, name: null, targetId: null, state: 'declined' } })
    nothing(JSON.stringify(told))
    expect((await view(carl, 'chat', chatId)).body).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    expect((await view(carl, 'chat', chatId)).status).toBe(200)
    // the creator's row now says it was declined, without buttons
    const after = (await activity(alice)).find((x) => x.sourceId === `chat:${chatId}:${ids.carl}`)
    expect(after.accessRequest.state).toBe('declined')
    expect(after.accessRequest.canAnswer).toBeUndefined()
  })

  test('Share adds the asker by name: the chat opens for them, they get "shared a chat with you"', async () => {
    const chatId = await chatOf(alice)
    await shareChat(alice, chatId, [{ subjectType: 'user', subjectId: ids.bob }])
    await ask(dina, 'chat', chatId)
    const q = requestOf('chat', chatId, ids.dina)!
    expect((await approve(alice, q.id)).body).toEqual({ state: 'approved' })
    expect((await view(dina, 'chat', chatId)).body).toEqual({ status: 'open' })
    expect((await dina.try('GET', `/api/chats/${chatId}`)).status).toBe(200)
    const audience = await alice.call('GET', `/api/chats/${chatId}/audience`)
    expect(audience.subjects.map((s: any) => s.subjectId).sort()).toEqual([ids.bob, ids.dina].sort())
    expect((await activity(dina)).some((x) => x.eventType === 'chat.shared')).toBe(true)
    // asking again: open, nothing asked
    expect((await ask(dina, 'chat', chatId)).body).toEqual({ status: 'open' })
  })

  test('a private chat: its first share asks the creator to confirm the check, then shares it', async () => {
    const chatId = await chatOf(alice, 'Only mine')
    await ask(bob, 'chat', chatId)
    const q = requestOf('chat', chatId, ids.bob)!
    const first = await answer(alice, q.id, 'approve')
    expect(first.body.state).toBe('confirm')
    expect(typeof first.body.confirmKey).toBe('string')
    expect(first.body.check.added).toBe(1)
    expect(requestOf('chat', chatId, ids.bob)!.state).toBe('pending')
    expect((await answer(alice, q.id, 'approve', first.body.confirmKey)).body).toEqual({ state: 'approved' })
    expect((await view(bob, 'chat', chatId)).body).toEqual({ status: 'open' })
  })

  test('shared another way meanwhile: the waiting request settles as approved', async () => {
    const chatId = await chatOf(alice, 'Settles')
    await ask(carl, 'chat', chatId)
    await shareChat(alice, chatId, [{ subjectType: 'user', subjectId: ids.carl }])
    const row = (await activity(alice)).find((x) => x.sourceId === `chat:${chatId}:${ids.carl}`)
    expect(row.accessRequest.state).toBe('approved')
    expect(requestOf('chat', chatId, ids.carl)!.state).toBe('approved')
  })

  test('a chat that is never shared with people: no ask (why not_shareable); asking anyway: 403', async () => {
    const personal = (await alice.call('POST', '/api/projects', { name: 'Mine', scope: 'personal', instructions: '' })).id
    const inPersonal = await chatOf(alice, 'In a personal project', { projectId: personal })
    const r = await view(bob, 'chat', inPersonal)
    expect(r.body).toEqual({ status: 'no_access', canAsk: false, askedAt: null, why: 'not_shareable' })
    nothing(JSON.stringify(r.body), 'personal')
    expect((await ask(bob, 'chat', inPersonal)).status).toBe(403)
    // a private chat of a team project (members don't see it): no ask
    const team = await teamProject(alice, 'Locked room', [ids.bob])
    const locked = await chatOf(alice, 'Locked', { projectId: team })
    h.ctx.db.query('UPDATE chats SET shared_at = NULL WHERE id = ?').run(locked)
    expect((await view(carl, 'chat', locked)).body).toEqual({ status: 'no_access', canAsk: false, askedAt: null, why: 'not_shareable' })
  })

  test('a shared chat of a team project: the ask is to join its project; Share makes them a member and the chat opens', async () => {
    const team = await teamProject(alice, 'Launch plan', [ids.bob])
    const chatId = await chatOf(alice, 'Launch questions', { projectId: team })
    h.ctx.db.query('UPDATE chats SET shared_at = COALESCE(shared_at, ?) WHERE id = ?').run(new Date().toISOString(), chatId)
    expect((await view(bob, 'chat', chatId)).body).toEqual({ status: 'open' })
    const r = await view(carl, 'chat', chatId)
    expect(r.body).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    nothing(JSON.stringify(r.body), 'Launch')
    expect((await ask(carl, 'chat', chatId)).body.status).toBe('sent')
    const q = requestOf('project', team, ids.carl)!
    expect(q.state).toBe('pending')
    // the link of the chat and of its project read the same waiting ask
    expect((await view(carl, 'project', team)).body.askedAt).not.toBeNull()
    const row = (await activity(alice)).find((x) => x.sourceId === `project:${team}:${ids.carl}`)
    expect(row.accessRequest).toMatchObject({ kind: 'project', name: 'Launch plan', canAnswer: true })
    expect((await approve(alice, q.id)).body).toEqual({ state: 'approved' })
    expect((await view(carl, 'chat', chatId)).body).toEqual({ status: 'open' })
  })

  test('guests and switched-off askers', async () => {
    const chatId = await chatOf(alice, 'Guests')
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(ids.dina)
    try {
      expect((await view(dina, 'chat', chatId)).status).toBe(403)
      expect((await ask(dina, 'chat', chatId)).status).toBe(403)
      expect(requestOf('chat', chatId, ids.dina)).toBeNull()
    } finally { h.ctx.db.query('UPDATE users SET guest = 0 WHERE id = ?').run(ids.dina) }
    // carl asks, then is switched off: no push, and Share closes it
    await ask(carl, 'chat', chatId)
    const q = requestOf('chat', chatId, ids.carl)!
    const n = noticeOf(ids.alice, 'access.requested', `chat:${chatId}:${ids.carl}`)!
    expect(accessRequestPushWanted(h.ctx, n.id)).toBe(true)
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.carl)
    try {
      expect(accessRequestPushWanted(h.ctx, n.id)).toBe(false)
      expect((await answer(alice, q.id, 'approve')).body).toEqual({ state: 'closed' })
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(ids.carl) }
    // dina asks, then becomes a guest: Share closes it, nothing is shared
    const later = await chatOf(alice, 'Guest later')
    await ask(dina, 'chat', later)
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(ids.dina)
    try {
      expect((await answer(alice, requestOf('chat', later, ids.dina)!.id, 'approve')).body).toEqual({ state: 'closed' })
    } finally { h.ctx.db.query('UPDATE users SET guest = 0 WHERE id = ?').run(ids.dina) }
  })
})

describe('a project link', () => {
  test('a team project: members and those who manage it open it; others ask; the creator answers; Share makes them a member', async () => {
    const id = await teamProject(alice, 'Secret merger', [ids.bob])
    for (const c of [alice, bob, owner, admin]) expect((await view(c, 'project', id)).body).toEqual({ status: 'open' })
    const r = await view(carl, 'project', id)
    expect(r.body).toEqual({ status: 'no_access', canAsk: true, askedAt: null })
    nothing(JSON.stringify(r.body), 'Secret merger')
    expect((await view(carl, 'project', crypto.randomUUID())).body).toEqual({ status: 'unknown' })
    await ask(carl, 'project', id, 'please')
    // its creator answers (the owner and admins only when the creator cannot)
    expect(noticeOf(ids.alice, 'access.requested', `project:${id}:${ids.carl}`)).not.toBeNull()
    expect(noticeOf(ids.olga, 'access.requested', `project:${id}:${ids.carl}`)).toBeNull()
    const q = requestOf('project', id, ids.carl)!
    expect((await answer(bob, q.id, 'approve')).status).toBe(404)
    expect((await answer(alice, q.id, 'approve')).body).toEqual({ state: 'approved' })
    expect((await view(carl, 'project', id)).body).toEqual({ status: 'open' })
    expect((await carl.try('GET', `/api/projects/${id}`)).status).toBe(200)
    // carl is told, with its name and link now that he is in it
    const told = (await activity(carl)).find((x) => x.eventType === 'access.answered')
    expect(told).toMatchObject({ link: 'project', accessRequest: { kind: 'project', name: 'Secret merger', targetId: id, state: 'approved' } })
  })

  test('a project whose creator was switched off: the owner and admins answer it', async () => {
    const id = await teamProject(dina, 'Orphan', [])
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.dina)
    try {
      await ask(carl, 'project', id)
      expect(noticeOf(ids.olga, 'access.requested', `project:${id}:${ids.carl}`)).not.toBeNull()
      expect(noticeOf(ids.adam, 'access.requested', `project:${id}:${ids.carl}`)).not.toBeNull()
      const q = requestOf('project', id, ids.carl)!
      expect((await answer(admin, q.id, 'decline')).body).toEqual({ state: 'declined' })
      // the other answerer's row is answered too
      const row = (await activity(owner)).find((x) => x.sourceId === `project:${id}:${ids.carl}`)
      expect(row.accessRequest.state).toBe('declined')
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(ids.dina) }
  })

  test('a personal project: no ask', async () => {
    const id = (await alice.call('POST', '/api/projects', { name: 'Diary', scope: 'personal', instructions: '' })).id
    expect((await view(bob, 'project', id)).body).toEqual({ status: 'no_access', canAsk: false, askedAt: null, why: 'not_shareable' })
    expect((await ask(bob, 'project', id)).status).toBe(403)
  })
})

describe('limits', () => {
  test(`one owner: at most ${FILE_REQUESTS_PER_OWNER_DAY} asks a day from one person, files and chats together`, async () => {
    // bob's file and chats: dina asks for the file once, then chats until the day's limit
    const path = `users/${ids.bob}/limit.txt`
    await bob.call('PUT', '/api/files/content', { path, content: 'x', baseSha256: null })
    const link = (await bob.call('POST', '/api/files/link', { path })).id
    expect((await dina.call('POST', `/api/files/shared/${link}/request`, {})).status).toBe('sent')
    for (let i = 1; i < FILE_REQUESTS_PER_OWNER_DAY; i++) expect((await ask(dina, 'chat', await chatOf(bob, `limit ${i}`))).body.status).toBe('sent')
    const over = await ask(dina, 'chat', await chatOf(bob, 'one too many'))
    expect(over.status).toBe(429)
    // and the file requests count the chat asks too
    const path2 = `users/${ids.bob}/limit2.txt`
    await bob.call('PUT', '/api/files/content', { path: path2, content: 'y', baseSha256: null })
    const link2 = (await bob.call('POST', '/api/files/link', { path: path2 })).id
    expect((await dina.try('POST', `/api/files/shared/${link2}/request`, {})).status).toBe(429)
  })
})

describe('the push', () => {
  const sessionOf = (userId: string) => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id
  function phones(users: string[]) {
    const sent: NativeSend[] = []
    let now = Date.now()
    const p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
      nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, now: () => now, phoneDecision: () => ({ kind: 'send' }) })
    for (const u of users) p.registerDevice(u, sessionOf(u), { consent: true, platform: 'android', environment: 'production', token: crypto.randomBytes(40).toString('base64url') })
    const tick = async () => { now = Math.max(now + 5, Date.now()); await p.tick() }
    return { p, sent, tick }
  }
  const later = () => new Promise((r) => setTimeout(r, 5))

  test('pushed to whoever answers: the code and ids only, the tap opens the request; answered: not any more', async () => {
    const chatId = await chatOf(alice, 'SECRET pushed')
    const ph = phones([ids.alice])
    try {
      await later()
      await ask(bob, 'chat', chatId, 'SECRET NOTE')
      const n = noticeOf(ids.alice, 'access.requested', `chat:${chatId}:${ids.bob}`)!
      await ph.tick()
      const mine = ph.sent.filter((s) => s.payload.code === 'access.requested')
      expect(mine).toHaveLength(1)
      expect(mine[0]!.payload).toMatchObject({ code: 'access.requested', notificationId: n.id, path: `/activity/${n.id}` })
      expect(Object.keys(mine[0]!.payload).sort()).toEqual(['code', 'locale', 'notificationId', 'path', 'tag'])
      expect(JSON.stringify(mine[0]!.payload)).not.toMatch(/SECRET|pushed|BOB|bob/i)
      expect(pushMessages('en').bodies['access.requested']).toBe('Someone asked for access to a chat or project.')
      const q = requestOf('chat', chatId, ids.bob)!
      await answer(alice, q.id, 'decline')
      expect(accessRequestPushWanted(h.ctx, n.id)).toBe(false)
      expect(pushPathOf(h.ctx, 'access.requested', n.id)).toBeUndefined()
    } finally { await ph.p.stop() }
  })

  test('"File sharing" off: not wanted; on again: wanted', async () => {
    const chatId = await chatOf(alice, 'Switch')
    // (carl reached the day's limit to alice above)
    expect((await ask(dina, 'chat', chatId)).body.status).toBe('sent')
    const n = noticeOf(ids.alice, 'access.requested', `chat:${chatId}:${ids.dina}`)!
    expect(accessRequestPushWanted(h.ctx, n.id)).toBe(true)
    savePreferences(h.ctx.db, ids.alice, { fileShares: false })
    expect(accessRequestPushWanted(h.ctx, n.id)).toBe(false)
    savePreferences(h.ctx.db, ids.alice, { fileShares: true })
    expect(accessRequestPushWanted(h.ctx, n.id)).toBe(true)
  })

  test(`at most ${FILE_REQUEST_PUSHES_PER_DAY} request pushes a day, file and chat requests together`, async () => {
    const askers: Client[] = []
    for (let i = 0; i < FILE_REQUEST_PUSHES_PER_DAY + 2; i++) askers.push((await addMember(h, owner, { username: `asker${i}` })).client)
    h.ctx.db.query('DELETE FROM access_request_push_deliveries WHERE notification_id IN (SELECT id FROM access_request_notices WHERE user_id = ?)').run(ids.olga)
    h.ctx.db.query('DELETE FROM file_share_push_deliveries WHERE notification_id IN (SELECT id FROM file_share_notices WHERE user_id = ?)').run(ids.olga)
    const ph = phones([ids.olga])
    try {
      await later()
      for (let i = 0; i < askers.length; i++) {
        if (i % 2) {
          const path = `users/${ids.olga}/cap-${i}.txt`
          await owner.call('PUT', '/api/files/content', { path, content: String(i), baseSha256: null })
          const link = (await owner.call('POST', '/api/files/link', { path })).id
          expect((await askers[i]!.call('POST', `/api/files/shared/${link}/request`, {})).status).toBe('sent')
        } else expect((await ask(askers[i]!, 'chat', await chatOf(owner, `cap ${i}`))).body.status).toBe('sent')
        await ph.tick()
      }
      // olga's, one per request (an earlier test's waiting push to alice may go through this service too)
      const olgas = new Set([...(h.ctx.db.query('SELECT id FROM access_request_notices WHERE user_id = ?').all(ids.olga) as { id: string }[]), ...(h.ctx.db.query('SELECT id FROM file_share_notices WHERE user_id = ?').all(ids.olga) as { id: string }[])].map((r) => r.id))
      const codes = ph.sent.filter((s) => (s.payload.code === 'access.requested' || s.payload.code === 'file.access_requested') && olgas.has(s.payload.notificationId as string))
      expect(new Set(codes.map((s) => s.payload.notificationId)).size).toBe(FILE_REQUEST_PUSHES_PER_DAY)
      expect(codes.some((s) => s.payload.code === 'access.requested')).toBe(true)
      expect(codes.some((s) => s.payload.code === 'file.access_requested')).toBe(true)
    } finally { await ph.p.stop() }
  })
})

describe('account removal', () => {
  test("a deleted asker's requests and Activity rows go", async () => {
    const fay = await addMember(h, owner, { username: 'fay' })
    const chatId = await chatOf(alice, 'Removal')
    await ask(fay.client, 'chat', chatId)
    await alice.call('POST', `/api/access-requests/${requestOf('chat', chatId, fay.id)!.id}`, { answer: 'decline' })
    expect(noticeOf(fay.id, 'access.answered', requestOf('chat', chatId, fay.id)!.id)).not.toBeNull()
    const { runAccountCleanups } = await import('../../server/src/auth/account-removal')
    await runAccountCleanups(h.ctx, fay.id)
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ?').get(fay.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM access_request_notices WHERE user_id = ?').get(fay.id)).toEqual({ n: 0 })
    // alice's row of it is gone with the request
    const row = (await activity(alice)).find((x) => x.sourceId === `chat:${chatId}:${fay.id}`)
    expect(!row || row.accessRequest.gone).toBe(true)
  })
})
