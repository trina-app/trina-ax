// Demo replays (server/src/demo/replay.ts; docs/DECISIONS.md "Demo company: a new hire at 트리나", round 2). On a demo
// server a demo person's first message that is exactly one of their recorded prompts plays the recorded real answer:
// its text, and its team tool calls made again through the turn's own tools as that person, so the files it shows are
// made now by the product. Never off a demo server, never for someone else or another message; a second replay makes
// new files instead of failing on the first one's; the step trail carries the "prepared in advance" note.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TEAM_TOOL_PREFIX, type EngineEvent } from '@mycel/shared'
import { API, type DemoFile, type DemoRecording } from '@mycel/shared/api'
import { demoReplayFor, freeName, replayPause, runReplay } from '../../server/src/demo/replay'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const T = TEAM_TOOL_PREFIX
const rec = (o: Partial<DemoRecording> = {}): DemoRecording => ({
  v: 1, username: 'alice', userId: 'alice', prompt: '카드뉴스 만들어 줘', kind: 'showcase', recordedAt: '2026-11-05T00:00:00.000Z', engine: 'claude-code', model: 'claude-test',
  events: [
    { type: 'text', t: 0, text: '캠페인 기획을 읽고 users/alice/카드뉴스.md로 저장할게요.' },
    { type: 'tool', t: 1000, name: `${T}read`, input: { file_path: 'shared/plan.md' }, ok: true, ms: 200 },
    { type: 'tool', t: 2000, name: 'TodoWrite', input: { todos: [] }, ok: true, output: 'ok', ms: 10 },
    { type: 'tool', t: 3000, name: `${T}write`, input: { file_path: 'users/alice/카드뉴스.md', content: '# 1장' }, ok: true, ms: 300 },
    { type: 'text', t: 4000, text: '저장했어요: users/alice/카드뉴스.md' },
  ],
  ...o,
})

