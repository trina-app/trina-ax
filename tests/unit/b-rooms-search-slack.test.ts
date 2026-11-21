// ⌘K room message search at least as good as Slack's (QA TC-5365, docs/DECISIONS.md "⌘K: from:, in:, phrases, word
// forms, best match, near matches"): a Korean word with a particle ("회의를") and an English ending ("deploys") find the
// word's other forms; "quoted phrases"; from: a person and in: a room or a 1:1 chat; the best match first; near matches
// when nothing matched as typed; on 100,000 messages. And the rule that does not change: a hit is only a message the
// person would see by opening its room now, whatever the filters name (a room or a person they do not share reads as
// one that does not exist). The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type RoomMessage, type RoomSearchPage } from '@mycel/shared/api'
import { editDistance, nearMatch, parseSearch, searchStem } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { searchRooms } from '../../server/src/rooms/reader'
import { matchScore, RELEVANT_POOL, searchRoomFiles, searchRoomMessages } from '../../server/src/rooms/search'

setDefaultTimeout(180_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-search-slack' })
  // the fixture's groups get real ids, as rooms need (b-rooms-search.test.ts)
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { await h.close() })

let groups = 0
async function teamRoom(memberIds: string[], name = `slack-${++groups}`): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return r.id
}
const groupChat = async (by: string, others: string[], name?: string) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others, ...(name ? { name } : {}) } })).id
const dm = async (by: string, other: string) => (await h.api(by).call(API.createRoom, { body: { kind: 'dm', userId: other } })).id
const send = (user: string, roomId: string, body: string, extra: Record<string, unknown> = {}) =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...extra } }) as Promise<RoomMessage>
const search = (user: string, q: string, extra: { cursor?: string; limit?: number; sort?: 'relevant' | 'recent'; room?: string } = {}) => h.api(user).call(API.searchRoomMessages, { query: { q, ...extra } }) as Promise<RoomSearchPage>
const bodies = (p: RoomSearchPage) => p.items.map((i) => i.snippet)
const tagged = async (user: string, q: string, tag: string, extra: { sort?: 'relevant' | 'recent'; room?: string } = {}) => bodies(await search(user, q, extra)).filter((b) => b.includes(tag))
const raw = async (user: string, q: string) => (await h.req(user, `/api/room-messages?q=${encodeURIComponent(q)}`)).text()

describe('the text: word forms, phrases, filters (shared/src/search-text.ts)', () => {
  test('searchStem: a Korean particle, an English ending; short words and other text as typed', () => {
    const cases: [string, string][] = [
      ['회의를', '회의'], ['견적서는', '견적서'], ['인화원에서', '인화원'], ['인화원', '인화원'], ['사과', '사과'], ['고객에게서', '고객'],
      ['deploys', 'deploy'], ['deployed', 'deploy'], ['deploying', 'deploy'], ['Meetings', 'meeting'], ['shipped', 'ship'], ['companies', 'compan'],
      ['boxes', 'box'], ['process', 'process'], ['during', 'during'], ['status', 'status'], ['speed', 'speed'], ['bus', 'bus'], ['q4-plan', 'q4-plan'], ['Q4', 'Q4'],
    ]
    for (const [w, s] of cases) expect(searchStem(w), w).toBe(s)
  })

  test('parseSearch: from:, in:, quoted phrases, words; a lone quote and an empty filter are text', () => {
    expect(parseSearch('from:@bob in:#marketing 견적서를 "budget review"')).toEqual({ words: ['견적서를', 'budget review'], terms: ['견적서', 'budget review'], forms: [['견적서'], ['budget review']], phrases: [false, true], from: ['bob'], in: ['marketing'], mentions: [] })
    expect(parseSearch('from:"Bob Lee" in:"Q4 launch" hi')).toMatchObject({ from: ['Bob Lee'], in: ['Q4 launch'], words: ['hi'] })
    expect(parseSearch('FROM:me 네')).toMatchObject({ from: ['me'], words: ['네'] })
    expect(parseSearch('"abc from: x')).toMatchObject({ words: ['"abc', 'from:', 'x'], from: [] })
    expect(parseSearch('x from:bob from:BOB')).toMatchObject({ from: ['bob'] })
    // mentions: (the "Mentions me" chip sends mentions:me), as typed
    expect(parseSearch('mentions:me 견적 MENTIONS:@Me')).toMatchObject({ mentions: ['me'], words: ['견적'] })
    expect(parseSearch('mentions: x')).toMatchObject({ mentions: [], words: ['mentions:', 'x'] })
  })

  test('nearMatch: a typing mistake or two in a word or the start of one, never in a short one', () => {
    expect(editDistance('recieve', 'receive', 1)).toBe(1)
    expect(nearMatch('Please receive it', 'recieve')).toBe(true)
    expect(nearMatch('pushed to staging', 'stagign')).toBe(true)
    expect(nearMatch('the deployments list', 'deploymnet')).toBe(true)
    expect(nearMatch('the cat sat', 'cst')).toBe(false)
    expect(nearMatch('hello world', 'recieve')).toBe(false)
    expect(nearMatch('q4-plan here', 'q4-plam')).toBe(false)
  })
})

