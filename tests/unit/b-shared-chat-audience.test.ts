// People who see a shared project chat later (docs/DECISIONS.md "People who see a shared chat later"): an answer stays
// visible to its runner, to the people who saw the chat when it read what it used, and to anyone who may read those
// places now; everyone else gets one line in its place and nothing of it anywhere. The project is on projects/falcon:
// alice writes it, the finance group (bob) reads it, carol (admin) and dana (owner) see everything. gina (finance, added
// here) joins later and cannot read groups/marketing; erin (marketing) gets the project later and reads it. Covered: a
// confirmed read and a read nobody had to confirm, the covered viewer, the viewer who reads the place, an answer built
// on a hidden one, a later reader continuing the chat (nothing hidden reaches their engine, and their answer is not
// hidden from the others), search, the sources list, artifacts, export, older answers, a missing record, and a
// group's skill in a shared chat (members only, as in a room).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { addTestPerson } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { recordOlderAnswers, WITHHELD_ANSWER } from '../../server/src/chat/shared'
import { answerRecord, withheldFrom } from '../../server/src/chat/shared-answers'
import { runExport } from '../../server/src/system/export'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const BRIEF = 'groups/marketing/campaign-brief.md'
const CANARY = 'Autumn Upgrade'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-audience', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('gina', 'gina', 'Gina Han', 'member')").run()
  addTestPerson('gina', { id: 'gina', name: 'Gina Han', role: 'member', locale: 'en' })
  for (const u of ['alice', 'bob', 'carol', 'erin', 'gina']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return { started, done: done.data.message }
}
async function askWithCard(user: string, chatId: string, content: string, value: 'share' | 'skip') {
  const started = await send(user, chatId, content)
  const card = await ws[user]!.next('turn.request', (f) => f.data.turnId === started.turnId, 15_000)
  await h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: value } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return { started, card: card.data.request as { question: string }, done: done.data.message }
}
const messages = async (user: string, chatId: string): Promise<Message[]> => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items
const answerFor = async (user: string, chatId: string, id: string) => (await messages(user, chatId)).find((m) => m.id === id)!
const found = async (user: string, q: string) => (await h.api(user).call(API.listChats, { query: { projectId, q } })).items.map((c) => c.id)

/** gina joins the finance group (so the project: finance reads it), or leaves it */
const join = () => db().query("INSERT OR IGNORE INTO group_members VALUES ('finance', 'gina')").run()
const leave = () => db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'gina'").run()
/** erin gets the project (she reads groups/marketing already) */
const erinJoins = () => db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('aud-erin', 'f_projects_falcon', 'user', 'erin', 'read')").run()
const erinLeaves = () => db().query("DELETE FROM folder_rules WHERE id = 'aud-erin'").run()

/** what a hidden answer shows: its place, nothing of it */
const shell = (m: Message) => ({ withheld: m.withheld, content: m.content, steps: m.steps, files: m.files, model: m.model, sourceCount: m.sourceCount, error: m.error })
const HIDDEN = { withheld: true as const, content: '', steps: [], files: null, model: null, sourceCount: undefined, error: null }

