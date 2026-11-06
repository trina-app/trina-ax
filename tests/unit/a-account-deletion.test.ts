// A person asks the team owner to delete their own account (shared/src/api/account-deletion.ts,
// server/src/auth/deletion-requests.ts; App Store review 5.1.1(v)). The request deletes nothing itself: it tells the
// owner in the inbox (metadata only, shown always, one entry per owner and person), the owner cannot ask, asking is
// idempotent and limited per day, cancel and the owner's delete close it, and the owner's Admin › Members list says
// who asked.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { notificationsOf } from '../../server/src/notifications/service'
import { DELETION_REQUESTS_PER_DAY } from '../../server/src/auth/deletion-requests'

// every test makes people (password hashing): slow when many test files run at once
setDefaultTimeout(30_000)
const PATH = '/api/me/deletion-request'
let h: Harness, owner: Client, ownerId: string
let admin: Awaited<ReturnType<typeof addMember>>
beforeAll(async () => {
  h = await harness('account-deletion')
  owner = await withOwner(h)
  ownerId = (await owner.call('GET', '/api/me')).user.id
  admin = await addMember(h, owner, { username: 'adele', role: 'admin' })
})
afterAll(async () => { await h?.close() })

const entries = async (c: Client) => (await c.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.deletion_request')
const audits = (action: string, id: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND actor_id = ? AND target = ?').get(action, id, id) as { n: number }).n

describe('asking', () => {
  test('a member asks once: the owner is told (name, link to the person), nobody else; asking again changes nothing', async () => {
    const m = await addMember(h, owner, { username: 'mina' })
    expect(await m.client.call('GET', PATH)).toEqual({ state: 'none', requestedAt: null })
    const signals = h.hub.events.length
    const first = await m.client.call('POST', PATH, { confirm: true })
    expect(first.state).toBe('pending')
    expect(Date.parse(first.requestedAt)).toBeGreaterThan(0)
    const [entry, ...more] = await entries(owner)
    expect(more).toEqual([])
    expect(entry).toMatchObject({ eventType: 'account.deletion_request', sourceId: m.id, link: 'admin_members', readAt: null, chatId: null, deletionRequest: { name: 'MINA', state: 'open' } })
    // the realtime signal carries nothing but "the inbox changed", to the owner only
    const sent = h.hub.events.slice(signals)
    expect(sent.length).toBeGreaterThan(0)
    for (const e of sent) {
      expect(e.target).toBe(ownerId)
      expect(e.data).toEqual({ type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } })
    }
    // admins cannot delete accounts and are not told; the person is not told about their own request
    expect(await entries(admin.client)).toEqual([])
    expect(await entries(m.client)).toEqual([])
    // idempotent: the same request, no second entry, one audit row
    const again = await m.client.call('POST', PATH, { confirm: true })
    expect(again).toEqual(first)
    expect(await entries(owner)).toHaveLength(1)
    expect(audits('account.deletion_request', m.id)).toBe(1)
    // the stored rows are metadata only: ids and times
    const row = h.ctx.db.query('SELECT * FROM account_deletion_notices WHERE source_id = ?').get(m.id) as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(['created_at', 'event_type', 'id', 'read_at', 'source_id', 'suppressed', 'user_id'])
  })

  test('only `{ confirm: true }` asks; the request names nobody else', async () => {
    const m = await addMember(h, owner, { username: 'noel' })
    for (const body of [undefined, {}, { confirm: false }, { confirm: 'yes' }, { confirm: true, userId: admin.id }]) {
      expect((await m.client.try('POST', PATH, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await m.client.call('GET', PATH)).toEqual({ state: 'none', requestedAt: null })
    // ?userId= is not read: the caller's own request only
    await m.client.call('POST', `${PATH}?userId=${admin.id}`, { confirm: true })
    expect(await admin.client.call('GET', PATH)).toEqual({ state: 'none', requestedAt: null })
    expect((await m.client.call('GET', PATH)).state).toBe('pending')
  })

  test('an admin may ask too (the owner deletes admins)', async () => {
    expect((await admin.client.call('POST', PATH, { confirm: true })).state).toBe('pending')
    expect((await entries(owner)).some((x: any) => x.sourceId === admin.id && x.deletionRequest?.state === 'open')).toBe(true)
    expect((await admin.client.call('DELETE', PATH)).state).toBe('none')
  })

  test('the owner cannot ask: 409 with what to do first', async () => {
    expect(await owner.call('GET', PATH)).toEqual({ state: 'owner', requestedAt: null })
    const r = await owner.try('POST', PATH, { confirm: true })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('팀장을 넘겨')
    expect(await owner.call('DELETE', PATH)).toEqual({ state: 'owner', requestedAt: null })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM account_deletion_requests WHERE user_id = ?').get(ownerId)).toEqual({ n: 0 })
  })

  test('a person must be signed in with a changed password', async () => {
    expect((await h.client().try('GET', PATH)).status).toBe(401)
    expect((await h.client().try('POST', PATH, { confirm: true })).status).toBe(401)
    const r = await owner.call('POST', '/api/admin/users', { username: 'tina', name: 'Tina', role: 'member', groupIds: [] })
    const t = h.client()
    await t.login('tina', r.temporaryPassword)
    expect((await t.try('POST', PATH, { confirm: true })).status).toBe(403)
  })
})

describe('cancel and ask again', () => {
  test('cancel closes it and marks the owner\'s entry read; asking again re-arms the same entry', async () => {
    const m = await addMember(h, owner, { username: 'cleo' })
    await m.client.call('POST', PATH, { confirm: true })
    const [open] = (await entries(owner)).filter((x: any) => x.sourceId === m.id)
    expect(await m.client.call('DELETE', PATH)).toEqual({ state: 'none', requestedAt: null })
    expect(audits('account.deletion_cancel', m.id)).toBe(1)
    const [cancelled] = (await entries(owner)).filter((x: any) => x.sourceId === m.id)
    expect(cancelled).toMatchObject({ id: open.id, link: null, deletionRequest: { name: 'CLEO', state: 'cancelled' } })
    expect(cancelled.readAt).not.toBeNull()
    // a second cancel is a no-op
    expect((await m.client.call('DELETE', PATH)).state).toBe('none')
    expect(audits('account.deletion_cancel', m.id)).toBe(1)
    await m.client.call('POST', PATH, { confirm: true })
    const back = (await entries(owner)).filter((x: any) => x.sourceId === m.id)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: open.id, readAt: null, link: 'admin_members', deletionRequest: { state: 'open' } })
  })

  test(`at most ${DELETION_REQUESTS_PER_DAY} requests a day: asking and cancelling over and over is refused, then allowed a day later`, async () => {
    const m = await addMember(h, owner, { username: 'remy' })
    for (let i = 0; i < DELETION_REQUESTS_PER_DAY; i++) {
      expect((await m.client.call('POST', PATH, { confirm: true })).state).toBe('pending')
      await m.client.call('DELETE', PATH)
    }
    const r = await m.client.try('POST', PATH, { confirm: true })
    expect(r.status).toBe(429)
    expect((await m.client.call('GET', PATH)).state).toBe('none')
    expect((await entries(owner)).filter((x: any) => x.sourceId === m.id)).toHaveLength(1)
    h.advance(86_400_000 + 1000)
    try { expect((await m.client.call('POST', PATH, { confirm: true })).state).toBe('pending') }
    finally { h.advance(-(86_400_000 + 1000)) }
  })
})

describe('the owner handles it', () => {
  test('Admin › Members tells the owner (not admins) who asked; deleting the account archives the files and closes the request', async () => {
    const m = await addMember(h, owner, { username: 'dora' })
    await m.client.call('POST', PATH, { confirm: true })
    expect((await owner.call('GET', '/api/admin/users')).deletionRequested).toContain(m.id)
    expect((await admin.client.call('GET', '/api/admin/users')).deletionRequested).toBeUndefined()
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'users', m.id, 'notes.md'), 'dora')
    // removed like anyone else: the personal files go to the owner's archive, they are not deleted
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`)).status).toBe(204)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users', m.id))).toBe(false)
    const row = h.ctx.db.query('SELECT handled_at, handled_by, cancelled_at FROM account_deletion_requests WHERE user_id = ?').get(m.id) as { handled_at: string | null; handled_by: string | null; cancelled_at: string | null }
    expect(row.handled_by).toBe(ownerId)
    expect(row.handled_at).not.toBeNull()
    expect(row.cancelled_at).toBeNull()
    const [entry] = (await entries(owner)).filter((x: any) => x.sourceId === m.id)
    expect(entry).toMatchObject({ link: null, deletionRequest: { name: null, state: 'handled' } })
    expect(entry.readAt).not.toBeNull()
    expect((await owner.call('GET', '/api/admin/users')).deletionRequested).not.toContain(m.id)
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }
    const detail = JSON.parse(audit.detail)
    expect(detail).toMatchObject({ personalFolder: 'transfer', requested: true })
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, detail.movedTo, 'notes.md'), 'utf8')).toBe('dora')
  })

  test('a new owner (owner transfer) gets the open requests; a person who became the owner is left out', async () => {
    const m = await addMember(h, owner, { username: 'ezra' })
    await m.client.call('POST', PATH, { confirm: true })
    const next = await addMember(h, owner, { username: 'nora' })
    await next.client.call('POST', PATH, { confirm: true })
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: next.id, password: OWNER_PW })
    notificationsOf(h.ctx).reconcile()
    const mine = await entries(next.client)
    expect(mine.map((x: any) => x.sourceId)).toContain(m.id)
    expect(mine.map((x: any) => x.sourceId)).not.toContain(next.id)
    // the new owner's own old request: the page says "owner", and the list does not show it as one to handle
    expect(await next.client.call('GET', PATH)).toEqual({ state: 'owner', requestedAt: null })
    // give the owner role back for the rest of the file
    await next.client.call('POST', '/api/admin/transfer-ownership', { userId: ownerId, password: next.password })
  })

  test('the request goes with the account row (foreign keys with ON DELETE CASCADE)', () => {
    for (const table of ['account_deletion_requests', 'account_deletion_notices']) {
      const fks = h.ctx.db.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[]
      expect(fks.length, table).toBeGreaterThan(0)
      for (const fk of fks) expect(fk, table).toMatchObject({ table: 'users', on_delete: 'CASCADE' })
    }
  })
})
