// S-118 (QA TC-b4s r118, TC-b3s-20/22): 박준호's chat was shared with 이서연 from its first answer, so that answer never
// read groups/영업 (a shared chat searches only places everyone in it opens). After an admin moved him to 마케팅 he asked
// "영업 폴더 단가표.xlsx 다시 열어서 A형 가격 확인해줘"; the AI searched shared and groups/마케팅, listed groups, and said
// it "could not find" the folder and asked for a path. No earlier read named the place, so lostAccessFor had nothing to
// say. Now a folder of a group the person left lately, which they named themselves in this chat, gets the fact on any
// search, listing or refusal of the answer: their access ended (their groups changed) and who can give it again; in a
// shared chat only that it cannot be opened from this chat. Through the real launcher with the fake engine.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import { spokenText, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { leftGroupPlaces, lostAccessFor, namesFolder } from '../../server/src/chat/tools'
import { TurnFiles } from '../../server/src/files/service'
import { leftGroupNote } from '../../server/src/policy/refusal'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const LINE = 'This user was in a group that opens'
const SHARED_LINE = 'cannot be opened from this chat now'

let h: Harness
const ws: Record<string, TestSocket> = {}
let groupId: string, dir: string, name: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-lost-access-left-group', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const g = await h.api('dana').call(API.createGroup, { body: { name: 'Salesleft', memberIds: ['alice', 'erin'] } })
  groupId = g.id
  dir = (h.ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(g.id) as { path: string }).path
  name = dir.split('/').pop()!
  fs.mkdirSync(path.join(h.team, dir), { recursive: true })
  fs.writeFileSync(path.join(h.team, dir, 'prices.md'), '| item | price |\n| A | 100 |\n')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const setMembers = (memberIds: string[]) => h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds } })
