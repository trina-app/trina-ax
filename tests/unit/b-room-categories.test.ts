// Conversation categories (shared/src/api/room-categories.ts, server/src/rooms/categories.ts, migration 428): the team's
// own, made by admins. Covered: only an admin or the owner makes, renames, orders, deletes and files (a member 403);
// everyone reads the same list; names unique in any letter case; a channel's category is the same for every member;
// a DM or an unnamed group chat cannot go in one (409); a room I am not in 404; deleting a category takes its channels
// out for everyone; every window hears roomCategories.changed.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('admins manage categories, everyone sees the same; channels only; delete takes channels out', async () => {
  h = await harness('b-room-categories')
  const owner = await withOwner(h)
  const admin = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })

  // a member cannot make one
  expect((await mia.client.try('POST', '/api/room-categories', { name: 'Mine' })).status).toBe(403)
  const mon = await admin.client.try('POST', '/api/room-categories', { name: '  Monitoring ' })
  expect(mon.status).toBe(201)
  expect(mon.body).toMatchObject({ name: 'Monitoring', position: 0 })
  const ownerMade = await owner.try('POST', '/api/room-categories', { name: 'Internal' })
  expect(ownerMade.status).toBe(201)
  expect(ownerMade.body.position).toBe(1)
  // the same name in another letter case is taken
  const dup = await admin.client.try('POST', '/api/room-categories', { name: 'MONITORING' })
  expect([dup.status, dup.body.error.params.reason]).toEqual([409, 'room_category_name_taken'])
  // everyone (a member too) reads the same list
  expect(((await mia.client.call('GET', '/api/room-categories')).items as any[]).map((c) => c.name)).toEqual(['Monitoring', 'Internal'])
  // every window heard it (the test hub records a broadcast as '*')
  const heard = h.hub.events.filter((e) => e.kind === 'publish' && (e.data as { type: string }).type === 'roomCategories.changed').map((e) => e.target)
  expect(heard).toContain('*')

  // a member cannot rename, order, delete or file
  expect((await mia.client.try('PATCH', `/api/room-categories/${mon.body.id}`, { name: 'x' })).status).toBe(403)
  expect((await mia.client.try('PUT', '/api/room-categories/order', { ids: [ownerMade.body.id] })).status).toBe(403)
  expect((await mia.client.try('DELETE', `/api/room-categories/${mon.body.id}`)).status).toBe(403)

  // a named group room (a private channel) with the admin, mia and nora
  const ch = await admin.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, nora.id], name: 'Trina AX CI' })
  expect((await mia.client.try('PUT', `/api/rooms/${ch.id}/category`, { categoryId: mon.body.id })).status).toBe(403)
  const filed = await admin.client.try('PUT', `/api/rooms/${ch.id}/category`, { categoryId: mon.body.id })
  expect(filed.status).toBe(200)
  expect(filed.body.categoryId).toBe(mon.body.id)
  // the same for every member
  const miaRooms = (await mia.client.call('GET', '/api/rooms')).items as any[]
  expect(miaRooms.find((r) => r.id === ch.id).categoryId).toBe(mon.body.id)

  // a DM and an unnamed group chat are personal: 409
  const dm = await admin.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })
  const dmTry = await admin.client.try('PUT', `/api/rooms/${dm.id}/category`, { categoryId: mon.body.id })
  expect([dmTry.status, dmTry.body.error.params.reason]).toEqual([409, 'room_category_personal'])
  const unnamed = await admin.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, nora.id] })
  expect((await admin.client.try('PUT', `/api/rooms/${unnamed.id}/category`, { categoryId: mon.body.id })).status).toBe(409)
  // a room the admin is not in: 404 like any room call
  const theirs = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [otto.id], name: 'Private' })
  expect((await admin.client.try('PUT', `/api/rooms/${theirs.id}/category`, { categoryId: mon.body.id })).status).toBe(404)
  // an unknown category: 404
  expect((await admin.client.try('PUT', `/api/rooms/${ch.id}/category`, { categoryId: '0190a000-0000-7000-8000-000000000000' })).status).toBe(404)

  // order, rename
  const ordered = await admin.client.call('PUT', '/api/room-categories/order', { ids: [ownerMade.body.id] })
  expect((ordered.items as any[]).map((c) => c.name)).toEqual(['Internal', 'Monitoring'])
  expect((await admin.client.call('PATCH', `/api/room-categories/${mon.body.id}`, { name: 'Alerts' })).name).toBe('Alerts')

  // delete: its channels go back for everyone, the rest are numbered again
  expect((await admin.client.try('DELETE', `/api/room-categories/${mon.body.id}`)).status).toBe(204)
  expect(((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.id === ch.id).categoryId).toBeUndefined()
  expect((await mia.client.call('GET', '/api/room-categories')).items).toEqual([{ id: ownerMade.body.id, name: 'Internal', position: 0 }])
})
