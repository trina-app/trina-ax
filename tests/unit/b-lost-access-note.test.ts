// S-118 (scenario QA 11-22): 박준호 read the price list in groups/영업 in his chat, an admin moved him to 마케팅, and the
// next answer said "영업 폴더는 목록에도 보이지 않았습니다", asked for a path and called the price it had read earlier
// unverified. Now a file tool's "not found or no access" on a place this person's own earlier answers in the chat read
// (chat_reads), and that the folder rules no longer let them read, gets one line: the access ended, who can give it
// again, and what was read stays true. A search whose scope covers such a place says it once a turn. Never for a place
// they never read, nor for another member's reads in a shared chat. Through the real launcher with the fake engine.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { carriedReads, saveReads } from '../../server/src/chat/carried-reads'
import { lostAccessFor } from '../../server/src/chat/tools'
import { TurnFiles } from '../../server/src/files/service'
import { lostAccessNote } from '../../server/src/policy/refusal'
import { KEEP_VERIFIED_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const LINE = 'Earlier in this chat this user opened'

let h: Harness
const ws: Record<string, TestSocket> = {}
let groupId: string, dir: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-lost-access-note', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const g = await h.api('dana').call(API.createGroup, { body: { name: 'Sales lost', memberIds: ['alice', 'erin'] } })
  groupId = g.id
  dir = (h.ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(g.id) as { path: string }).path
  fs.mkdirSync(path.join(h.team, dir), { recursive: true })
  fs.writeFileSync(path.join(h.team, dir, 'prices.md'), '| item | price |\n| A | 100 |\n| B | 150 |\n')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const setMembers = (memberIds: string[]) => h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds } })
