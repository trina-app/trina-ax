// Small UX follow-ups of the 11-22 scenario QA (plan docs/AGENTS/plan/20261122-0820-qa-ux-followups-1122.md;
// docs/decisions/20261122-qa-ux-followups-1122.md). Covered: a chat file's restore makes the chat's line "{actor} restored
// {file} to version {n}" (GET …/audience events, only for people who may open the file); leaving gives the creator one
// 'chat.left' notice and the "left" line also once the chat is theirs alone, and the leaver no notice of their own leave;
// a chat-share notice keeps the sharer's name after their account is deleted; Claude Code's own limit reports become
// "used up until" (engine/claude-parse.ts, chat/turn.ts engineErrorOf); "Archived accounts" in the reader's language.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { ARCHIVE_DIR, folderLabel } from '@mycel/shared'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { ClaudeStreamParser, limitResetIn } from '../../server/src/engine/claude-parse'
import { engineErrorOf } from '../../server/src/chat/turn'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-qa-ux-followups', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
const put = (user: string, chatId: string, subjects: Sub[], o: { confirmKey?: string; withFiles?: boolean } = {}): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...o } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, { confirmKey: r.confirmKey })
  if (r.status !== 'saved') throw new Error('not saved')
}
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}
async function newChat(user = 'alice', text = 'hello') {
  const c = await h.api(user).call(API.createChat, { body: {} })
  await ask(user, c.id, `${text}\n${fake({ say: `answer to ${text}` })}`)
  return c.id
}

