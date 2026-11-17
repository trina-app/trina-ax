// Where the AI saves new content, and what it says about who can open it (docs/decisions/20261117-ai-save-my-files-default.md,
// QA TC-4792, MAN-026/MAN-027). In a 3-person room's side chat the AI saved a summary to Company-wide › Meeting notes
// (10 people), the card said "read content fewer people can see (…)", and the answer claimed "everyone in the room can
// open it". Covered here, through the fake engine and the real gate:
// - the instructions: new content goes to the person's own folder (My files, users/<id>/) unless they or the task name
//   a place; Company-wide is not picked because the content looks like it belongs there; not for a guest;
// - a save to My files: no card, and the result's audience line says only the user can open it;
// - a place the person names is honoured, and after a room read the wider-audience card still asks, in plain words with
//   the counts of the source and of the place; a "no" saves nothing;
// - in a ✦ side chat the audience line counts the room's people from the real folder (all of them / some, and how many
//   outside the room), never from the room.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { labeledPath } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { folderPurposeLines, saveNewPlaceRule } from '../../server/src/chat/prompt'
import { audienceWords, saveAudienceNote } from '../../server/src/chat/save-audience'
import { tr } from '../../server/src/chat/i18n'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const W = (p: string) => labeledPath(p.replace(/\/+$/, ''), 'en', 'alice', ' › ')

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-ai-save-place', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

