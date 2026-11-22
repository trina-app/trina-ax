// A team skill is found the same way in every place a member talks to the AI (the 2026-11-17 scenario catalog:
// SKL-01 and its variants). Covered, with the fake engine through the real launcher and gate: a member finds the team
// skill skills/quote-writer/SKILL.md by the words of its title and description (Korean, folder name in English) with
// find_skills, and loads it with the skill tool, in their own chat, in a shared project chat (its own code path:
// the chat's readers) and in a room's ✦ side chat (checked to be one; it runs the own-chat path); the same skill moved
// into a group (move_skill's target, groups/<folder>/skills/) is found by a member of that group in all three places
// (with group members only), and neither listed nor loaded for someone outside the group, in their own chat or in a
// shared project chat with a group member.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { groupFolder } from '../../server/src/admin/groups'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const tool = (name: string, args: unknown) => ({ tool: name, args, sayResult: true })
const QUOTE = '---\nname: quote-writer\ndescription: 거래처 견적서를 만들고 회사 직인을 찍는다. "견적서 만들어줘", "견적서에 도장 찍어줘" 같은 요청에 쓴다.\nmetadata:\n  title: 견적서 작성\n---\n\n# 견적서 작성\n\n- 회사 직인: `shared/도장/직인.png`\nQUOTE-STEPS-7c1\n'

let h: Harness
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), text) }

beforeAll(async () => {
  h = await startHarness({ name: 'b-skill-lookup-contexts' })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
})
afterAll(async () => { await h?.close() })

const answer = async (assistantId: string) => {
  await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(assistantId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 60_000 })
  const m = h.ctx.db.query('SELECT status, content, error FROM messages WHERE id = ?').get(assistantId) as { status: string; content: string; error: string | null }
  if (m.status !== 'done') throw new Error(`turn ended ${m.status}: ${m.error}`)
  return m.content
}
const send = async (user: string, chatId: string, content: string) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  return answer(r.assistantMessage.id)
}

/** the three places: my own chat, a shared project chat both people are in, a team room's ✦ side chat */
async function places(user: string, memberIds: string[]): Promise<Record<string, string>> {
  const own = (await h.api(user).call(API.createChat, { body: {} })).id
  const proj = await h.api(user).call(API.createProject, { body: { name: `견적 ${uuidv7().slice(-6)}`, instructions: '', participants: memberIds.filter((id) => id !== user).map((id) => ({ subjectType: 'user' as const, subjectId: id })) } })
  const projectChat = await h.api(user).call(API.createChat, { body: { projectId: proj.id } })
  // the places are what they say: a shared project chat, a side chat of this room
  expect(projectChat.shared).toBeTruthy()
  const project = projectChat.id
  const g = await h.api('dana').call(API.createGroup, { body: { name: `skill-room-${uuidv7().slice(-6)}`, memberIds } })
  const room = (await h.api(user).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!room) throw new Error('no team room')
  const sideChat = await h.api(user).call(API.createChat, { body: { sideRoomId: room.id } })
  expect(sideChat.sideRoomId).toBe(room.id)
  const side = sideChat.id
  return { own, project, side }
}

// one call per turn: in a Korean app a result said before the next call is interim narration and stays out of the
// answer (chat/narration.ts narrationScript), so each result is its own turn's answer
const lookup = async (user: string, chatId: string) => [
  await send(user, chatId, fake(tool('find_skills', { query: '견적서 작성' }))),
  await send(user, chatId, fake(tool('find_skills', { query: '견적서' }))),
  await send(user, chatId, fake(tool('skill', { name: 'quote-writer' }))),
]

describe('a member finds the team skill quote-writer in every place', () => {
  test('own chat, shared project chat, room side chat: find_skills names it, the skill tool loads it', async () => {
    put('skills/quote-writer/SKILL.md', QUOTE)
    try {
      const where = await places('bob', ['bob', 'alice'])
      for (const [place, chatId] of Object.entries(where)) {
        const [byTitle, byWord, loaded] = await lookup('bob', chatId)
        expect({ place, found: byTitle }).toEqual({ place, found: expect.stringContaining('- quote-writer "견적서 작성": 거래처 견적서를 만들고') })
        expect({ place, found: byTitle }).not.toEqual({ place, found: expect.stringContaining('No skill matches') })
        expect({ place, found: byWord }).toEqual({ place, found: expect.stringContaining('(skills/quote-writer/SKILL.md)') })
        expect({ place, loaded }).toEqual({ place, loaded: expect.stringContaining('QUOTE-STEPS-7c1') })
      }
    } finally { fs.rmSync(path.join(h.team, 'skills/quote-writer'), { recursive: true, force: true }) }
  })
})

describe('the same skill moved into a group', () => {
  test('a member of the group finds it in all three places; someone outside the group does not', async () => {
    // a group with a Korean name like the catalog's 영업, alice in it and bob not; its folder is groups/<name>/
    const g = await h.api('dana').call(API.createGroup, { body: { name: `영업-${uuidv7().slice(-4)}`, memberIds: ['alice'] } })
    const folder = groupFolder(h.ctx, g.id)!
    put(`${folder}/skills/quote-writer/SKILL.md`, QUOTE)
    try {
      // a project and a room of group members only (a shared chat with someone outside the group does not offer the
      // group's skill: its answers reach people the skill is not for)
      const where = await places('alice', ['alice'])
      for (const [place, chatId] of Object.entries(where)) {
        const [byTitle, , loaded] = await lookup('alice', chatId)
        expect({ place, found: byTitle }).toEqual({ place, found: expect.stringContaining(`(${folder}/skills/quote-writer/SKILL.md)`) })
        expect({ place, loaded }).toEqual({ place, loaded: expect.stringContaining('QUOTE-STEPS-7c1') })
      }
      // bob, outside the group: not listed, not loaded, in his own chat and in a shared project chat with alice
      const own = (await h.api('bob').call(API.createChat, { body: {} })).id
      const proj = await h.api('alice').call(API.createProject, { body: { name: `견적 ${uuidv7().slice(-6)}`, instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
      const shared = (await h.api('bob').call(API.createChat, { body: { projectId: proj.id } })).id
      for (const chatId of [own, shared]) {
        const [byTitle, , loaded] = await lookup('bob', chatId)
        expect(byTitle).not.toContain(`${folder}/skills/quote-writer`)
        expect(loaded).toContain('No skill called "quote-writer"')
        expect(loaded).not.toContain('QUOTE-STEPS-7c1')
      }
    } finally { fs.rmSync(path.join(h.team, folder, 'skills'), { recursive: true, force: true }) }
  })
})
