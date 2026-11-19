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
const search = (user: string, q: string, extra: { cursor?: string; limit?: number; sort?: 'relevant' | 'recent' } = {}) => h.api(user).call(API.searchRoomMessages, { query: { q, ...extra } }) as Promise<RoomSearchPage>
const bodies = (p: RoomSearchPage) => p.items.map((i) => i.snippet)
const tagged = async (user: string, q: string, tag: string, extra: { sort?: 'relevant' | 'recent' } = {}) => bodies(await search(user, q, extra)).filter((b) => b.includes(tag))
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
    expect(parseSearch('from:@bob in:#marketing 견적서를 "budget review"')).toEqual({ words: ['견적서를', 'budget review'], terms: ['견적서', 'budget review'], phrases: [false, true], from: ['bob'], in: ['marketing'] })
    expect(parseSearch('from:"Bob Lee" in:"Q4 launch" hi')).toMatchObject({ from: ['Bob Lee'], in: ['Q4 launch'], words: ['hi'] })
    expect(parseSearch('FROM:me 네')).toMatchObject({ from: ['me'], words: ['네'] })
    expect(parseSearch('"abc from: x')).toMatchObject({ words: ['"abc', 'from:', 'x'], from: [] })
    expect(parseSearch('x from:bob from:BOB')).toMatchObject({ from: ['bob'] })
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
    const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', ?, 'room', ?, '[]', ?)`)
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
        ins.run(uuidv7(), room, start + i + 1, ['alice', 'erin', 'bob'][i % 3]!, b.trim(), new Date(Date.UTC(2025, 0, 1) + i * 300_000).toISOString())
      }
      db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(start + N, room)
    })()
    const inserted = performance.now() - t0
    const after = ftsBytes(db)
    const text = (db.query('SELECT SUM(length(CAST(body AS BLOB))) n FROM room_messages WHERE room_id = ?').get(room) as { n: number }).n
    const times: Record<string, number> = {}
    const qs: [string, 'relevant' | 'recent'][] = [
      ['견적', 'recent'], ['견적서를', 'relevant'], ['회의를', 'relevant'], ['deploys', 'relevant'], ['"quarterly budget"', 'relevant'], ['특별견적', 'relevant'],
      ['from:erin 견적서', 'relevant'], ['in:@alice', 'recent'], ['from:me 인화원', 'recent'], ['없는말입니다', 'relevant'], ['parcle', 'relevant'], ['recieve', 'relevant'], ['stagign meetnig', 'relevant'], ['qaurterly', 'relevant'],
    ]
    for (const [q, sort] of qs) {
      searchRoomMessages(db, 'bob', { q, sort })
      const runs: number[] = []
      for (let i = 0; i < 3; i++) { const t = performance.now(); searchRoomMessages(db, 'bob', { q, sort }); runs.push(performance.now() - t) }
      times[`${q} (${sort})`] = Number(runs.sort((a, b) => a - b)[1]!.toFixed(1))
    }
    console.log(`room search on ${N} messages: insert ${inserted.toFixed(0)} ms; text ${(text / 1e6).toFixed(1)} MB, index +${((after - before) / 1e6).toFixed(1)} MB; median ms:`, JSON.stringify(times))
    // loose bounds (a busy machine runs these far slower)
    for (const [k, v] of Object.entries(times)) expect(v, k).toBeLessThan(1500)
    expect(searchRoomMessages(db, 'bob', { q: 'recieve', sort: 'relevant' }).items.map((i) => i.snippet).some((s) => s.includes('recieve'))).toBe(true)
    const near = searchRoomMessages(db, 'bob', { q: 'parcle', sort: 'relevant' })
    expect(near.near).toBe(true)
    expect(near.items[0]!.snippet).toContain('parcel')
    expect(searchRoomMessages(db, 'bob', { q: '특별견적', sort: 'relevant' }).items).toHaveLength(20)
  })
})
