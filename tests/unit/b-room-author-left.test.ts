// S-110 (scenario QA 11-22): after 정하늘 (a guest) was removed her old room messages showed a plain "정하늘". Room
// messages now carry authorLeft for an author whose account is turned off or removed: 'guest' for a guest, 'member'
// for anyone else (shared RoomMessage.authorLeft, rooms/store.ts messagesOut), in the timeline and in threads; never for
// an active account.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
let h: Harness
let roomId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-room-author-left' })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short (as b-post-to-room does)
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomId = ((await h.api('alice').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'all')!.id
})
afterAll(async () => { await h?.close() })

const send = (user: string, body: string, threadRootId?: string) => h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...(threadRootId ? { threadRootId } : {}) } })
const timeline = async (viewer: string) => (await h.api(viewer).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]

describe('authorLeft', () => {
  test('absent for an active author; member once the account is off; guest for a removed guest; in a thread too', async () => {
    const root = await send('erin', 'the draft is in')
    await send('bob', 'thanks', root.id)
    await send('erin', 'one more', root.id)
    const mine = await send('bob', 'ok')
    expect((await timeline('bob')).find((m) => m.id === root.id)!.authorLeft).toBeUndefined()
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'erin'").run()
    try {
      const list = await timeline('bob')
      expect(list.find((m) => m.id === root.id)).toMatchObject({ author: { id: 'erin' }, authorLeft: 'member' })
      expect(list.find((m) => m.id === mine.id)!.authorLeft).toBeUndefined()
      h.ctx.db.query("UPDATE users SET guest = 1 WHERE id = 'erin'").run()
      expect((await timeline('alice')).find((m) => m.id === root.id)!.authorLeft).toBe('guest')
      const page = await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: root.id }, query: {} })
      const thread = page.items as RoomMessage[]
      expect(page.root.authorLeft).toBe('guest')
      expect(thread.filter((m) => m.author?.id === 'erin').map((m) => m.authorLeft)).toEqual(['guest'])
      expect(thread.find((m) => m.author?.id === 'bob')!.authorLeft).toBeUndefined()
    } finally {
      h.ctx.db.query("UPDATE users SET status = 'active', guest = 0 WHERE id = 'erin'").run()
    }
  })
})
