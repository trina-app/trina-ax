// One card for many (docs/AGENTS/plan/20261123-0339-batch-cards.md). The owner, 2026-11-23: "스킬 여러개 만들라고 하니깐
// 한번에 저렇게 다 띄워 버리네", "항상 허용하면 뒤에것들은 안해도 되어야지", "무거운것도 문제야", and a skill of 15 reference
// files refused because "카드 한 장에는 6만 자까지만 들어가요" ("뭔 이런 어이없는 이유가 있냐"). Three skills put into the team's
// skills in one answer give one card (one group: the same key, the same buttons) that leads in plain words; pressing it
// late moves all three; "Always allow" on one answers the others and moves all of them; a 15-file skill of ~150k
// characters moves on one card, or with no card under Always. With the fake engine through the real launcher and gate,
// safety cards waiting after the answer (as in production).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message, type TurnRequest } from '@mycel/shared/api'
import fs from 'node:fs'
import path from 'node:path'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { ALWAYS_VALUE } from '../../server/src/chat/always-allow'
import { batchKeyed } from '../../server/src/chat/turn'
import { sameCard } from '../../server/src/chat/open-questions'
import { groupCards, pressPlan, showsAsBatch } from '../../web/src/lib/cardBatch'

setDefaultTimeout(120_000)

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const md = (name: string, description: string, body = 'steps') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
const sf = (name: string, from = 'users/carol/lang-skills') => ({ tool: 'skill_files', args: { action: 'move', path: `${from}/${name}`, to_folder: 'skills' }, sayResult: true })

