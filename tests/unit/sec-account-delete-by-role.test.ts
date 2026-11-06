// Who deletes an account (설계서 4번 탭 "DELETE /api/admin/users/:id", DECISIONS.md 역할 규칙): the owner anyone but
// themselves; an admin a plain member only, after typing their own password again. An admin never deletes the owner,
// another admin or themselves, and the role of the target is read again at the moment of the delete, so a member
// promoted since the page was loaded is refused. Deleting stays as heavy as it was: sessions end at once, chats and
// memories are purged after the retention period, the personal folder goes to the owner (or is deleted).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { deleteUser } from '../../server/src/admin/users'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { HttpError } from '../../server/src/http/errors'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

describe('account deletion by role', () => {
  let h: Harness
  let owner: Client
  let admin: Awaited<ReturnType<typeof addMember>>
  let admin2: Awaited<ReturnType<typeof addMember>>
  let ownerId: string
  beforeAll(async () => {
    h = await harness('sec-delete-by-role')
    owner = await withOwner(h, 'dana')
    ownerId = (await owner.call('GET', '/api/me')).user.id
    admin = await addMember(h, owner, { username: 'carol', role: 'admin' })
    admin2 = await addMember(h, owner, { username: 'axel', role: 'admin', password: 'copper field wind 9' })
  })
  afterAll(() => h.close())

  const row = (id: string) => h.ctx.db.query('SELECT status, deleted_at, role FROM users WHERE id = ?').get(id) as { status: string; deleted_at: string | null; role: string }
  const deleteAudits = () => (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.delete'").get() as { n: number }).n
  const del = (c: Client, id: string, body?: unknown, q = '') => c.try('DELETE', `/api/admin/users/${id}${q}`, body)

  test('the contract is admin-level and carries an optional password', () => {
    expect(API.deleteUser.auth).toBe('admin')
    expect(API.deleteUser.body!.safeParse({ password: 'x' }).success).toBe(true)
    expect(API.deleteUser.body!.safeParse({}).success).toBe(true)
  })

  test('an admin deletes a member with the password: sessions end, the folder goes to the owner, the audit line names the admin', async () => {
    const erin = await addMember(h, owner, { username: 'erin' })
    const folder = path.join(h.ctx.files.fx.root, 'users', erin.id)
    fs.writeFileSync(path.join(folder, 'notes.md'), 'erin keeps this')
    const r = await del(admin.client, erin.id, { password: admin.password })
    expect(r.status).toBe(204)
    expect((await erin.client.try('GET', '/api/me')).status).toBe(401)
    expect((await h.client().try('POST', '/api/auth/login', { username: 'erin', password: erin.password })).status).toBe(401)
    expect((await owner.call('GET', '/api/admin/users')).items.some((u: any) => u.id === erin.id)).toBe(false)
    expect(fs.existsSync(folder)).toBe(false)
    expect(row(erin.id).deleted_at).not.toBeNull()
    const a = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'user.delete' AND target = ?").all(erin.id) as { actor_id: string; target: string; detail: string }[]
    expect(a).toHaveLength(1)
    expect(a[0]!.actor_id).toBe(admin.id)
    expect(JSON.parse(a[0]!.detail)).toMatchObject({ personalFolder: 'transfer' })
    // the archive is in the owner's personal folder (users/<ownerId>/<archive>/<target>/...), not the admin's
    const movedTo = JSON.parse(a[0]!.detail).movedTo as string
    expect(movedTo.startsWith(`users/${ownerId}/`)).toBe(true)
    expect(movedTo.split('/').at(-1)).toBe(erin.id)
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, movedTo, 'notes.md'), 'utf8')).toBe('erin keeps this')
    const adminFolder = path.join(h.ctx.files.fx.root, 'users', admin.id)
    const inAdmin = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => [e.name, ...(e.isDirectory() ? inAdmin(path.join(dir, e.name)) : [])])
    expect(inAdmin(adminFolder)).not.toContain(erin.id)
    expect(inAdmin(adminFolder)).not.toContain('notes.md')
  })

  test('an admin may choose to delete the personal folder too, as the owner may', async () => {
    const gus = await addMember(h, owner, { username: 'gus' })
    const folder = path.join(h.ctx.files.fx.root, 'users', gus.id)
    fs.writeFileSync(path.join(folder, 'x.md'), 'x')
    expect((await del(admin.client, gus.id, { password: admin.password }, '?personalFolder=delete')).status).toBe(204)
    expect(fs.existsSync(folder)).toBe(false)
    const d = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target = ?").get(gus.id) as { detail: string }
    expect(JSON.parse(d.detail)).toMatchObject({ personalFolder: 'delete', movedTo: null })
  })

  test('an admin without a valid password is refused and nothing happens (none, empty, wrong, someone else\'s)', async () => {
    const hal = await addMember(h, owner, { username: 'hal' })
    const folder = path.join(h.ctx.files.fx.root, 'users', hal.id)
    fs.writeFileSync(path.join(folder, 'notes.md'), 'hal keeps this')
    const before = deleteAudits()
    for (const body of [undefined, {}, { password: '' }, { password: 'not the password' }, { password: admin2.password }]) {
      const r = await del(admin.client, hal.id, body)
      expect(r.status, JSON.stringify(body)).toBe(body && (body as any).password === '' ? 400 : 403)
    }
    expect(row(hal.id)).toMatchObject({ status: 'active', deleted_at: null })
    expect((await hal.client.try('GET', '/api/me')).status).toBe(200)
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('hal keeps this')
    expect(deleteAudits()).toBe(before)
  })

  test('a wrong admin password is audited (auth.reauth_failed) and counts toward the per-person limit', async () => {
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
    const ned = await addMember(h, owner, { username: 'ned' })
    const failed = () => (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauth_failed' AND actor_id = ?").get(admin2.id) as { n: number }).n
    const before = failed()
    for (let i = 0; i < DEFAULT_LIMITS.perReauth; i++) expect((await del(admin2.client, ned.id, { password: 'wrong wrong 1' })).status).toBe(403)
    expect(failed()).toBe(before + DEFAULT_LIMITS.perReauth)
    // the limit is reached: even the right password waits (429), and nothing was deleted
    expect((await del(admin2.client, ned.id, { password: admin2.password })).status).toBe(429)
    expect(row(ned.id).deleted_at).toBeNull()
    h.advance(DEFAULT_LIMITS.windowMs + 1000)
  })

  test('an admin cannot delete the owner, another admin or themselves, even with the right password', async () => {
    const before = deleteAudits()
    expect((await del(admin.client, ownerId, { password: admin.password })).status).toBe(403)
    expect((await del(admin.client, admin2.id, { password: admin.password })).status).toBe(403)
    expect((await del(admin.client, admin.id, { password: admin.password })).status).toBe(403)
    expect(row(ownerId).deleted_at).toBeNull()
    expect(row(admin2.id).deleted_at).toBeNull()
    expect(row(admin.id).deleted_at).toBeNull()
    expect((await admin2.client.try('GET', '/api/me')).status).toBe(200)
    expect(deleteAudits()).toBe(before)
  })

  test('a member promoted between page load and delete is refused', async () => {
    const ivy = await addMember(h, owner, { username: 'ivy' })
    // the admin loaded the page while ivy was a member; the owner promotes ivy; the admin then presses Delete
    expect((await owner.try('PATCH', `/api/admin/users/${ivy.id}`, { role: 'admin' })).status).toBe(200)
    const before = deleteAudits()
    expect((await del(admin.client, ivy.id, { password: admin.password })).status).toBe(403)
    expect(row(ivy.id)).toMatchObject({ role: 'admin', deleted_at: null })
    expect(deleteAudits()).toBe(before)
  })

  test('a promotion that lands while the password is being checked is refused too (the role is read again inside the delete)', async () => {
    const jon = await addMember(h, owner, { username: 'jon' })
    const sessions = h.ctx.services.sessions as unknown as { verifyPassword: (...a: unknown[]) => Promise<boolean> }
    const real = sessions.verifyPassword
    sessions.verifyPassword = async (...a: unknown[]) => {
      const ok = await real.apply(sessions, a)
      h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(jon.id)
      return ok
    }
    try {
      expect((await del(admin.client, jon.id, { password: admin.password })).status).toBe(403)
    } finally { sessions.verifyPassword = real }
    expect(row(jon.id)).toMatchObject({ role: 'admin', deleted_at: null })
  })

  test('an admin demoted while the password is checked is refused (the actor is read again inside the delete)', async () => {
    const ora = await addMember(h, owner, { username: 'ora', role: 'admin' })
    const pat = await addMember(h, owner, { username: 'pat' })
    const sessions = h.ctx.services.sessions as unknown as { verifyPassword: (...a: unknown[]) => Promise<boolean> }
    const real = sessions.verifyPassword
    sessions.verifyPassword = async (...a: unknown[]) => {
      const ok = await real.apply(sessions, a)
      h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(ora.id)
      return ok
    }
    try {
      expect((await del(ora.client, pat.id, { password: ora.password })).status).toBe(403)
    } finally { sessions.verifyPassword = real }
    expect(row(pat.id).deleted_at).toBeNull()
    // disabled while the password is checked: the same
    const qui = await addMember(h, owner, { username: 'qui', role: 'admin' })
    const rex = await addMember(h, owner, { username: 'rex' })
    sessions.verifyPassword = async (...a: unknown[]) => {
      const ok = await real.apply(sessions, a)
      h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(qui.id)
      return ok
    }
    try {
      expect((await del(qui.client, rex.id, { password: qui.password })).status).toBe(403)
    } finally { sessions.verifyPassword = real }
    expect(row(rex.id).deleted_at).toBeNull()
  })

  test('the check inside the delete itself: a promotion that lands after the first checks, before the delete runs', async () => {
    const sam = await addMember(h, owner, { username: 'sam' })
    const ctxFor = (userId: string, role: string) => {
      const vars: Record<string, unknown> = { auth: { user: { id: userId, role } }, locale: 'en', info: { ip: '10.0.0.7', userAgent: 'test' }, log: { warn() {}, error() {} } }
      return { get: (k: string) => vars[k] } as any
    }
    // the owner has no password step; the only thing between the first guard and the transaction is this read of the
    // person's sign-ins, which here promotes them: only the check inside the transaction can still stop the delete
    const integ = integrationsOf(h.ctx)
    const real = integ.signInsToRevoke.bind(integ)
    integ.signInsToRevoke = (id: string) => { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(id); return real(id) }
    let err: unknown
    try { await deleteUser(ctxFor(admin.id, 'admin'), h.ctx, sam.id, 'delete', admin.password) } catch (e) { err = e }
    finally { integ.signInsToRevoke = real }
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('forbidden')
    expect(row(sam.id)).toMatchObject({ role: 'admin', deleted_at: null })
  })

  test('the server function itself refuses a plain member, and an admin without the password', async () => {
    const kim = await addMember(h, owner, { username: 'kim' })
    const ctxFor = (userId: string, role: string) => {
      const vars: Record<string, unknown> = { auth: { user: { id: userId, role } }, locale: 'en', info: { ip: '10.0.0.7', userAgent: 'test' } }
      return { get: (k: string) => vars[k] } as any
    }
    const lou = await addMember(h, owner, { username: 'lou' })
    // a plain member aims at another member; an admin aims at a member without the password
    for (const [c, target, pw] of [[ctxFor(lou.id, 'member'), kim.id, undefined], [ctxFor(admin.id, 'admin'), kim.id, undefined]] as const) {
      let err: unknown
      try { await deleteUser(c, h.ctx, target, 'delete', pw) } catch (e) { err = e }
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).code).toBe('forbidden')
    }
    expect(row(kim.id)).toMatchObject({ status: 'active', deleted_at: null })
  })

  test('a plain member cannot delete anyone', async () => {
    const lee = await addMember(h, owner, { username: 'lee' })
    const mo = await addMember(h, owner, { username: 'mo' })
    expect((await del(lee.client, mo.id, { password: lee.password })).status).toBe(403)
    expect(row(mo.id).deleted_at).toBeNull()
    expect((await del(lee.client, admin.id, { password: lee.password })).status).toBe(403)
  })

  test('the owner is unchanged: deletes a member and an admin without a password, never themselves; the audit names the owner', async () => {
    const finn = await addMember(h, owner, { username: 'finn' })
    expect((await owner.try('DELETE', `/api/admin/users/${finn.id}`)).status).toBe(204)
    expect((await finn.client.try('GET', '/api/me')).status).toBe(401)
    expect((await owner.call('GET', '/api/admin/users')).items.some((u: any) => u.id === finn.id)).toBe(false)
    const a = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'user.delete' AND target = ?").get(finn.id) as { actor_id: string }
    expect(a.actor_id).toBe(ownerId)
    // a body with a password is fine too (the web sends none for the owner), and an admin goes the same way
    const old = await addMember(h, owner, { username: 'olaf', role: 'admin' })
    expect((await del(owner, old.id, {})).status).toBe(204)
    expect((await owner.try('DELETE', `/api/admin/users/${ownerId}`)).status).toBe(403)
    expect(row(ownerId).deleted_at).toBeNull()
  })

  test('the admin keeps what an admin had: disable and password reset on members', async () => {
    const m = await addMember(h, owner, { username: 'mia' })
    expect((await admin.client.try('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })).status).toBe(200)
    expect((await admin.client.try('POST', `/api/admin/users/${m.id}/reset-password`)).status).toBe(200)
  })
})