describe('what is found', () => {
  test('a Korean word with a particle, part of a word, an English ending, any case; a phrase in quotes', async () => {
    const room = await teamRoom(['alice', 'erin'])
    await send('alice', room, 'FORM-CANARY 인화원 연수 일정 공유드립니다')
    await send('alice', room, 'FORM-CANARY 내일 회의 10시로 옮겼어요')
    await send('alice', room, 'FORM-CANARY We deployed the new build to staging')
    await send('alice', room, 'FORM-CANARY The meeting is moved to Thursday')
    await send('alice', room, 'FORM-CANARY Q4 budget review on Friday')
    await send('alice', room, 'FORM-CANARY review the budget split')
    const T = 'FORM-CANARY'
    expect(await tagged('erin', '인화', T)).toEqual([`${T} 인화원 연수 일정 공유드립니다`])
    expect(await tagged('erin', '인화원에서', T)).toEqual([`${T} 인화원 연수 일정 공유드립니다`])
    expect(await tagged('erin', '회의를', T)).toEqual([`${T} 내일 회의 10시로 옮겼어요`])
    for (const q of ['deploys', 'DEPLOYING', 'deployed']) expect(await tagged('erin', q, T), q).toEqual([`${T} We deployed the new build to staging`])
    expect(await tagged('erin', 'meetings', T)).toEqual([`${T} The meeting is moved to Thursday`])
    expect(await tagged('erin', 'budget review', T)).toEqual([`${T} review the budget split`, `${T} Q4 budget review on Friday`])
    expect(await tagged('erin', '"budget review"', T)).toEqual([`${T} Q4 budget review on Friday`])
    // the hit's text starts at the part found, the particle left out
    expect((await search('erin', `${T} 회의를`)).items[0]!.snippet).toBe(`${T} 내일 회의 10시로 옮겼어요`)
  })

  test('thread replies and 1:1 chats are found, with their thread named', async () => {
    const room = await teamRoom(['alice', 'erin'])
    const root = await send('alice', room, 'THREAD-CANARY 인화원 버스 일정')
    await send('erin', room, 'THREAD-CANARY 버스는 8시에 출발합니다', { threadRootId: root.id })
    const d = await dm('alice', 'bob')
    await send('bob', d, 'THREAD-CANARY 도면 파일 zephyr 버전')
    const reply = (await search('alice', 'THREAD-CANARY 버스는 8시')).items
    expect(reply.map((i) => [i.snippet, i.threadRootId])).toEqual([['THREAD-CANARY 버스는 8시에 출발합니다', root.id]])
    expect(bodies(await search('alice', 'THREAD-CANARY zephyr'))).toEqual(['THREAD-CANARY 도면 파일 zephyr 버전'])
    expect(bodies(await search('erin', 'THREAD-CANARY zephyr'))).toEqual([])
  })

  test('from: a person by username, name, initials or me; nobody of that name finds nothing and says so', async () => {
    const room = await teamRoom(['alice', 'erin'])
    await send('alice', room, 'FROM-CANARY 견적서 alice')
    await send('erin', room, 'FROM-CANARY 견적서 erin')
    const T = 'FROM-CANARY'
    expect(await tagged('alice', `from:erin ${T}`, T)).toEqual([`${T} 견적서 erin`])
    expect(await tagged('alice', `from:@erin ${T} 견적서를`, T)).toEqual([`${T} 견적서 erin`])
    expect(await tagged('alice', `from:"Erin Yoo" ${T}`, T)).toEqual([`${T} 견적서 erin`])
    expect(await tagged('alice', `from:me ${T}`, T)).toEqual([`${T} 견적서 alice`])
    const p = await search('alice', `from:erin ${T}`)
    expect(p.filters).toEqual({ from: [{ id: 'erin', name: 'Erin Yoo' }], in: [], missing: [] })
    const none = await search('alice', `from:nobody-here ${T}`)
    expect(none).toEqual({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: ['from:nobody-here'] } })
    // from: alone: their messages, newest first
    expect((await search('alice', 'from:erin')).items.every((i) => i.author?.id === 'erin')).toBe(true)
  })

  test('in: a room by its name, a 1:1 chat by the person, the everyone room by its word; in: alone lists it', async () => {
    const room = await teamRoom(['alice', 'erin'], 'Q4 Launch')
    const other = await teamRoom(['alice', 'erin'])
    const d = await dm('alice', 'erin')
    await send('alice', room, 'IN-CANARY 일정 in the launch room')
    await send('alice', other, 'IN-CANARY 일정 elsewhere')
    await send('erin', d, 'IN-CANARY 일정 in the dm')
    const T = 'IN-CANARY'
    expect(await tagged('alice', `in:"Q4 Launch" ${T}`, T)).toEqual([`${T} 일정 in the launch room`])
    expect(await tagged('alice', `in:#q4 ${T}`, T)).toEqual([`${T} 일정 in the launch room`])
    expect(await tagged('alice', `in:@erin ${T}`, T)).toEqual([`${T} 일정 in the dm`])
    expect(await tagged('alice', `in:"Erin Yoo" ${T}`, T)).toEqual([`${T} 일정 in the dm`])
    expect(bodies(await search('alice', 'in:"Q4 Launch"'))).toEqual([`${T} 일정 in the launch room`])
    const p = await search('alice', `in:"Q4 Launch" from:alice ${T}`)
    expect(p.filters?.in.map((r) => r.id)).toEqual([room])
    expect(p.filters?.from.map((x) => x.id)).toEqual(['alice'])
  })

  test('files: by name with from: and in:, a word with a particle too', async () => {
    const room = await teamRoom(['alice', 'erin'], 'Files Room')
    const up = async (user: string, name: string) => {
      const fd = new FormData()
      fd.append('file', new File(['x'], name, { type: 'application/pdf' }))
      const r = await h.req(user, `/api/rooms/${room}/files`, { method: 'POST', body: fd })
      return ((await r.json()) as { id: string }).id
    }
    await send('alice', room, 'FILE-CANARY', { fileIds: [await up('alice', 'FILECANARY_견적서_v2.pdf')] })
    await send('erin', room, 'FILE-CANARY', { fileIds: [await up('erin', 'FILECANARY_회의록.pdf')] })
    const names = (u: string, q: string) => searchRoomFiles(h.ctx.db, u, { q }).items.map((i) => i.file.name)
    expect(names('erin', 'FILECANARY 견적서는')).toEqual(['FILECANARY_견적서_v2.pdf'])
    expect(names('erin', 'FILECANARY from:erin')).toEqual(['FILECANARY_회의록.pdf'])
    expect(names('erin', 'in:"Files Room"').sort()).toEqual(['FILECANARY_견적서_v2.pdf', 'FILECANARY_회의록.pdf'])
    expect(names('bob', 'FILECANARY')).toEqual([])
    expect(names('bob', 'in:"Files Room"')).toEqual([])
  })

  test('a Korean verb in another form (docs/decisions/20261121-ko-search-forms.md): messages, best match, files, the AI\'s search, chat records; who sees it unchanged', async () => {
    const room = await teamRoom(['alice', 'erin'])
    const other = await teamRoom(['bob'])
    const T = 'VERB-CANARY'
    await send('alice', room, `${T} 시안 만들었어요`)
    await send('alice', room, `${T} 보고서를 작성했습니다`)
    await send('alice', room, `${T} 견적서 보냈어요`)
    await send('alice', room, `${T} 이번 건은 좀 어렵습니다`)
    await send('alice', room, `${T} 시가 총액`)
    // bob's room: the same words, never anyone else's hit
    await send('bob', other, `${T} 시안 만들었어요 (bob)`)
    for (const sort of ['relevant', 'recent'] as const) {
      expect(await tagged('erin', '만든', T, { sort }), sort).toEqual([`${T} 시안 만들었어요`])
      expect(await tagged('erin', '만들다', T, { sort })).toEqual([`${T} 시안 만들었어요`])
      expect(await tagged('erin', '보고서 작성', T, { sort })).toEqual([`${T} 보고서를 작성했습니다`])
      expect(await tagged('erin', '작성했어요', T, { sort })).toEqual([`${T} 보고서를 작성했습니다`])
      expect(await tagged('erin', '보낸', T, { sort })).toEqual([`${T} 견적서 보냈어요`])
      expect(await tagged('erin', '어려워요', T, { sort })).toEqual([`${T} 이번 건은 좀 어렵습니다`])
      // a noun gains no stem alone: "시간" is not "시가"
      expect(await tagged('erin', '시간', T, { sort })).toEqual([])
      expect(await tagged('bob', '만든', T, { sort })).toEqual([`${T} 시안 만들었어요 (bob)`])
    }
    // the form found is what the snippet starts at and the app marks
    const p = await search('erin', `${T} 보낸`)
    expect(p.items.map((i) => i.snippet)).toEqual([`${T} 견적서 보냈어요`])
    expect(parseSearch('보낸').forms[0]).toContain('보냈')
    // files by name, and the AI's search of the rooms (rooms tool)
    const fd = new FormData()
    fd.append('file', new File(['x'], 'VERBCANARY_작성한_보고서.pdf', { type: 'application/pdf' }))
    const fid = ((await (await h.req('alice', `/api/rooms/${room}/files`, { method: 'POST', body: fd })).json()) as { id: string }).id
    await send('alice', room, `${T} 파일`, { fileIds: [fid] })
    expect(searchRoomFiles(h.ctx.db, 'erin', { q: 'VERBCANARY 작성했어요' }).items.map((i) => i.file.name)).toEqual(['VERBCANARY_작성한_보고서.pdf'])
    expect(searchRoomFiles(h.ctx.db, 'bob', { q: 'VERBCANARY 작성했어요' }).items).toEqual([])
    const ai = searchRooms(h.ctx.db, 'erin', 'UTC', { query: `${T} 만든` })
    expect(ai.count).toBe(1)
    expect(ai.text).toContain('시안 만들었어요')
    // the message and the one its file 작성한_보고서.pdf came with
    expect(searchRooms(h.ctx.db, 'erin', 'UTC', { query: `${T} 보고서가` }).count).toBe(2)
    expect(searchRooms(h.ctx.db, 'carol', 'UTC', { query: `${T} 만든` }).count ?? 0).toBe(0)
    // the chat records' search (AI chats): by title too, particles and verb forms
    const c = await h.api('erin').call(API.createChat, { body: { title: 'VERBCANARY 주간 보고서를 작성했습니다' } })
    for (const q of ['VERBCANARY 작성했어요', 'VERBCANARY 보고서가', 'VERBCANARY 작성하다'])
      expect((await h.api('erin').call(API.listChats, { query: { q } })).items.map((x) => x.id), q).toEqual([c.id])
    expect((await h.api('erin').call(API.listChats, { query: { q: 'VERBCANARY 보냈어요' } })).items).toEqual([])
    expect((await h.api('alice').call(API.listChats, { query: { q: 'VERBCANARY 작성했어요' } })).items).toEqual([])
  })
})