let h: Harness
let ws: TestSocket
const db = () => h.ctx.db
const root = () => h.ctx.files.fx.root
const put = (rel: string, body: string) => { const abs = path.join(root(), ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const has = (rel: string) => fs.existsSync(path.join(root(), ...rel.split('/')))
const always = () => (db().query("SELECT COUNT(*) n FROM card_always_allow WHERE user_id = 'carol' AND kind = 'skill_files'").get() as { n: number }).n
const open = (messageId: string) => db().query('SELECT request_id, turn_id, request FROM open_questions WHERE message_id = ? AND answer IS NULL ORDER BY created_at, request_id').all(messageId) as { request_id: string; turn_id: string; request: string }[]
const post = (turnId: string, requestId: string, answer: unknown) =>
  h.req('carol', `/api/turns/${turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId, answer }) })

beforeAll(async () => {
  h = await startHarness({ name: 'batch-cards', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000, safetyCardsWait: true })
  ws = await h.ws('carol', { windowId: 'win-batch' })
  await ws.next('hello')
})
afterAll(async () => { ws?.close(); await h?.close() })

/** Ask in a new own chat; the answer ends with its cards waiting. */
async function ask(content: string, cards: number) {
  const chatId = (await h.api('carol').call(API.createChat, { body: {} })).id as string
  const r = await h.api('carol').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  await ws.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  expect(await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })).toBe(true)
  const rows = open(r.assistantMessage.id)
  expect(rows.length).toBe(cards)
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, rows, cards: rows.map((x) => ({ turnId: x.turn_id, messageId: r.assistantMessage.id as string, request: JSON.parse(x.request) as Ask })) }
}
async function nextTurn(chatId: string, parentId: string) {
  const u = await ws.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === parentId && f.data.message.role === 'user', 30_000)
  const a = await ws.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === u.data.message.id, 30_000)
  const done = (await ws.next('message.done', (f) => f.data.messageId === a.data.message.id, 60_000)).data.message as Message
  await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
  return { done, turnId: a.data.message.turnId as string }
}
const cardsIn = (turnId: string) => ws.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId)
const three = (tag: string) => {
  for (const [i, n] of ['copy', 'voice', 'seo'].entries()) put(`users/carol/lang-skills/${tag}-${n}/SKILL.md`, md(`${tag}-${n}`, `Writes ${n} for landing pages ${i}`, `## Steps\n- write ${n}`))
  return ['copy', 'voice', 'seo'].map((n) => `${tag}-${n}`)
}

describe('three skills to the team in one answer', () => {
  test('one card: the same group key and buttons, plain words first (name, description, who follows), the paths behind 자세히', async () => {
    const names = three('one')
    const w = await ask(`이 폴더의 스킬들 팀 스킬로 만들어줘\n${fake(...names.map((n) => sf(n)))}`, 3)
    const groups = groupCards(w.cards)
    expect(groups.length).toBe(1)
    expect(showsAsBatch(groups[0]!)).toBe(true)
    const b = w.cards.map((c) => c.request.batch!)
    expect(new Set(b.map((x) => x.key)).size).toBe(1)
    expect(b.map((x) => x.item)).toEqual(names)
    expect(b[0]!.about).toBe('Writes copy for landing pages 0')
    // no raw path in the plain-words part: only behind 자세히 (the question and details)
    for (const x of b) expect(JSON.stringify([x.one, x.many, x.item, x.about, x.summary, x.summaryMany])).not.toContain('users/carol')
    expect(b[0]!.summary).toMatch(/^팀 모두의 AI가 이 스킬을 따르게 돼요 \(\d+명\)$/)
    // (the card is still the server's: its question and details are what the press binds to)
    expect(w.cards[0]!.request.question).toContain('users/carol/lang-skills')
    // a late press of the one card: each answered in order, the last starts the turn that moves all three
    await Bun.sleep(1800)
    for (const a of pressPlan(w.cards, 'yes', new Set(w.cards.map((c) => c.request.requestId)))) expect((await post(w.turnId, a.requestId, a.answer)).status).toBe(204)
    const next = await nextTurn(w.chatId, w.answerId)
    expect(next.done.status).toBe('done')
    for (const n of names) { expect(has(`skills/${n}/SKILL.md`)).toBe(true); expect(has(`users/carol/lang-skills/${n}`)).toBe(false) }
    expect(cardsIn(next.turnId)).toEqual([])
  })

  test('an unticked item is sent its card\'s no first, the ticked ones the press; that one is not moved', async () => {
    const names = three('tick')
    const w = await ask(fake(...names.map((n) => sf(n))), 3)
    const plan = pressPlan(w.cards, 'yes', new Set([w.cards[0]!.request.requestId, w.cards[2]!.request.requestId]))
    expect(plan.map((p) => p.answer)).toEqual(['no', 'yes', 'yes'])
    for (const a of plan) expect((await post(w.turnId, a.requestId, a.answer)).status).toBe(204)
    await nextTurn(w.chatId, w.answerId)
    expect(has(`skills/${names[0]}/SKILL.md`)).toBe(true)
    expect(has(`skills/${names[1]}`)).toBe(false)
    expect(has(`skills/${names[2]}/SKILL.md`)).toBe(true)
  })

  test('"Always allow" on ONE of the cards answers the others: all three move at once, kept for good, no card again', async () => {
    db().query("DELETE FROM card_always_allow WHERE user_id = 'carol'").run()
    const names = three('alw')
    const w = await ask(fake(...names.map((n) => sf(n))), 3)
    expect(w.cards[0]!.request.options!.map((o) => o.value)).toEqual(['yes', ALWAYS_VALUE, 'no'])
    // one press on the first card only (as when they were shown one by one)
    expect((await post(w.turnId, w.rows[0]!.request_id, ALWAYS_VALUE)).status).toBe(204)
    const next = await nextTurn(w.chatId, w.answerId)
    expect(open(w.answerId)).toEqual([])
    for (const n of names) expect(has(`skills/${n}/SKILL.md`)).toBe(true)
    expect(cardsIn(next.turnId)).toEqual([])
    expect(always()).toBe(1)
    // and the next answer asks nothing for this kind (Settings › 트리나에게 허용한 것 lists it)
    const items = (await h.api('carol').call(API.listAiAllowances)).items as { id: string }[]
    expect(items.map((x) => x.id)).toContain('card:skill_files')
    db().query("DELETE FROM card_always_allow WHERE user_id = 'carol'").run()
  })
})

describe('a skill of 15 reference files (~150k characters)', () => {
  const big = (tag: string) => {
    const name = `${tag}-community-voice`
    put(`users/carol/lang-skills/${name}/SKILL.md`, md(name, 'Community voice for posts'))
    for (let i = 0; i < 15; i++) put(`users/carol/lang-skills/${name}/references/ref-${i}.md`, `# ref ${i}\n${'가나다라마바사 voice line. '.repeat(500)}\n`)
    return name
  }
  test('moves on one card that never carries the whole text: SKILL.md and the files by name and size', async () => {
    const name = big('big')
    const w = await ask(`그냥 모두 팀스킬로 넣어봐\n${fake(sf(name))}`, 1)
    const card = w.cards[0]!.request
    const chars = JSON.stringify(card).length
    expect(chars).toBeLessThan(40_000)
    const list = card.details!.find((d) => d.open?.length)
    expect(list!.open!.length).toBe(16)
    expect((await post(w.turnId, card.requestId, 'yes')).status).toBe(204)
    await nextTurn(w.chatId, w.answerId)
    expect(has(`skills/${name}/references/ref-14.md`)).toBe(true)
  })
  test('under Always: no card, moved', async () => {
    db().query("INSERT OR IGNORE INTO card_always_allow (user_id, kind, created_at) VALUES ('carol', 'skill_files', ?)").run(new Date().toISOString())
    const name = big('alw')
    const chatId = (await h.api('carol').call(API.createChat, { body: {} })).id as string
    const r = await h.api('carol').call(API.sendMessage, { params: { id: chatId }, body: { content: fake(sf(name)), clientMessageId: cm(), attachmentIds: [] } })
    await ws.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
    expect(cardsIn(r.turnId)).toEqual([])
    expect(has(`skills/${name}/references/ref-0.md`)).toBe(true)
    db().query("DELETE FROM card_always_allow WHERE user_id = 'carol'").run()
  })
})

describe('the group key', () => {
  test('a server card of any tool gets its tool as its key; an own key stays; the AI\'s own question gets none', () => {
    const card: TurnRequest = { kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Share?', options: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }] }
    expect((batchKeyed(card, 'share_with_person') as Ask).batch).toEqual({ key: 'tool:share_with_person' })
    expect((batchKeyed({ ...card, batch: { key: 'own' } }, 'x') as Ask).batch).toEqual({ key: 'own' })
    expect((batchKeyed({ ...card, origin: undefined }, 'x') as Ask).batch).toBeUndefined()
    expect(batchKeyed(card, null)).toBe(card)
    // the key is presentation only: the press binds to the question and details
    expect(sameCard(card, batchKeyed(card, 'share_with_person'))).toBe(true)
  })
  test('cards of other answers, other keys or other buttons stay apart; a generic group keeps whole questions', () => {
    const c = (id: string, m: string, key: string, yes = 'Yes') => ({ turnId: 't', messageId: m, request: { kind: 'ask_user', origin: 'server', requestId: id, question: `Q ${id}`, options: [{ label: yes, value: 'y' }, { label: 'No', value: 'n' }], batch: { key } } as TurnRequest })
    const g = groupCards([c('a', 'm1', 'k'), c('b', 'm2', 'k'), c('c', 'm1', 'k'), c('d', 'm1', 'k2'), c('e', 'm1', 'k', 'Send')])
    expect(g.map((x) => x.map((y) => y.request.requestId))).toEqual([['a', 'c'], ['b'], ['d'], ['e']])
    expect(showsAsBatch(g[1]!)).toBe(false)
    expect(showsAsBatch(g[0]!)).toBe(true)
    // the card's own no: every item gets it
    expect(pressPlan(g[0]!, 'n', new Set(['a'])).map((p) => p.answer)).toEqual(['n', 'n'])
  })
})
