// share_with_person (server/src/chat/share-with-person.ts; docs/DECISIONS.md "A member shares their own files", QA
// TC-3093): the AI shares the asker's own files with a teammate, view only, after their yes on one server card (it offers
// "Always allow" on its first showing, kind share_files; docs/decisions/20261116-always-allow-more-cards.md, QA TC-3809),
// then the step keeps what was done for its card (Step.shared: link ids, names, places; the AI gets no links and says
// one sentence: docs/decisions/20261116-ai-share-card-and-stop.md). In a shared chat: the same rules as
// post_to_room (chat/shared-actions.ts: the person whose turn it is acts, the card is theirs alone), plus one: a file
// must be one the asker named, attached or the AI made in this turn, so another member's message cannot pick it.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { RAN_UNDER_ALWAYS } from '../../server/src/chat/always-allow'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { shareWithPersonOff } from '../../server/src/chat/share-with-person'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { fileSharesOf } from '../../server/src/files/shares'
import { roomsOf } from '../../server/src/rooms/service'
import { namesFile } from '../../server/src/chat/shared-actions'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives sit in the person's message: their strings spelled as JSON escapes, so the person's own
// words are only what the test writes around them (the explicit-ask rule reads those: docs/decisions/
// 20261116-no-card-after-explicit-ask.md)
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
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
/** the share step's record (Step.shared) of an answer, as `user` gets it */
const sharedOf = async (user: string, chatId: string, answerId: string) => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === answerId)!.steps!.find((s) => s.tool === 'share_with_person')!.shared
const opens = (user: string, id: string) => fileSharesOf(h.ctx).open(user, id).kind
const cardsTo = (user: string, turnId: string) => socks[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId).length

