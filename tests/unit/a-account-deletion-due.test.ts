// A person's own account deletion request deletes the account by itself on a date (shared/src/api/account-deletion.ts,
// server/src/auth/deletion-requests.ts deleteDueAccounts, migration 297; docs/DECISIONS.md "Self-service account
// deletion"): the password is asked every time (wrong: 403, five wrong: 429), the date is 7 days later, nothing goes
// before it, the sweep deletes on it with no actor, a cancel or becoming the owner stops it, a request from before
// (no date) gets one 7 days from the sweep and an inbox notice, and what the person asked to be deleted goes at once:
// private chats, memories, trashed files, file history and folder records under users/<id>/.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { deleteDueAccounts, markSweepStart } from '../../server/src/auth/deletion-requests'
import { finishRemovals } from '../../server/src/admin/users'
import { lastSweepForget } from '../../server/src/auth/sweeper'

setDefaultTimeout(30_000)
const PATH = '/api/me/deletion-request'
const DAY = 86_400_000
let h: Harness, owner: Client, ownerId: string
beforeAll(async () => {
  h = await harness('account-deletion-due')
  owner = await withOwner(h)
  ownerId = (await owner.call('GET', '/api/me')).user.id
})
afterAll(async () => { await h?.close() })

const live = (id: string) => !!h.ctx.db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(id)
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

