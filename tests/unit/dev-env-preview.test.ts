// The preview of a dev server on the srt runner (docs/DECISIONS.md "Dev environment on srt: preview"), against a fake
// system: its port forwarder is a unix socket server in a temp folder that answers with the run id and the port it was
// started for, so each test sees which run a request reached (attack A26: a link of run A never reaches run B).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type Step } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { _forwarders, previewSocket, setSrtSystem } from '../../server/src/devenv/srt/runner'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, srtShellDescription } from '../../server/src/devenv/tool'
import { _previewLinks, previewFetch } from '../../server/src/devenv/preview'

setDefaultTimeout(30_000)

const SUFFIX = 'preview.example.net'
const ORIGIN = `https://*.${SUFFIX}`
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }

// ---- the fake system: every run sleeps until stopped; a forwarder answers "<runId> <port> <path>" ----
const live = new Map<string, { resolve: (v: { code: number | null; signal: string | null }) => void; spec: SpawnSpec }>()
const forwards: { runId: string; port: number; socket: string; stopped: boolean }[] = []
let forwardFails = ''
/** the state systemd gives a live run (the scope can be "inactive" just after systemd-run asked for it) */
let liveState = 'active'
/** the pid the fake spawn gives (a live one: this test process) */
let livePid = 999_999
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: (v: { code: number | null; signal: string | null }) => void
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    live.set(spec.runId, { resolve, spec })
    return { pid: livePid, exited }
  },
  async stop(runId) { const r = live.get(runId); if (r) { live.delete(runId); r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId): Promise<UnitInfo> { return live.has(runId) ? { state: liveState, result: '', memoryBytes: 1 << 20 } : { state: '', result: '', memoryBytes: null } },
  async units() { return [...live.keys()].map((id) => `trina-dev-${id}.scope`) },
  async forget() {},
  oomKills() { return 0 },
  cpuUsec() { return 0 },
  procs() { return [] },
  async selfTest() { return '' },
  async forward({ runId, port, socket }) {
    if (forwardFails) return { error: forwardFails }
    const rec = { runId, port, socket, stopped: false }
    forwards.push(rec)
    const server = Bun.serve({ unix: socket, fetch: (req) => new Response(`${runId} ${port} ${new URL(req.url).pathname} host=${req.headers.get('host')} cookie=${req.headers.get('cookie') ?? ''}`, { headers: { 'set-cookie': 'app=1; Path=/' } }) })
    let done!: () => void
    const exited = new Promise<void>((r) => { done = r })
    return { socket, exited, stop: () => { rec.stopped = true; server.stop(true); done() } }
  },
}

let h: Harness
let base = ''
let projectId = '', chatAlice = '', chatAlice2 = '', chatErin = ''
const steps: NonNullable<Step['devEnvRun']>[] = []
const shell = (userId: string, project: { id: string; folderPath: string; name: string } | null, chatId: string) =>
  boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal: new AbortController().signal, confirm: async () => null, redact: (s) => s, queueStep: (r) => steps.push(r) })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_runs ORDER BY started_at, id').all() as { id: string; user_id: string; unit: string; state: string; end_reason: string | null }[]
const runIdOf = (unit: string) => unit.slice('trina-dev-'.length, -'.scope'.length)
const turnOn = (patch: Partial<ReturnType<typeof teamSetting>> = {}) =>
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }), ...patch })

/** a request to the gateway as the browser sends it */
const gw = (url: string, cookie?: string) => {
  const u = new URL(url)
  return previewFetch(h.ctx, new Request(url, { headers: { host: u.host, ...(cookie ? { cookie } : {}) } }))
}
/** redeem a link: the session cookie of its origin */
async function redeem(url: string): Promise<{ origin: string; cookie: string }> {
  const r = await gw(url)
  expect(r.status).toBe(303)
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!
  expect(cookie).toMatch(/^mycel_pv=[0-9a-f]{48}$/)
  return { origin: new URL(url).origin, cookie }
}
/** start a dev server through the real tool; returns its row id and run id */
async function devServer(userId: string, chatId: string, port = 3000, project: { id: string; folderPath: string; name: string } | null = null) {
  const r = await shell(userId, project, chatId).call({ command: 'npm run dev', background: true, port, log_name: `web${chatId.slice(-4)}` })
  expect(r.isError).toBeUndefined()
  const row = rows().filter((x) => x.user_id === userId && x.state === 'running').at(-1)!
  return { rowId: row.id, runId: runIdOf(row.unit), text: out(r) }
}
const link = (userId: string, rowId: string, port = 3000) => h.api(userId).call(API.previewMyDevEnvRun, { params: { runId: rowId }, body: { port } })

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'dev-env-preview' })
  // short: a unix socket path has at most 104 bytes on macOS (108 on Linux)
  base = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'srtpv-'))
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  chatAlice = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatAlice2 = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatErin = (await h.api('erin').call(API.createChat, { body: {} })).id
})
const endAll = () => { for (const r of live.values()) r.resolve({ code: null, signal: 'SIGKILL' }); live.clear() }
afterAll(async () => {
  // the runs end, so the runner lets go of what it holds for them (srt's placeholders, other test files share it)
  endAll()
  await Bun.sleep(20)
  setSrtSystem(null)
  delete process.env.MYCEL_DEV_ENV
  delete process.env.MYCEL_DEV_PREVIEW_ORIGIN
  await h.close()
  fs.rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  endAll()
  forwards.length = 0; liveState = 'active'; livePid = 999_999; steps.length = 0; forwardFails = ''
  _previewLinks().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  process.env.MYCEL_DEV_PREVIEW_ORIGIN = ORIGIN
  turnOn()
})

