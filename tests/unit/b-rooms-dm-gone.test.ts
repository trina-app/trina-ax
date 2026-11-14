// A DM with a person who was deleted from the team (Room.gone): the room stays in the other person's list and its history
// stays readable, but nothing can be written in it. A group chat is not closed by one person leaving it.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { newId } from '../../server/src/db'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('after one person is deleted the DM is gone for the other: readable, closed to new messages; groups go on', async () => {
  h = await harness('b-rooms-dm-gone')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const say = (c: typeof mia.client, id: string, body: string) => c.try('POST', `/api/rooms/${id}/messages`, { body, clientMessageId: newId(), mentions: [], mentionsAll: false, fileIds: [] })
  expect((await say(mia.client, dm.id, 'hello nora')).status).toBe(201)
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).gone).toBeUndefined()

  expect((await owner.try('DELETE', `/api/admin/users/${nora.id}`)).status).toBe(204)

  const room = await mia.client.call('GET', `/api/rooms/${dm.id}`)
  expect(room.gone).toBe(true)
  expect(room.peers[0].name).toBe('NORA')
  expect(((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.id === dm.id).gone).toBe(true)
  // the history stays readable
  const history = await mia.client.call('GET', `/api/rooms/${dm.id}/messages`)
  expect(JSON.stringify(history)).toContain('hello nora')
  // and nothing new goes in
  const refused = await say(mia.client, dm.id, 'are you there?')
  expect(refused.status).toBe(409)
  expect(JSON.stringify(refused.body)).toContain('팀을 떠나')
  // a group chat the person was in is not closed
  expect((await mia.client.call('GET', `/api/rooms/${group.id}`)).gone).toBeUndefined()
  expect((await say(mia.client, group.id, 'still here')).status).toBe(201)
})