const newChat = async (user: string) => (await h.api(user).call(API.createChat, { body: {} })).id
async function ask(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  return { text: done.data.message.content as string, assistantId: r.assistantMessage.id as string }
}
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('a place read earlier in this chat, no longer open', () => {
  test('a refused read says the access ended (not "not in your list"); a search covering it says so once a turn', async () => {
    const chat = await newChat('alice')
    await ask('alice', chat, `quote from the price list\n${fake({ tool: 'read', args: { file_path: `${dir}/prices.md` } }, { say: 'B is 150' })}`)
    await setMembers(['erin'])
    try {
      const again = await ask('alice', chat, `add the B price too\n${fake({ tool: 'read', args: { file_path: `${dir}/prices.md` }, sayResult: true })}`)
      // the very file read before: the file service's own fact (files/moved.ts), and what was read stays true
      expect(again.text).toContain('but this person can no longer open it')
      expect(again.text).toContain('Do not ask them for a path')
      expect(again.text).toContain('do not take it back or call it unverified')
      expect(again.text).not.toContain(LINE)
      // a file in the same group folder: the line, with who can give access again
      const near = await ask('alice', chat, `and the B sheet\n${fake({ tool: 'read', args: { file_path: `${dir}/b.md` }, sayResult: true })}`)
      expect(near.text).toContain(`${LINE} '${dir}'`)
      expect(near.text).toContain('Admin › Groups')
      expect(near.text).toContain('do not take it back or call it unverified')
      // another file in the same group folder (one that never existed): the same line, decided on the rules alone
      const other = await ask('alice', chat, `and the old list\n${fake({ tool: 'read', args: { file_path: `${dir}/never-there.md` }, sayResult: true })}`)
      expect(other.text).toContain(`${LINE} '${dir}'`)
      // two searches of the whole team folder in one turn: the line once
      const found = await ask('alice', chat, `find it\n${fake({ tool: 'glob', args: { pattern: '**/prices*' }, sayResult: true }, { tool: 'grep', args: { pattern: 'price' }, sayResult: true })}`)
      expect(count(found.text, LINE)).toBe(1)
      // a search elsewhere (alice's own folder): no line
      const mine = await ask('alice', chat, `in my folder\n${fake({ tool: 'glob', args: { pattern: '*', path: 'users/alice' }, sayResult: true })}`)
      expect(mine.text).not.toContain(LINE)
    } finally { await setMembers(['alice', 'erin']) }
  })

  test('a place never read in this chat: the plain answer, no line', async () => {
    const chat = await newChat('alice')
    await ask('alice', chat, `hi\n${fake({ say: 'hello' })}`)
    await setMembers(['erin'])
    try {
      const r = await ask('alice', chat, `read the price list\n${fake({ tool: 'read', args: { file_path: `${dir}/prices.md` }, sayResult: true })}`)
      expect(r.text).toContain('not found or no access')
      expect(r.text).not.toContain(LINE)
    } finally { await setMembers(['alice', 'erin']) }
  })

  test('still open: a missing file there gets no line', async () => {
    const chat = await newChat('alice')
    await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: `${dir}/prices.md` } }, { say: 'ok' })}`)
    const r = await ask('alice', chat, `the other one\n${fake({ tool: 'read', args: { file_path: `${dir}/gone.md` }, sayResult: true })}`)
    expect(r.text).not.toContain(LINE)
  })

  test("another member's read in a shared chat never counts as this person's", async () => {
    const chat = await newChat('alice')
    const a = await ask('alice', chat, `hi\n${fake({ say: 'hello' })}`)
    // erin's turn in the same chat read the price list (her row, not alice's)
    saveReads(h.ctx.db, { chatId: chat, messageId: a.assistantId, userId: 'erin' }, new Map([[`${dir}/prices.md`, 'x'.repeat(64)]]), new Map())
    await setMembers([])
    try {
      const rt = h.rt()
      const exec = (userId: string) => {
        const files = new TurnFiles()
        files.carried = carriedReads(h.ctx.db, rt.files, { chatId: chat, userId, answers: [a.assistantId] })
        return { rt, spec: { userId, locale: 'en' }, files, livePrincipal: () => rt.files.principal(userId) } as unknown as Parameters<typeof lostAccessFor>[0]
      }
      const denied = `Access denied: not found or no access: '${dir}/prices.md'`
      expect(lostAccessFor(exec('alice'), 'read', true, { file_path: `${dir}/prices.md` }, denied, new Set())).toBeNull()
      expect(lostAccessFor(exec('alice'), 'glob', false, { pattern: '*' }, 'No files found', new Set())).toBeNull()
      // erin herself gets it
      expect(lostAccessFor(exec('erin'), 'read', true, { file_path: `${dir}/prices.md` }, denied, new Set())).toContain(`${LINE} '${dir}'`)
      // a search whose path is another folder: nothing; one inside the place: the line, then not again this turn
      const noted = new Set<string>()
      expect(lostAccessFor(exec('erin'), 'grep', false, { pattern: 'x', path: 'shared' }, '', noted)).toBeNull()
      expect(lostAccessFor(exec('erin'), 'grep', false, { pattern: 'x', path: `${dir}/sub` }, '', noted)).toContain(LINE)
      expect(lostAccessFor(exec('erin'), 'glob', false, { pattern: '**/*' }, '', noted)).toBeNull()
    } finally { await setMembers(['alice', 'erin']) }
  })

  test('losing only a folder inside shared/ names that folder (shared/ itself still opens)', async () => {
    const chat = await newChat('alice')
    const a = await ask('alice', chat, `hi\n${fake({ say: 'hello' })}`)
    fs.mkdirSync(path.join(h.team, 'shared', '재무'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'shared', '재무', 'budget.md'), '# budget\n')
    saveReads(h.ctx.db, { chatId: chat, messageId: a.assistantId, userId: 'alice' }, new Map([['shared/재무/budget.md', 'y'.repeat(64)]]), new Map())
    const rt = h.rt()
    const files = new TurnFiles()
    files.carried = carriedReads(h.ctx.db, rt.files, { chatId: chat, userId: 'alice', answers: [a.assistantId] })
    const exec = { rt, spec: { userId: 'alice', locale: 'en' }, files, livePrincipal: () => rt.files.principal('alice') } as unknown as Parameters<typeof lostAccessFor>[0]
    const denied = "Access denied: not found or no access: 'shared/재무/other.md'"
    // still open: nothing
    expect(lostAccessFor(exec, 'read', true, { file_path: 'shared/재무/other.md' }, denied, new Set())).toBeNull()
    h.ctx.db.query("INSERT INTO folders (id, path, limited) VALUES ('lost-shared-fin', 'shared/재무', 1)").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('lost-shared-fin-none', 'lost-shared-fin', 'everyone', NULL, 'none')").run()
    try {
      const note = lostAccessFor(exec, 'read', true, { file_path: 'shared/재무/other.md' }, denied, new Set())
      expect(note).toContain(`${LINE} 'shared/재무'`)
      // a file elsewhere in shared/ (still open to her): no line
      expect(lostAccessFor(exec, 'read', true, { file_path: 'shared/notes.md' }, "Access denied: not found or no access: 'shared/notes.md'", new Set())).toBeNull()
    } finally {
      h.ctx.db.query("DELETE FROM folder_rules WHERE id = 'lost-shared-fin-none'").run()
      h.ctx.db.query("DELETE FROM folders WHERE id = 'lost-shared-fin'").run()
    }
  })

  test('the note and the prompt rule', () => {
    const n = lostAccessNote(h.ctx.db, ['groups/영업'], 'ko')
    expect(n).toContain('이 폴더는 더 이상 열 수 없어요 (권한이 바뀌었거나 옮겨졌어요)')
    expect(n).toContain('An admin can give access again')
    expect(n).not.toMatch(/does not exist|was deleted/)
    expect(KEEP_VERIFIED_RULE).toContain('do not take back or call unverified what you read')
  })
})