describe('runReplay (no server)', () => {
  const run = async (r: DemoRecording, o: { exists?: (p: string) => boolean; userId?: string; fast?: boolean; fail?: boolean } = {}) => {
    const events: EngineEvent[] = []
    const calls: any[] = []
    const res = await runReplay(r, {
      rpc: async (m: any) => { calls.push(m); return o.fail ? { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Access denied: not found or no access' }], isError: true } } : { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `did ${m.params.name}` }] } } },
      emit: (e) => events.push(e), signal: new AbortController().signal, userId: o.userId ?? 'alice', exists: o.exists ?? (() => false), fast: o.fast, sleep: async () => {},
    })
    return { events, calls, res, text: events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('') }
  }

  test('text and steps as recorded; team tools called again, the engine\'s own only shown', async () => {
    const { events, calls, res, text } = await run(rec())
    expect(text).toBe('캠페인 기획을 읽고 users/alice/카드뉴스.md로 저장할게요.\n\n저장했어요: users/alice/카드뉴스.md')
    expect(calls.map((c) => [c.method, c.params.name, c.params.arguments.file_path ?? null, c.params._meta['claudecode/toolUseId']])).toEqual([
      ['tools/call', 'read', 'shared/plan.md', 'replay-1'], ['tools/call', 'write', 'users/alice/카드뉴스.md', 'replay-3'],
    ])
    const tools = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => `${e.type}:${'name' in e ? e.name : e.ok}`)
    expect(tools).toEqual([`tool_start:${T}read`, 'tool_end:true', 'tool_start:TodoWrite', 'tool_end:true', `tool_start:${T}write`, 'tool_end:true'])
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(res.failed).toBe(0)
  })

  test('a file that is there already: the next free name, in the call and in every word of the answer', async () => {
    const there = new Set(['users/alice/카드뉴스.md', 'users/alice/카드뉴스-2.md'])
    const { calls, text } = await run(rec(), { exists: (p) => there.has(p) })
    expect(calls[1].params.arguments.file_path).toBe('users/alice/카드뉴스-3.md')
    const linked = await run(rec({ events: [{ type: 'tool', t: 0, name: `${T}write`, input: { file_path: 'users/alice/카드뉴스.md', content: 'x' }, ok: true }, { type: 'text', t: 1, text: `[카드뉴스](/files/view?path=${encodeURIComponent('users/alice/카드뉴스.md')})` }] }), { exists: (p) => there.has(p) })
    expect(linked.text).toBe(`[카드뉴스](/files/view?path=${encodeURIComponent('users/alice/카드뉴스-3.md')})`)
    const named = await run(rec({ events: [{ type: 'tool', t: 0, name: `${T}write`, input: { file_path: 'users/alice/카드뉴스.md', content: 'x' }, ok: true }, { type: 'text', t: 1, text: '📄 [카드뉴스.md](/files/view?path=users%2Falice%2F%EC%B9%B4%EB%93%9C%EB%89%B4%EC%8A%A4.md)' }] }), { exists: (p) => there.has(p) })
    expect(named.text).toBe(`📄 [카드뉴스-3.md](/files/view?path=${encodeURIComponent('users/alice/카드뉴스-3.md')})`)
    expect(text).toContain('users/alice/카드뉴스-3.md로 저장할게요')
    expect(text).not.toContain('카드뉴스.md')
    expect(freeName('a/b.tar.xlsx', (p) => p === 'a/b.tar.xlsx')).toBe('a/b.tar-2.xlsx')
  })

  test('a folder the answer made in the person\'s own folder, there already: the whole folder gets the next name', async () => {
    const r = rec({ events: [
      { type: 'tool', t: 0, name: `${T}write`, input: { file_path: 'users/alice/카드뉴스/images/.keep', content: '' }, ok: true },
      { type: 'tool', t: 1, name: `${T}copy_files`, input: { paths: ['groups/m/a.png'], to_folder: 'users/alice/카드뉴스/images' }, ok: true },
      { type: 'tool', t: 2, name: `${T}write`, input: { file_path: 'users/alice/카드뉴스/카드.html', content: '<img src="images/a.png">' }, ok: true },
      { type: 'text', t: 3, text: '[카드](users/alice/카드뉴스/카드.html)' }] })
    const there = new Set(['users/alice/카드뉴스', 'users/alice/카드뉴스/카드.html', 'users/alice/카드뉴스/images'])
    const { calls, text } = await run(r, { exists: (p) => there.has(p) })
    expect(calls.map((c) => c.params.arguments.file_path ?? c.params.arguments.to_folder)).toEqual(['users/alice/카드뉴스-2/images/.keep', 'users/alice/카드뉴스-2/images', 'users/alice/카드뉴스-2/카드.html'])
    expect(text).toBe('[카드](users/alice/카드뉴스-2/카드.html)')
    // a file straight in the person's folder or in a team folder keeps its folder
    const flat = await run(rec(), { exists: (p) => p === 'users/alice/카드뉴스.md' })
    expect(flat.calls[1].params.arguments.file_path).toBe('users/alice/카드뉴스-2.md')
  })

  test('another person\'s id in paths becomes this person\'s; a failed call is counted, the answer goes on', async () => {
    const { calls, res, text } = await run(rec({ userId: 'jiwoo-old' , events: [{ type: 'tool', t: 0, name: `${T}write`, input: { file_path: 'users/jiwoo-old/x.md', content: 'x' }, ok: true }, { type: 'text', t: 1, text: 'users/jiwoo-old/x.md' }] }), { userId: 'jiwoo', fail: true })
    expect(calls[0].params.arguments.file_path).toBe('users/jiwoo/x.md')
    expect(text).toBe('users/jiwoo/x.md')
    expect(res.failed).toBe(1)
  })

  test('a showcase streams in small pieces with pauses; a past chat at once', async () => {
    const long = rec({ events: [{ type: 'text', t: 0, text: '가'.repeat(100) }] })
    const slow = await run(long)
    expect(slow.events.filter((e) => e.type === 'text').length).toBeGreaterThan(3)
    const fast = await run(long, { fast: true })
    expect(fast.events.filter((e) => e.type === 'text').length).toBe(1)
    expect([replayPause(0), replayPause(3000), replayPause(60_000)]).toEqual([150, 900, 1800])
  })
})

describe('demoReplayFor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-replay-'))
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(rec()))
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"v": 2}')
  const demo: DemoFile = { company: 'Acme', password: 'demo words 1234', replays: dir, personas: [{ key: 'newHire', username: 'alice', intro: 'x', questions: [] }, { key: 'lead', username: 'bob', intro: 'y', questions: [] }] }
  const ctx = (config: Record<string, unknown>) => ({ config: { mode: 'dev', ...config }, log: { warn() {} } }) as never
  const q = { username: 'alice', content: '카드뉴스  만들어 줘 ', first: true, scheduled: false, attachments: false }
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('only on a demo server, only the person it was recorded for, only their first plain message', () => {
    expect(demoReplayFor(ctx({ demo }), q)?.prompt).toBe('카드뉴스 만들어 줘')
    expect(demoReplayFor(ctx({}), q)).toBeNull()
    expect(demoReplayFor(ctx({ demo: { ...demo, replays: undefined } }), q)).toBeNull()
    expect(demoReplayFor(ctx({ demo, mode: 'prod' }), q)).toBeNull()
    expect(demoReplayFor(ctx({ demo, deployment: 'hosted' }), q)).toBeNull()
    expect(demoReplayFor(ctx({ demo, office: true }), q)).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, username: 'bob' })).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, username: 'carol' })).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, first: false })).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, scheduled: true })).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, attachments: true })).toBeNull()
    expect(demoReplayFor(ctx({ demo }), { ...q, content: '카드뉴스 만들어 줘 그리고 하나 더' })).toBeNull()
  })
})

