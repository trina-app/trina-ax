// The Trina list's groups (GET /api/chats/groups, server/src/chat/chat-groups.ts) never show what the person cannot
// see now. The project is on projects/falcon and shares its chats: alice writes it, the finance group (bob) reads it;
// dana (the owner) manages it without being its member. Covered: someone else's chats and folders (by canary, in the
// raw response), the chats of a shared project I never wrote in (not counted), a project I lost (not named, not counted
// in projectsMore), its shared chat (nowhere, nor in GET /api/chats?other=1), my own private chat there (with the other
// chats), and coming back to the project.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Chat, type ChatGroups } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { updateGroupAs } from '../../server/src/admin/groups'

setDefaultTimeout(90_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'sec-chat-groups', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'dana']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const groups = (user: string): Promise<ChatGroups> => h.api(user).call(API.listChatGroups, {})
const raw = async (user: string) => (await h.req(user, '/api/chats/groups')).text()
/** every chat id the groups name, wherever (top rows, marks, pins, other) */
const named = (g: ChatGroups) => [...g.pinned, ...g.folders.flatMap((f) => f.top), ...g.projects.flatMap((p) => p.top), ...g.other.items].map((c) => c.id)
const touch = (id: string, msAgo: number) => db().query('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - msAgo).toISOString(), id)
/** a chat of `user` with a title (an untitled chat nobody used is left out), last active `minutesAgo` */
async function chat(user: string, minutesAgo: number, body: { projectId?: string } = {}, title = 'c'): Promise<Chat> {
  const c = await h.api(user).call(API.createChat, { body: { ...body, title } })
  touch(c.id, minutesAgo * 60_000)
  return c
}
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
}

describe('never shows what I cannot see', () => {
  test("someone else's chats and folders, a project I lost, a shared chat of it", async () => {
    const shared = await chat('bob', 1, { projectId })
    await ask('bob', shared.id, 'BOB-SHARED-QUESTION')
    const mine = await chat('bob', 2, {}, 'bob-private')
    // a private chat of bob's in the project (made before it shared its chats)
    const privateInProject = await chat('bob', 3, {}, 'bob-private-in-falcon')
    db().query('UPDATE chats SET project_id = ? WHERE id = ?').run(projectId, privateInProject.id)
    const aliceFolder = await h.api('alice').call(API.createNavFolder, { body: { kind: 'chats', name: 'ALICE-FOLDER-CANARY' } })
    const aliceChat = await chat('alice', 0, {}, 'ALICE-CHAT-CANARY')
    await h.api('alice').call(API.setChatFolder, { params: { id: aliceChat.id }, body: { folderId: aliceFolder.id } })

    const g = await groups('bob')
    const falcon = g.projects.find((p) => p.projectId === projectId)!
    expect(falcon.top.map((c) => c.id)).toEqual([shared.id, privateInProject.id])
    expect(g.other.items.map((c) => c.id)).toEqual([mine.id])
    // alice's chats in falcon that bob never wrote in are not his list's
    expect(falcon.count).toBe(2)
    for (const who of ['bob', 'dana']) {
      const text = await raw(who)
      expect(text).not.toContain('ALICE-FOLDER-CANARY')
      expect(text).not.toContain('ALICE-CHAT-CANARY')
    }

    // bob leaves the finance group: he loses projects/falcon
    updateGroupAs(h.ctx, 'dana', 'finance', { memberIds: [] }, 'en')
    try {
      const lost = await groups('bob')
      expect(lost.projects.map((p) => p.projectId)).not.toContain(projectId)
      // the shared chat is nowhere, his private one is with the other chats, and the project is never named
      expect(named(lost)).not.toContain(shared.id)
      expect(lost.other.items.map((c) => c.id)).toEqual([mine.id, privateInProject.id])
      expect(lost.projectsMore).toBe(0)
      const text = await raw('bob')
      expect(text).not.toContain('Falcon')
      expect(text).not.toContain('BOB-SHARED-QUESTION')
      // the next pages say the same
      const page = await h.api('bob').call(API.listChats, { query: { other: '1' } })
      expect(page.items.map((c) => c.id)).not.toContain(shared.id)
    } finally { updateGroupAs(h.ctx, 'dana', 'finance', { memberIds: ['bob'] }, 'en') }
    expect((await groups('bob')).projects.find((p) => p.projectId === projectId)?.count).toBe(2)
  })
})

describe('never a chat in the trash or a room session', () => {
  test('a chat in the trash is in no group and not in the next pages', async () => {
    const gone = await chat('bob', 0, {}, 'BOB-TRASHED-CANARY')
    await h.api('bob').call(API.deleteChat, { params: { id: gone.id } })
    expect(await raw('bob')).not.toContain('BOB-TRASHED-CANARY')
    expect(JSON.stringify(await h.api('bob').call(API.listChats, { query: { other: '1' } }))).not.toContain('BOB-TRASHED-CANARY')
  })
  test("a room's AI session is never listed", async () => {
    const roomChat = await chat('bob', 0, {}, 'BOB-ROOM-SESSION-CANARY')
    const room = db().query('SELECT id FROM rooms LIMIT 1').get() as { id: string } | null
    expect(room).not.toBeNull()
    db().query('UPDATE chats SET room_id = ? WHERE id = ?').run(room!.id, roomChat.id)
    expect(await raw('bob')).not.toContain('BOB-ROOM-SESSION-CANARY')
  })
})