describe('who sees a hit, whatever the filters say', () => {
  test('in: a room I am not in reads as no such room; from: someone finds only what I see of them', async () => {
    const secret = await teamRoom(['alice', 'erin'], 'Secret Pricing')
    await send('erin', secret, 'VIS-CANARY 원가 secret numbers')
    const mine = await teamRoom(['bob', 'erin'])
    await send('erin', mine, 'VIS-CANARY 원가 shared with bob')
    const p = await search('bob', 'in:"Secret Pricing" VIS-CANARY')
    const q = await search('bob', 'in:"No Such Room" VIS-CANARY')
    expect(p).toEqual({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: ['in:Secret Pricing'] } })
    expect(q.filters?.missing).toEqual(['in:No Such Room'])
    expect(bodies(await search('bob', 'from:erin VIS-CANARY'))).toEqual(['VIS-CANARY 원가 shared with bob'])
    for (const s of ['relevant', 'recent'] as const) expect(bodies(await search('bob', 'VIS-CANARY 원가', { sort: s }))).toEqual(['VIS-CANARY 원가 shared with bob'])
    // a near match never reaches past the rooms either
    expect(bodies(await search('bob', 'VIS-CANARY secrte'))).toEqual([])
    for (const u of ['bob', 'carol', 'dana']) {
      expect(await raw(u, 'from:erin secret')).not.toContain('secret numbers')
      expect(await raw(u, 'in:"Secret Pricing"')).not.toContain('secret numbers')
    }
  })

  test('a 1:1 chat of two others is not found with in:@ either', async () => {
    const d = await dm('alice', 'erin')
    await send('alice', d, 'DMVIS-CANARY 연봉협상')
    expect((await search('bob', 'in:@erin DMVIS-CANARY')).items).toEqual([])
    expect(bodies(await search('bob', 'in:@alice')).filter((b) => b.includes('DMVIS-CANARY'))).toEqual([])
    expect(await raw('carol', 'from:alice 연봉협상')).not.toContain('DMVIS-CANARY')
  })
})