describe('a read the card confirmed', () => {
  let chatId: string, answerId: string, questionId: string
  beforeAll(async () => {
    chatId = (await newShared()).id
    // four people see the chat; bob cannot read groups/marketing: the card, and alice says yes
    const r = await askWithCard('alice', chatId, fake({ tool: 'read', args: { file_path: BRIEF }, sayResult: true }), 'share')
    expect(r.card.question).toContain('Of the 4 people in the project who see this chat, 1 cannot see this place')
    expect(r.done.content).toContain(CANARY)
    answerId = r.done.id
    questionId = r.started.userMessage!.id
    join()
  })
  afterAll(() => { leave(); erinLeaves() })

  test('a later reader who cannot read the place gets one line in its place; the question stays', async () => {
    expect((await h.api('gina').call(API.getChat, { params: { id: chatId } })).shared?.audience).toBe(5)
    const forGina = await messages('gina', chatId)
    expect(forGina.find((m) => m.id === questionId)!.content).toContain(BRIEF)
    expect(shell(forGina.find((m) => m.id === answerId)!)).toEqual(HIDDEN)
    expect(JSON.stringify(forGina)).not.toContain(CANARY)
  })

  test('the people the card covered keep it (bob cannot read the place); its runner too; a later reader who reads the place sees it', async () => {
    expect((await answerFor('bob', chatId, answerId)).content).toContain(CANARY)
    expect((await answerFor('alice', chatId, answerId)).content).toContain(CANARY)
    erinJoins()
    try {
      const forErin = await answerFor('erin', chatId, answerId)
      expect(forErin.withheld).toBeUndefined()
      expect(forErin.content).toContain(CANARY)
    } finally { erinLeaves() }
  })

  test('search finds it only by what the person sees; the sources list and artifacts of the hidden answer are empty for them', async () => {
    expect(await found('bob', 'Autumn')).toContain(chatId)
    expect(await found('gina', 'Autumn')).not.toContain(chatId)
    // the question is everyone's to find
    expect(await found('gina', 'campaign-brief')).toContain(chatId)
    // every word must be found through what the person sees: a word of the hidden answer does not count
    expect(await found('bob', 'campaign-brief Autumn')).toContain(chatId)
    expect(await found('gina', 'campaign-brief Autumn')).not.toContain(chatId)
    expect(await found('gina', 'Autumn campaign-brief')).not.toContain(chatId)
    expect(await h.api('gina').call(API.messageSources, { params: { id: chatId, messageId: answerId } })).toEqual({ files: [], unavailable: 0 })
    const forBob = await h.api('bob').call(API.messageSources, { params: { id: chatId, messageId: answerId } })
    expect(forBob.unavailable + forBob.files.length).toBeGreaterThan(0)
  })

  test('a later reader continues the chat: nothing of the hidden answer reaches their engine, and their answer is not hidden from the others', async () => {
    const r = await ask('gina', chatId, fake({ echo: 'system' }))
    expect(r.done.content).toContain(WITHHELD_ANSWER)
    expect(r.done.content).not.toContain(CANARY)
    // her answer records that the hidden one was not in its context
    expect(answerRecord(db(), r.done.id)!.left).toEqual([answerId])
    expect((await answerFor('bob', chatId, r.done.id)).withheld).toBeUndefined()
    expect((await answerFor('carol', chatId, r.done.id)).withheld).toBeUndefined()
    // bob (covered) asks next: his engine had alice's answer, so his answer is hidden from gina, not from erin
    const b = await ask('bob', chatId, 'summary?\n' + fake({ say: 'BOB-SUMMARY' }))
    expect(b.done.content).toBe('BOB-SUMMARY')
    expect(shell(await answerFor('gina', chatId, b.done.id))).toEqual(HIDDEN)
    erinJoins()
    try { expect((await answerFor('erin', chatId, b.done.id)).content).toBe('BOB-SUMMARY') } finally { erinLeaves() }
    // and gina's next answer, built on hers and bob's, keeps both out of her engine
    const again = await ask('gina', chatId, fake({ echo: 'system' }))
    // (the two hidden answers, and her own earlier answer, which echoed the first line)
    expect(again.done.content.split(WITHHELD_ANSWER).length - 1).toBe(3)
    expect(again.done.content).not.toContain(CANARY)
    expect(answerRecord(db(), again.done.id)!.left.sort()).toEqual([answerId, b.done.id].sort())
    expect((await answerFor('bob', chatId, again.done.id)).withheld).toBeUndefined()
  })
})

describe('a read nobody had to confirm', () => {
  test('everyone who saw the chat read the place: a later reader who cannot read it gets the line', async () => {
    // bob is out of the project for a moment: alice, carol and dana all read groups/marketing, no card
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    let chatId: string, answerId: string
    try {
      chatId = (await newShared()).id
      const r = await ask('alice', chatId, fake({ tool: 'read', args: { file_path: BRIEF }, sayResult: true }))
      expect(r.done.content).toContain(CANARY)
      answerId = r.done.id
    } finally { db().query("INSERT INTO group_members VALUES ('finance', 'bob')").run() }
    expect(shell(await answerFor('bob', chatId, answerId))).toEqual(HIDDEN)
    expect((await answerFor('carol', chatId, answerId)).content).toContain(CANARY)
    expect(withheldFrom(db(), h.ctx.files.rules(), chatId, 'bob').has(answerId)).toBe(true)
  })

  test('an answer that read only what everyone may read stays visible to a later reader', async () => {
    const chatId = (await newShared()).id
    const r = await ask('alice', chatId, fake({ tool: 'read', args: { file_path: 'projects/falcon/plan.md' }, sayResult: true }))
    join()
    try { expect((await answerFor('gina', chatId, r.done.id)).withheld).toBeUndefined() } finally { leave() }
  })
})