describe('a replayed answer in a real chat turn', () => {
  let h: Harness
  let sock: TestSocket
  let bobSock: TestSocket
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-replay-turn-'))
  beforeAll(async () => {
    h = await startHarness({ name: 'b-demo-replay', turnTimeoutMs: 60_000 })
    fs.mkdirSync(path.join(h.team, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'shared', 'plan.md'), '# 11월 캠페인\n')
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(rec()))
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(rec({ kind: 'history', daysAgo: 3, prompt: '지난주 일 정리해 줘', events: [
      { type: 'tool', t: 0, name: `${T}set_title`, input: { title: '지난주 정리' }, ok: true }, { type: 'text', t: 500, text: '정리했어요.' }] })))
    ;(h.ctx.config as { demo?: DemoFile }).demo = { company: 'Acme', password: 'demo words 1234', replays: dir, personas: [{ key: 'newHire', username: 'alice', intro: 'x', questions: [] }] }
    sock = await h.ws('alice', { windowId: 'win-replay-a' }); await sock.next('hello')
    bobSock = await h.ws('bob', { windowId: 'win-replay-b' }); await bobSock.next('hello')
  })
  afterAll(async () => { sock?.close(); bobSock?.close(); await h?.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  test('the answer, its steps with the note, and the file made now by the write tool, as alice', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, sock, 'alice', chat.id, '카드뉴스 만들어 줘')
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('캠페인 기획을 읽고 users/alice/카드뉴스.md로 저장할게요.\n\n저장했어요: users/alice/카드뉴스.md')
    expect(r.done.steps[0]).toMatchObject({ tool: 'demo_replay', label: 'Prepared in advance for the demo', status: 'ok' })
    expect(r.done.steps.filter((s) => s.tool === 'read' || s.tool === 'write').map((s) => s.status)).toEqual(['ok', 'ok'])
    expect(fs.readFileSync(path.join(h.team, 'users', 'alice', '카드뉴스.md'), 'utf8')).toBe('# 1장')
    expect(r.done.files?.saved.map((f) => f.path)).toEqual(['users/alice/카드뉴스.md'])
    // made by the tool as alice, in this turn
    const events = h.ctx.db.query("SELECT tool, ok FROM tool_events WHERE turn_id = ? AND tool IN ('read', 'write') ORDER BY id").all(r.started.turnId)
    expect(events).toEqual([{ tool: 'read', ok: 1 }, { tool: 'write', ok: 1 }])
  })

  test('the same showcase again makes a second file; another message or another person gets the engine', async () => {
    const again = await ask(h, sock, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, '카드뉴스 만들어 줘')
    expect(again.done.content).toContain('users/alice/카드뉴스-2.md')
    expect(fs.existsSync(path.join(h.team, 'users', 'alice', '카드뉴스-2.md'))).toBe(true)
    // not the recorded prompt: the (fake) engine answers, no note
    const other = await ask(h, sock, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, '@fake {"say":"engine here"}')
    expect(other.done.steps.some((s) => s.tool === 'demo_replay')).toBe(false)
    // bob is not the person it was recorded for
    const bob = await ask(h, bobSock, 'bob', (await h.api('bob').call(API.createChat, { body: {} })).id, '카드뉴스 만들어 줘')
    expect(bob.done.steps.some((s) => s.tool === 'demo_replay')).toBe(false)
    expect(fs.existsSync(path.join(h.team, 'users', 'bob', '카드뉴스.md'))).toBe(false)
  })

  test('a past chat: replayed at once, named as recorded, and it says it was days ago', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, sock, 'alice', chat.id, '지난주 일 정리해 줘')
    expect(r.done.content).toBe('정리했어요.')
    const row = h.ctx.db.query('SELECT title, created_at, updated_at FROM chats WHERE id = ?').get(chat.id) as { title: string; created_at: string; updated_at: string }
    expect(row.title).toBe('지난주 정리')
    const days = (Date.now() - Date.parse(row.updated_at)) / 86_400_000
    expect(days).toBeGreaterThan(2.9)
    expect(days).toBeLessThan(3.1)
    const msgs = h.ctx.db.query('SELECT created_at FROM messages WHERE chat_id = ?').all(chat.id) as { created_at: string }[]
    for (const m of msgs) expect((Date.now() - Date.parse(m.created_at)) / 86_400_000).toBeGreaterThan(2.9)
  })

  test('without the demo flag the same message goes to the engine', async () => {
    const was = (h.ctx.config as { demo?: DemoFile }).demo
    delete (h.ctx.config as { demo?: DemoFile }).demo
    try {
      const r = await ask(h, sock, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, '카드뉴스 만들어 줘')
      expect(r.done.steps.some((s) => s.tool === 'demo_replay')).toBe(false)
      expect(fs.existsSync(path.join(h.team, 'users', 'alice', '카드뉴스-3.md'))).toBe(false)
    } finally { (h.ctx.config as { demo?: DemoFile }).demo = was }
  })
})
