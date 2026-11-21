// "This conversation" (room=) on a guest's 1:1 chat (docs/decisions/20261120-search-shortcuts-slack.md): room= with
// from:me returns only my messages; once the DM is closed (the member left the guest's place) room= finds nothing for
// either side, messages or files, says roomGone and never echoes the room's id or its words.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()
const send = (c: Client, room: string, body: string) => c.call('POST', `/api/rooms/${room}/messages`, { body, clientMessageId: cm(), mentions: [], fileIds: [] })
const get = (c: Client, p: string) => c.call('GET', p)
const msgs = (c: Client, q: string, room: string) => get(c, `/api/room-messages?q=${encodeURIComponent(q)}&room=${room}`)
const files = (c: Client, q: string, room: string) => get(c, `/api/room-files?q=${encodeURIComponent(q)}&room=${room}`)

test('closed guest DM: room= finds nothing for either side, says roomGone, never echoes the id', async () => {
  h = await harness('a-guests-room-param')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(mia.client, [nora.id])
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const dm = (await gus.client.call('POST', '/api/rooms', { kind: 'dm', userId: mia.id })).id as string
  await send(gus.client, dm, 'RVDM-CANARY secret dm words')
  await send(mia.client, dm, 'RVDM-CANARY mia reply')
  expect((await msgs(gus.client, 'RVDM-CANARY', dm)).items).toHaveLength(2)
  expect((await msgs(gus.client, 'from:me RVDM-CANARY', dm)).items.map((i: { snippet: string }) => i.snippet)).toEqual(['RVDM-CANARY secret dm words'])
  // mia leaves the group chat: the DM is closed to both
  await mia.client.call('POST', `/api/rooms/${room}/leave`)
  for (const c of [gus.client, mia.client]) {
    for (const q of ['RVDM-CANARY', 'from:me', 'mentions:me', 'from:me mentions:me']) {
      const p = await msgs(c, q, dm)
      expect(p.items).toEqual([])
      expect(p.filters.roomGone).toBe(true)
      expect(JSON.stringify(p)).not.toContain(dm)
      expect(JSON.stringify(p)).not.toContain('secret')
      const f = await files(c, q, dm)
      expect(f.items).toEqual([])
      expect(f.filters.roomGone).toBe(true)
    }
  }
})
