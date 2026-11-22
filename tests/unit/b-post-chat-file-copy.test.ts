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
async function chatWithFile(name: string, body: string) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, fake({ say: 'hi' }))
  let r = await put('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }])
  if (r.status === 'confirm') r = await put('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }], r.confirmKey)
  const made = await run('alice', c.id, fake({ tool: 'write', args: { file_path: `chat:files/${name}`, content: body }, sayResult: true }))
  const att = made.attachments.find((a) => a.name === name)
  if (!att) throw new Error(`no chat file: ${made.content}`)
  return { chat: c.id as string, id: att.id, link: `/c/${c.id}?file=${att.id}` }
}

const dmOf = (a: string, b: string) => h.ctx.db.query("SELECT id FROM rooms WHERE kind = 'dm' AND dm_key = ?").get([a, b].sort().join('|')) as { id: string } | null

describe('a chat file sent to a teammate with post_to_room', () => {
  test('the recipient gets a copy they can open, byte for byte, and the card names the file', async () => {
    const body = '# 제안서\n\n한 장짜리 초안입니다.\n'
    const f = await chatWithFile('proposal.md', body)
    const r = await run('alice', f.chat, `Send this to Bob\n${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `The one-page proposal: [proposal.md](${f.link})` }, sayResult: true })}`, 'send_files')
    // one card, with the files choice, and the text shows the file's name, never the raw /c/ link
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.options?.map((o) => o.value)).toContain('send_files')
    const shown = JSON.stringify(r.cards[0]!.details ?? [])
    expect(shown).not.toContain('/c/')
    expect(shown).toContain('proposal.md')
    expect(r.content).toContain('"status":"sent"')
    expect(r.content).toContain('chat_files_copied')
    // the copy in alice's own downloads, the chat file unchanged in the chat
    expect(fs.readFileSync(path.join(h.team, 'users/alice/downloads/proposal.md'), 'utf8')).toBe(body)
    // the 1:1 chat with bob: the message links the copy, never this chat's link, and carries the file
    const dm = dmOf('alice', 'bob')
    expect(dm).not.toBeNull()
    const m = h.ctx.db.query('SELECT id, body FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get(dm!.id) as { id: string; body: string }
    expect(m.body).not.toContain('/c/')
    const files = h.ctx.db.query('SELECT id, name FROM room_files WHERE message_id = ?').all(m.id) as { id: string; name: string }[]
    expect(files.map((x) => x.name)).toEqual(['proposal.md'])
    // bob (not in the chat) opens it: the same bytes
    const opened = roomFilesOf(h.ctx).open('bob', dm!.id, files[0]!.id, false)
    expect(fs.readFileSync(opened.abs, 'utf8')).toBe(body)
    // and through the API, as the app opens it
    const res = await h.req('bob', `/api/rooms/${dm!.id}/files/${files[0]!.id}?download=1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(body)
  })

  test('the same call again (a retry) keeps one copy, no "(1)" next to it', async () => {
    const body = 'notes v1\n'
    const f = await chatWithFile('notes.md', body)
    const call = { tool: 'post_to_room', args: { room: 'Bob Lee', text: `Notes: [notes.md](${f.link})` }, sayResult: true }
    await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    await run('alice', f.chat, `Send this to Bob\n${fake(call)}`, 'no')
    const names = fs.readdirSync(path.join(h.team, 'users/alice/downloads')).filter((n) => n.startsWith('notes'))
    expect(names).toEqual(['notes.md'])
  })

  test('Send without the files: the answer is told the recipient cannot open it (never a plain "sent")', async () => {
    const f = await chatWithFile('memo.md', 'memo\n')
    const r = await run('alice', f.chat, `Send this to Bob\n${fake({ tool: 'post_to_room', args: { room: 'Bob Lee', text: `Memo: [memo.md](${f.link})` }, sayResult: true })}`, 'send')
    expect(r.content).toContain('"status":"sent"')
    expect(r.content).toContain('cannot_open')
    expect(r.content).toContain('it did not go as a file')
  })
})

describe('the words', () => {
  test('only links to this chat\'s files are taken, any spelling the router opens', () => {
    const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
    expect(chatFileLinksIn(`[a](/c/chat-1?file=${id}) [b](/C/chat-1/?file=${id}) [c](/c/chat-2?file=${id})`, 'chat-1').map((x) => x.id)).toEqual([id, id])
  })

  test('the card shows a chat file\'s link as the file\'s name for someone who sees that chat', async () => {
    const f = await chatWithFile('plan.md', 'plan\n')
    const text = `Here: [the plan](${f.link})`
    expect(cardTextWords(h.ctx.db, text, 'en', 'alice')).toBe('Here: plan.md')
    // someone who does not see the chat: as written
    expect(cardTextWords(h.ctx.db, text, 'en', 'bob')).toBe(text)
  })
})
