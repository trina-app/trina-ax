// Smoke test of batch 4 (S1-A/E, r119): a file the AI attached to its answer in a shared chat (chat:files/, its link
// /c/<chat>?file=<id>) sent to a teammate with post_to_room went as that link only; the teammate, not in the chat, got
// "파일을 찾을 수 없거나 볼 권한이 없어요" while the answer said it was sent. Now the post links a copy kept in the
// person's own downloads, and that copy goes with the post as a file the recipient opens (chat/post-chat-files.ts).
// The card shows the file by its name, never the raw link (QA b4s S1-A, S3).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomFilesOf } from '../../server/src/rooms/files'
import { cardTextWords } from '../../server/src/chat/share-words'
import { chatFileLinksIn } from '../../server/src/chat/post-chat-files'
import { chatFilesOf } from '../../server/src/chat/chat-files'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-post-chat-file-copy', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
type Card = { requestId: string; question: string; options?: { value: string }[]; details?: { label: string; text: string }[] }
async function run(user: string, chatId: string, content: string, answer = 'no') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { cards, content: done.data.message.content as string, attachments: (done.data.message.attachments ?? []) as Attachment[] }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}

/** a chat alice shares with erin, and a file the AI attached to an answer there */
async function chatWithFile(name: string, body: string): Promise<{ chat: string; id: string; link: string; bytes: Buffer }> {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, fake({ say: 'hi' }))
  let r = await put('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }])
  if (r.status === 'confirm') r = await put('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }], r.confirmKey)
  const made = await run('alice', c.id, fake({ tool: 'make_file', args: { format: 'docx', content: body, output: `chat:files/${name}` }, sayResult: true }))
  const att = made.attachments.find((a) => a.name === name)
  if (!att) throw new Error(`no chat file: ${made.content}`)
  const bytes = fs.readFileSync(chatFilesOf(h.ctx).open('alice', c.id, att.id, false).abs)
  return { chat: c.id as string, id: att.id, link: `/c/${c.id}?file=${att.id}`, bytes }
}

const dmOf = (a: string, b: string) => h.ctx.db.query("SELECT id FROM rooms WHERE kind = 'dm' AND dm_key = ?").get([a, b].sort().join('|')) as { id: string } | null

describe('a chat file sent to a teammate with post_to_room', () => {
  test('the recipient gets a copy they can open, byte for byte, and the card names the file', async () => {
    const body = '# 제안서\n\n한 장짜리 초안입니다.\n'
    const f = await chatWithFile('proposal.docx', body)
    // (no ask in alice's own words: the card; with one, the next test, it goes without it)
    const r = await run('alice', f.chat, `${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `The one-page proposal: [proposal.docx](${f.link})` }, sayResult: true })}`, 'send_files')
    // one card, with the files choice, and the text shows the file's name, never the raw /c/ link
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.options?.map((o) => o.value)).toContain('send_files')
    const shown = JSON.stringify(r.cards[0]!.details ?? [])
    expect(shown).not.toContain('/c/')
    expect(shown).toContain('proposal.docx')
    expect(r.content).toContain('"status":"sent"')
    expect(r.content).toContain('chat_files_copied')
    // the copy in alice's own downloads, the chat file unchanged in the chat
    expect(fs.readFileSync(path.join(h.team, 'users/alice/downloads/proposal.docx')).equals(f.bytes)).toBe(true)
    // the 1:1 chat with bob: the message links the copy, never this chat's link, and carries the file
    const dm = dmOf('alice', 'bob')
    expect(dm).not.toBeNull()
    const m = h.ctx.db.query('SELECT id, body FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get(dm!.id) as { id: string; body: string }
    expect(m.body).not.toContain('/c/')
    const files = h.ctx.db.query('SELECT id, name FROM room_files WHERE message_id = ?').all(m.id) as { id: string; name: string }[]
    expect(files.map((x) => x.name)).toEqual(['proposal.docx'])
    // bob (not in the chat) opens it: the same bytes
    const opened = roomFilesOf(h.ctx).open('bob', dm!.id, files[0]!.id, false)
    expect(fs.readFileSync(opened.abs).equals(f.bytes)).toBe(true)
    // and through the API, as the app opens it
    const res = await h.req('bob', `/api/rooms/${dm!.id}/files/${files[0]!.id}?download=1`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(f.bytes)).toBe(true)
  })

  test('the same call again (a retry) keeps one copy, no "(1)" next to it', async () => {
    const body = 'notes v1\n'
    const f = await chatWithFile('notes.docx', body)
    const call = { tool: 'post_to_room', args: { room: 'Bob Lee', text: `Notes: [notes.docx](${f.link})` }, sayResult: true }
    await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    const names = fs.readdirSync(path.join(h.team, 'users/alice/downloads')).filter((n) => n.startsWith('notes'))
    expect(names).toEqual(['notes.docx'])
  })

  test('a link to a file of this chat that is not there: nothing is posted, never a dead link', async () => {
    const f = await chatWithFile('memo.docx', 'memo')
    const gone = `/c/${f.chat}?file=01a1fc0c-bb3a-74b5-a134-000000000000`
    const before = (h.ctx.db.query('SELECT COUNT(*) n FROM room_messages').get() as { n: number }).n
    const r = await run('alice', f.chat, `Send this to Bob\n${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `Memo: [memo.docx](${gone})` }, sayResult: true })}`, 'send_files')
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('Nothing was posted')
    expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_messages').get() as { n: number }).n).toBe(before)
  })

  test('a name already taken in downloads: the copy goes next to it, and the same call again reuses that copy', async () => {
    fs.mkdirSync(path.join(h.team, 'users/alice/downloads'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'users/alice/downloads/taken.docx'), 'someone else')
    const f = await chatWithFile('taken.docx', 'taken')
    const call = { tool: 'post_to_room', args: { room: 'Bob Lee', text: `Taken: [taken.docx](${f.link})` }, sayResult: true }
    const r1 = await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    // a post that did not go says the copy stays in the downloads
    expect(r1.content).toContain('was kept in the user\'s own downloads folder')
    await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    const names = fs.readdirSync(path.join(h.team, 'users/alice/downloads')).filter((n) => n.startsWith('taken'))
    expect(names).toHaveLength(2)
    expect(fs.readFileSync(path.join(h.team, 'users/alice/downloads/taken.docx'), 'utf8')).toBe('someone else')
  })

  test('a link to another chat\'s file, or a chat file in own words: refused before anything is copied', async () => {
    const f = await chatWithFile('other.docx', 'other')
    const g = await chatWithFile('mine.docx', 'mine')
    const before = fs.readdirSync(path.join(h.team, 'users/alice/downloads')).length
    const r1 = await run('alice', g.chat, `Send this to Bob\n${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `Other: [other.docx](${f.link})` }, sayResult: true })}`, 'send_files')
    expect(r1.cards).toHaveLength(0)
    expect(r1.content).toContain('a file of another chat')
    const r2 = await run('alice', g.chat, `Send this to Bob\n${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `Mine: [mine.docx](${g.link})`, own_words: true }, sayResult: true })}`, 'send_files')
    expect(r2.cards).toHaveLength(0)
    expect(r2.content).toContain('own words or the note carry no file')
    expect(fs.readdirSync(path.join(h.team, 'users/alice/downloads')).length).toBe(before)
  })
})

describe('the words', () => {
  test('only links to this chat\'s files are taken, any spelling the router opens', () => {
    const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
    expect(chatFileLinksIn(`[a](/c/chat-1?file=${id}) [b](/C/chat-1/?file=${id}) [c](/c/chat-2?file=${id})`, 'chat-1').map((x) => x.here)).toEqual([true, true, false])
  })

  test('the card shows a chat file\'s link as the file\'s name for someone who sees that chat', async () => {
    const f = await chatWithFile('plan.docx', 'plan\n')
    const text = `Here: [the plan](${f.link})`
    expect(cardTextWords(h.ctx.db, text, 'en', 'alice')).toBe('Here: plan.docx')
    // someone who does not see the chat: as written
    expect(cardTextWords(h.ctx.db, text, 'en', 'bob')).toBe(text)
  })
})