describe('the tool', () => {
  test('with a preview origin: background=true with a port gives the step a Preview button', async () => {
    const s = await devServer('alice', chatAlice, 5173)
    expect(s.text).toContain('Preview button for port 5173')
    expect(steps).toEqual([{ id: s.rowId, kind: 'server', state: 'started', position: null, port: 5173 }])
    expect(shell('alice', null, chatAlice).description).toContain('the person gets a Preview button')
  })
  test('with no port: no button, and the AI is told to start it again with one', async () => {
    const r = await shell('alice', null, chatAlice).call({ command: 'npm run dev', background: true })
    expect(out(r)).toContain('no port: the person has no Preview button')
    expect(steps).toEqual([])
  })
  test('with no preview origin: the old text (curl in one command), no button', async () => {
    delete process.env.MYCEL_DEV_PREVIEW_ORIGIN
    const s = await devServer('alice', chatAlice)
    expect(s.text).toContain('test it in one command with curl')
    expect(steps).toEqual([])
    expect(shell('alice', null, chatAlice).description).toBe(srtShellDescription(false))
  })
  test('a port is refused for a job or a command, and srt\'s proxy ports are refused', async () => {
    expect(out(await shell('alice', null, chatAlice).call({ command: 'x', port: 3000 }))).toContain('port goes only with background=true')
    expect(out(await shell('alice', null, chatAlice).call({ command: 'x', job: true, background: true, port: 3000 }))).toContain('port goes only with background=true')
    expect(out(await shell('alice', null, chatAlice).call({ command: 'x', background: true, port: 3128 }))).toContain('sandbox proxy')
    expect(out(await shell('alice', null, chatAlice).call({ command: 'x', background: true, port: 1080 }))).toContain('sandbox proxy')
    expect(rows()).toEqual([])
  })
})

