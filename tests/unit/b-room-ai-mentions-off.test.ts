// "@트리나 …" in a room is off by default since the side chat (AppConfig.roomAiMentions, docs/DECISIONS.md "Trina side
// chat"): the text is an ordinary message, no AI turn starts, and Me says so (the box offers no AI in its "@" list).
// The operator's switch brings the old way back. The test harness turns it on for the room AI tests.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function world(roomAiMentions: boolean) {
  h = await harness(`b-room-ai-mentions-${roomAiMentions ? 'on' : 'off'}`, { roomAiMentions })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const send = (body: string) => mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body, clientMessageId: 'cm-' + crypto.randomUUID() })
  const turns = () => (h.ctx.db.query('SELECT COUNT(*) n FROM room_ai_turns').get() as { n: number }).n
  return { mia, dm, send, turns }
}

test('off (the default): "@트리나 …" is an ordinary message, no AI turn, and Me does not offer it', async () => {
  const w = await world(false)
  const m = await w.send('@트리나 summarize this please')
  expect(m.body).toBe('@트리나 summarize this please')
  expect(w.turns()).toBe(0)
  expect((await w.mia.client.call('GET', '/api/me')).server.roomAiMentions).toBeUndefined()
})

test('on (the operator\'s switch): Me offers it', async () => {
  const w = await world(true)
  expect((await w.mia.client.call('GET', '/api/me')).server.roomAiMentions).toBe(true)
})