// "This conversation" (room=) and "Mentions me" (mentions:me): docs/decisions/20261120-search-shortcuts-slack.md
describe('room= and mentions:me narrow, never widen', () => {
  test('room= finds only that room; bare (no from:/in:) too; with in: it is both', async () => {
    const a = await teamRoom(['alice', 'erin'], 'Here Room')
    const b = await teamRoom(['alice', 'erin'], 'There Room')
    await send('alice', a, 'HERE-CANARY 견적 in here')
    await send('alice', b, 'HERE-CANARY 견적 over there')
    const T = 'HERE-CANARY'
    expect(await tagged('erin', `${T} 견적을`, T)).toHaveLength(2)
    expect(await tagged('erin', `${T} 견적`, T, { room: a })).toEqual([`${T} 견적 in here`])
    const p = await search('erin', T, { room: a })
    expect(bodies(p)).toEqual([`${T} 견적 in here`])
    // the room is not named back (the chip says it), and it counts as a filter: no roomGone, nothing missing
    expect(p.filters).toEqual({ from: [], in: [], missing: [] })
    // bare: no text at all, only the room's messages (as a filter alone lists them)
    expect(searchRoomMessages(h.ctx.db, 'erin', { q: '', room: a }).items.map((i) => i.roomId)).toEqual([a])
    // with in: the room only when in: names it too
    expect(bodies(await search('erin', `in:"There Room" ${T}`, { room: a }))).toEqual([])
    expect(bodies(await search('erin', `in:"Here Room" ${T}`, { room: a }))).toEqual([`${T} 견적 in here`])
    expect(bodies(await search('erin', `in:Room ${T}`, { room: b }))).toEqual([`${T} 견적 over there`])
    // with from:me
    await send('erin', a, 'HERE-CANARY 견적 erin here')
    expect(bodies(await search('erin', `from:me ${T}`, { room: a }))).toEqual([`${T} 견적 erin here`])
    // files too
    expect(searchRoomFiles(h.ctx.db, 'erin', { q: 'in:"There Room"', room: a }).items).toEqual([])
  })

  test('room= a room I am not in, left or that was archived: nothing, roomGone, its id never echoed', async () => {
    const secret = await teamRoom(['alice', 'erin'], 'Secret Here')
    await send('erin', secret, 'GONE-CANARY 원가 secret')
    for (const u of ['bob', 'carol', 'dana']) {
      const p = await search(u, 'GONE-CANARY', { room: secret })
      expect(p).toEqual({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: [], roomGone: true } })
      expect(JSON.stringify(p)).not.toContain(secret)
      expect(searchRoomFiles(h.ctx.db, u, { q: 'GONE-CANARY', room: secret }).items).toEqual([])
      expect(await (await h.req(u, `/api/room-messages?q=GONE-CANARY&room=${secret}`)).text()).not.toContain('원가')
    }
    // a group chat left: gone at once
    const g = await groupChat('alice', ['bob', 'erin'], 'Left Chat')
    await send('alice', g, 'GONE-CANARY left chat words')
    expect(bodies(await search('bob', 'GONE-CANARY', { room: g }))).toEqual(['GONE-CANARY left chat words'])
    await h.api('bob').call(API.leaveRoom, { params: { id: g } })
    expect((await search('bob', 'GONE-CANARY', { room: g })).filters?.roomGone).toBe(true)
    // an archived room: gone for everyone in it
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), g)
    expect((await search('alice', 'GONE-CANARY', { room: g })).items).toEqual([])
    // a made-up id and a bad one
    expect((await search('erin', 'GONE-CANARY', { room: uuidv7() })).filters?.roomGone).toBe(true)
    expect((await h.req('erin', '/api/room-messages?q=x&room=not-an-id')).status).toBe(400)
  })

  test('mentions:me: by name and @everyone by someone else, in my rooms only; mentions:someone finds nothing', async () => {
    const room = await teamRoom(['alice', 'erin', 'bob'])
    const other = await teamRoom(['alice', 'bob'])
    await send('alice', room, 'MENT-CANARY @erin 견적 please', { mentions: ['erin'] })
    await send('alice', room, 'MENT-CANARY @everyone 견적 all', { mentionsAll: true })
    await send('erin', room, 'MENT-CANARY @everyone by erin herself', { mentionsAll: true })
    await send('alice', room, 'MENT-CANARY no mention 견적')
    await send('alice', other, 'MENT-CANARY @bob not for erin', { mentions: ['bob'] })
    const T = 'MENT-CANARY'
    expect(await tagged('erin', `mentions:me ${T}`, T, { sort: 'recent' })).toEqual([`${T} @everyone 견적 all`, `${T} @erin 견적 please`])
    // the chip and the typed words are one search; with no other text too
    expect(await tagged('erin', 'mentions:me', T, { sort: 'recent' })).toEqual([`${T} @everyone 견적 all`, `${T} @erin 견적 please`])
    expect((await search('erin', `mentions:me ${T}`)).filters).toMatchObject({ mentions: true, missing: [] })
    // with room= and from:
    expect(await tagged('erin', `mentions:me from:alice ${T}`, T, { room })).toHaveLength(2)
    expect(await tagged('bob', `mentions:me ${T}`, T, { room })).toEqual([`${T} @everyone by erin herself`, `${T} @everyone 견적 all`])
    expect(await tagged('bob', `mentions:me ${T}`, T)).toContain(`${T} @bob not for erin`)
    // a near match keeps it
    expect(bodies(await search('erin', `mentions:me ${T} pleese`)).every((b) => !b.includes('no mention'))).toBe(true)
    // someone else's mentions: nothing, said as a filter that matched nobody
    const p = await search('erin', `mentions:bob ${T}`)
    expect(p.items).toEqual([])
    expect(p.filters?.missing).toEqual(['mentions:bob'])
    // carol (not in either room) sees none of it
    expect((await search('carol', `mentions:me ${T}`)).items).toEqual([])
  })
})