const newChat = async (user: string) => (await h.api(user).call(API.createChat, { body: {} })).id
async function ask(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  return spokenText(h, r.assistantMessage.id)
}
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('a folder of a group the person left, which they named in this chat', () => {
  test('never read in this chat: a search elsewhere and a listing of groups say the access ended, once a turn', async () => {
    const chat = await newChat('alice')
    await setMembers(['erin'])
    try {
      // TC-b4s: the searches named other folders, then groups was listed: the fact once in the answer
      const text = await ask('alice', chat, `open the ${name} folder price list again\n${fake(
        { tool: 'glob', args: { pattern: '**/*prices*', path: 'shared' }, sayResult: true },
        { tool: 'list', args: { path: 'groups' }, sayResult: true },
      )}`)
      expect(count(text, LINE)).toBe(1)
      expect(text).toContain(`'${dir}'`)
      expect(text).toContain('Who can give access again: an admin')
      expect(text).toContain('Do not ask them for a path')
      // a read of a file there: "not found or no access" gets the same fact (the next answer: once a turn again)
      const read = await ask('alice', chat, `read it\n${fake({ tool: 'read', args: { file_path: `${dir}/prices.md` }, sayResult: true })}`)
      expect(read).toContain('not found or no access')
      expect(read).toContain(LINE)
    } finally { await setMembers(['alice', 'erin']) }
  })

  test('a search about something else, or the name inside another word: nothing', async () => {
    const chat = await newChat('alice')
    await setMembers(['erin'])
    try {
      // she named the folder, but this answer's search was for something else, in another folder
      const text = await ask('alice', chat, `write the ${name} report\n${fake({ tool: 'glob', args: { pattern: '**/*minutes*', path: 'shared' }, sayResult: true })}`)
      expect(text).not.toContain(LINE)
    } finally { await setMembers(['alice', 'erin']) }
    expect(namesFolder('영업이익 보고서', '영업')).toBe(false)
  })

  test('not named by the person, back in the group, or never in it: nothing', async () => {
    const chat = await newChat('alice')
    await setMembers(['erin'])
    try {
      const text = await ask('alice', chat, `find the price list\n${fake({ tool: 'list', args: { path: 'groups' }, sayResult: true })}`)
      expect(text).not.toContain(LINE)
    } finally { await setMembers(['alice', 'erin']) }
    // back in it: the folder opens again, nothing to say
    const chat2 = await newChat('alice')
    const back = await ask('alice', chat2, `open the ${name} folder\n${fake({ tool: 'list', args: { path: 'groups' }, sayResult: true })}`)
    expect(back).not.toContain(LINE)
    // bob was never in it
    const rt = h.rt()
    const exec = { rt, spec: { userId: 'bob', chatId: chat2, locale: 'en' } } as unknown as Parameters<typeof leftGroupPlaces>[0]
    expect(leftGroupPlaces(exec, 'bob', () => true, () => false)).toEqual([])
  })

  test('a shared chat (others write in it): only that it cannot be opened from this chat, nobody\'s access named', async () => {
    const chat = await newChat('alice')
    await ask('alice', chat, `the ${name} price list\n${fake({ say: 'ok' })}`)
    await setMembers(['erin'])
    try {
      const rt = h.rt()
      const exec = { rt, spec: { userId: 'alice', chatId: chat, locale: 'en' }, files: new TurnFiles(), livePrincipal: () => rt.files.principal('alice'), otherAuthors: true } as unknown as Parameters<typeof lostAccessFor>[0]
      const noted = new Set<string>()
      const refused = 'Not searched: a search in this shared chat needs a folder. Name one of the folders everyone in this chat can open ("shared").'
      const n = lostAccessFor(exec, 'glob', true, { pattern: '**/prices*' }, refused, noted)
      expect(n).toContain(SHARED_LINE)
      // only the name she wrote, never the path
      expect(n).toContain(`the '${name}' folder`)
      expect(n).not.toContain(`'${dir}'`)
      expect(n).not.toContain(LINE)
      expect(n).toContain("never say that someone's access or groups changed")
      // once a turn
      expect(lostAccessFor(exec, 'list', false, { path: 'groups' }, '', noted)).toBeNull()
      // a refusal of something else (a file outside the folder): nothing
      expect(lostAccessFor(exec, 'read', true, { file_path: 'shared/x.md' }, "Access denied: not found or no access: 'shared/x.md'", new Set())).toBeNull()
      // a write tool's result is never a search: nothing
      expect(lostAccessFor(exec, 'write', false, { file_path: 'shared/x.md' }, 'Saved', new Set())).toBeNull()
    } finally { await setMembers(['alice', 'erin']) }
  })

  test('the note', () => {
    const n = leftGroupNote(h.ctx.db, ['groups/영업'], 'ko')
    expect(n).toContain('이 폴더는 이제 열 수 없어요. 부서가 바뀌어 접근 권한이 끝났어요')
    expect(n).toContain('This is a fact, not a guess')
    expect(n).toContain('Who can give access again: an admin')
    expect(n).toContain('Do not ask them for a path')
    // nothing was read there in this chat: no line about what was read
    expect(n).not.toContain('What earlier answers read')
    expect(n).not.toContain('Earlier in this chat')
    // a shared chat: who, never how ("adds them to the group" would say whose groups changed)
    const sh = leftGroupNote(h.ctx.db, ['groups/영업'], 'ko', { shared: true })
    expect(sh).toContain('Who can give access again: an admin; say only who')
    expect(sh).not.toContain('adds them to the group')
  })

  test('the folder named as a word of its own', () => {
    expect(namesFolder('영업 폴더 단가표.xlsx 다시 열어서', '영업')).toBe(true)
    expect(namesFolder('영업에서 받은 단가표', '영업')).toBe(true)
    expect(namesFolder('영업팀 자료', '영업')).toBe(true)
    expect(namesFolder('다음 영업일까지 보내줘', '영업')).toBe(false)
    expect(namesFolder('인사말 써줘', '인사')).toBe(false)
    expect(namesFolder('open the sales folder', 'sales')).toBe(true)
    expect(namesFolder('presales deck', 'sales')).toBe(false)
  })
})