type Card = { requestId: string; question: string; options?: { value: string }[] }
async function run(user: string, chatId: string, content: string, answer: (c: Card) => string = () => 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const newChat = async (user: string, body: Record<string, unknown> = {}) => (await h.api(user).call(API.createChat, { body })).id
const at = (rel: string) => path.join(h.team, rel)
const write = (file_path: string, content = '# notes\n') => ({ tool: 'write', args: { file_path, content }, sayResult: true })
const activeTeam = () => (h.ctx.db.query("SELECT COUNT(*) n FROM users WHERE status = 'active' AND deleted_at IS NULL AND role != 'guest'").get() as { n: number }).n
let rooms = 0
async function groupChat(owner: string, others: string[]): Promise<string> {
  const r = await h.api(owner).call(API.createRoom, { body: { kind: 'group', userIds: others, name: `leads-${++rooms}` } })
  await h.api(owner).call(API.sendRoomMessage, { params: { id: r.id }, body: { body: 'Sunday meeting: we agreed on the new price list.', mentions: [], clientMessageId: cm(), fileIds: [] } })
  return r.id
}

describe('the default place is My files', () => {
  test('the instructions send new content to the own folder unless a place is named; Company-wide is not picked for its look', async () => {
    const rule = saveNewPlaceRule('alice')
    expect(rule).toContain("goes in the user's own folder users/alice/")
    expect(rule).toContain('unless the user names another place or the task clearly names one')
    expect(rule).toContain('Never pick a team folder (shared/, a group\'s, a project\'s) yourself because the content looks like it belongs there')
    const shared = folderPurposeLines('en', 'alice', 'shared/Templates').find((l) => l.startsWith('- shared/'))!
    expect(shared).toContain('a new file goes here only when the user or the task names it')
    const templates = folderPurposeLines('en', 'alice', 'shared/Templates').find((l) => l.startsWith('Forms and templates'))!
    expect(templates).toContain("saving the new document in the user's own folder unless the user or the task names a place")
    // in a real turn's instructions
    const r = await run('alice', await newChat('alice'), fake({ echo: 'system' }))
    expect(r.content).toContain(rule)
  })

  test('a summary saved to My files: no card, and the result says only the user can open it', async () => {
    const roomId = await groupChat('alice', ['bob'])
    const r = await run('alice', await newChat('alice'), fake({ tool: 'room_read', args: { room: roomId } }, write('users/alice/Meeting notes/sunday.md')))
    expect(r.cards).toHaveLength(0)
    expect(fs.existsSync(at('users/alice/Meeting notes/sunday.md'))).toBe(true)
    expect(r.content).toContain("Who can open the new file now (the server's count from its folder): users/alice/Meeting notes/sunday.md: only the user.")
  })
})

describe('a place the person names', () => {
  test('is honoured; after a room read the wider-audience card still asks, in plain words with both counts; no saves nothing', async () => {
    const roomId = await groupChat('alice', ['bob'])
    const n = activeTeam()
    const no = await run('alice', await newChat('alice'), `Save the summary in Company-wide › Meeting notes\n${fake({ tool: 'room_read', args: { room: roomId } }, write('shared/Meeting notes/sunday-no.md'))}`, () => 'skip')
    expect(no.cards).toHaveLength(1)
    expect(fs.existsSync(at('shared/Meeting notes/sunday-no.md'))).toBe(false)
    const q = no.cards[0]!.question
    expect(q).toContain(`This came from messages of the conversation 'leads-${rooms}' (2 people). Save it to ${W('shared/Meeting notes/sunday-no.md')} (${n} people)?`)
    expect(q).not.toContain('read content fewer people can see')

    const yes = await run('alice', await newChat('alice'), `Save the summary in Company-wide › Meeting notes\n${fake({ tool: 'room_read', args: { room: roomId } }, write('shared/Meeting notes/sunday.md'))}`, () => 'save')
    expect(yes.cards).toHaveLength(1)
    expect(fs.existsSync(at('shared/Meeting notes/sunday.md'))).toBe(true)
    // the audience line is the real folder's: the whole team, not "the room"
    expect(yes.content).toContain(`shared/Meeting notes/sunday.md: everyone in the team (${n} people).`)
  })

  test('the card in the other languages keeps the facts: source with its count, place with its count', () => {
    const from = tr('widenFrom', 'ko', { source: "'leads' 대화의 메시지", n: '3' })
    expect(from).toBe("'leads' 대화의 메시지(3명)")
    expect(tr('widenConfirm', 'ko', { sources: from, target: '전사 공유 › 회의록', n: '10' })).toBe("이 내용은 'leads' 대화의 메시지(3명)에서 왔어요. 10명이 볼 수 있는 전사 공유 › 회의록에 저장할까요?")
    expect(tr('widenConfirm', 'id', { sources: 'x (3 orang)', target: 'Company-wide', n: '10' })).toBe('Ini berasal dari x (3 orang). Simpan ke Company-wide (10 orang)?')
    expect(tr('widenConfirm', 'es', { sources: 'x', target: 'y', n: '10' })).toBe('Esto viene de x. ¿Guardarlo en y (10 personas)?')
    expect(tr('widenFromYou', 'es', { source: 'su carpeta personal' })).toBe('su carpeta personal (solo usted)')
    expect(tr('widenFromYou', 'id', { source: 'folder pribadi Anda' })).toBe('folder pribadi Anda (hanya Anda)')
  })
})

describe('who can open it, in a side chat', () => {
  test('the audience line counts the room\'s people from the real folder, never from the room', async () => {
    const roomId = await groupChat('alice', ['bob'])
    const chat = await newChat('alice', { sideRoomId: roomId })
    const own = await run('alice', chat, fake(write('users/alice/side-notes.md')))
    expect(own.content).toContain("users/alice/side-notes.md: only the user; 1 of the room's 2 people, nobody outside the room.")
    const n = activeTeam()
    const wide = await run('alice', chat, `Save it in Company-wide\n${fake(write('shared/side-notes.md'))}`, () => 'save')
    expect(fs.existsSync(at('shared/side-notes.md'))).toBe(true)
    expect(wide.content).toContain(`shared/side-notes.md: everyone in the team (${n} people); all 2 of the room's people, and ${n - 2} ${n - 2 === 1 ? 'person' : 'people'} outside the room.`)
  })

  test('the words alone: a folder the room cannot all open says how many of them can', () => {
    const rules = h.ctx.files.rules()
    const ids = (h.ctx.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
    expect(audienceWords(h.ctx.db, rules, 'users/alice/x.md', 'alice', ['alice', 'bob'])).toBe("only the user; 1 of the room's 2 people, nobody outside the room")
    expect(audienceWords(h.ctx.db, rules, 'users/alice/x.md', 'alice')).toBe('only the user')
    expect(saveAudienceNote(h.ctx.db, rules, [], 'alice')).toBe('')
    // the whole team reads shared/ in the fixture
    expect(audienceWords(h.ctx.db, rules, 'shared/x.md', 'alice', ids)).toContain(`all ${ids.length} of the room's people, nobody outside the room`)
  })
})