describe('order', () => {
  test('best match: the whole text in order above a newer message with the words apart; newest first on recent', async () => {
    const room = await teamRoom(['alice', 'erin'])
    await send('alice', room, 'RANK-CANARY Q4 budget review on Friday')
    await send('alice', room, 'RANK-CANARY can you review the budget split')
    const T = 'RANK-CANARY'
    expect(await tagged('erin', `${T} budget review`, T, { sort: 'relevant' })).toEqual([`${T} Q4 budget review on Friday`, `${T} can you review the budget split`])
    expect(await tagged('erin', `${T} budget review`, T, { sort: 'recent' })).toEqual([`${T} can you review the budget split`, `${T} Q4 budget review on Friday`])
    // the default is newest first (older apps)
    expect(await tagged('erin', `${T} budget review`, T)).toEqual([`${T} can you review the budget split`, `${T} Q4 budget review on Friday`])
    // scores: as typed and as a whole word above a part of a word; a newer one above an older one when equal
    const parts = parseSearch('회의')
    const now = Date.parse('2026-11-19T00:00:00Z')
    expect(matchScore('회의 10시', parts, '2026-11-18T00:00:00Z', now)).toBeGreaterThan(matchScore('회의실 예약', parts, '2026-11-18T00:00:00Z', now))
    expect(matchScore('회의를 옮겼어요', parts, '2026-11-18T00:00:00Z', now)).toBeGreaterThan(matchScore('회의실 예약', parts, '2026-11-18T00:00:00Z', now))
    expect(matchScore('회의 10시', parts, '2026-11-18T00:00:00Z', now)).toBeGreaterThan(matchScore('회의 10시', parts, '2025-11-18T00:00:00Z', now))
    // a whole word from months ago above a part of a word from yesterday
    expect(matchScore('내일 회의 10시로', parts, '2026-04-15T00:00:00Z', now)).toBeGreaterThan(matchScore('회의실 예약은', parts, '2026-11-18T00:00:00Z', now))
  })

  test('best match pages: all of the pool, then newest first below it; no repeats, never a message twice', async () => {
    const room = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const start = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(room) as { last_seq: number }).last_seq
    const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', 'alice', 'room', ?, '[]', ?)`)
    const n = RELEVANT_POOL + 45
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(uuidv7(), room, start + i + 1, `POOL-CANARY ${i % 3 ? 'note' : 'POOL-CANARY twice'} ${i}`, new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString())
      db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(start + n, room)
    })()
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const p = searchRoomMessages(db, 'erin', { q: 'POOL-CANARY', sort: 'relevant', limit: 30, cursor })
      for (const i of p.items) { expect(seen.has(i.id)).toBe(false); seen.add(i.id) }
      cursor = p.nextCursor ?? undefined
      pages++
    } while (cursor && pages < 40)
    expect(seen.size).toBe(n)
    // a best-match cursor is refused on newest first (it is a place in another order)
    const first = searchRoomMessages(db, 'erin', { q: 'POOL-CANARY', sort: 'relevant', limit: 30 })
    expect((await h.req('erin', `/api/room-messages?q=POOL-CANARY&sort=recent&cursor=${first.nextCursor}`)).status).toBe(400)
    // a message sent between pages changes no later page of that order
    const second = searchRoomMessages(db, 'erin', { q: 'POOL-CANARY', sort: 'relevant', limit: 30, cursor: first.nextCursor! })
    await send('alice', room, 'POOL-CANARY POOL-CANARY POOL-CANARY newest')
    expect(searchRoomMessages(db, 'erin', { q: 'POOL-CANARY', sort: 'relevant', limit: 30, cursor: first.nextCursor! }).items.map((i) => i.id)).toEqual(second.items.map((i) => i.id))
    // a bad cursor is refused
    expect((await h.req('erin', `/api/room-messages?q=x&sort=relevant&cursor=${Buffer.from(JSON.stringify({ o: '-1' })).toString('base64url')}`)).status).toBe(400)
  })
})