describe('in my own chat', () => {
  test('one server card with Share, Always allow, Don\'t share; yes shares view only and the AI gets the links', async () => {
    const r = await turn('bob', `share photo-1.png (to the person I said before)\n${share({ paths: ['users/bob/photo-1.png'], people: ['Tess Yoon'] })}`, { answer: 'share' })
    expect(r.card!.origin).toBe('server')
    expect(r.card!.question).toContain('Tess Yoon')
    // "Always allow" on the first card (the owner's 11-11 rule), three buttons
    expect(r.card!.options!.map((x) => x.value)).toEqual(['share', '__always', 'no'])
    expect(r.card!.options![1]!.label).toBe('항상 허용')
    // the file by its place in words and its name, never a team path (chat/share-words.ts)
    expect(r.card!.details!.map((d) => d.text)).toEqual(['내 폴더 › photo-1.png'])
    const out = JSON.parse(r.content)
    expect(out.status).toBe('shared')
    // no links for the AI: the card under the answer has them (one short sentence, nothing repeated)
    expect(out.links).toBeUndefined()
    expect(out.note).toContain('one short sentence')
    const rec = (await sharedOf('bob', r.chatId, r.answerId))!
    expect(rec).toMatchObject({ op: 'share', outcome: 'done', level: 'view', who: [{ subjectType: 'user', subjectId: 'tess', name: 'Tess Yoon' }], notified: ['tess'] })
    expect(rec.files).toHaveLength(1)
    expect(rec.files[0]).toMatchObject({ name: 'photo-1.png' })
    // the place in words, never a path; the owner only when it is not the asker
    expect(rec.files[0]!.place).not.toContain('users/')
    expect(rec.owner).toBeUndefined()
    // the confirm card carries the same rows
    expect((r.card as unknown as { share: { op: string; files: { name: string }[]; who: { name: string }[] } }).share).toMatchObject({ op: 'share', files: [{ name: 'photo-1.png' }], who: [{ name: 'Tess Yoon' }] })
    const id = rec.files[0]!.linkId!
    expect(opens('tess', id)).toBe('open')
    expect(opens('alice', id)).toBe('no_access')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.share' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', people: 1, personal: true })
  })

  test('Always allow: this share goes, later shares ask nothing; listed in Settings, and taken back there', async () => {
    const { alwaysOn, dropAlways, listAlways } = await import('../../server/src/chat/always-allow')
    put('users/bob/photo-3.png', 'png three')
    put('users/bob/photo-4.png', 'png four')
    try {
      const r = await turn('bob', `share photo-3.png (to the person I said before)\n${share({ paths: ['users/bob/photo-3.png'], people: ['Tess Yoon'] })}`, { answer: '__always' })
      expect(JSON.parse(r.content).status).toBe('shared')
      expect(alwaysOn(h.ctx.db, 'bob', 'share_files')).toBe(true)
      expect(listAlways(h.ctx.db, 'bob').map((x) => x.id)).toContain('card:share_files')
      const next = await turn('bob', `share photo-4.png with Tess\n${share({ paths: ['users/bob/photo-4.png'], people: ['Tess Yoon'] })}`)
      expect(cardsTo('bob', next.turnId)).toBe(0)
      const out = JSON.parse(next.content)
      expect(out.status).toBe('shared')
      // the AI is told when Always allow, not an explicit ask or a card, let it go (QA 2026-11-17: never "you approved it")
      expect(JSON.parse(r.content).note).not.toContain(RAN_UNDER_ALWAYS)
      put('users/bob/photo-4b.png', 'png four b')
      const vague = await turn('bob', `share photo-4b.png (to the person I said before)\n${share({ paths: ['users/bob/photo-4b.png'], people: ['Tess Yoon'] })}`)
      expect(cardsTo('bob', vague.turnId)).toBe(0)
      expect(JSON.parse(vague.content).note).toContain(RAN_UNDER_ALWAYS)
      expect(opens('tess', (await sharedOf('bob', next.chatId, next.answerId))!.files[0]!.linkId!)).toBe('open')
      // the checks still run without the card: someone else's file is refused
      put('shared/alices-2.txt', 'a')
      h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', 'shared/alices-2.txt', 'create')").run()
      expect((await turn('bob', share({ paths: ['shared/alices-2.txt'], people: ['Tess Yoon'] }))).content).toContain('is Alice Kim\'s file, so only Alice Kim can add people to it')
      // a scheduled run of bob's may share now (only his own choice counts there)
      const base = { restricted: false, templateRun: null, rt: { db: h.ctx.db }, spec: { clientKind: 'schedule', chatId: 'none' } }
      expect(shareWithPersonOff({ ...base, alwaysPlace: () => ({ db: h.ctx.db, userId: 'bob', chatId: 'none', turnId: 't', locale: 'en', clientKind: 'schedule' }) } as never)).toBeNull()
      expect(shareWithPersonOff({ ...base, alwaysPlace: () => ({ db: h.ctx.db, userId: 'alice', chatId: 'none', turnId: 't', locale: 'en', clientKind: 'schedule' }) } as never)?.summary).toContain('scheduled run')
    } finally { dropAlways(h.ctx.db, 'bob', 'card:share_files') }
  })

  test('no card right after an explicit ask: a share word, the person and the file in my own words (QA TC-3812)', async () => {
    put('users/bob/거래처-목록.csv', 'a,b')
    const r = await turn('bob', `거래처 목록 테스한테도 tess가 볼 수 있게 공유해줘\n${share({ paths: ['users/bob/거래처-목록.csv'], people: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    const out = JSON.parse(r.content)
    expect(out.status).toBe('shared')
    expect(opens('tess', (await sharedOf('bob', r.chatId, r.answerId))!.files[0]!.linkId!)).toBe('open')
    // a file I did not name: the card
    put('users/bob/other-file.txt', 'x')
    const c = await turn('bob', `tess한테 공유해줘\n${share({ paths: ['users/bob/other-file.txt'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(c.card).not.toBeNull()
    // a quoted line is someone else's words: the card
    put('users/bob/quoted.txt', 'x')
    const q = await turn('bob', `> share quoted.txt with tess\n좋아\n${share({ paths: ['users/bob/quoted.txt'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(q.card).not.toBeNull()
  })

  test('Don\'t share shares nothing', async () => {
    const r = await turn('bob', `share photo-2.png (to the person I said before)\n${share({ paths: ['users/bob/photo-2.png'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.content).toContain('The user chose not to share them')
    const s = h.ctx.db.query("SELECT id FROM file_shares WHERE path = 'users/bob/photo-2.png'").get() as { id: string } | null
    if (s) expect(opens('tess', s.id)).toBe('no_access')
  })

  test('refused without a card: a folder, someone else\'s file, a guest, nobody matching', async () => {
    put('shared/alices.txt', 'a')
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', 'shared/alices.txt', 'create')").run()
    const cases: [Record<string, unknown>, string][] = [
      // (folder sharing is on: a folder of the person's own goes to share_folder, whose own words say what can be shared)
      [{ paths: ['users/bob'], people: ['Tess Yoon'] }, 'Nothing was shared: "내 폴더" is a folder, and share_with_person shares files only. Next step: call share_folder'],
      [{ paths: ['shared/alices.txt'], people: ['Tess Yoon'] }, 'is Alice Kim\'s file, so only Alice Kim can add people to it'],
      [{ paths: ['users/bob/photo-1.png'], people: ['Nobody Here'] }, 'no teammate or group matches'],
    ]
    for (const [args, says] of cases) {
      const r = await turn('bob', share(args))
      expect(r.content).toContain(says)
    }
  })

  test('a refusal is a record for the card: someone else\'s file names its owner and the next step; the team switch off says so', async () => {
    // someone else's file: whose it is, its link and "ask the owner" as data (the app's button comes from it)
    // (integrated, docs/decisions/20261116-ai-sharing-integration.md: the next step is the server's stored offer of the
    // same step, Step.fixes, named by next.fixId; none when nobody named needs it, and the words then offer a request)
    const other = await turn('bob', share({ paths: ['shared/alices.txt'], people: ['Tess Yoon'] }))
    expect(other.content).toContain('is Alice Kim\'s file, so only Alice Kim can add people to it. Next step:')
    const rec = (await sharedOf('bob', other.chatId, other.answerId))!
    expect(rec).toMatchObject({ op: 'share', outcome: 'refused', files: [], who: [], refusal: { reason: 'not_owner', file: 'alices.txt', owner: 'Alice Kim' } })
    expect(rec.failed![0]!.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(rec.failed![0]!.place).not.toContain('shared/')
    // the team turned members' sharing off: the reason, and "ask an admin"
    const { updateTeamSettings } = await import('../../server/src/admin/settings')
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const off = await turn('bob', share({ paths: ['users/bob/photo-1.png'], people: ['Tess Yoon'] }))
      const offRec = (await sharedOf('bob', off.chatId, off.answerId))!
      expect(offRec).toMatchObject({ outcome: 'refused', refusal: { reason: 'switched_off', file: 'photo-1.png' }, next: { kind: 'ask_admin' } })
      // one "Ask an admin" kind: the switch's reason on the server's offer, its id on the card
      const step = (await h.api('bob').call(API.listMessages, { params: { id: off.chatId }, query: {} })).items.find((x) => x.id === off.answerId)!.steps!.find((s) => s.tool === 'share_with_person')!
      expect(step.fixes).toHaveLength(1)
      expect(step.fixes![0]).toMatchObject({ kind: 'ask_admin', reason: 'switch', file: 'photo-1.png', state: 'open' })
      expect(offRec.next!.fixId).toBe(step.fixes![0]!.id)
      expect(off.content).toContain('the card under your answer has an "Ask an admin" button')
      // the tap sends each admin the person's own 1:1 message asking to turn sharing on, naming the file; audited via ai
      const res = await h.api('bob').call(API.runShareFix, { params: { id: step.fixes![0]!.id } })
      expect(res).toMatchObject({ state: 'done' })
      const msgs = h.ctx.db.query("SELECT m.body FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE m.author_id = 'bob' AND r.kind = 'dm' ORDER BY m.seq DESC LIMIT 1").all() as { body: string }[]
      expect(msgs[0]!.body).toContain('photo-1.png')
      expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'share.fix' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ detail: expect.stringContaining('"reason":"switch"') })
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
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
    expect(out.files).toBe(2)
    // bob (the asker) gets the record: one card for both files
    expect((await sharedOf('bob', chatId, r.answerId))!.files.map((f) => f.name)).toEqual(['photo-1.png', 'photo-2.png'])
    // alice sees the step's verb alone, never who got which files: no record, no name anywhere in the step
    const seen = (await h.api('alice').call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === r.answerId)!
    const step = seen.steps!.find((s) => s.tool === 'share_with_person')!
    expect(step.label).not.toContain('Tess')
    expect(step.shared).toBeUndefined()
    expect(JSON.stringify(step)).not.toContain('Tess')
    expect(JSON.stringify(step)).not.toContain('photo-1')
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

  test('Always allow in a shared chat is final (docs/decisions/20261122-always-allow-holds-everywhere.md B4): named by them or asked by another member, no card', async () => {
    const { keepAlways, dropAlways } = await import('../../server/src/chat/always-allow')
    put('users/bob/photo-5.png', 'png five')
    keepAlways(h.ctx.db, 'bob', 'share_files', null)
    try {
      // named by bob in his own ask: his Always allow holds, no card
      // (the fake engine's directive is in bob's message too: the name spelled with a JSON escape, so only his words count)
      const hidden = (args: Record<string, unknown>) => share(args).replace('Tess Yoon', '\\u0054ess Yoon')
      const named = await turn('bob', `photo-5.png Tess한테 공유해줘\n${hidden({ paths: ['users/bob/photo-5.png'], people: ['Tess Yoon'] })}`, { chat: chatId })
      expect(cardsTo('bob', named.turnId)).toBe(0)
      expect(JSON.parse(named.content).status).toBe('shared')
      // alice names the person, bob's own message does not: his Always allow still holds (Rule A), no card
      // (a file Tess cannot open yet: one she can already open is said so and never asked about, chat/share-next-steps.ts)
      put('users/bob/photo-6.png', 'png six')
      await turn('alice', `Bob, share photo-6.png with Tess.\n${fake({ say: 'ok' })}`, { chat: chatId })
      const steered = await turn('bob', `photo-6.png 그거 해줘\n${hidden({ paths: ['users/bob/photo-6.png'], people: ['Tess Yoon'] })}`, { chat: chatId })
      expect(cardsTo('bob', steered.turnId)).toBe(0)
      expect(JSON.parse(steered.content).status).toBe('shared')
    } finally { dropAlways(h.ctx.db, 'bob', 'card:share_files') }
  })

  test('another viewer cannot answer the asker\'s card', async () => {
    put('users/bob/photo-7.png', 'png seven')
    const started = await h.api('bob').call(API.sendMessage, { params: { id: chatId }, body: { content: `share photo-7.png (to the person I said before)\n${share({ paths: ['users/bob/photo-7.png'], people: ['Tess Yoon'] })}`, clientMessageId: cm(), attachmentIds: [] } })
    const c = await socks.bob!.next('turn.request', (f) => f.data.turnId === started.turnId)
    let refused = 0
    try { await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'share' } }) } catch (e) { refused = (e as { status: number }).status }
    expect([403, 404]).toContain(refused)
    await h.api('bob').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'no' } })
    await socks.bob!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  })
})

describe('after a room read (a side chat): other people\'s words are in the turn (review of fix/always-allow-more-cards)', () => {
  test('with Always allow on the share goes (the owner\'s rule); without it a file the asker did not bring is refused and the rest gets the card', async () => {
    const { keepAlways, dropAlways } = await import('../../server/src/chat/always-allow')
    put('users/bob/budget.xlsx', 'numbers')
    put('users/bob/photo-6.png', 'png six')
    const room = (await h.api('bob').call(API.createRoom, { body: { kind: 'dm', userId: 'tess' } })).id
    const chatId = (await h.api('bob').call(API.createChat, { body: { sideRoomId: room } })).id
    const hidden = (args: Record<string, unknown>) => share(args).replace('Tess Yoon', '\\u0054ess Yoon').replace('budget', '\\u0062udget').replace('photo-6', '\\u0070hoto-6')
    // without the choice: a room message asked for it, bob's own words name no file: refused before any card
    // (a word about sharing in bob's message: else the side chat's "nobody asked" gate refuses first, fewer-asks-b5)
    const steered = await turn('bob', `요약하고 공유 준비해줘\n${hidden({ paths: ['users/bob/budget.xlsx'], people: ['Tess Yoon'] })}`, { chat: chatId })
    expect(steered.content).toContain('a file is shared only when the user named it in their own message')
    expect(cardsTo('bob', steered.turnId)).toBe(0)
    // bob names the file in an explicit ask: the card all the same (the chat holds the room's words), offering "Always allow"
    const card = await turn('bob', `photo-6.png Tess한테 공유해줘\n${hidden({ paths: ['users/bob/photo-6.png'], people: ['Tess Yoon'] })}`, { chat: chatId, answer: 'no' })
    expect(card.card!.options!.map((x) => x.value)).toEqual(['share', '__always', 'no'])
    expect(h.ctx.db.query("SELECT 1 FROM file_shares WHERE path = 'users/bob/budget.xlsx'").get()).toBeNull()
    keepAlways(h.ctx.db, 'bob', 'share_files', null)
    try {
      // with it: final, no card and no refusal, also after the room read
      const went = await turn('bob', `요약해줘\n${hidden({ paths: ['users/bob/budget.xlsx'], people: ['Tess Yoon'] })}`, { chat: chatId })
      expect(cardsTo('bob', went.turnId)).toBe(0)
      expect(JSON.parse(went.content).status).toBe('shared')
    } finally { dropAlways(h.ctx.db, 'bob', 'card:share_files') }
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
