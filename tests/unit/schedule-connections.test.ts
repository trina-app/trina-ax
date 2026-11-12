// The schedule card offers only the connections the task names (docs/DECISIONS.md "The schedule card offers only the
// connections the task names"). Every card named every "allow" team connection the person could use: a one-time news
// briefing asked whether it may send to an image service the team once added as an example. Now:
//  - a connection is on the card (its line and the "with sends" answer) only when the task names it: its whole name in
//    the title or the instruction, or schedule_create's `connections` (by name, slug or team_<slug> key); otherwise the
//    card has no connections line, the plain answers, and runs send nowhere (`write_connections` stays empty)
//  - a name in `connections` that is not an "allow" team connection is refused before the card, nothing created
//  - the same rule on the edit card (plus the connections the task may already send to) and on "다시 확인"
//  - the card's answer is bound to the connections it offers, not to every "allow" connection
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ApiError, type ScheduleTaskEdit } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import type { ScheduleRow } from '../../server/src/chat/schedules'
import { noteEgressIp } from '../../server/src/tools/egress'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import type { ConfirmExtra, TurnPerson } from '../../server/src/tools/url-gate'
import { listedConnections, taskConnections, TEXT, writableConnections } from '../../server/src/tools/schedules'

setDefaultTimeout(60_000)

let h: Harness
const conn: Record<'higgs' | 'board' | 'chat' | 'mine', string> = { higgs: '', board: '', chat: '', mine: '' }
function connection(name: string, slug: string, policy: 'allow' | 'ask', scope: 'team' | 'personal' = 'team'): string {
  const id = uuidv7()
  h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, kind, name, slug, url, auth, write_policy, status, created_at, updated_at)
    VALUES (?, ?, ?, 'mcp', ?, ?, ?, 'none', ?, 'connected', 'x', 'x')`).run(id, scope, scope === 'personal' ? 'bob' : null, name, slug, `https://${slug}.example/mcp`, policy)
  if (scope === 'team') h.ctx.db.query("INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(id)
  return id
}
beforeAll(async () => {
  h = await startHarness({ name: 'schedule-connections', timeZone: 'Asia/Seoul', askUserTimeoutMs: 3000 })
  noteEgressIp(h.ctx, '198.51.100.7')
  // the team's example image service and a board, both "send without asking"; a chat service that asks; bob's own
  conn.higgs = connection('Higgsfield', 'higgsfield', 'allow')
  conn.board = connection('Team board', 'board', 'allow')
  conn.chat = connection('Acme Chat', 'acmechat', 'ask')
  conn.mine = connection('Bob Notes', 'bobnotes', 'allow', 'personal')
})
afterAll(async () => { await h?.close() })

const day = () => new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10)
const news = { title: '오늘의 뉴스 브리핑', prompt: '오늘의 주요 뉴스를 찾아 다섯 줄로 요약해서 users/bob/news.md에 저장해 줘.', repeat: 'once', time: '09:00' }
type Asked = { question: string; extra?: ConfirmExtra; options: { label: string; value: string }[] }
function person(answer: string, asked: Asked[]): TurnPerson {
  return {
    locale: 'ko',
    async confirm(question, _a, _d, extra) { asked.push({ question, extra, options: [] }); return answer === 'create' },
    async choose(question, options, extra) { asked.push({ question, extra, options }); return answer },
    turnUrls: () => [],
  }
}
const create = (args: Record<string, unknown>, p: TurnPerson) =>
  toolRegistry(h.ctx.files).call('schedule_create', { ...news, date: day(), ...args }, { user: h.ctx.files.principal('bob'), turnId: null, files: new TurnFiles(), person: p })
