// Scheduled run outcome (server/src/chat/schedule-outcome.ts; QA SCHED-03, R2-SKILL-10, B-W12-2, B-W26-3, CHAT-12):
// "the run ended" is not "the task worked". A scheduled run whose skill save was auto-refused (nobody can confirm in
// an unattended run) ends 'done' but is "finished with problems"; an engine error or an empty answer is "failed";
// otherwise "succeeded". The result is stored on the run, shown in the schedule list, and the inbox text follows it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { isLookUpTool, outcomeEvent, scheduleRunOutcome, storedRunOutcome } from '../../server/src/chat/schedule-outcome'
import { notificationsOf } from '../../server/src/notifications/service'
import { TEXT as PUSH_TEXT } from '../../server/src/notifications/text'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('outcome rules', () => {
  test('failed = not done or no answer; problems = done with a refused/failed tool; succeeded otherwise', () => {
    expect(scheduleRunOutcome({ status: 'done', content: 'Summary', failedTools: 0 })).toBe('succeeded')
    expect(scheduleRunOutcome({ status: 'done', content: 'Summary', failedTools: 1 })).toBe('problems')
    // paused at a per-answer limit before the task was done: someone should continue it
    expect(scheduleRunOutcome({ status: 'done', content: 'Half of it', failedTools: 0, limited: true })).toBe('problems')
    expect(scheduleRunOutcome({ status: 'done', content: '  \n', failedTools: 0 })).toBe('failed')
    for (const status of ['error', 'stopped', 'interrupted']) expect(scheduleRunOutcome({ status, content: 'x', failedTools: 0 })).toBe('failed')
  })
  test('look-ups are reads and searches; saves, sends, posts, memories and sub-tasks are not', () => {
    for (const t of ['web_fetch', 'read', 'grep', 'glob', 'list', 'drive_read', 'WebSearch', 'web_search', 'room_read', 'get_page_text']) expect(isLookUpTool(t)).toBe(true)
    for (const t of ['write', 'edit', 'make_file', 'save_url', 'remember', 'post_to_room', 'share_file', 'agent', 'move_files', 'my_notes__create_task', '', null]) expect(isLookUpTool(t)).toBe(false)
  })
  test('rows without a stored outcome (older builds, interrupted recovery) fall back to the status', () => {
    expect(storedRunOutcome({ status: 'done', run_outcome: null })).toBe('succeeded')
    expect(storedRunOutcome({ status: 'interrupted', run_outcome: null })).toBe('failed')
    expect(storedRunOutcome({ status: 'done', run_outcome: 'problems' })).toBe('problems')
    expect([outcomeEvent('succeeded'), outcomeEvent('problems'), outcomeEvent('failed')]).toEqual(['schedule.success', 'schedule.failure', 'schedule.failure'])
  })
  test('the generic lock-screen text for "needs attention" does not claim the task failed', () => {
    expect(PUSH_TEXT['schedule.failure'].ko).not.toContain('못했어요')
  })
})

