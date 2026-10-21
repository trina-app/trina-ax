// Security regression: deleting an account is the owner's alone (설계서 4번 탭 "DELETE /api/admin/users/:id … owner만",
// DECISIONS.md 역할 규칙). Before the fix an admin who is not the owner could tombstone a plain member: the member's
// sessions ended at once, their chats and memories were purged after the retention period and their personal folder
// was moved to the owner (or deleted with ?personalFolder=delete). Admins may still disable a member and reset their
// password (5번 탭).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { deleteUser } from '../../server/src/admin/users'
import { HttpError } from '../../server/src/http/errors'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('account deletion is owner-only', () => {
  let h: Harness
  let owner: Client
  let admin: Awaited<ReturnType<typeof addMember>>
  beforeAll(async () => {
    h = await harness('sec-delete-owner-only')
    owner = await withOwner(h, 'dana')
    admin = await addMember(h, owner, { username: 'carol', role: 'admin' })
  })
  afterAll(() => h.close())

  test('the contract marks the endpoint owner-level', () => {
    expect(API.deleteUser.auth).toBe('owner')
  })

  test('an admin (not owner) cannot delete a member account, with either personal-folder option', async () => {
    const erin = await addMember(h, owner, { username: 'erin' })
    const folder = path.join(h.ctx.files.fx.root, 'users', erin.id)
    fs.writeFileSync(path.join(folder, 'notes.md'), 'erin keeps this')
    for (const q of ['', '?personalFolder=delete', '?personalFolder=transfer']) {
      const r = await admin.client.try('DELETE', `/api/admin/users/${erin.id}${q}`)
      expect(r.status, q).toBe(403)
    }
    // nothing happened to erin: still listed and active, still signed in, can sign in again, folder intact
    const listed = (await owner.call('GET', '/api/admin/users')).items.find((u: any) => u.id === erin.id)
    expect(listed).toMatchObject({ id: erin.id, username: 'erin', status: 'active' })
    expect((await erin.client.try('GET', '/api/me')).status).toBe(200)
    expect((await h.client().try('POST', '/api/auth/login', { username: 'erin', password: erin.password })).status).toBe(200)
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('erin keeps this')
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.delete'").get()).toEqual({ n: 0 })
  })

  test('second check: the server function itself refuses a non-owner even if the route let it through', () => {
    const erin = h.ctx.db.query("SELECT id FROM users WHERE username = 'erin'").get() as { id: string }
    const vars: Record<string, unknown> = { auth: { user: { id: admin.id, role: 'admin' } }, locale: 'en' }
    const c = { get: (k: string) => vars[k] } as any
    let err: unknown
    try { deleteUser(c, h.ctx, erin.id, 'delete') } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('forbidden')
    expect(h.ctx.db.query('SELECT status, deleted_at FROM users WHERE id = ?').get(erin.id)).toEqual({ status: 'active', deleted_at: null })
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users', erin.id, 'notes.md'))).toBe(true)
  })

  test('the admin keeps what tab 5 gives them on members: disable and password reset', async () => {
    const m = await addMember(h, owner, { username: 'mia' })
    expect((await admin.client.try('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })).status).toBe(200)
    expect((await admin.client.try('POST', `/api/admin/users/${m.id}/reset-password`)).status).toBe(200)
  })

  test('the owner still deletes a member (204) and the member is gone', async () => {
    const m = await addMember(h, owner, { username: 'finn' })
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`)).status).toBe(204)
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    expect((await owner.call('GET', '/api/admin/users')).items.some((u: any) => u.id === m.id)).toBe(false)
  })
})
