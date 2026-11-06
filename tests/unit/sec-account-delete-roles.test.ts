// Who may delete an account (DECISIONS.md A 역할 규칙; owner decision 2026-11-06, before it the owner only): the owner,
// or an admin for a member (active or disabled). Nobody deletes the owner or themselves, and only the owner deletes an
// admin; guard() in server/src/admin/users.ts enforces this, the contract is admin-level. Whoever deletes, the personal
// folder goes to the owner's archive, never to the acting admin.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { deleteUser } from '../../server/src/admin/users'
import { HttpError } from '../../server/src/http/errors'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('account deletion: the owner, or an admin for members', () => {
  let h: Harness
  let owner: Client
  let admin: Awaited<ReturnType<typeof addMember>>
  beforeAll(async () => {
    h = await harness('sec-delete-roles')
    owner = await withOwner(h, 'dana')
    admin = await addMember(h, owner, { username: 'carol', role: 'admin' })
  })
  afterAll(() => h.close())

  const asAdmin = (id: string) => {
    const vars: Record<string, unknown> = { auth: { user: { id: admin.id, role: 'admin' } }, locale: 'en', log: h.ctx.log }
    return () => deleteUser({ get: (k: string) => vars[k] } as any, h.ctx, id, 'delete')
  }
  const refused = (fn: () => void) => {
    let err: unknown
    try { fn() } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('forbidden')
  }

  test('the contract marks the endpoint admin-level (the role rules are the server\'s)', () => {
    expect(API.deleteUser.auth).toBe('admin')
  })

  test('an admin deletes a member: the member is gone and the personal folder goes to the owner, not the admin', async () => {
    const erin = await addMember(h, owner, { username: 'erin' })
    const root = h.ctx.files.fx.root
    fs.writeFileSync(path.join(root, 'users', erin.id, 'notes.md'), 'erin keeps this')
    expect((await admin.client.try('DELETE', `/api/admin/users/${erin.id}`)).status).toBe(204)
    expect((await erin.client.try('GET', '/api/me')).status).toBe(401)
    expect((await h.client().try('POST', '/api/auth/login', { username: 'erin', password: erin.password })).status).toBe(401)
    expect((await owner.call('GET', '/api/admin/users')).items.some((u: any) => u.id === erin.id)).toBe(false)
    // the team language is Korean (withOwner): the owner's archive folder
    expect(fs.readFileSync(path.join(root, 'users', 'dana', '보관된 계정', erin.id, 'notes.md'), 'utf8')).toBe('erin keeps this')
    expect(fs.existsSync(path.join(root, 'users', admin.id, '보관된 계정'))).toBe(false)
    expect(h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'user.delete' AND target = ?").get(erin.id)).toEqual({ actor_id: admin.id })
  })

  test('an admin deletes a disabled member too, with either personal-folder option', async () => {
    for (const how of ['delete', 'transfer'] as const) {
      const m = await addMember(h, owner, { username: `mia-${how}` })
      expect((await admin.client.try('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })).status).toBe(200)
      expect((await admin.client.try('DELETE', `/api/admin/users/${m.id}?personalFolder=${how}`)).status).toBe(204)
      expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users', m.id))).toBe(false)
    }
  })

  test('an admin cannot delete another admin, the owner or themselves (HTTP and the server function)', async () => {
    const abe = await addMember(h, owner, { username: 'abe', role: 'admin' })
    for (const id of [abe.id, 'dana', admin.id]) {
      for (const q of ['', '?personalFolder=delete']) expect((await admin.client.try('DELETE', `/api/admin/users/${id}${q}`)).status, `${id}${q}`).toBe(403)
      refused(asAdmin(id))
    }
    // nothing happened to them
    expect((await abe.client.try('GET', '/api/me')).status).toBe(200)
    expect((await admin.client.try('GET', '/api/me')).status).toBe(200)
    expect(h.ctx.db.query('SELECT status, deleted_at FROM users WHERE id = ?').get(abe.id)).toEqual({ status: 'active', deleted_at: null })
  })

  test('a member cannot delete anyone', async () => {
    const m = await addMember(h, owner, { username: 'finn' })
    const other = await addMember(h, owner, { username: 'gail' })
    expect((await m.client.try('DELETE', `/api/admin/users/${other.id}`)).status).toBe(403)
    expect((await other.client.try('GET', '/api/me')).status).toBe(200)
  })

  test('the owner deletes an admin and a member, never themselves', async () => {
    expect((await owner.try('DELETE', '/api/admin/users/dana')).status).toBe(403)
    const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
    const hal = await addMember(h, owner, { username: 'hal' })
    for (const p of [ada, hal]) {
      expect((await owner.try('DELETE', `/api/admin/users/${p.id}`)).status).toBe(204)
      expect((await p.client.try('GET', '/api/me')).status).toBe(401)
    }
  })
})
