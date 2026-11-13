// The Trina list's groups (GET /api/chats/groups, server/src/chat/chat-groups.ts; docs/DECISIONS.md "The Trina list:
// pinned, folders, projects, other chats"). The project is on projects/falcon and shares its chats: alice writes it, the
// finance group (bob) reads it; dana (owner) and carol (admin) are not its members. Covered: each chat in exactly one
// place (pinned › folder › project › other), the counts and first rows, a chat made only to hold attachments left out,
// the other chats' next pages (GET /api/chats?other=1) without a gap or a repeat, at most 8 project groups with recent
// activity (the rest counted in projectsMore), folding after 7 days, the marks of rows past `top`. What it never shows is
// tests/security/chat-groups.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CHAT_GROUPS_PROJECTS_MAX, type Chat, type ChatGroups } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(90_000)
const cm = () => 'cm-' + crypto.randomUUID()
const DAY = 86_400_000

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-groups', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
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

describe('alice: each chat in one place', () => {
  test('pinned › folder › project › other; counts, first rows and the next pages of the other chats', async () => {
    const pinned = await chat('alice', 1, { projectId })
    await h.api('alice').call(API.pinChat, { params: { id: pinned.id } })
    const inProject = [await chat('alice', 2, { projectId }), await chat('alice', 3, { projectId }), await chat('alice', 4, { projectId }), await chat('alice', 5, { projectId })]
    const folder = await h.api('alice').call(API.createNavFolder, { body: { kind: 'chats', name: 'Reports' } })
    const filed = await chat('alice', 6)
    await h.api('alice').call(API.setChatFolder, { params: { id: filed.id }, body: { folderId: folder.id } })
    const others: Chat[] = []
    for (let i = 0; i < 55; i++) others.push(await chat('alice', 10 + i))
    // made only to hold attachments: not in the list
    const unused = await h.api('alice').call(API.createChat, { body: {} })

    const g = await groups('alice')
    expect(g.pinned.map((c) => c.id)).toEqual([pinned.id])
    expect(g.folders).toMatchObject([{ id: folder.id, name: 'Reports', count: 1, top: [{ id: filed.id }] }])
    expect(g.projects).toHaveLength(1)
    expect(g.projects[0]).toMatchObject({ projectId, name: 'Falcon', count: 4, folded: false })
    expect(g.projects[0]!.top.map((c) => c.id)).toEqual(inProject.slice(0, 3).map((c) => c.id))
    expect(g.other.items).toHaveLength(50)
    expect(g.other.nextCursor).toBeString()
    // each chat once
    const all = named(g)
    expect(new Set(all).size).toBe(all.length)
    expect(all).not.toContain(unused.id)
    // the next page: the rest of the other chats, nothing twice, nothing from another group
    const next = await h.api('alice').call(API.listChats, { query: { other: '1', cursor: g.other.nextCursor! } })
    expect([...g.other.items, ...next.items].map((c) => c.id)).toEqual(others.map((c) => c.id))
    expect(next.nextCursor).toBeNull()
    // the other chats alone: not with a project or a search
    expect((await h.req('alice', `/api/chats?other=1&projectId=${projectId}`)).status).toBe(400)
    // unpinned, the chat goes back to its project's group
    await h.api('alice').call(API.unpinChat, { params: { id: pinned.id } })
    const after = await groups('alice')
    expect(after.pinned).toEqual([])
    expect(after.projects[0]!.count).toBe(5)
    expect(after.projects[0]!.top[0]!.id).toBe(pinned.id)
  })

  test('a row past the first three keeps its mark in `marked`', async () => {
    const old = await chat('alice', 60 * 24, { projectId })
    await ask('alice', old.id, 'hello')
    // the answer just finished: unseen. Four newer chats push it out of `top`
    for (let i = 0; i < 4; i++) await chat('alice', i, { projectId })
    touch(old.id, 50 * 60_000)
    const p = (await groups('alice')).projects.find((x) => x.projectId === projectId)!
    expect(p.top.map((c) => c.id)).not.toContain(old.id)
    expect(p.marked).toContainEqual(expect.objectContaining({ id: old.id, unseen: true }))
    // seen: no mark any more
    await h.api('alice').call(API.markChatSeen, { params: { id: old.id } })
    expect((await groups('alice')).projects.find((x) => x.projectId === projectId)!.marked.map((m) => m.id)).not.toContain(old.id)
  })
})

describe('projects: at most 8 with recent activity', () => {
  test('the 8 most recent of the last 14 days, the rest counted; 7 days without activity starts folded', async () => {
    const ids: string[] = []
    for (let i = 0; i < 11; i++) {
      const p = await h.api('dana').call(API.createProject, { body: { name: `P${i}`, scope: 'personal', participants: [], instructions: '' } })
      ids.push(p.id)
      // P0 newest … P9 ten days ago; P10 twenty days ago (not recent)
      const c = await chat('dana', 0, { projectId: p.id })
      touch(c.id, i === 10 ? 20 * DAY : i * DAY)
    }
    const g = await groups('dana')
    expect(g.projects).toHaveLength(CHAT_GROUPS_PROJECTS_MAX)
    expect(g.projects.map((p) => p.projectId)).toEqual(ids.slice(0, 8))
    expect(g.projects.map((p) => p.folded)).toEqual([false, false, false, false, false, false, false, true])
    // dana sees her 11 personal projects (falcon is not hers to read: she manages it, she is not its member)
    expect(g.projectsMore).toBe(3)
    expect(await raw('dana')).not.toContain('Falcon')
    // every project with chats of her list, the 20-day-old one too: one chat each, its last activity (프로젝트's list)
    const act = new Map((g.projectActivity ?? []).map((a) => [a.projectId, a]))
    expect(ids.every((id) => act.get(id)?.count === 1)).toBe(true)
    expect(act.get(ids[10]!)!.lastActivityAt < act.get(ids[0]!)!.lastActivityAt).toBe(true)
  })
})