describe('scheduled runs through the chat runtime', () => {
  // No WebSocket: a scheduled run has nobody watching, and the runtime does not need a connected window.
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'schedule-outcome', timeZone: 'Asia/Seoul', askUserTimeoutMs: 20_000 }) })
  afterAll(async () => { await h?.close() })

  /** create a one-time schedule, make it due now, run it and wait for the turn to end */
  async function run(user: string, title: string, prompt: string) {
    const rt = h.rt(), now = new Date()
    const made = rt.schedules.create(user, { title, prompt, repeat: 'once', date: '2099-01-01', time: '09:00' }, undefined, CONFIRMED)
    h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 1000).toISOString(), made.id)
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get(user, made.id)!.last_chat_id!
    await waitFor(() => !!h.ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('done','error','stopped','interrupted')").get(chatId), { timeoutMs: 30_000 })
    const turn = h.ctx.db.query('SELECT id, status, run_outcome FROM turns WHERE chat_id = ?').get(chatId) as { id: string; status: string; run_outcome: string }
    const n = notificationsOf(h.ctx)
    n.reconcile(user) // the hook already ran; reconciling again must not add or change anything
    const inbox = n.list(user, {}).items.filter((i) => i.sourceId === turn.id)
    const listed = (await h.api(user).call(API.listSchedules)).items.find((i) => i.id === made.id)!
    return { made, chatId, turn, inbox, listed }
  }

  test('a normal run succeeded: success notification and "done" in the list', async () => {
    const r = await run('alice', 'Normal', fake({ say: 'Here is the summary.' }))
    expect(r.turn).toMatchObject({ status: 'done', run_outcome: 'succeeded' })
    expect(r.inbox).toHaveLength(1)
    expect(r.inbox[0]).toMatchObject({ eventType: 'schedule.success', code: 'schedule.success', outcome: 'succeeded', chatId: r.chatId })
    expect(r.listed.lastOutcome).toBe('done')
  })

  test('an engine error failed: failure notification and "error" in the list', async () => {
    const r = await run('alice', 'Broken', fake({ fail: 'rate limit exceeded' }))
    expect(r.turn).toMatchObject({ status: 'error', run_outcome: 'failed' })
    expect(r.inbox).toHaveLength(1)
    expect(r.inbox[0]).toMatchObject({ eventType: 'schedule.failure', outcome: 'failed' })
    expect(r.listed.lastOutcome).toBe('error')
  })

  test('a skill save auto-refused in an unattended run is "finished with problems", not "completed" (R2-SKILL-10)', async () => {
    const r = await run('carol', 'Team rule', fake({ tool: 'write', args: { file_path: 'skills/예약-QA.md', content: '# 예약 QA\n- 오늘 날짜\n' }, sayResult: true }))
    // the run itself ended normally with an answer …
    expect(r.turn.status).toBe('done')
    // … but its write was refused because nobody could confirm it, and the AI is told so: never "the user did not allow"
    // for a card nobody saw (docs/DECISIONS.md "Refusals say why, who and what next")
    const said = (h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(r.chatId) as { content: string }).content
    expect(said).toContain("Nothing was saved to 'skills/예약-QA.md' in skills/")
    expect(said).toContain('Why: nobody could be asked: this is a scheduled run')
    expect(said).not.toContain('did not allow')
    expect(h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").get(r.turn.id)).toEqual({ summary: 'write -> nobody to ask (scheduled run) (team skills)', ok: 0 })
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'skills.ai_write_refused' AND target = 'skills/예약-QA.md'").get() as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ turnId: r.turn.id, answer: 'none' })
    expect(r.turn.run_outcome).toBe('problems')
    expect(r.inbox).toHaveLength(1)
    expect(r.inbox[0]).toMatchObject({ eventType: 'schedule.failure', code: 'schedule.failure', outcome: 'problems', chatId: r.chatId })
    expect(r.listed.lastOutcome).toBe('problems')
    // the finished one-time task cannot be turned on again; the API says why
    expect(r.listed).toMatchObject({ enabled: false, resumeBlockedReason: 'completed' })
    const res = await h.req('carol', `/api/schedules/${r.made.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatchObject({ code: 'conflict', params: { reason: 'schedule_completed' } })
  })

  test('a briefing whose page reads failed but whose answer is complete succeeded (look-ups need nobody)', async () => {
    // a web search, then pages it could not open: an address the chat never showed (its card cannot be shown in a
    // scheduled run, so it is refused), a file that is not there; the AI answers from what it found
    const r = await run('alice', 'News briefing', fake(
      { webSearch: { query: 'today news', hits: [{ title: 'A', url: 'https://news.example/a' }] } },
      { tool: 'web_fetch', args: { url: 'https://unseen.example/today' } },
      { tool: 'read', args: { file_path: 'users/alice/not-there.md' } },
      { tool: 'grep', args: { pattern: '(' } },
      { say: '오늘의 뉴스 브리핑: 세계 3건, 한국 3건, 인도네시아 2건.' },
    ))
    expect(r.turn.status).toBe('done')
    const refused = h.ctx.db.query("SELECT tool FROM tool_events WHERE turn_id = ? AND ok = 0 ORDER BY id").all(r.turn.id) as { tool: string }[]
    expect(refused.map((x) => x.tool)).toContain('web_fetch')
    expect(refused.map((x) => x.tool)).toContain('read')
    expect(r.turn.run_outcome).toBe('succeeded')
    expect(r.inbox[0]).toMatchObject({ eventType: 'schedule.success', outcome: 'succeeded' })
    expect(r.listed.lastOutcome).toBe('done')
  })

  test('a refused save still makes the run "with problems", also after failed reads (TC-019)', async () => {
    const r = await run('carol', 'Save after reads', fake(
      { tool: 'web_fetch', args: { url: 'https://unseen.example/b' } },
      { tool: 'write', args: { file_path: 'skills/브리핑.md', content: '# 브리핑\n' } },
      { say: 'Done.' },
    ))
    expect(h.ctx.db.query("SELECT ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").get(r.turn.id)).toEqual({ ok: 0 })
    expect(r.turn).toMatchObject({ status: 'done', run_outcome: 'problems' })
    expect(r.listed.lastOutcome).toBe('problems')
  })

  test('an empty answer after failed reads failed; a run cut off by an engine error failed', async () => {
    const empty = await run('alice', 'Empty', fake({ tool: 'web_fetch', args: { url: 'https://unseen.example/c' } }))
    expect(empty.turn.run_outcome).toBe('failed')
    expect(empty.listed.lastOutcome).toBe('error')
    const broken = await run('alice', 'Cut off', fake({ say: 'Part one.' }, { fail: 'overloaded' }))
    expect(broken.turn).toMatchObject({ status: 'error', run_outcome: 'failed' })
  })

  test('the list keeps a problems result even after an older inbox build would call it success', () => {
    // legacy rows (no run_outcome) still read as before: done = success
    h.ctx.db.query('INSERT INTO chats(id,user_id,title) VALUES(?,?,?)').run('legacy-chat', 'alice', 'legacy')
    h.ctx.db.query("INSERT INTO schedules(id,user_id,title,prompt,repeat,time,date,enabled) VALUES('legacy-s','alice','Legacy','x x x','once','09:00','2099-01-01',0)").run()
    h.ctx.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,ended_at,schedule_id,scheduled_for) VALUES('legacy-t','legacy-chat','alice','claude-code','done',?,'legacy-s','legacy')").run(new Date().toISOString())
    expect(h.rt().schedules.lastOutcome('alice', 'legacy-s')).toBe('done')
    notificationsOf(h.ctx).reconcile('alice')
    expect(notificationsOf(h.ctx).list('alice', {}).items.find((i) => i.sourceId === 'legacy-t')).toMatchObject({ eventType: 'schedule.success', outcome: 'succeeded' })
  })
})