describe('restore line', () => {
  test('a restore in the chat file panel is a line of the chat, with who, the file and the version', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const dir = `users/alice/qa-${crypto.randomUUID().slice(0, 6)}`
    const r = await ask('alice', c.id, `make it\n${fake({ tool: 'write', args: { file_path: `${dir}/견적서.md`, content: 'v1' } }, { say: 'made' })}`)
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id: c.id }, body: { subjects: [bob, erin] } })
    expect((await put('alice', c.id, [bob, erin], { confirmKey: p.previewKey, withFiles: true })).status).toBe('saved')
    const row = db().query('SELECT attachments FROM messages WHERE id = ?').get(r.assistantMessage.id) as { attachments: string }
    const rootId = (JSON.parse(row.attachments) as Attachment[]).find((a) => a.origin === 'shared-copy')!.id
    const saveAs = (user: string, content: string) => h.req(user, `/api/chats/${c.id}/files/${rootId}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    expect((await saveAs('bob', 'v2 by bob')).status).toBe(200)
    expect((await h.req('erin', `/api/chats/${c.id}/files/${rootId}/versions/1/restore`, { method: 'POST' })).status).toBe(200)
    for (const user of ['alice', 'bob', 'erin']) {
      const a = await h.api(user).call(API.getChatAudience, { params: { id: c.id } })
      const line = a.events?.find((e) => e.kind === 'restored')
      expect(line).toMatchObject({ kind: 'restored', actor: 'Erin Yoo', names: ['견적서.md'], version: 1 })
    }
    // the line is ids and a number only
    expect(db().query('SELECT actor_id, file_id, version FROM chat_file_events WHERE chat_id = ?').all(c.id)).toEqual([{ actor_id: 'erin', file_id: rootId, version: 1 }])
    // newer restore lines of a file nobody here may open, more than a page of them, do not push the one they may see
    // out of the list (people-share.ts chatEventsOf: visibility first, then the limit)
    for (let i = 0; i < 60; i++) db().query("INSERT INTO chat_file_events (chat_id, at, actor_id, kind, file_id, version) VALUES (?, ?, 'erin', 'restored', 'no-such-file', 1)").run(c.id, new Date(Date.now() + 60_000 + i).toISOString())
    const later = await h.api('bob').call(API.getChatAudience, { params: { id: c.id } })
    expect(later.events?.filter((e) => e.kind === 'restored')).toEqual([expect.objectContaining({ actor: 'Erin Yoo', names: ['견적서.md'], version: 1 })])
  })
})

describe('leaving', () => {
  test('the last one out: the creator keeps the "left" line, gets one notice; the leaver gets none about it', async () => {
    const id = await newChat('alice', 'one to one')
    await share('alice', id, [bob])
    // bob's "shared a chat with you"
    expect(db().query("SELECT COUNT(*) AS n FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").get(id)).toEqual({ n: 1 })
    await h.api('bob').call(API.leaveChat, { params: { id } })
    // the chat is alice's own again, and its lines stay for her
    const a = await h.api('alice').call(API.getChatAudience, { params: { id } })
    expect(a.kind).toBe('private')
    expect(a.events?.map((e) => [e.kind, e.actor])).toEqual([['added', 'Alice Kim'], ['left', 'Bob Lee']])
    // one notice for alice, with who and the chat
    const notices = (await h.api('alice').call(API.listNotifications, { query: {} })).items.filter((x) => x.code === 'chat.left')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.chatLeft).toEqual({ name: 'Bob Lee', title: expect.any(String) })
    expect(notices[0]!.link).toBe('chat')
    expect(notices[0]!.chatId).toBe(id)
    // nothing for bob about his own leave: his share notice of it went
    expect(db().query("SELECT COUNT(*) AS n FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").get(id)).toEqual({ n: 0 })
    expect((await h.api('bob').call(API.listNotifications, { query: {} })).items.filter((x) => x.chatId === id || x.code === 'chat.lost' || x.code === 'chat.left')).toEqual([])
  })

  test('someone else\'s private chat gives no lines', async () => {
    const id = await newChat('erin', 'mine only')
    const a = await h.api('erin').call(API.getChatAudience, { params: { id } })
    expect(a.events).toBeUndefined()
  })
})

describe('the sharer is gone', () => {
  test('a share notice keeps the sharer\'s name after their account is deleted', async () => {
    addTestPerson('ivan', { id: 'ivan', name: 'Ivan Moss', role: 'member', locale: 'en' })
    db().query("INSERT INTO users (id, username, name, role, locale) VALUES ('ivan', 'ivan', 'Ivan Moss', 'member', 'en')").run()
    ws.ivan = await h.ws('ivan'); await ws.ivan.next('hello')
    const id = await newChat('ivan', 'ivan shares')
    await share('ivan', id, [bob])
    await h.api('dana').call(API.deleteUser, { params: { id: 'ivan' }, query: { personalFolder: 'delete' }, body: {} })
    const n = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((x) => x.code === 'chat.shared' && db().query('SELECT 1 FROM chat_share_notices WHERE id = ? AND chat_id = ?').get(x.id, id))
    expect(n?.chatShared?.name).toBe('Ivan Moss')
  })
})

describe('AI limit words', () => {
  const later = Math.floor(Date.now() / 1000) + 3 * 86_400
  test('Claude Code\'s rate_limit_event gives the reset time: "used up until"', () => {
    const p = new ClaudeStreamParser()
    p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: later, rateLimitType: 'seven_day' } }))
    const out = p.push(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your weekly limit · resets Nov 25, 3pm" }))
    const err = out.find((e) => e.type === 'error')!
    expect(err).toMatchObject({ code: 'rate_limit', retryAt: new Date(later * 1000).toISOString() })
    const body = engineErrorOf(err as { code: 'rate_limit'; retryAt: string }, 'ko')
    expect(body.params?.reason).toBe('usage_used_up')
    expect(body.params?.until).toBe(new Date(later * 1000).toISOString())
    expect(body.code).toBe('rate_limited')
  })
  test('the older "limit reached|<epoch>" form, and a weekly limit with no time', () => {
    expect(limitResetIn(`Claude AI usage limit reached|${later}`)).toBe(new Date(later * 1000).toISOString())
    const p = new ClaudeStreamParser()
    const err = p.push(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your weekly limit" })).find((e) => e.type === 'error')!
    expect(err).toMatchObject({ code: 'rate_limit', weekly: true })
    expect(engineErrorOf(err as { code: 'rate_limit'; weekly: true }, 'en').params?.reason).toBe('usage_used_up')
    // a short limit with no time keeps "try again a bit later"
    const short = new ClaudeStreamParser().push(JSON.stringify({ type: 'result', is_error: true, result: 'rate limit: 429' })).find((e) => e.type === 'error')!
    expect(engineErrorOf(short as { code: 'rate_limit' }, 'en').params?.reason).toBe('rate_limit')
  })
})

describe('folder words', () => {
  test('"Archived accounts" in the reader\'s language, whatever language it was made in', () => {
    for (const made of Object.values(ARCHIVE_DIR)) {
      expect(folderLabel(`users/dana/${made}`, 'ko', 'dana')).toBe('보관된 계정')
      expect(folderLabel(`users/dana/${made}`, 'ja', 'dana')).toBe(ARCHIVE_DIR.ja)
    }
    // only the person's own folder's: someone else's folder of that name stays as it is
    expect(folderLabel('users/dana/x/Archived accounts', 'ko', 'dana')).toBeNull()
    expect(folderLabel('users/olga/Archived accounts', 'ko', 'dana')).toBeNull()
  })
})