describe('around the transcript', () => {
  test('artifacts of a hidden answer: not listed, not opened, and an update by the later reader finds nothing', async () => {
    const chatId = (await newShared()).id
    const r = await askWithCard('alice', chatId, fake({ tool: 'read', args: { file_path: BRIEF } }, { tool: 'artifact', args: { action: 'create', key: 'brief', type: 'markdown', title: 'ART-TITLE', content: `# ${CANARY}` } }, { say: 'made' }), 'share')
    expect(r.done.content).toBe('made')
    const art = (await h.api('bob').call(API.listChatArtifacts, { params: { id: chatId } })).items
    expect(art.map((a) => a.key)).toEqual(['brief'])
    const artId = art[0]!.versions[0]!.id
    join()
    try {
      expect((await h.api('gina').call(API.listChatArtifacts, { params: { id: chatId } })).items).toEqual([])
      expect((await errOf(h.api('gina').call(API.getArtifact, { params: { id: artId } }))).status).toBe(404)
      const g = await ask('gina', chatId, fake({ tool: 'artifact', args: { action: 'update', key: 'brief', type: 'markdown', edits: [{ old: 'Autumn', new: 'x' }] }, sayResult: true }, { tool: 'artifact', args: { action: 'create', key: 'brief', type: 'markdown', content: 'GINA-OWN' } }, { say: 'ok' }))
      expect(g.done.status).toBe('done')
      // the update finds nothing (the same words as for a key that is not there)
      expect(g.done.content).toContain("no artifact with key 'brief' in this chat yet")
      const mine = (await h.api('gina').call(API.listChatArtifacts, { params: { id: chatId } })).items
      // her own version only, without the hidden one's title
      expect(mine.map((a) => a.versions.map((v) => [v.version, v.title]))).toEqual([[[2, null]]])
      const steps = JSON.stringify(g.done.steps)
      expect(steps).not.toContain('ART-TITLE')
      expect(h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'artifact' ORDER BY id").all(g.started.turnId)).toHaveLength(2)
      // bob, whom the card covered, sees both versions; gina's own stays hers to see too
      expect((await h.api('bob').call(API.listChatArtifacts, { params: { id: chatId } })).items[0]!.versions.map((v) => v.version)).toEqual([2, 1])
    } finally { leave() }
  })

  test('an artifact version built on a hidden one on another branch is hidden too (it may carry its content)', async () => {
    const chatId = (await newShared()).id
    const first = await askWithCard('alice', chatId, fake({ tool: 'read', args: { file_path: BRIEF } }, { tool: 'artifact', args: { action: 'create', key: 'brief', type: 'markdown', title: 'XB-TITLE', content: 'XB-BODY' } }, { say: 'made' }), 'share')
    // alice edits her first question: a new branch, whose answer reads nothing and updates the key (v2 holds v1's text)
    const edited = await h.api('alice').call(API.editMessage, { params: { id: chatId, messageId: first.started.userMessage!.id }, body: { content: fake({ tool: 'artifact', args: { action: 'update', key: 'brief', type: 'markdown', edits: [{ old: 'XB-BODY', new: 'XB-BODY v2' }] } }, { say: 'updated' }), clientMessageId: cm(), attachmentIds: [] } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === edited.assistantMessage.id, 30_000)
    await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
    const all = (await h.api('carol').call(API.listChatArtifacts, { params: { id: chatId } })).items[0]!.versions
    expect(all.map((v) => [v.version, v.title])).toEqual([[2, 'XB-TITLE'], [1, 'XB-TITLE']])
    join()
    try {
      // the answer of the new branch is not hidden from gina, its artifact version is
      expect((await answerFor('gina', chatId, edited.assistantMessage.id)).withheld).toBeUndefined()
      expect((await h.api('gina').call(API.listChatArtifacts, { params: { id: chatId } })).items).toEqual([])
      for (const v of all) expect((await errOf(h.api('gina').call(API.getArtifact, { params: { id: v.id } }))).status).toBe(404)
    } finally { leave() }
  })

  test("export: the creator's own shared chat with an answer hidden from them has the line in its place", async () => {
    // bob makes the chat, is out of the project while alice reads marketing (no card: alice, carol, dana read it)
    const chatId = (await newShared('bob')).id
    await ask('bob', chatId, 'start\n' + fake({ say: 'BOB-START' }))
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try { await ask('alice', chatId, fake({ tool: 'read', args: { file_path: BRIEF }, sayResult: true })) }
    finally { db().query("INSERT INTO group_members VALUES ('finance', 'bob')").run() }
    const out = await runExport(db(), h.team, { ownerId: 'bob', locale: 'ko', what: ['chats'], sharedVisible: () => true, sharedWithheld: (id) => withheldFrom(db(), h.ctx.files.rules(), id, 'bob') })
    const text = Buffer.from(Bun.zstdDecompressSync(fs.readFileSync(path.join(h.team, out.path)))).toString('utf8')
    const LINE = '(볼 수 없는 자료를 참고한 답이라 가려졌어요)'
    // his own answer as it is, alice's as the line
    expect(text).toContain('\n\nBOB-START\n')
    expect(text).not.toContain(CANARY)
    expect(text.split(LINE).length - 1).toBe(1)
    // without the check, every answer of a shared chat is the line
    const none = await runExport(db(), h.team, { ownerId: 'bob', locale: 'ko', what: ['chats'], sharedVisible: () => true })
    const all = Buffer.from(Bun.zstdDecompressSync(fs.readFileSync(path.join(h.team, none.path)))).toString('utf8')
    expect(all).not.toContain('\n\nBOB-START\n')
    expect(all.split(LINE).length - 1).toBe(2)
  })

  test('older answers (no record): hidden from everyone but their runner until recorded at start, then seen by who sees the chat then', async () => {
    const chatId = (await newShared()).id
    const r = await ask('alice', chatId, 'old\n' + fake({ say: 'OLD-ANSWER' }))
    db().query('DELETE FROM shared_answer_reads WHERE message_id = ?').run(r.done.id)
    // fails closed: no record, nobody but its runner
    expect(shell(await answerFor('bob', chatId, r.done.id))).toEqual(HIDDEN)
    expect((await answerFor('alice', chatId, r.done.id)).content).toBe('OLD-ANSWER')
    expect(recordOlderAnswers(db(), h.ctx.files)).toBeGreaterThanOrEqual(1)
    expect((await answerFor('bob', chatId, r.done.id)).content).toBe('OLD-ANSWER')
    // what it read is not known: a later reader does not see it, even one who reads everything the project has
    join()
    try { expect(shell(await answerFor('gina', chatId, r.done.id))).toEqual(HIDDEN) } finally { leave() }
    erinJoins()
    try { expect((await answerFor('erin', chatId, r.done.id)).withheld).toBe(true) } finally { erinLeaves() }
    // a second start changes nothing
    expect(recordOlderAnswers(db(), h.ctx.files)).toBe(0)
  })
})

describe("a group's skills in a shared chat are its members' only (as in a room)", () => {
  test('not on the list while someone who sees the chat is not in the group; loading it asks with its own words', async () => {
    // a group of alice and erin, its folder groups/<name>/ (the owner and admins read it too), a project on that folder
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'Brief team', memberIds: ['alice', 'erin'] } })
    const folder = (db().query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(g.id) as { path: string }).path
    const abs = path.join(h.team, folder, 'skills/brief-writer.md')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '---\nname: GROUP-BRIEF-SKILL\ndescription: write a brief\n---\nGROUP-SKILL-BODY-55\n')
    const p = await oldProject(h, 'alice', { name: 'Briefs', folderPath: folder, instructions: '' })
    await h.api('alice').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    // alice, erin, carol and dana see it; carol and dana read the folder but are not in the group
    expect(chat.shared?.audience).toBe(4)
    const sys = await ask('alice', chat.id, fake({ echo: 'system' }))
    expect(sys.done.content).not.toContain('GROUP-BRIEF-SKILL')
    const r = await askWithCard('alice', chat.id, fake({ tool: 'skill', args: { name: 'GROUP-BRIEF-SKILL' }, sayResult: true }), 'skip')
    expect(r.card.question).toContain('The AI wants to use a skill in')
    expect(r.card.question).toContain('Of the 4 people in the project who see this chat, 2 cannot use this skill')
    expect(r.done.content).not.toContain('GROUP-SKILL-BODY-55')
    const yes = await askWithCard('alice', chat.id, fake({ tool: 'skill', args: { name: 'GROUP-BRIEF-SKILL' }, sayResult: true }), 'share')
    expect(yes.done.content).toContain('GROUP-SKILL-BODY-55')
    // a "/name" run asks the same
    const cmd = await askWithCard('alice', chat.id, '/GROUP-BRIEF-SKILL\n' + fake({ echo: 'message' }), 'skip')
    expect(cmd.done.content).not.toContain('GROUP-SKILL-BODY-55')
  })
})