const latest = () => h.ctx.db.query("SELECT * FROM schedules WHERE user_id = 'bob' ORDER BY created_at DESC, id DESC LIMIT 1").get() as ScheduleRow | null
const row = (id: string) => h.ctx.db.query('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
const clear = () => h.ctx.db.query("DELETE FROM schedules WHERE user_id = 'bob'").run()
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error') }, (e: unknown) => e as ApiError)
const line = (names: string) => TEXT.connections.ko.replace('{names}', names)

describe('which connections a task names', () => {
  test('the whole name in the title or instruction, any case, a Korean particle after it; listed by name, slug or key', () => {
    const writable = writableConnections(h.ctx, 'bob')
    // only team "allow" connections: not the one that asks, not bob's own
    expect(writable.map((r) => r.name).sort()).toEqual(['Higgsfield', 'Team board'])
    const names = (t: { title: string; prompt: string }, also?: Set<string>) => taskConnections(writable, t, also).map((r) => r.name).sort()
    expect(names(news)).toEqual([])
    expect(names({ title: news.title, prompt: '뉴스를 요약해서 higgsfield로 카드 이미지를 만들어 줘.' })).toEqual(['Higgsfield'])
    expect(names({ title: 'Higgsfield 카드', prompt: news.prompt })).toEqual(['Higgsfield'])
    expect(names({ title: 'Weekly', prompt: 'Post it to the team board.' })).toEqual(['Team board'])
    // part of a longer Latin word is not the name
    expect(names({ title: 'w', prompt: 'Read the Higgsfields archive and the team boards list.' })).toEqual([])
    expect(names(news, new Set([conn.higgs]))).toEqual(['Higgsfield'])
    expect(listedConnections(writable, ['higgsfield', ' Team Board ', 'team_board'])).toEqual({ ids: new Set([conn.higgs, conn.board]), unknown: [] })
    expect(listedConnections(writable, ['Acme Chat', 'Bob Notes', 'Slack', ''])).toEqual({ ids: new Set(), unknown: ['Acme Chat', 'Bob Notes', 'Slack'] })
  })
})

describe('schedule_create', () => {
  test('a news briefing with an "allow" image service on the team: no connections line, the plain answers, no sends', async () => {
    clear()
    const asked: Asked[] = []
    const r = await create({}, person('create', asked))
    expect(r.isError).toBeFalsy()
    const card = asked[0]!
    expect(card.question).toContain('제목: 오늘의 뉴스 브리핑')
    expect(card.question).not.toContain('Higgsfield')
    expect(card.question).not.toContain(TEXT.connections.ko.split(':')[0]!)
    expect(card.options.map((o) => o.value)).toEqual(['create', 'deny'])
    expect(card.options.map((o) => o.label)).toEqual([TEXT.create.ko, TEXT.deny.ko])
    expect(latest()!.write_connections).toBeNull()
    expect(r.text).not.toContain('connected services')
    expect(r.summary).not.toContain('may send')
  })

  test('the instruction names the service: its line and the answer with sends; only that one is allowed', async () => {
    clear()
    const asked: Asked[] = []
    const r = await create({ prompt: '오늘의 주요 뉴스를 요약해서 Higgsfield로 카드 이미지를 만들어 줘.' }, person('create_write', asked))
    const card = asked[0]!
    expect(card.question).toContain(line('Higgsfield'))
    expect(card.question).not.toContain('Team board')
    expect(card.options.map((o) => o.value)).toEqual(['create_write', 'create', 'deny'])
    expect(JSON.parse(latest()!.write_connections!)).toEqual([conn.higgs])
    expect(r.text).toContain('Its runs may send to Higgsfield without asking.')
    expect(r.summary).toContain('may send to 1 connections')
  })

  test('the AI names it in `connections` (by key here): the same card; "create" without sends stores none and says so', async () => {
    clear()
    const asked: Asked[] = []
    const r = await create({ connections: ['team_board'] }, person('create', asked))
    const card = asked[0]!
    expect(card.question).toContain(line('Team board'))
    expect(card.question).not.toContain('Higgsfield')
    expect(card.options.map((o) => o.value)).toEqual(['create_write', 'create', 'deny'])
    expect(latest()!.write_connections).toBeNull()
    expect(r.text).toContain('never send to connected services')
    // both: named in the instruction and listed
    const both: Asked[] = []
    await create({ prompt: 'Post the news summary to the team board.', connections: ['Higgsfield'] }, person('create_write', both))
    expect(both[0]!.question).toContain(line('Higgsfield, Team board'))
    expect(JSON.parse(latest()!.write_connections!).sort()).toEqual([conn.higgs, conn.board].sort())
  })

  test('a name that is not an "allow" team connection is refused before the card, nothing created', async () => {
    clear()
    for (const name of ['Slack', 'Acme Chat']) {
      const asked: Asked[] = []
      const r = await create({ connections: ['Higgsfield', name] }, person('create_write', asked))
      expect(r.isError).toBe(true)
      expect(r.text).toContain(`"${name}" is not one of them, so nothing was created`)
      expect(r.text).toContain('Higgsfield, Team board')
      expect(asked).toHaveLength(0)
      expect(latest()).toBeNull()
    }
    // the person's own connection: only with the recipients the card pins (send_to; schedule-save-scope.test.ts)
    const asked: Asked[] = []
    const r = await create({ connections: ['Higgsfield', 'Bob Notes'] }, person('create_write', asked))
    expect(r.isError).toBe(true)
    expect(r.text).toContain("Bob Notes is the user's own connection: a run sends to it only at recipients the card pins, so give them in send_to")
    expect(asked).toHaveLength(0)
    expect(latest()).toBeNull()
  })
})

describe('edit and 다시 확인', () => {
  const edit = (s: ScheduleRow, o: Partial<ScheduleTaskEdit> = {}): ScheduleTaskEdit => ({ kind: 'task', title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date, projectId: s.project_id, ...o })
  const make = (prompt: string, writeConnections: string[]) => h.rt().schedules.create('bob', { title: news.title, prompt, repeat: 'daily', time: '09:00' }, undefined, { allowedUrls: [], writeConnections })

  test('edit: only named connections, and the ones the task may already send to; an unrelated one changing keeps the card', async () => {
    clear()
    const s = make(news.prompt, [])
    const card = (await h.api('bob').call(API.scheduleEditCard, { params: { id: s.id }, body: edit(s, { time: '08:00' }) })).request
    expect(card.question).not.toContain('Higgsfield')
    expect(card.options!.map((o) => o.value)).toEqual(['save', 'cancel'])
    // a connection the task does not name changes: the card the person saw still holds
    h.ctx.db.query('UPDATE integrations SET version = version + 1 WHERE id = ?').run(conn.higgs)
    // (the card still matches: only its own answers are refused, not the card as changed)
    const notOption = await failure(h.api('bob').call(API.editSchedule, { params: { id: s.id }, body: { ...edit(s, { time: '08:00' }), requestId: card.requestId, answer: 'save_write' } }))
    expect(notOption.status).toBe(400)
    expect(notOption.body.params?.reason).not.toBe('schedule_card_changed')
    await h.api('bob').call(API.editSchedule, { params: { id: s.id }, body: { ...edit(s, { time: '08:00' }), requestId: card.requestId, answer: 'save' } })
    expect(row(s.id)).toMatchObject({ time: '08:00', write_connections: null })
    // naming it in the instruction puts it on the card
    const named = edit(row(s.id), { prompt: `${news.prompt} 그리고 Higgsfield로 카드 이미지도 만들어 줘.` })
    const c2 = (await h.api('bob').call(API.scheduleEditCard, { params: { id: s.id }, body: named })).request
    expect(c2.question).toContain(line('Higgsfield'))
    expect(c2.options!.map((o) => o.value)).toEqual(['save_write', 'save', 'cancel'])
    await h.api('bob').call(API.editSchedule, { params: { id: s.id }, body: { ...named, requestId: c2.requestId, answer: 'save_write' } })
    expect(JSON.parse(row(s.id).write_connections!)).toEqual([conn.higgs])
    // a task allowed to send to one it does not name (listed by the AI at creation): an edit of the time keeps it on offer
    const listed = make(news.prompt, [conn.board])
    const c3 = (await h.api('bob').call(API.scheduleEditCard, { params: { id: listed.id }, body: edit(listed, { time: '07:30' }) })).request
    expect(c3.question).toContain(line('Team board'))
    expect(c3.question).not.toContain('Higgsfield')
    await h.api('bob').call(API.editSchedule, { params: { id: listed.id }, body: { ...edit(listed, { time: '07:30' }), requestId: c3.requestId, answer: 'save_write' } })
    expect(JSON.parse(row(listed.id).write_connections!)).toEqual([conn.board])
    // one it may send to that now asks before each change: no longer on the card, so saving drops it
    h.ctx.db.query("UPDATE integrations SET write_policy = 'ask', version = version + 1 WHERE id = ?").run(conn.board)
    try {
      const c4 = (await h.api('bob').call(API.scheduleEditCard, { params: { id: listed.id }, body: edit(row(listed.id), { time: '07:00' }) })).request
      expect(c4.question).not.toContain('Team board')
      expect(c4.options!.map((o) => o.value)).toEqual(['save', 'cancel'])
      await h.api('bob').call(API.editSchedule, { params: { id: listed.id }, body: { ...edit(row(listed.id), { time: '07:00' }), requestId: c4.requestId, answer: 'save' } })
      expect(row(listed.id).write_connections).toBeNull()
    } finally { h.ctx.db.query("UPDATE integrations SET write_policy = 'allow' WHERE id = ?").run(conn.board) }
  })

  test('다시 확인: a task nobody confirmed is offered only the connections it names', async () => {
    clear()
    const legacy = (prompt: string) => {
      const id = uuidv7()
      h.ctx.db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, enabled, review_since) VALUES (?, 'bob', ?, ?, 'daily', '09:00', 0, ?)").run(id, news.title, prompt, new Date().toISOString())
      return id
    }
    const quiet = legacy(news.prompt)
    const c1 = (await h.api('bob').call(API.getScheduleReview, { params: { id: quiet } })).request
    expect(c1.question).not.toContain('Higgsfield')
    expect(c1.options!.map((o) => o.value)).toEqual(['resume', 'keep'])
    // a connection the task does not name changes: the card still holds (only its own answers count)
    h.ctx.db.query('UPDATE integrations SET version = version + 1 WHERE id = ?').run(conn.higgs)
    const notOption = await failure(h.api('bob').call(API.confirmScheduleReview, { params: { id: quiet }, body: { requestId: c1.requestId, answer: 'resume_write' } }))
    expect(notOption.status).toBe(400)
    expect(notOption.body.params?.reason).not.toBe('schedule_card_changed')
    await h.api('bob').call(API.confirmScheduleReview, { params: { id: quiet }, body: { requestId: c1.requestId, answer: 'resume' } })
    expect(row(quiet)).toMatchObject({ enabled: 1, write_connections: null })
    const named = legacy('매일 아침 뉴스를 요약해서 팀 게시판이 아니라 Team board에 올려 줘.')
    const c2 = (await h.api('bob').call(API.getScheduleReview, { params: { id: named } })).request
    expect(c2.question).toContain(line('Team board'))
    expect(c2.options!.map((o) => o.value)).toEqual(['resume_write', 'resume', 'keep'])
    await h.api('bob').call(API.confirmScheduleReview, { params: { id: named }, body: { requestId: c2.requestId, answer: 'resume_write' } })
    expect(JSON.parse(row(named).write_connections!)).toEqual([conn.board])
  })
})
