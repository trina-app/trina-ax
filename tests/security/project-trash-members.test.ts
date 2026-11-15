// A team project in the trash keeps its card for its members (docs/DECISIONS.md "A team project in the trash: its
// members keep its card", QA TC-1060, TC-1062): they get its name, that it is in the trash, who moved it there and when,
// and its creator may restore it. Nothing of its contents: every way in to its files, versions, chats, instructions,
// people and search answers stays 404 (or answers without a canary) for its members too, while it is in the trash. Bob,
// who is not a member, gets nothing at all, not even the card or the reason on its chat link.
// Fixture (tests/lib/b-harness.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(120_000)
const K = { file: 'SEC-PTM-FILE-1a2', name: 'SEC-PTM-NAME-3b4', instr: 'SEC-PTM-INSTR-5c6', chat: 'SEC-PTM-CHAT-7d8' } as const
const ALL = Object.values(K)
const DIR = 'projects/Binned'

let h: Harness
let projectId = '', chatId = '', trashId = ''
const leaked = (text: string) => ALL.filter((k) => text.includes(k))
async function raw(who: string, method: string, p: string): Promise<{ status: number; text: string; json: any }> {
  const r = await h.req(who, p, { method })
  const text = await r.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, text, json }
}
const q = (p: string) => encodeURIComponent(p)

beforeAll(async () => {
  h = await startHarness({ name: 'sec-project-trash-members' })
  const a = h.api('alice')
  projectId = (await a.call(API.createProject, { body: { name: 'Binned', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: K.instr } })).id
  expect(h.rt().store.projectRow(projectId)!.folder_path).toBe(DIR)
  await a.call(API.saveContent, { body: { path: `${DIR}/plan.md`, content: `${K.file}\n`, baseSha256: null } })
  await a.call(API.saveContent, { body: { path: `${DIR}/${K.name}.md`, content: 'n\n', baseSha256: null } })
  // a shared chat of erin's in it (team project chats are shared by default)
  const chat = await h.api('erin').call(API.createChat, { body: { projectId, title: K.chat } })
  chatId = chat.id
  expect(chat.shared).toBeTruthy()
  await a.call(API.deleteProject, { params: { id: projectId } })
  trashId = h.rt().store.projectRow(projectId)!.trashed_with!
  expect(trashId).toBeTruthy()
})
afterAll(async () => { await h.close() })

describe('a team project in the trash, as its members and others try to read it', () => {
  test('its contents: 404 (or nothing) for its members and for everyone else', async () => {
    const ways = [
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/people`,
      `/api/projects/${projectId}/access`,
      `/api/files/content?path=${q(`${DIR}/plan.md`)}`,
      `/api/files/tree?path=${q(DIR)}`,
      `/api/files/history?path=${q(`${DIR}/plan.md`)}`,
      `/api/files/download?path=${q(`${DIR}/plan.md`)}`,
      `/api/chats/${chatId}/messages`,
    ]
    for (const who of ['alice', 'erin', 'bob']) {
      for (const p of ways) {
        const r = await raw(who, 'GET', p)
        expect({ who, p, refused: r.status === 404 || r.status === 403 }).toEqual({ who, p, refused: true })
        expect({ who, p, leaked: leaked(r.text) }).toEqual({ who, p, leaked: [] })
      }
      // lists and searches that could name what is inside
      for (const p of [`/api/chats?projectId=${projectId}`, `/api/chats?q=${q(K.chat)}`, `/api/files/find?q=${q(K.name)}`, `/api/files/search?q=${q(K.file)}`, '/api/chats/groups', '/api/projects', '/api/projects?manage=1']) {
        const r = await raw(who, 'GET', p)
        expect({ who, p, leaked: leaked(r.text) }).toEqual({ who, p, leaked: [] })
      }
    }
  })

  test('its card and page: its members get its name and state only; bob gets 404', async () => {
    for (const who of ['alice', 'erin']) {
      const r = await raw(who, 'GET', `/api/projects/${projectId}?manage=1`)
      expect(r.status).toBe(200)
      expect([r.json.inTrash, r.json.member, r.json.wasMember, r.json.instructions, r.json.trashed?.by?.id]).toEqual([true, false, true, '', 'alice'])
      expect(leaked(r.text)).toEqual([])
    }
    expect((await raw('bob', 'GET', `/api/projects/${projectId}?manage=1`)).status).toBe(404)
    expect((await raw('bob', 'GET', '/api/projects?manage=1')).text).not.toContain(projectId)
  })

  test('its shared chat link: the reason only to its members', async () => {
    for (const who of ['alice', 'erin']) {
      const r = await raw(who, 'GET', `/api/chats/${chatId}`)
      expect([r.status, r.json?.error?.params?.reason, r.json?.error?.params?.projectId]).toEqual([404, 'project_in_trash', projectId])
      expect(leaked(r.text)).toEqual([])
    }
    for (const who of ['bob', 'carol', 'dana']) {
      const r = await raw(who, 'GET', `/api/chats/${chatId}`)
      expect([r.status, r.json?.error?.params]).toEqual([404, undefined])
    }
  })

  test('restore: its creator yes, its other member and bob no; Files › Trash lists it for its creator only among them', async () => {
    const listed = async (who: string) => ((await raw(who, 'GET', '/api/files/trash')).json?.items ?? []).some((x: { id: string }) => x.id === trashId)
    expect([await listed('alice'), await listed('erin'), await listed('bob')]).toEqual([true, false, false])
    for (const who of ['erin', 'bob']) {
      expect((await raw(who, 'POST', `/api/projects/${projectId}/restore`)).status).toBeGreaterThanOrEqual(403)
      expect((await raw(who, 'POST', `/api/files/trash/${trashId}/restore`)).status).toBe(404)
    }
    // deleting it for good stays the owner's and admins'
    expect((await raw('alice', 'DELETE', `/api/files/trash/${trashId}`)).status).toBe(403)
    expect((await raw('alice', 'DELETE', `/api/projects/${projectId}`)).status).toBe(404)
    const back = await raw('alice', 'POST', `/api/projects/${projectId}/restore`)
    expect([back.status, back.json?.inTrash]).toEqual([200, false])
    // back: bob still reads none of it
    expect((await raw('bob', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`)).status).toBe(404)
    expect((await raw('erin', 'GET', `/api/files/content?path=${q(`${DIR}/plan.md`)}`)).status).toBe(200)
  })
})