describe('near matches', () => {
  test('nothing as typed: the words with a typing mistake, said as near; a match as typed wins', async () => {
    const room = await teamRoom(['alice', 'erin'])
    await send('alice', room, 'NEAR-CANARY Please receive the package at the front desk')
    await send('alice', room, 'NEAR-CANARY We deployed it to staging')
    const p = await search('erin', 'recieve package')
    expect(p.near).toBe(true)
    expect(bodies(p)).toEqual(['NEAR-CANARY Please receive the package at the front desk'])
    expect(p.items[0]!.snippet).toContain('receive')
    expect(bodies(await search('erin', 'stagign'))).toContain('NEAR-CANARY We deployed it to staging')
    // as typed: no near flag
    expect((await search('erin', 'receive')).near).toBeUndefined()
    // short words and words with other characters: as typed only
    expect((await search('erin', 'stg')).items).toEqual([])
    expect((await search('erin', 'NEAR-CANARZ')).items).toEqual([])
  })
})

// the size of the full-text index's tables: dbstat where this SQLite has it (the Linux Bun build of CI does not: "no such
// table: dbstat"), else the bytes of the shadow tables' blobs and text
function ftsBytes(db: { query: (sql: string) => { get: () => unknown; all: () => unknown } }): number {
  try {
    return ((db.query("SELECT SUM(pgsize) n FROM dbstat WHERE name LIKE 'room_messages_fts%'").get() as { n: number | null }).n) ?? 0
  } catch {
    const one = (sql: string) => { try { return ((db.query(sql).get() as { n: number | null }).n) ?? 0 } catch { return 0 } }
    return one('SELECT SUM(length(block)) n FROM room_messages_fts_data') + one('SELECT SUM(length(term) + 8) n FROM room_messages_fts_idx') + one('SELECT SUM(length(sz)) n FROM room_messages_fts_docsize')
  }
}

