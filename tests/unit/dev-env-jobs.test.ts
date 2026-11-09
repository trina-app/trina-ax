// Dev environment jobs and box stops (docs/DECISIONS.md "Dev environment: disk floor, jobs, CPU as activity"): box_shell
// with job: true against a fake boxd, the tracker that polls it, the notice, the inbox entry and the audit line when a
// job ends, the result on the next box_shell call, what an older boxd does, the notice when boxd stops a box, and the
// storage rule before each command. No engine turn here: the tests call the tool directly. The box side (watchdog, CPU
// use, exit file reads) is in native/cmd/mycel-boxd/*_test.go and scripts/dev-env/vm-tests.sh.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { setBoxdClient, type BoxdClient, type BoxdResult } from '../../server/src/devenv/boxd'
import { JOB_MAX_AGE_MS, jobResultsForAI, jobRuns, pollJobs, pollStops, purgeOldJobs, runningJobs, startJob } from '../../server/src/devenv/jobs'
import { newConsent, OFF_SETTING, saveDevEnvSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
import { notificationsOf, notifyDevEnv } from '../../server/src/notifications/service'
import { configureStorageGuard } from '../../server/src/system/storage'

setDefaultTimeout(40_000)

let h: Harness
let projectId = ''
let chatId = ''
const FOLDER = 'projects/falcon'
const publish: { user: string; frame: { type: string; data: { level?: string; code?: string; message?: string; link?: string } } }[] = []

type Job = { name: string; state: 'running' | 'ended'; code: number | null; seconds: number; tail: string; lastLine: string; why?: string }
let jobs: Job[] = []
/** what the next jobs op answers instead of the list */
let jobsFail: string | null = null
let jobsCalls = 0
let execCalls: Record<string, unknown>[] = []
/** an older boxd: it ignores job and answers with no job field */
let oldBoxd = false
let execAnswer: Partial<{ signal: string; reason: string; code: number }> = {}
let ensureFail: string | null = null
let boxes: { box: string; state: 'running' | 'stopped'; startedAt: null; lastActiveAt: null; memoryMiB: null; stopCode?: string; stopReason?: string; stoppedAt?: string }[] = []

const fakeBoxd: BoxdClient = {
  async status() { return { ok: true, value: { ev: 'status', available: true, boxes } } },
  async ensure() { return ensureFail ? { ok: false, message: ensureFail } : { ok: true, value: { ev: 'ok' } } },
  async stop() { return { ok: true, value: { ev: 'ok' } } },
  async ps() { return { ok: true, value: { ev: 'ps', processes: [] } } },
  async preview() { return { ok: true, value: { ev: 'preview', socket: '/nonexistent/preview.sock' } } },
  async exec(req) {
    execCalls.push(req)
    if (req.job && !oldBoxd && !jobs.some((j) => j.name === req.logName)) jobs = [...jobs, running(req.logName!)] // boxd lists a job before exec answers
    return { ok: true, value: { ev: 'exit', code: 0, signal: '', stdout: '', stderr: '', truncated: false, ms: 5, ...execAnswer, ...(req.job && !oldBoxd ? { job: true } : {}) } }
  },
  async jobs(): Promise<BoxdResult<{ ev: 'jobs'; running: boolean; jobs: Job[] }>> {
    jobsCalls++
    if (jobsFail) return { ok: false, message: jobsFail }
    return { ok: true, value: { ev: 'jobs', running: true, jobs } }
  },
}

function shell(userId = 'alice', project: { id: string; folderPath: string; name: string } = { id: projectId, folderPath: FOLDER, name: 'Render' }) {
  return boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal: new AbortController().signal, confirm: async () => null, redact: (s) => s.replaceAll('hunter2', '[hidden]') })
}
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_jobs WHERE project_id = ? ORDER BY started_at, id').all(projectId) as Record<string, unknown>[]
const audits = (action: string) => h.ctx.db.query('SELECT actor_id, detail FROM audit_log WHERE action = ? AND target = ? ORDER BY id').all(action, projectId) as { actor_id: string | null; detail: string }[]
const clear = () => {
  for (const t of ['dev_env_jobs', 'dev_env_stops', 'dev_env_notices']) h.ctx.db.query(`DELETE FROM ${t}`).run()
  h.ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'dev_env.%'").run()
}

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'dev-env-jobs' })
  projectId = (await oldProject(h, 'alice', { name: 'Render', folderPath: FOLDER, instructions: '' })).id
  chatId = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
  saveDevEnvSetting(h.ctx.db, projectId, { ...OFF_SETTING, enabled: true, consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
  setBoxdClient(fakeBoxd)
  const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = ((user: string, frame: never) => { publish.push({ user, frame }); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
})
afterAll(async () => { setBoxdClient(null); delete process.env.MYCEL_DEV_ENV; await h.close() })
beforeEach(() => {
  clear()
  jobs = []; jobsFail = null; jobsCalls = 0; execCalls = []; oldBoxd = false; execAnswer = {}; ensureFail = null; boxes = []; publish.length = 0
})

const running = (name: string, tail = 'frame=1'): Job => ({ name, state: 'running', code: null, seconds: 5, tail, lastLine: tail.split('\n').at(-1)! })
const ended = (name: string, code: number | null, tail = 'done', why?: string): Job => ({ name, state: 'ended', code, seconds: 9, tail, lastLine: tail.split('\n').at(-1)!, ...(why ? { why } : {}) })
const jobNotices = () => publish.filter((p) => p.frame.type === 'notice' && p.frame.data.code === 'dev_env_job')

describe('starting a job', () => {
  test('box_shell job: a background command with a log name, tracked in the database', async () => {
    const r = await shell().call({ command: 'ffmpeg -i a.mp4 b.mp4', job: true, log_name: 'render' })
    expect(r.isError).toBeUndefined()
    expect(execCalls[0]).toMatchObject({ background: true, job: true, logName: 'render', command: 'ffmpeg -i a.mp4 b.mp4' })
    expect(out(r)).toContain('Started as job render (log: /cache/logs/render.log)')
    expect(rows()).toMatchObject([{ name: 'render', user_id: 'alice', chat_id: chatId, turn_id: 'turn-1', ended_at: null, exit_code: null, ai_told_at: null }])
    expect(jobRuns(h.ctx.db, projectId, 'render')).toBe(true)
    expect(JSON.parse(audits('dev_env.command')[0]!.detail)).toMatchObject({ job: 'render', background: true })
  })
  test('with no log name a job gets its own name', async () => {
    await shell().call({ command: 'sleep 1', job: true })
    const name = String(rows()[0]!.name)
    expect(name).toMatch(/^job-[0-9a-f]{6}$/)
    expect(execCalls[0]).toMatchObject({ logName: name })
  })
  test('a dev server stays a plain background command: no job, no row, no notice', async () => {
    const r = await shell().call({ command: 'npm run dev', background: true, log_name: 'dev' })
    expect(execCalls[0]).toMatchObject({ background: true, logName: 'dev' })
    expect(execCalls[0]!.job).toBeUndefined()
    expect(out(r)).toContain('Started in the background (log: /cache/logs/dev.log)')
    expect(rows()).toEqual([])
  })
  test('a name that still runs is refused before the box', async () => {
    jobs = [running('render')]
    await shell().call({ command: 'a', job: true, log_name: 'render' })
    execCalls = []
    const r = await shell().call({ command: 'b', job: true, log_name: 'render' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('a job named render still runs')
    expect(execCalls).toEqual([])
  })
  test('a plain background command may not take the log of a running job, also with no log name', async () => {
    jobs = [running('render'), running('background')]
    await shell().call({ command: 'a', job: true, log_name: 'render' })
    await shell().call({ command: 'b', job: true, log_name: 'background' })
    execCalls = []
    for (const input of [{ background: true, log_name: 'render' }, { background: true }]) {
      const r = await shell().call({ command: 'c', ...input })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('still runs')
    }
    expect(execCalls).toEqual([])
  })
  test('a job that did not start says so: not that it runs, and not that the server does not track jobs', async () => {
    execAnswer = { code: 125 }
    oldBoxd = true
    const r = await shell().call({ command: 'ffmpeg', job: true, log_name: 'render' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('The command did not start (exit code 125).')
    expect(out(r)).not.toContain('does not track')
    expect(rows()).toEqual([])
  })
  test('an older boxd does not track jobs: the command runs, and the AI is told', async () => {
    oldBoxd = true
    const r = await shell().call({ command: 'ffmpeg', job: true, log_name: 'render' })
    expect(r.isError).toBeUndefined()
    expect(out(r)).toContain('this server does not track jobs')
    expect(rows()).toEqual([])
  })
})

describe('the tracker', () => {
  const start = (name = 'render', userId = 'alice') => startJob(h.ctx, { projectId, name, userId, chatId, turnId: 'turn-1', command: 'x' })

  test('a running job: the last line is the progress, on the project page for people who see the box', async () => {
    start(); jobs = [running('render', 'frame=1\nframe=99 fps=30')]
    await pollJobs(h.ctx)
    expect(runningJobs(h.ctx.db, projectId)).toMatchObject([{ name: 'render', by: { id: 'alice', name: 'Alice Kim' }, lastLine: 'frame=99 fps=30' }])
    expect(jobNotices()).toEqual([])
    expect((await h.api('alice').call(API.devEnv, { params: { id: projectId } })).jobs).toMatchObject([{ name: 'render', lastLine: 'frame=99 fps=30' }])
    expect((await h.api('carol').call(API.devEnv, { params: { id: projectId } })).jobs).toHaveLength(1)
    expect((await h.api('bob').call(API.devEnv, { params: { id: projectId } })).jobs).toEqual([]) // reads only
  })
  test('a job that ends: live notice with the exit code, the tail and the chat link, an inbox entry, one audit line, once', async () => {
    const id = start(); jobs = [ended('render', 0, 'frame=99\nmuxing done')]
    await pollJobs(h.ctx)
    await pollJobs(h.ctx) // a second poll tells nobody again
    expect(rows()).toMatchObject([{ exit_code: 0, log_tail: 'frame=99\nmuxing done', last_line: 'muxing done' }])
    expect(rows()[0]!.ended_at).toBeTruthy()
    expect(runningJobs(h.ctx.db, projectId)).toEqual([])
    const n = jobNotices()
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ user: 'alice', frame: { data: { level: 'info', link: `/c/${chatId}` } } })
    expect(n[0]!.frame.data.message).toContain('Dev environment job render ended (exit code 0).')
    expect(n[0]!.frame.data.message).toContain('muxing done')
    const inbox = notificationsOf(h.ctx).list('alice', {})
    const item = inbox.items.find((i) => i.sourceId === id)!
    expect(item).toMatchObject({ eventType: 'dev_env.job', chatId, link: 'chat', devEnv: { projectId, projectName: 'Render', job: { name: 'render', exitCode: 0, tail: 'frame=99\nmuxing done' } } })
    const a = audits('dev_env.job')
    expect(a).toHaveLength(1)
    expect(a[0]!.actor_id).toBe('alice')
    expect(JSON.parse(a[0]!.detail)).toMatchObject({ job: id, name: 'render', code: 0, turnId: 'turn-1' })
    // read works across the union of the inbox tables
    expect(notificationsOf(h.ctx).read('alice', item.id).readAt).toBeTruthy()
    // the activity list says what ended
    const act = await h.api('alice').call(API.devEnvActivity, { params: { id: projectId } })
    expect(act.items.some((i) => i.text === 'job render: exit 0')).toBe(true)
  })
  test('a failed job warns, and a person in another language reads it in theirs', async () => {
    h.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      start(); jobs = [ended('render', 2, 'error: no such file')]
      await pollJobs(h.ctx)
      expect(jobNotices()[0]!.frame.data).toMatchObject({ level: 'warn' })
      expect(jobNotices()[0]!.frame.data.message).toContain('종료 코드 2')
    } finally { h.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run() }
  })
  test('a job that the box took down has no exit code: the reason stays with it', async () => {
    start(); jobs = [ended('render', null, 'frame=7', 'the server disk has only 1.0 GiB free')]
    await pollJobs(h.ctx)
    expect(rows()).toMatchObject([{ exit_code: null, end_note: 'the server disk has only 1.0 GiB free' }])
    expect(jobNotices()[0]!.frame.data).toMatchObject({ level: 'warn' })
    expect(jobNotices()[0]!.frame.data.message).toContain('exit code not known')
    expect(jobNotices()[0]!.frame.data.message).toContain('the server disk has only 1.0 GiB free')
    expect(jobResultsForAI(h.ctx, projectId)[0]).toContain('ended with no exit code (the server disk has only 1.0 GiB free)')
  })
  test('open rows from before a restart are polled like new ones, across projects', async () => {
    start(); jobs = [ended('render', 0)]
    await pollJobs(h.ctx) // no project: every open row, as the timer does after a start
    expect(rows()[0]!.ended_at).toBeTruthy()
  })
  test('an answer that does not name an open job ends it (boxd restarted, so its box stopped)', async () => {
    start(); jobs = []
    await pollJobs(h.ctx)
    expect(rows()).toMatchObject([{ exit_code: null, end_note: 'boxd did not report this job' }])
    expect(jobNotices()).toHaveLength(1)
  })
  test('a failed poll changes nothing', async () => {
    start(); jobsFail = 'boxd unreachable'
    await pollJobs(h.ctx)
    expect(rows()[0]!.ended_at).toBeNull()
    expect(jobNotices()).toEqual([])
  })
  test('an older boxd ("unknown op"): nothing breaks, the job stays open, and the poll waits longer', async () => {
    const box = 'old-' + Date.now()
    h.ctx.db.query('INSERT INTO projects (id, name, folder_path, instructions) VALUES (?, ?, ?, ?)').run(box, 'Old', 'projects/old', '')
    startJob(h.ctx, { projectId: box, name: 'a', userId: 'alice', turnId: 't', command: 'x' })
    jobsFail = 'unknown op'
    await pollJobs(h.ctx, box)
    await pollJobs(h.ctx, box)
    expect(jobsCalls).toBe(1)
    expect(jobRuns(h.ctx.db, box, 'a')).toBe(true)
    h.ctx.db.query('DELETE FROM projects WHERE id = ?').run(box)
    expect(h.ctx.db.query('SELECT 1 FROM dev_env_jobs WHERE project_id = ?').get(box)).toBeNull() // the row goes with the project
  })
  test('a client with no jobs op does not break', async () => {
    start()
    const { jobs: _gone, ...old } = fakeBoxd
    setBoxdClient(old)
    try {
      await pollJobs(h.ctx)
      expect(rows()[0]!.ended_at).toBeNull()
    } finally { setBoxdClient(fakeBoxd) }
  })
  test('a row with no answer for too long ends, so a poll does not go on for ever', async () => {
    const id = start(); jobsFail = 'boxd unreachable'
    h.ctx.db.query('UPDATE dev_env_jobs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - JOB_MAX_AGE_MS - 1000).toISOString(), id)
    await pollJobs(h.ctx)
    expect(rows()[0]!.ended_at).toBeTruthy()
  })
  test('a person who cannot read the folder gets no log: not live, not in the inbox', async () => {
    const id = start('other', 'erin'); jobs = [ended('other', 0, 'secret line')]
    await pollJobs(h.ctx)
    expect(jobNotices()).toEqual([])
    expect(rows()[0]!.log_tail).toBe('secret line') // the record stays
    h.ctx.db.query("INSERT INTO dev_env_notices (id, user_id, event_type, source_id, created_at) VALUES ('n1', 'erin', 'dev_env.job', ?, ?)").run(id, new Date().toISOString())
    const item = notificationsOf(h.ctx).list('erin', {}).items.find((i) => i.sourceId === id)!
    expect(item).toMatchObject({ eventType: 'dev_env.job', chatId: null, link: null })
    expect(item.devEnv).toBeUndefined()
  })
  test('old rows go, open rows stay', () => {
    const a = start('old1'), b = start('open1')
    const long = new Date(Date.now() - 31 * 86400_000).toISOString()
    h.ctx.db.query('UPDATE dev_env_jobs SET ended_at = ? WHERE id = ?').run(long, a)
    purgeOldJobs(h.ctx.db)
    expect(rows().map((r) => r.id)).toEqual([b])
  })
})

describe('the AI gets the result on its next box_shell call', () => {
  test('once, in that project, whoever started the job, with the end of the log', async () => {
    startJob(h.ctx, { projectId, name: 'render', userId: 'bob', chatId, turnId: 't0', command: 'x' })
    jobs = [ended('render', 1, 'token hunter2\nframe=5')]
    const first = out(await shell().call({ command: 'echo next' }))
    // the log has a section of its own, with an end line that the box cannot know
    const m = /Job render ended with exit code 1\.\n--- last lines of the log of job render: .* line ([0-9a-f]{12}) ---\ntoken \[hidden\]\nframe=5\n([0-9a-f]{12})/.exec(first)
    expect(m?.[1]).toBe(m?.[2])
    expect(out(await shell().call({ command: 'echo again' }))).not.toContain('Job render')
    expect(rows()[0]!.ai_told_at).toBeTruthy()
  })
  test('also in an answer that refuses the command', async () => {
    startJob(h.ctx, { projectId, name: 'render', userId: 'alice', chatId, turnId: 't0', command: 'x' })
    jobs = [ended('render', 0)]
    ensureFail = 'the server disk has only 1.0 GiB free. Free space: empty the trash or delete files'
    const r = await shell().call({ command: 'echo next' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('Job render ended with exit code 0.')
    expect(out(r)).toContain('Free space: empty the trash')
  })
})

describe('a box that boxd stopped', () => {
  const stopped = (code: string, at: string) => ({ box: projectId, state: 'stopped' as const, startedAt: null, lastActiveAt: null, memoryMiB: null, stopCode: code, stopReason: `because ${code}`, stoppedAt: at })
  const stopNotices = () => publish.filter((p) => p.frame.type === 'notice' && p.frame.data.code === 'dev_env_box_stopped')

  test('at the disk floor: the people who may use it and the admins hear why, once per stop', async () => {
    boxes = [stopped('disk', '2026-11-02T10:00:00Z')]
    await pollStops(h.ctx)
    await pollStops(h.ctx)
    const told = stopNotices().map((p) => p.user)
    expect(new Set(told).size).toBe(told.length)
    expect(told).toContain('alice') // may use the box
    expect(told).toContain('carol') // admin
    expect(told).not.toContain('bob') // reads only
    expect(told).not.toContain('erin')
    expect(stopNotices().find((p) => p.user === 'alice')!.frame.data).toMatchObject({ level: 'warn', link: `/projects/${projectId}` })
    expect(stopNotices().find((p) => p.user === 'alice')!.frame.data.message).toContain('server disk is nearly full')
    expect(stopNotices().find((p) => p.user === 'carol')!.frame.data.message).toContain('서버 디스크') // carol reads Korean
    const a = audits('dev_env.box_stopped')
    expect(a).toHaveLength(1)
    expect(a[0]!.actor_id).toBeNull()
    expect(JSON.parse(a[0]!.detail)).toEqual({ code: 'disk', reason: 'because disk' })
    const inbox = notificationsOf(h.ctx).list('alice', {}).items.find((i) => i.eventType === 'dev_env.box')!
    expect(inbox).toMatchObject({ link: 'project', devEnv: { projectId, projectName: 'Render', stopCode: 'disk' } })
    // the next stop is a new one
    boxes = [stopped('disk', '2026-11-02T11:00:00Z')]
    await pollStops(h.ctx)
    expect(stopNotices()).toHaveLength(told.length * 2)
  })
  test('a stop past the keep time is not new: no second notice each time the purge took its row', async () => {
    const day = 86400_000
    const at = new Date(Date.now() - 29 * day).toISOString().replace(/\.\d+Z$/, 'Z')
    boxes = [stopped('disk', at)]
    await pollStops(h.ctx)
    const once = stopNotices().length
    expect(once).toBeGreaterThan(0)
    purgeOldJobs(h.ctx.db, Date.now() + 2 * day) // boxd restarted nothing: it still reports this stop
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM dev_env_stops').get()).toEqual({ n: 0 })
    boxes = [stopped('disk', new Date(Date.now() - 31 * day).toISOString().replace(/\.\d+Z$/, 'Z'))]
    await pollStops(h.ctx)
    expect(stopNotices()).toHaveLength(once)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM dev_env_stops').get()).toEqual({ n: 0 })
    expect(audits('dev_env.box_stopped')).toHaveLength(1)
  })
  test('an admin who cannot read the folder still reads which box stopped and why, with no link', async () => {
    h.ctx.db.query("INSERT INTO dev_env_stops (id, project_id, code, reason, stopped_at) VALUES ('s1', ?, 'disk', '', '2026-11-02T10:00:00Z')").run(projectId)
    const realPrincipal = h.ctx.files.principal.bind(h.ctx.files)
    h.ctx.files.principal = ((id: string) => { if (id === 'carol') throw new Error('no access'); return realPrincipal(id) }) as typeof h.ctx.files.principal
    try {
      notifyDevEnv(h.ctx, 'carol', 'dev_env.box', 's1')
      expect(notificationsOf(h.ctx).list('carol', {}).items.find((i) => i.sourceId === 's1')).toMatchObject({ link: null, devEnv: { projectName: 'Render', stopCode: 'disk' } })
    } finally { h.ctx.files.principal = realPrincipal }
  })
  test('the CPU maximum tells people too; an idle stop tells nobody', async () => {
    boxes = [stopped('idle', '2026-11-02T10:00:00Z')]
    await pollStops(h.ctx)
    expect(stopNotices()).toEqual([])
    boxes = [stopped('busy_max', '2026-11-02T10:05:00Z')]
    await pollStops(h.ctx)
    expect(stopNotices().length).toBeGreaterThan(0)
  })
  test('the project page says why', async () => {
    boxes = [stopped('disk', '2026-11-02T10:00:00Z')]
    expect((await h.api('alice').call(API.devEnv, { params: { id: projectId } })).box).toMatchObject({ state: 'stopped', stopCode: 'disk' })
    boxes = [{ ...stopped('disk', '2026-11-02T10:00:00Z'), state: 'running' }]
    expect((await h.api('alice').call(API.devEnv, { params: { id: projectId } })).box).toMatchObject({ state: 'running', stopCode: null })
  })
  test('a stop from before the last start is not why the box is stopped now', async () => {
    boxes = [{ ...stopped('disk', '2026-11-02T10:00:00Z'), startedAt: '2026-11-02T11:00:00Z' as never }] // a person stopped it later
    expect((await h.api('alice').call(API.devEnv, { params: { id: projectId } })).box).toMatchObject({ state: 'stopped', stopCode: null })
    boxes = [{ ...stopped('disk', '2026-11-02T12:00:00Z'), startedAt: '2026-11-02T11:00:00Z' as never }]
    expect((await h.api('alice').call(API.devEnv, { params: { id: projectId } })).box).toMatchObject({ state: 'stopped', stopCode: 'disk' })
  })
  test('a restart that cannot start the box says why', async () => {
    ensureFail = 'the server disk has only 1.0 GiB free and a box needs 3.0 GiB free to start'
    await expect(h.api('alice').call(API.devEnvBox, { params: { id: projectId }, body: { action: 'restart' } })).rejects.toThrow('the server disk has only 1.0 GiB free')
  })
  test('an unknown box and a box with no stop are skipped', async () => {
    boxes = [{ box: projectId, state: 'running', startedAt: null, lastActiveAt: null, memoryMiB: null }, { ...stopped('disk', '2026-11-02T10:00:00Z'), box: 'gone' }]
    await pollStops(h.ctx)
    expect(stopNotices()).toEqual([])
  })
  test('a command that boxd ended says why, not its exit code', async () => {
    execAnswer = { signal: 'box_stopped', reason: 'the server disk has only 1.0 GiB free', code: 137 }
    const r = await shell().call({ command: 'dd if=/dev/zero of=big' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('Stopped: the server disk has only 1.0 GiB free.')
    expect(out(r)).not.toContain('Exit code')
  })
})

describe('the storage rule before each command', () => {
  afterAll(() => configureStorageGuard({ root: h.team, enforce: () => false }))
  const GiB = 1 << 30

  test('near a full disk the command does not run, and the text says how to free space', async () => {
    fs.mkdirSync(path.join(h.team, FOLDER), { recursive: true })
    // 100 GiB disk, 1 GiB free: under the reserve of 2 GiB
    configureStorageGuard({ root: h.team, enforce: () => true, statfs: () => ({ bsize: 4096, blocks: (100 * GiB) / 4096, bfree: GiB / 4096, bavail: GiB / 4096 }) })
    const r = await shell().call({ command: 'echo hi' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain("the team's storage is full")
    expect(out(r)).toContain('empty the trash or delete files')
    expect(execCalls).toEqual([])
    expect(JSON.parse(audits('dev_env.command').at(-1)!.detail)).toMatchObject({ result: { error: 'storage_full' } })
  })
  test('with room the command runs', async () => {
    configureStorageGuard({ root: h.team, enforce: () => true, statfs: () => ({ bsize: 4096, blocks: (100 * GiB) / 4096, bfree: (50 * GiB) / 4096, bavail: (50 * GiB) / 4096 }) })
    const r = await shell().call({ command: 'echo hi' })
    expect(r.isError).toBeUndefined()
    expect(execCalls).toHaveLength(1)
  })
  test('where the rule is not enforced the command runs', async () => {
    configureStorageGuard({ root: h.team, enforce: () => false, statfs: () => ({ bsize: 4096, blocks: 100, bfree: 0, bavail: 0 }) })
    expect((await shell().call({ command: 'echo hi' })).isError).toBeUndefined()
  })
})
