// share_with_person (server/src/chat/share-with-person.ts; docs/DECISIONS.md "A member shares their own files", QA
// TC-3093): the AI shares the asker's own files with a teammate, view only, after their yes on one server card shown
// every time (Always allow never skips it), then replies with the /f/<id> links. In a shared chat: the same rules as
// post_to_room (chat/shared-actions.ts: the person whose turn it is acts, the card is theirs alone), plus one: a file
// must be one the asker named, attached or the AI made in this turn, so another member's message cannot pick it.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { shareWithPersonOff } from '../../server/src/chat/share-with-person'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { fileSharesOf } from '../../server/src/files/shares'
import { roomsOf } from '../../server/src/rooms/service'
import { namesFile } from '../../server/src/chat/shared-actions'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const share = (args: Record<string, unknown>) => fake({ tool: 'share_with_person', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-share-with-person', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  h.ctx.db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['alice', 'bob']) {
    socks[u] = await h.ws(u, { windowId: `win-swp-${u}` })
    await socks[u]!.next('hello')
  }
  put('users/bob/photo-1.png', 'png one')
  put('users/bob/photo-2.png', 'png two')
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })
const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }

type Card = { question: string; origin?: string; options?: { label: string; value: string }[]; details?: { label: string; text: string }[] }
async function turn(user: string, content: string, o: { chat?: string; answer?: string | null } = {}) {
  const chatId = o.chat ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (o.answer !== undefined) {
    const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    if (o.answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, content: done.data.message.content as string, card }
}
const opens = (user: string, id: string) => fileSharesOf(h.ctx).open(user, id).kind
const cardsTo = (user: string, turnId: string) => socks[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId).length

describe('in my own chat', () => {
  test('one server card every time, Share or Don\'t share only; yes shares view only and the AI gets the links', async () => {
    const r = await turn('bob', `share photo-1.png with Tess\n${share({ paths: ['users/bob/photo-1.png'], people: ['Tess Yoon'] })}`, { answer: 'share' })
    expect(r.card!.origin).toBe('server')
    expect(r.card!.question).toContain('Tess Yoon')
    // never "Always allow": this grants access
    expect(r.card!.options!.map((x) => x.value)).toEqual(['share', 'no'])
    expect(r.card!.details!.map((d) => d.text)).toEqual(['photo-1.png'])
    const out = JSON.parse(r.content)
    expect(out.status).toBe('shared')
    expect(out.links[0].url).toMatch(/^\/f\/[A-Za-z0-9_-]{22}$/)
    const id = out.links[0].url.slice(3)
    expect(opens('tess', id)).toBe('open')
    expect(opens('alice', id)).toBe('no_access')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.share' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', people: 1, personal: true })
  })

  test('Don\'t share shares nothing', async () => {
    const r = await turn('bob', `share photo-2.png with Tess\n${share({ paths: ['users/bob/photo-2.png'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.content).toContain('The user chose not to share them')
    const s = h.ctx.db.query("SELECT id FROM file_shares WHERE path = 'users/bob/photo-2.png'").get() as { id: string } | null
    if (s) expect(opens('tess', s.id)).toBe('no_access')
  })

  test('refused without a card: a folder, someone else\'s file, a guest, nobody matching', async () => {
    put('shared/alices.txt', 'a')
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', 'shared/alices.txt', 'create')").run()
    const cases: [Record<string, unknown>, string][] = [
      [{ paths: ['users/bob'], people: ['Tess Yoon'] }, 'Nothing was shared'],
      [{ paths: ['shared/alices.txt'], people: ['Tess Yoon'] }, 'only its owner can share it'],
      [{ paths: ['users/bob/photo-1.png'], people: ['Nobody Here'] }, 'no teammate or group matches'],
    ]
    for (const [args, says] of cases) {
      const r = await turn('bob', share(args))
      expect(r.content).toContain(says)
    }
  })
})

describe('in a shared chat (the same rules as post_to_room)', () => {
  let chatId = ''
  beforeAll(async () => {
    chatId = (await turn('alice', fake({ say: 'hi' }))).chatId
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects } })
    if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
  })

  test('offered; the asker names the files and the person: the card is the asker\'s alone', async () => {
    const tools = (await turn('bob', fake({ echo: 'tools' }), { chat: chatId })).content.split(',').map((t) => t.replace(/^mcp__team__/, ''))
    expect(tools).toContain('share_with_person')
    const r = await turn('bob', `photo-1.png 랑 photo-2.png 테스도 볼 수 있게 공유해줘\n${share({ paths: ['users/bob/photo-1.png', 'users/bob/photo-2.png'], people: ['Tess Yoon'] })}`, { chat: chatId, answer: 'share' })
    expect(cardsTo('bob', r.turnId)).toBe(1)
    expect(cardsTo('alice', r.turnId)).toBe(0)
    const out = JSON.parse(r.content)
    expect(out.status).toBe('shared')
    expect(out.links).toHaveLength(2)
    // alice sees the step's verb alone, never who got which files
    const seen = (await h.api('alice').call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === r.answerId)!
    const step = seen.steps!.find((s) => s.tool === 'share_with_person')!
    expect(step.label).not.toContain('Tess')
  })

  test('another member\'s message cannot pick the asker\'s files: refused before any card', async () => {
    put('users/bob/salary.pdf', 'private')
    await turn('alice', `Bob, share salary.pdf with Tess.\n${fake({ say: 'ok' })}`, { chat: chatId })
    // bob's own message does not name the file; the AI follows alice's line anyway
    // (the fake engine reads its directive from bob's message: the path spelled with a JSON escape, so bob's own words do
    // not contain the file's name)
    const directive = share({ paths: ['users/bob/salary.pdf'], people: ['Tess Yoon'] }).replace('salary', '\\u0073alary')
    const r = await turn('bob', `요약해줘\n${directive}`, { chat: chatId })
    expect(r.content).toContain('a file is shared only when the user named it in their own message')
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(h.ctx.db.query("SELECT 1 FROM file_shares WHERE path = 'users/bob/salary.pdf'").get()).toBeNull()
  })

  test('another viewer cannot answer the asker\'s card', async () => {
    const started = await h.api('bob').call(API.sendMessage, { params: { id: chatId }, body: { content: `share photo-2.png with Tess\n${share({ paths: ['users/bob/photo-2.png'], people: ['Tess Yoon'] })}`, clientMessageId: cm(), attachmentIds: [] } })
    const c = await socks.bob!.next('turn.request', (f) => f.data.turnId === started.turnId)
    let refused = 0
    try { await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'share' } }) } catch (e) { refused = (e as { status: number }).status }
    expect([403, 404]).toContain(refused)
    await h.api('bob').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'no' } })
    await socks.bob!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  })
})

describe('where it is not offered, and the lists', () => {
  test('never in a scheduled run (the card is asked every time), a template or restricted run', () => {
    const base = { restricted: false, templateRun: null, rt: { db: h.ctx.db }, spec: { clientKind: 'web', chatId: 'none' } } as never
    expect(shareWithPersonOff(base)).toBeNull()
    expect(shareWithPersonOff({ ...(base as object), spec: { clientKind: 'schedule', chatId: 'none' } } as never)?.summary).toContain('scheduled run')
    expect(shareWithPersonOff({ ...(base as object), restricted: true } as never)?.summary).toContain('not here')
    expect(shareWithPersonOff({ ...(base as object), spec: { clientKind: 'slack', chatId: 'none' } } as never)?.summary).toContain('Slack')
  })
  test('main AI only, in a shared chat\'s list, its own card after a room read', () => {
    expect(PARENT_ONLY_TOOLS.has('share_with_person')).toBe(true)
    expect(SHARED_TOOLS.has('share_with_person')).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has('share_with_person')).toBe(true)
  })
  test('namesFile: the name or its stem, whole words, three letters at least', () => {
    expect(namesFile('share photo-1.png with Tess', 'users/bob/photo-1.png')).toBe(true)
    expect(namesFile('photo-1 보내줘', 'users/bob/photo-1.png')).toBe(true)
    expect(namesFile('share the photos', 'users/bob/photo-1.png')).toBe(false)
    expect(namesFile('a b', 'users/bob/a.png')).toBe(false)
  })
})
