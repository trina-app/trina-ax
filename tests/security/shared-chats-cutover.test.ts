// No new hidden answers, with the cutover in the past (docs/DECISIONS.md "People who see a shared chat later: nothing
// new is hidden", security review of #813). A shared project chat on projects/falcon (alice writes it, the finance group
// with bob reads it; gina joins finance later and cannot read groups/marketing):
// - in bob's chat an older answer no card covered (alice read groups/marketing while bob was out of the project) stays
//   hidden from bob in search, export and his AI's transcript; a newer one read the same way shows;
// - a newer answer whose record says "not all known" (x, as a chat shared later writes for memories or an unknown scope)
//   stays with its own people: a later reader does not get it;
// - GET …/messages?through= (the widening list's link) shows another branch only for an answer of this chat the caller
//   sees: an answer of another chat, an answer hidden from the caller, a person's message id: the active branch.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Message } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { WITHHELD_ANSWER } from '../../server/src/chat/shared'
import { setHiddenAnswersCutover, withheldFrom } from '../../server/src/chat/shared-answers'
import { runExport } from '../../server/src/system/export'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const BRIEF = 'groups/marketing/campaign-brief.md'
const CANARY = 'Autumn Upgrade'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
let chatId: string, oldId: string, oldQuestion: string, newId: string, otherChatAnswer: string
beforeAll(async () => {
  h = await startHarness({ name: 'sec-shared-cutover', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('gina', 'gina', 'Gina Han', 'member')").run()
  addTestPerson('gina', { id: 'gina', name: 'Gina Han', role: 'member', locale: 'en' })
  for (const u of ['alice', 'bob', 'gina']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  setHiddenAnswersCutover(h.ctx.db, '9999-12-31T00:00:00.000Z')
  // bob's chat (his export holds it)
  chatId = (await h.api('bob').call(API.createChat, { body: { projectId } })).id
  await ask('bob', chatId, 'start\n' + fake({ say: 'BOB-START' }))
  // bob out of the project while alice reads the brief: no card, an older answer no card covered
  out('bob')
  try {
    const r = await ask('alice', chatId, 'old\n' + fake({ tool: 'read', args: { file_path: BRIEF }, sayResult: true }))
    oldId = r.done.id
    oldQuestion = r.started.userMessage!.id
  } finally { back('bob') }
  // the cutover now: from here on nothing new is hidden
  await Bun.sleep(5)
  setHiddenAnswersCutover(h.ctx.db, new Date().toISOString())
  await Bun.sleep(5)
  out('bob')
  try { newId = (await ask('alice', chatId, 'again\n' + fake({ tool: 'read', args: { file_path: BRIEF } }, { say: 'NEWWORDS-77' }))).done.id }
  finally { back('bob') }
  const other = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
  otherChatAnswer = (await ask('alice', other, 'elsewhere\n' + fake({ say: 'OTHER-CHAT' }))).done.id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
function out(u: string) { db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = ?").run(u) }
function back(u: string) { db().query("INSERT OR IGNORE INTO group_members VALUES ('finance', ?)").run(u) }
const send = (user: string, id: string, content: string) => h.api(user).call(API.sendMessage, { params: { id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
async function ask(user: string, id: string, content: string) {
  const started = await send(user, id, content)
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  await waitFor(() => !h.rt().activeTurn(id), { timeoutMs: 15_000 })
  return { started, done: done.data.message as Message }
}
const page = async (user: string, through?: string): Promise<Message[]> =>
  (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: through ? { through } : {} })).items
const found = async (user: string, q: string) => (await h.api(user).call(API.listChats, { query: { projectId, q } })).items.map((c) => c.id)

describe('the cutover in the past', () => {
  test('the older uncovered answer stays hidden from bob; the newer one shows', async () => {
    const items = await page('bob')
    expect(items.find((m) => m.id === oldId)).toMatchObject({ withheld: true, content: '' })
    expect(items.find((m) => m.id === newId)?.content).toContain('NEWWORDS-77')
    expect(withheldFrom(db(), h.ctx.files.rules(), chatId, 'bob')).toEqual(new Set([oldId]))
  })

  test('search: the older answer\'s words never count for bob; the newer one\'s do', async () => {
    expect(await found('bob', 'Autumn')).not.toContain(chatId)
    expect(await found('bob', 'NEWWORDS-77')).toContain(chatId)
    expect(await found('alice', 'Autumn')).toContain(chatId)
  })

  test("export: the line in the older answer's place, the newer answer as it is", async () => {
    const outFile = await runExport(db(), h.team, { ownerId: 'bob', locale: 'en', what: ['chats'], sharedVisible: () => true, sharedWithheld: (id) => withheldFrom(db(), h.ctx.files.rules(), id, 'bob') })
    const text = Buffer.from(Bun.zstdDecompressSync(fs.readFileSync(path.join(h.team, outFile.path)))).toString('utf8')
    expect(text).not.toContain(CANARY)
    expect(text).toContain('NEWWORDS-77')
  })

  test("bob's own AI: the older answer is the line, the newer one is there", async () => {
    const r = await ask('bob', chatId, fake({ echo: 'system' }))
    expect(r.done.content).toContain(WITHHELD_ANSWER)
    expect(r.done.content).not.toContain(CANARY)
    expect(r.done.content).toContain('NEWWORDS-77')
  })

  test('a newer answer whose record is not all known (x) stays with its own people', async () => {
    db().query('UPDATE shared_answer_reads SET reads = ? WHERE message_id = ?').run(JSON.stringify([{ c: ['alice', 'bob'], s: [], x: 1 }]), newId)
    back('gina')
    try {
      expect((await page('gina')).find((m) => m.id === newId)).toMatchObject({ withheld: true, content: '' })
      expect((await page('bob')).find((m) => m.id === newId)?.withheld).toBeUndefined()
    } finally {
      out('gina')
      db().query('UPDATE shared_answer_reads SET reads = ? WHERE message_id = ?').run('[]', newId)
    }
  })
})

describe('?through= (the widening list\'s link)', () => {
  test('another branch only for an answer of this chat the caller sees; otherwise the active branch', async () => {
    // alice edits her first question: the older answer is on a branch that is not the active one
    const edited = await h.api('alice').call(API.editMessage, { params: { id: chatId, messageId: oldQuestion }, body: { content: 'edited\n' + fake({ say: 'EDITED' }), clientMessageId: cm(), attachmentIds: [] } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === edited.assistantMessage.id, 30_000)
    await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
    const active = (await page('bob')).map((m) => m.id)
    expect(active).toContain(edited.assistantMessage.id)
    expect(active).not.toContain(oldId)
    // alice ran it: her view goes to its branch
    expect((await page('alice', oldId)).map((m) => m.id)).toContain(oldId)
    // hidden from bob: the active branch, nothing of it
    const hidden = await page('bob', oldId)
    expect(hidden.map((m) => m.id)).toEqual(active)
    expect(JSON.stringify(hidden)).not.toContain(CANARY)
    // a person's message id, an answer of another chat, a made-up id: the active branch
    expect((await page('bob', oldQuestion)).map((m) => m.id)).toEqual(active)
    expect((await page('bob', otherChatAnswer)).map((m) => m.id)).toEqual(active)
    expect((await page('bob', crypto.randomUUID().replace(/^(.{14})./, '$17'))).map((m) => m.id)).toEqual(active)
    // the chat's active branch did not change for anyone
    expect((await page('alice')).map((m) => m.id)).toEqual(active)
  })
})