describe('on 100,000 messages', () => {
  test('fast enough on a small server: words, particles, filters, best match, near; the index size', async () => {
    const room = await teamRoom(['alice', 'erin', 'bob'])
    const ko = ['안녕하세요', '오늘 회의는', '견적서를 보내드릴게요', '내일까지', '디자인 시안', '확인 부탁드립니다', '감사합니다', '고객사 미팅', '자료 공유', '네 알겠습니다', '배포 일정', '인화원 연수']
    const en = ['the quarterly budget', 'deployed to staging', 'please review', 'meeting notes', 'shipping today', 'the client asked']
    const db = h.ctx.db
    const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, created_at, mentions) VALUES (?, ?, ?, 'user', ?, 'room', ?, ?, ?)`)
    const start = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(room) as { last_seq: number }).last_seq
    const before = ftsBytes(db)
    const N = 100_000
    const t0 = performance.now()
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        let b = ''
        for (let k = 0; k < 3 + (i * 7) % 10; k++) b += (k % 3 ? ko : en)[(i * 31 + k * 17) % (k % 3 ? ko.length : en.length)] + ' '
        if (i % 997 === 0) b += ' 특별견적 요청'
        if (i === 50_000) b += ' please recieve the parcel'
        // a rare mention of bob (a chip with no text walks far for it)
        ins.run(uuidv7(), room, start + i + 1, ['alice', 'erin', 'bob'][i % 3]!, b.trim(), new Date(Date.UTC(2025, 0, 1) + i * 300_000).toISOString(), i % 9973 === 1 ? '["bob"]' : '[]')
      }
      db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(start + N, room)
    })()
    const inserted = performance.now() - t0
    const after = ftsBytes(db)
    const text = (db.query('SELECT SUM(length(CAST(body AS BLOB))) n FROM room_messages WHERE room_id = ?').get(room) as { n: number }).n
    const times: Record<string, number> = {}
    const qs: [string, 'relevant' | 'recent', string?][] = [
      ['견적', 'recent'], ['견적서를', 'relevant'], ['회의를', 'relevant'], ['deploys', 'relevant'], ['"quarterly budget"', 'relevant'], ['특별견적', 'relevant'],
      ['from:erin 견적서', 'relevant'], ['in:@alice', 'recent'], ['from:me 인화원', 'recent'], ['없는말입니다', 'relevant'], ['parcle', 'relevant'], ['recieve', 'relevant'], ['stagign meetnig', 'relevant'], ['qaurterly', 'relevant'],
      // the chips with no text (docs/decisions/20261120-search-shortcuts-slack.md): Sent by me, Mentions me (rare: a far
      // walk), and This conversation with them
      ['from:me', 'relevant'], ['mentions:me', 'relevant'], ['mentions:me', 'recent', room], ['from:me mentions:me', 'relevant', room], ['견적', 'relevant', room],
      // a Korean verb's other forms (docs/decisions/20261121-ko-search-forms.md): found ("보낸" → 보내드릴게요, "확인했어요"
      // → 확인 부탁드립니다), and the slowest kind, a form with many whole forms found nowhere ("만든", "시간": a scan
      // of the index's text with every form)
      ['보낸', 'relevant'], ['확인했어요', 'relevant'], ['만든', 'relevant'], ['시간', 'recent'], ['어려워요 고객사', 'relevant'],
    ]
    for (const [q, sort, here] of qs) {
      const o = { q, sort, ...(here ? { room: here } : {}) }
      searchRoomMessages(db, 'bob', o)
      const runs: number[] = []
      for (let i = 0; i < 3; i++) { const t = performance.now(); searchRoomMessages(db, 'bob', o); runs.push(performance.now() - t) }
      times[`${q} (${sort}${here ? ', room' : ''})`] = Number(runs.sort((a, b) => a - b)[1]!.toFixed(1))
    }
    console.log(`room search on ${N} messages: insert ${inserted.toFixed(0)} ms; text ${(text / 1e6).toFixed(1)} MB, index +${((after - before) / 1e6).toFixed(1)} MB; median ms:`, JSON.stringify(times))
    // loose bounds (a busy machine runs these far slower)
    for (const [k, v] of Object.entries(times)) expect(v, k).toBeLessThan(1500)
    expect(searchRoomMessages(db, 'bob', { q: 'recieve', sort: 'relevant' }).items.map((i) => i.snippet).some((s) => s.includes('recieve'))).toBe(true)
    const near = searchRoomMessages(db, 'bob', { q: 'parcle', sort: 'relevant' })
    expect(near.near).toBe(true)
    expect(near.items[0]!.snippet).toContain('parcel')
    expect(searchRoomMessages(db, 'bob', { q: '특별견적', sort: 'relevant' }).items).toHaveLength(20)
    expect(searchRoomMessages(db, 'bob', { q: 'mentions:me', sort: 'recent', room }).items).toHaveLength(Math.ceil((N - 1) / 9973))
  })
})