describe('the link', () => {
  test('only the person who started the dev server gets a link; on another domain than the app', async () => {
    const s = await devServer('alice', chatAlice)
    const l = await link('alice', s.rowId)
    expect(l.url).toMatch(new RegExp(`^https://[0-9a-f]{20}\\.${SUFFIX.replaceAll('.', '\\.')}/__mycel_preview\\?t=[0-9a-f]{48}$`))
    await expect(link('erin', s.rowId)).rejects.toMatchObject({ status: 404 })
    await expect(link('carol', s.rowId)).rejects.toMatchObject({ status: 404 }) // an admin too: the run has alice's folder access
    const audit = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'dev_env.preview' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(audit.actor_id).toBe('alice')
    expect(JSON.parse(audit.detail)).toMatchObject({ run: s.rowId, port: 3000 })
  })
  test('refused: srt\'s proxy ports, a run that ended, a job, no preview origin, a server with no preview', async () => {
    const s = await devServer('alice', chatAlice)
    await expect(link('alice', s.rowId, 3128)).rejects.toMatchObject({ status: 400 })
    delete process.env.MYCEL_DEV_PREVIEW_ORIGIN
    await expect(link('alice', s.rowId)).rejects.toMatchObject({ status: 409, body: { params: { reason: 'dev_env_preview_not_configured' } } })
    process.env.MYCEL_DEV_PREVIEW_ORIGIN = ORIGIN
    setSrtSystem({ ...fake, forward: null }, { base, id: 'mycel', plan: PLAN })
    await expect(link('alice', s.rowId)).rejects.toMatchObject({ status: 409, body: { params: { reason: 'dev_env_preview_not_configured' } } })
    setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
    await h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: s.rowId } })
    await expect(link('alice', s.rowId)).rejects.toMatchObject({ status: 404, body: { params: { reason: 'dev_env_preview_not_running' } } })
    await shell('alice', null, chatAlice2).call({ command: 'sleep', job: true, log_name: 'render' })
    const job = rows().find((r) => r.state === 'running')!
    await expect(link('alice', job.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('the gateway', () => {
  test('a link is used once; the cookie opens the dev server, with Host localhost and without our cookie', async () => {
    const s = await devServer('alice', chatAlice)
    const { url } = await link('alice', s.rowId)
    const { origin, cookie } = await redeem(url)
    expect((await gw(url)).status).toBe(403) // single use
    const r = await gw(`${origin}/app/page?x=1`, `${cookie}; app=1`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(`${s.runId} 3000 /app/page host=localhost cookie=app=1`)
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.headers.getSetCookie()).toEqual(['app=1; Path=/'])
    expect((await gw(`${origin}/`)).status).toBe(403) // no cookie
    expect((await gw(`${origin}/`, 'mycel_pv=' + '0'.repeat(48))).status).toBe(403)
    expect((await gw(`https://${'a'.repeat(20)}.${SUFFIX}/`, cookie)).status).toBe(404)
    expect((await gw(`https://other.example.org/`, cookie)).status).toBe(404)
    // one forwarder per run and port, used again
    await gw(`${origin}/2`, cookie)
    expect(forwards).toHaveLength(1)
    expect(forwards[0]).toMatchObject({ runId: s.runId, port: 3000 })
    expect(forwards[0]!.socket).toBe(path.join(base, 'devenv', 'run', `${s.runId}-3000.sock`))
  })
  test('A26: a link of run A reaches only run A; the cookie of one link does not open another', async () => {
    const a = await devServer('alice', chatAlice)
    const b = await devServer('erin', chatErin)
    const la = await redeem((await link('alice', a.rowId)).url)
    const lb = await redeem((await link('erin', b.rowId)).url)
    expect(await (await gw(`${la.origin}/`, la.cookie)).text()).toStartWith(`${a.runId} 3000`)
    expect(await (await gw(`${lb.origin}/`, lb.cookie)).text()).toStartWith(`${b.runId} 3000`)
    expect((await gw(`${la.origin}/`, lb.cookie)).status).toBe(403)
    expect((await gw(`${lb.origin}/`, la.cookie)).status).toBe(403)
    // a second dev server of the same person in another chat: still only its own run
    const a2 = await devServer('alice', chatAlice2)
    const la2 = await redeem((await link('alice', a2.rowId)).url)
    expect(await (await gw(`${la2.origin}/`, la2.cookie)).text()).toStartWith(`${a2.runId} 3000`)
    expect(await (await gw(`${la.origin}/`, la.cookie)).text()).toStartWith(`${a.runId} 3000`)
    expect(new Set(forwards.map((f) => f.socket)).size).toBe(3)
  })
  test('the run ends: the link stops, its forwarder stops and its socket goes', async () => {
    const s = await devServer('alice', chatAlice)
    const l = await redeem((await link('alice', s.rowId)).url)
    expect((await gw(`${l.origin}/`, l.cookie)).status).toBe(200)
    await h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: s.rowId } })
    expect((await gw(`${l.origin}/`, l.cookie)).status).toBe(403)
    await Bun.sleep(10)
    expect(forwards[0]!.stopped).toBe(true)
    expect(_forwarders().size).toBe(0)
  })
  test('a run that ends by itself (the tracker): the forwarder stops too', async () => {
    const s = await devServer('alice', chatAlice)
    const l = await redeem((await link('alice', s.rowId)).url)
    await gw(`${l.origin}/`, l.cookie)
    const r = live.get(s.runId)!
    live.delete(s.runId)
    fs.writeFileSync(r.spec.exitFile, '0\n'); r.resolve({ code: 0, signal: null })
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'ended' })
    await Bun.sleep(10)
    expect(forwards[0]!.stopped).toBe(true)
    expect((await gw(`${l.origin}/`, l.cookie)).status).toBe(403)
  })
  test('the person loses the dev environment: the preview stops at the next request', async () => {
    const s = await devServer('alice', chatAlice)
    const l = await redeem((await link('alice', s.rowId)).url)
    turnOn({ scope: { mode: 'selected', groupIds: [], userIds: ['erin'] } })
    expect((await gw(`${l.origin}/`, l.cookie)).status).toBe(403)
  })
  test('the forwarder cannot start: 502 with why, and the next request tries again', async () => {
    const s = await devServer('alice', chatAlice)
    const l = await redeem((await link('alice', s.rowId)).url)
    forwardFails = 'port-forward: nothing listens on this port in the run'
    const r = await gw(`${l.origin}/`, l.cookie)
    expect(r.status).toBe(502)
    expect(await r.text()).toContain('nothing listens')
    forwardFails = ''
    expect((await gw(`${l.origin}/`, l.cookie)).status).toBe(200)
  })
  test('previewSocket takes the run from the row: a wrong run id or person gets nothing', async () => {
    const a = await devServer('alice', chatAlice)
    const b = await devServer('erin', chatErin)
    expect(await previewSocket(h.ctx, { rowId: a.rowId, runId: b.runId, userId: 'alice', port: 3000 })).toMatchObject({ ok: false })
    expect(await previewSocket(h.ctx, { rowId: a.rowId, runId: a.runId, userId: 'erin', port: 3000 })).toMatchObject({ ok: false })
    expect(await previewSocket(h.ctx, { rowId: a.rowId, runId: a.runId, userId: 'alice', port: 1080 })).toMatchObject({ ok: false })
    expect(forwards).toHaveLength(0)
  })
})

describe('the tracker and a run that just started', () => {
  test('a scope systemd knows but has not started yet (inactive) with a live process still runs: its settings stay', async () => {
    livePid = process.pid
    liveState = 'inactive'
    const s = await devServer('alice', chatAlice)
    const settings = path.join(base, 'devenv', 'run', `${s.runId}.json`)
    expect(fs.existsSync(settings)).toBe(true)
    await pollSrt(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'running' })
    expect(fs.existsSync(settings)).toBe(true)
  })
})