describe('asking', () => {
  test('the password every time: wrong is 403 and asks nothing; right sets the date 7 days later', async () => {
    const m = await addMember(h, owner, { username: 'wren' })
    const wrong = await m.client.try('POST', PATH, { confirm: true, password: 'not my password' })
    expect(wrong.status).toBe(403)
    expect(wrong.body.error.fields).toEqual({ 'body.password': 'wrong password' })
    expect((await m.client.call('GET', PATH)).state).toBe('none')
    const before = Date.now()
    const r = await m.client.call('POST', PATH, { confirm: true, password: m.password })
    expect(r.state).toBe('pending')
    const due = Date.parse(r.dueAt)
    expect(due - Date.parse(r.requestedAt)).toBe(7 * DAY)
    expect(due).toBeGreaterThanOrEqual(before + 7 * DAY - 5_000)
    expect(r.auditDays).toBeGreaterThan(0)
    // the owners' inbox and Admin › Members carry the date
    const [entry] = (await owner.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.deletion_request' && x.sourceId === m.id)
    expect(entry.deletionRequest).toMatchObject({ state: 'open', dueAt: r.dueAt })
    const users = await owner.call('GET', '/api/admin/users')
    expect(users.deletionDue[m.id]).toBe(r.dueAt)
    await m.client.call('DELETE', PATH)
  })

  test('five wrong passwords lock the re-check (429), like every password re-check', async () => {
    const m = await addMember(h, owner, { username: 'lock' })
    for (let i = 0; i < 5; i++) expect((await m.client.try('POST', PATH, { confirm: true, password: `wrong ${i}` })).status).toBe(403)
    expect((await m.client.try('POST', PATH, { confirm: true, password: m.password })).status).toBe(429)
    expect((await m.client.call('GET', PATH)).state).toBe('none')
  })

  test('the owner still cannot ask (409), with the right password', async () => {
    expect((await owner.try('POST', PATH, { confirm: true, password: OWNER_PW })).status).toBe(409)
  })
})

describe('the date', () => {
  test('nothing before the date; on it the sweep deletes the account with no actor, personal files to the owner, private data at once', async () => {
    const m = await addMember(h, owner, { username: 'dove' })
    const root = h.ctx.files.fx.root
    // a file with history, a file in the trash, a folder, a private chat and a memory
    const file = `users/${m.id}/plan.md`
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'v1', baseSha256: null })
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'v2', baseSha256: sha('v1') })
    await m.client.call('POST', '/api/files/mkdir', { path: `users/${m.id}/sub` })
    await m.client.call('PUT', '/api/files/content', { path: `users/${m.id}/sub/old.md`, content: 'bin me', baseSha256: null })
    await m.client.call('DELETE', `/api/files?path=${encodeURIComponent(`users/${m.id}/sub/old.md`)}`)
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM trash_items WHERE original_path LIKE ? AND restored_at IS NULL").get(`users/${m.id}/%`) as { n: number }).n).toBe(1)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(file) as { n: number }).n).toBeGreaterThan(0)
    const chat = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, engine_session_id) VALUES (?, ?, 'sess-dove')").run(chat, m.id)
    h.ctx.db.query('INSERT INTO memories (id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(uuidv7(), m.id, 'likes tea', new Date().toISOString())
    // a row a cleanup hook removes
    h.ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?)').run(m.id, 'k', new Date().toISOString())

    await m.client.call('POST', PATH, { confirm: true, password: m.password })
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0 })
    h.advance(7 * DAY - 60_000)
    try {
      expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0 })
      expect(live(m.id)).toBe(true)
      h.advance(120_000)
      expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 1, failed: 0 })
      await lastSweepForget
    } finally { h.advance(-(7 * DAY + 60_000)) }
    expect(live(m.id)).toBe(false)
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    // the audit: the server did it, because the person asked
    const row = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { actor_id: string | null; detail: string }
    expect(row.actor_id).toBeNull()
    const detail = JSON.parse(row.detail)
    expect(detail).toMatchObject({ personalFolder: 'transfer', requested: true, why: 'self_request', automatic: true })
    expect(detail.purged).toMatchObject({ chats: 1, trash: 1 })
    // the personal files went to the owner's archive, with their history; nothing left under users/<id>/
    expect(fs.readFileSync(path.join(root, detail.movedTo, 'plan.md'), 'utf8')).toBe('v2')
    expect(fs.existsSync(path.join(root, 'users', m.id))).toBe(false)
    const under = (t: string, col: string) => (h.ctx.db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ? OR ${col} LIKE ?`).get(`users/${m.id}`, `users/${m.id}/%`) as { n: number }).n
    expect(under('file_versions', 'path')).toBe(0)
    expect(under('trash_items', 'original_path')).toBe(0)
    expect(under('folders', 'path')).toBe(0)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${detail.movedTo}/plan.md`) as { n: number }).n).toBeGreaterThan(0)
    // private chats and memories at once, not after the retention days
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM suggestion_dismissals WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    // the request is handled by nobody (the server); the owners' entry says so
    expect(h.ctx.db.query('SELECT handled_by, handled_at IS NOT NULL AS done FROM account_deletion_requests WHERE user_id = ?').get(m.id)).toEqual({ handled_by: null, done: 1 })
    // a second sweep does nothing
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0, failed: 0 })
  })

  test('a cancel before the date keeps the account', async () => {
    const m = await addMember(h, owner, { username: 'kept' })
    await m.client.call('POST', PATH, { confirm: true, password: m.password })
    expect((await m.client.call('DELETE', PATH)).state).toBe('none')
    h.advance(8 * DAY)
    try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0 }) } finally { h.advance(-8 * DAY) }
    expect(live(m.id)).toBe(true)
  })

  test('becoming the owner cancels the request (audited, by ownership); the date never deletes an owner', async () => {
    const m = await addMember(h, owner, { username: 'heir' })
    await m.client.call('POST', PATH, { confirm: true, password: m.password })
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: m.id, password: OWNER_PW })
    try {
      const r = h.ctx.db.query('SELECT cancelled_at FROM account_deletion_requests WHERE user_id = ?').get(m.id) as { cancelled_at: string | null }
      expect(r.cancelled_at).not.toBeNull()
      const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'account.deletion_cancel' AND target = ?").get(m.id) as { actor_id: string; detail: string }
      expect(a.actor_id).toBe(ownerId)
      expect(JSON.parse(a.detail)).toEqual({ by: 'ownership' })
      h.advance(8 * DAY)
      try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0 }) } finally { h.advance(-8 * DAY) }
      expect(live(m.id)).toBe(true)
    } finally {
      await m.client.call('POST', '/api/admin/transfer-ownership', { userId: ownerId, password: m.password })
    }
  })

  test('the owner or an admin can delete sooner: the request is handled by them', async () => {
    const m = await addMember(h, owner, { username: 'soon' })
    await m.client.call('POST', PATH, { confirm: true, password: m.password })
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`)).status).toBe(204)
    expect(h.ctx.db.query('SELECT handled_by FROM account_deletion_requests WHERE user_id = ?').get(m.id)).toEqual({ handled_by: ownerId })
    // they asked: private chats go at once here too
    const detail = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }).detail)
    expect(detail).toMatchObject({ requested: true })
    expect(detail.purged).toBeDefined()
  })
})

describe('requests from before the automatic date (migration 297)', () => {
  test('an open request with no date gets one 7 days from the sweep and a notice to the person; it is not deleted at once', async () => {
    const m = await addMember(h, owner, { username: 'early' })
    const long = new Date(Date.now() - 30 * DAY).toISOString()
    h.ctx.db.query('INSERT INTO account_deletion_requests (user_id, requested_at) VALUES (?, ?)').run(m.id, long)
    expect((await m.client.call('GET', PATH))).toMatchObject({ state: 'pending', dueAt: null })
    const r = await deleteDueAccounts(h.ctx)
    expect(r).toMatchObject({ dated: 1, deleted: 0 })
    expect(live(m.id)).toBe(true)
    const st = await m.client.call('GET', PATH)
    expect(Date.parse(st.dueAt) - Date.now()).toBeGreaterThan(7 * DAY - 60_000)
    const [n, ...more] = (await m.client.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.deletion_due')
    expect(more).toEqual([])
    expect(n).toMatchObject({ link: 'account_deletion', deletionDue: { dueAt: st.dueAt }, readAt: null })
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account.deletion_dated' AND target = ?").get(m.id) as { n: number }).n).toBe(1)
    // a second sweep does not move the date or notify again
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 0, deleted: 0 })
    // a date from before the request (a row re-opened by an older build) counts as none
    h.ctx.db.query('UPDATE account_deletion_requests SET requested_at = ?, due_at = ? WHERE user_id = ?').run(new Date().toISOString(), long, m.id)
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 1, deleted: 0 })
    expect(live(m.id)).toBe(true)
    await m.client.call('DELETE', PATH)
    const [closed] = (await m.client.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.deletion_due')
    expect(closed).toMatchObject({ link: null, deletionDue: { dueAt: null } })
  })
})

describe('review of PR #816', () => {
  const notices = async (c: Client) => (await c.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.deletion_due')
  const row = (id: string) => h.ctx.db.query('SELECT requested_at, due_at, due_for, cancelled_at FROM account_deletion_requests WHERE user_id = ?').get(id) as { requested_at: string; due_at: string | null; due_for: string | null; cancelled_at: string | null }

  test('a rollback: an old date never carries over to a request opened again by an older build', async () => {
    const m = await addMember(h, owner, { username: 'roll' })
    const first = await m.client.call('POST', PATH, { confirm: true, password: m.password })
    await m.client.call('DELETE', PATH)
    // the older build opens it again two days later: requested_at changes, due_at and due_for stay
    const t2 = new Date(Date.parse(first.requestedAt) + 2 * DAY).toISOString()
    h.ctx.db.query('UPDATE account_deletion_requests SET requested_at = ?, cancelled_at = NULL WHERE user_id = ?').run(t2, m.id)
    expect((await m.client.call('GET', PATH)).dueAt).toBeNull()
    h.advance(3 * DAY)
    try {
      expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 1, deleted: 0 })
      const r = row(m.id)
      expect(r.due_for).toBe(r.requested_at)
      expect(Date.parse(r.due_at!)).toBeGreaterThan(Date.parse(first.dueAt))
      expect(await notices(m.client)).toHaveLength(1)
      // the first request's date passes: nothing happens
      h.advance(5 * DAY)
      try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 0 }) } finally { h.advance(-5 * DAY) }
      expect(live(m.id)).toBe(true)
    } finally { h.advance(-3 * DAY) }
    await m.client.call('DELETE', PATH)
  })

  test('a date that passed while the server was down (or a restored copy) is held 24 hours after the start, with a notice', async () => {
    const m = await addMember(h, owner, { username: 'late' })
    const now = Date.now()
    const asked = new Date(now - 9 * DAY).toISOString()
    h.ctx.db.query('INSERT INTO account_deletion_requests (user_id, requested_at, due_at, due_for) VALUES (?, ?, ?, ?)').run(m.id, asked, new Date(now - 2 * DAY).toISOString(), asked)
    markSweepStart(h.ctx, now)
    try {
      expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 1, deleted: 0 })
      expect(live(m.id)).toBe(true)
      expect(Date.parse(row(m.id).due_at!) - now).toBeGreaterThanOrEqual(DAY - 1000)
      expect(await notices(m.client)).toHaveLength(1)
      h.advance(DAY + 60_000)
      try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 1 }) } finally { h.advance(-(DAY + 60_000)) }
      expect(live(m.id)).toBe(false)
    } finally { markSweepStart(h.ctx, 0) }
  })

  test('an owner\'s leftover request is cancelled, never dated or announced', async () => {
    h.ctx.db.query('INSERT INTO account_deletion_requests (user_id, requested_at) VALUES (?, ?)').run(ownerId, new Date().toISOString())
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 0, deleted: 0 })
    expect(row(ownerId).cancelled_at).not.toBeNull()
    expect(row(ownerId).due_at).toBeNull()
    expect(await notices(owner)).toEqual([])
  })

  test('a member disabled after asking gets no notice they cannot read, and is still deleted on the date (they asked)', async () => {
    const m = await addMember(h, owner, { username: 'quiet' })
    h.ctx.db.query('INSERT INTO account_deletion_requests (user_id, requested_at) VALUES (?, ?)').run(m.id, new Date().toISOString())
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(m.id)
    expect(await deleteDueAccounts(h.ctx)).toMatchObject({ dated: 1 })
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM account_deletion_due_notices WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    h.advance(7 * DAY + 60_000)
    try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 1 }) } finally { h.advance(-(7 * DAY + 60_000)) }
    expect(live(m.id)).toBe(false)
  })

  test('no owner to take the folder: its files and history stay; the next start moves them to the owner\'s archive', async () => {
    const m = await addMember(h, owner, { username: 'orph' })
    const file = `users/${m.id}/keep.md`
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'a', baseSha256: null })
    await m.client.call('PUT', '/api/files/content', { path: file, content: 'b', baseSha256: sha('a') })
    await m.client.call('POST', PATH, { confirm: true, password: m.password })
    h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(ownerId)
    try {
      h.advance(7 * DAY + 60_000)
      try { expect(await deleteDueAccounts(h.ctx)).toMatchObject({ deleted: 1 }) } finally { h.advance(-(7 * DAY + 60_000)) }
    } finally { h.ctx.db.query("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId) }
    const root = h.ctx.files.fx.root
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe('b')
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(file) as { n: number }).n).toBeGreaterThan(0)
    // the audit row was written with the delete
    const before = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }).detail)
    expect(before).toMatchObject({ personalFolder: 'transfer', requested: true, movedTo: null })
    expect(await finishRemovals(h.ctx)).toBeGreaterThanOrEqual(1)
    const after = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }).detail)
    expect(after.finishedAtStart).toBe(true)
    expect(fs.readFileSync(path.join(root, after.movedTo, 'keep.md'), 'utf8')).toBe('b')
    expect(fs.existsSync(path.join(root, 'users', m.id))).toBe(false)
    // nothing left to finish: a second start does nothing for this person
    await finishRemovals(h.ctx)
    expect(JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(m.id) as { detail: string }).detail).movedTo).toBe(after.movedTo)
  })
})
