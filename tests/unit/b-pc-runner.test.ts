// Component B: the PC runner on the server (docs/DECISIONS.md "PC runner"). Off unless MYCEL_PC_RUNNER=1 and an admin turned
// it on for the project after the warning; offered only to a turn sent from a desktop app window, in a project, to someone
// with write access; never to a sub-agent, a scheduled run or a confidential chat; checked again on every call. A call goes
// to the window that sent the turn and to nobody else, and every call leaves an audit line. The app is a test socket here;
// the real app, its approval screen and the jail: desktop/e2e/pc-runner.spec.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, PC_RUNNER_WARNING_VERSION } from '@mycel/shared/api'
import { stepLabel, PC_TOOL_NAMES } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { newPcConsent, OFF_SETTING, mayUsePc, pcInForce, pcRunnerFlag, pcSetting, savePcSetting } from '../../server/src/pc/setting'
import { pcCallText, pcCallTimeoutMs, pcTools } from '../../server/src/pc/tool'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { parsePcToolInput } from '@mycel/shared'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-pc-desk-1'
const FOLDER = 'projects/falcon'

let h: Harness
let desk: TestSocket
let web: TestSocket
let projectId = ''

const turnOn = (scope: { mode: 'writers' | 'selected'; groupIds: string[]; userIds: string[] } = { mode: 'writers', groupIds: [], userIds: [] }) =>
  savePcSetting(h.ctx.db, projectId, { enabled: true, scope, consent: newPcConsent({ id: 'carol', name: 'Carol Park' }) })

/** the desktop app: answer pc.call frames with a scripted result */
function serve(sock: TestSocket, answer: (call: { callId: string; tool: string; args: Record<string, unknown>; project: { id: string; name: string } }) => unknown) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of sock.frames) {
      if (f.type !== 'pc.call' || done.has(f.data.call.callId)) continue
      done.add(f.data.call.callId)
      sock.send({ type: 'pc.ack', callId: f.data.call.callId })
      const r = answer(f.data.call)
      if (r) sock.send({ type: 'pc.result', result: r })
    }
  }, 20)
  return () => clearInterval(timer)
}
const okText = (callId: string, text: string, more: object = {}) => ({ callId, ok: true, content: [{ type: 'text', text }], approval: 'once', ...more })
const deskApi = () => h.api('alice', { window: DESK, client: 'desktop' })
const lastAudit = () => JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'pc_runner.call' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail) as Record<string, unknown>

beforeAll(async () => {
  process.env.MYCEL_PC_RUNNER = '1'
  h = await startHarness({ name: 'pc-runner', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000, relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  web = await h.ws('alice', { windowId: 'win-pc-web-01' })
  await web.next('hello')
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Falcon PC', folderPath: FOLDER, instructions: '' } })).id
})
afterAll(async () => { delete process.env.MYCEL_PC_RUNNER; desk?.close(); web?.close(); await h.close() })

describe('the setting', () => {
  test('off by default, needs the flag and a consent to the current warning', () => {
    expect(pcRunnerFlag({})).toBe(false)
    expect(pcRunnerFlag({ MYCEL_PC_RUNNER: '1' })).toBe(true)
    const on = { enabled: true, scope: OFF_SETTING.scope, consent: newPcConsent({ id: 'carol', name: 'Carol' }) }
    expect(pcInForce(on, true)).toBe(true)
    expect(pcInForce(on, false)).toBe(false)
    expect(pcInForce({ ...on, consent: null }, true)).toBe(false)
    expect(pcInForce({ ...on, consent: { ...on.consent, warningVersion: PC_RUNNER_WARNING_VERSION - 1 } }, true)).toBe(false)
    expect(pcInForce({ ...on, enabled: false }, true)).toBe(false)
  })
  test('write access in every scope; selected people only when selected', () => {
    const ref = { id: projectId, folderPath: FOLDER }
    savePcSetting(h.ctx.db, projectId, OFF_SETTING)
    expect(mayUsePc(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(false)
    turnOn()
    expect(mayUsePc(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(true)
    expect(mayUsePc(h.ctx.db, h.ctx.files, ref, 'bob')).toBe(false) // reads only
    turnOn({ mode: 'selected', groupIds: [], userIds: ['bob'] })
    expect(mayUsePc(h.ctx.db, h.ctx.files, ref, 'alice')).toBe(false)
    expect(mayUsePc(h.ctx.db, h.ctx.files, ref, 'bob')).toBe(false) // selected, still no write access
    turnOn()
  })
  test('API: admins only, warning first, audited; personal projects stay out', async () => {
    savePcSetting(h.ctx.db, projectId, OFF_SETTING)
    const scope = { mode: 'writers' as const, groupIds: [], userIds: [] }
    const put = (user: string) => h.req(user, `/api/projects/${projectId}/pc-runner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, scope }) })
    expect((await put('alice')).status).toBe(403)
    expect((await put('carol')).status).toBe(409)
    const r = await h.api('carol').call(API.updatePcRunner, { params: { id: projectId }, body: { enabled: true, scope, acceptWarning: PC_RUNNER_WARNING_VERSION } })
    expect(r).toMatchObject({ warningVersion: PC_RUNNER_WARNING_VERSION, mayManage: true })
    expect(r.setting.consent?.by?.id).toBe('carol')
    const actions = (h.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'pc_runner.%' AND action != 'pc_runner.call' ORDER BY id").all() as { action: string }[]).map((a) => a.action)
    expect(actions).toEqual(['pc_runner.consent', 'pc_runner.setting'])
    expect((await h.api('alice').call(API.pcRunner, { params: { id: projectId } })).mayUse).toBe(true)
    expect((await h.api('bob').call(API.pcRunner, { params: { id: projectId } })).mayUse).toBe(false)
  })
  test('without the flag every endpoint is 404 and no turn gets the tools', async () => {
    delete process.env.MYCEL_PC_RUNNER
    try {
      expect((await h.req('carol', `/api/projects/${projectId}/pc-runner`)).status).toBe(404)
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const t = await ask(h, desk, 'alice', chat.id, fake({ echo: 'tools' }), { window: DESK, client: 'desktop' })
      expect(t.done.content).not.toContain('pc_shell')
    } finally { process.env.MYCEL_PC_RUNNER = '1' }
  })
})

describe('who gets the tools', () => {
  const toolsOf = async (chatId: string, o: { window?: string; client?: 'desktop' | 'web' } = { window: DESK, client: 'desktop' }) =>
    (await ask(h, o.client === 'web' ? web : desk, 'alice', chatId, fake({ echo: 'tools' }), o)).done.content

  test('a desktop window in a project: all five tools and the rules', async () => {
    turnOn()
    const chat = await deskApi().call(API.createChat, { body: { projectId } })
    expect((await toolsOf(chat.id)).split(',')).toEqual(expect.arrayContaining([...PC_TOOL_NAMES]))
    const system = await ask(h, desk, 'alice', chat.id, fake({ echo: 'system' }), { window: DESK, client: 'desktop' })
    expect(system.done.content).toContain("## The person's computer (PC runner)")
  })
  test('not from the web, not outside a project, not when off', async () => {
    const webChat = await h.api('alice').call(API.createChat, { body: { projectId } })
    expect(await toolsOf(webChat.id, { window: 'win-pc-web-01', client: 'web' })).not.toContain('pc_shell')
    const free = await deskApi().call(API.createChat, { body: {} })
    expect(await toolsOf(free.id)).not.toContain('pc_shell')
    savePcSetting(h.ctx.db, projectId, OFF_SETTING)
    const off = await deskApi().call(API.createChat, { body: { projectId } })
    expect(await toolsOf(off.id)).not.toContain('pc_shell')
    turnOn()
  })
  test('a confidential chat keeps to local tools', async () => {
    const chat = await deskApi().call(API.createChat, { body: { projectId } })
    h.ctx.db.query('INSERT INTO safe_ops_chats(chat_id, material) VALUES (?, 1)').run(chat.id)
    expect(await toolsOf(chat.id)).not.toContain('pc_shell')
  })
  test('sub-agents never get them', () => {
    for (const t of PC_TOOL_NAMES) expect(PARENT_ONLY_TOOLS.has(t)).toBe(true)
  })
})

describe('a call', () => {
  test('reaches only the window that sent the turn, and comes back to the AI', async () => {
    turnOn()
    const stop = serve(desk, (c) => okText(c.callId, `ran ${c.tool} ${String(c.args.command)} in ${c.project.name}`, { run: { code: 0, signal: null, ms: 12 } }))
    try {
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const r = await ask(h, desk, 'alice', chat.id, fake({ tool: 'pc_shell', args: { command: 'npm test\nmore' }, sayResult: true }), { window: DESK, client: 'desktop' })
      expect(r.done.content).toContain('ran pc_shell npm test')
      expect(r.done.content).toContain('in Falcon PC')
      expect(web.frames.some((f) => f.type === 'pc.call')).toBe(false)
      expect(r.done.steps.find((s) => s.tool === 'pc_shell')).toMatchObject({ label: 'Command on this PC · npm test', status: 'ok' })
      expect(lastAudit()).toMatchObject({ tool: 'pc_shell', text: 'npm test\nmore', approval: 'once', ok: true, result: { code: 0, signal: null, ms: 12 } })
      const act = await h.api('bob').call(API.pcRunnerActivity, { params: { id: projectId } })
      expect(act.items[0]).toMatchObject({ tool: 'pc_shell', text: 'npm test\nmore', ok: true, approval: 'once', by: { id: 'alice', name: 'Alice Kim' } })
      // what came from a computer counts as outside content
      expect((h.ctx.db.query('SELECT session_tainted FROM chats WHERE id = ?').get(chat.id) as { session_tainted: number }).session_tainted).toBe(1)
    } finally { stop() }
  })
  test('a refusal reaches the AI and the audit log', async () => {
    const stop = serve(desk, (c) => ({ callId: c.callId, ok: false, content: [{ type: 'text', text: 'The person did not allow this.' }], error: 'The person did not allow this.', approval: 'denied' }))
    try {
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const r = await ask(h, desk, 'alice', chat.id, fake({ tool: 'pc_write', args: { file_path: 'a.txt', content: 'SECRET CONTENT OF A FILE' }, sayResult: true }), { window: DESK, client: 'desktop' })
      expect(r.done.content).toContain('did not allow')
      const a = lastAudit()
      expect(a).toMatchObject({ tool: 'pc_write', approval: 'denied', ok: false, text: 'a.txt (24 bytes)' })
      expect(JSON.stringify(a)).not.toContain('SECRET CONTENT') // no file content in the audit log
    } finally { stop() }
  })
  test('someone else cannot answer a call', async () => {
    let id = ''
    const stop = serve(desk, (c) => { id = c.callId; return null })
    const bob = await h.ws('bob', { windowId: 'win-pc-bob-01' })
    await bob.next('hello')
    try {
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const r = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'pc_read', args: { file_path: 'a' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
      await Bun.sleep(150)
      expect(id).not.toBe('')
      bob.send({ type: 'pc.result', result: okText(id, 'FORGED BY BOB') })
      await Bun.sleep(100)
      desk.send({ type: 'pc.result', result: okText(id, 'from the app') })
      const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(d.data.message.content).toContain('from the app')
      expect(d.data.message.content).not.toContain('FORGED')
    } finally { stop(); bob.close() }
  })
  test('the admin turns it off during a turn: the next call is refused and never reaches the app', async () => {
    const chat = await deskApi().call(API.createChat, { body: { projectId } })
    const before = desk.frames.filter((f) => f.type === 'pc.call').length
    const r = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'ask_user', args: { question: 'wait' } }, { tool: 'pc_shell', args: { command: 'echo x' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
    savePcSetting(h.ctx.db, projectId, OFF_SETTING)
    await deskApi().call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'ok' } })
    const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('The PC runner is off')
    expect(desk.frames.filter((f) => f.type === 'pc.call').length).toBe(before)
    turnOn()
  })
  test('the time limit pauses while the app waits for the person', async () => {
    let id = ''
    const stop = serve(desk, (c) => { id = c.callId; return null })
    try {
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const r = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'pc_shell', args: { command: 'echo x' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
      await Bun.sleep(150)
      const exec = [...(h.rt() as unknown as { running: Map<string, { id: string; waitingForPerson: boolean }> }).running.values()].find((e) => e.id === r.turnId)!
      expect(exec.waitingForPerson).toBe(false)
      desk.send({ type: 'pc.waiting', callId: id, waiting: true })
      await Bun.sleep(80)
      expect(exec.waitingForPerson).toBe(true)
      desk.send({ type: 'pc.waiting', callId: id, waiting: false })
      await Bun.sleep(80)
      expect(exec.waitingForPerson).toBe(false)
      desk.send({ type: 'pc.waiting', callId: id, waiting: true })
      await Bun.sleep(80)
      // a result while it still says "waiting" ends the wait as well
      desk.send({ type: 'pc.result', result: okText(id, 'done') })
      await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(exec.waitingForPerson).toBe(false)
    } finally { stop() }
  })
  test('stopping the turn tells the app', async () => {
    let id = ''
    const stop = serve(desk, (c) => { id = c.callId; return null })
    try {
      const chat = await deskApi().call(API.createChat, { body: { projectId } })
      const r = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'pc_shell', args: { command: 'sleep 100' } }), clientMessageId: cm(), attachmentIds: [] } })
      await Bun.sleep(150)
      await deskApi().call(API.stop, { params: { id: chat.id } })
      const c = await desk.next('pc.cancel', (f) => f.data.callId === id, 5000)
      expect(c.data.windowId).toBe(DESK)
      await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    } finally { stop() }
  })
  test('a reloaded page gets its running call again, so the result still arrives', async () => {
    const page = await h.ws('alice', { windowId: 'win-pc-reload', client: 'desktop' })
    await page.next('hello')
    const api = h.api('alice', { window: 'win-pc-reload', client: 'desktop' })
    const chat = await api.call(API.createChat, { body: { projectId } })
    const r = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'pc_shell', args: { command: 'npm test' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const call = await page.next('pc.call', () => true, 5000)
    const id = call.data.call.callId
    page.send({ type: 'pc.ack', callId: id })
    await Bun.sleep(50)
    page.close()
    const again = await h.ws('alice', { windowId: 'win-pc-reload', client: 'desktop' })
    const replay = await again.next('pc.call', (f) => f.data.call.callId === id, 5000)
    again.send({ type: 'pc.ack', callId: id })
    again.send({ type: 'pc.result', result: okText(replay.data.call.callId, 'kept by the app') })
    const d = await again.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('kept by the app')
    again.close()
  })
  test('the window goes away: the call fails with a reason, and no window at all fails at once', async () => {
    const away = await h.ws('alice', { windowId: 'win-pc-gone-1', client: 'desktop' })
    await away.next('hello')
    const api = h.api('alice', { window: 'win-pc-gone-1', client: 'desktop' })
    const chat = await api.call(API.createChat, { body: { projectId } })
    const r = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'pc_shell', args: { command: 'echo x' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    await away.next('pc.call', () => true, 5000)
    away.close()
    const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('pc_unavailable: the desktop app window did not come back')
    const none = await h.rt().pcRelay.call({ userId: 'alice', windowId: 'nobody', turnId: r.turnId, chatId: chat.id, project: { id: projectId, name: 'x' }, tool: 'pc_read', args: {}, timeoutMs: 1000, onWaiting() {} })
    expect(none).toMatchObject({ ok: false, error: 'pc_unavailable: the desktop app window that sent this message is not connected', approval: 'none' })
  })
})

describe('the tool', () => {
  const parsed = (t: string, a: unknown) => { const r = parsePcToolInput(t, a); if (!r.ok) throw new Error(r.error); return r.call }
  test('no file content in the audit text, and the wait covers the person and the command', () => {
    expect(pcCallText(parsed('pc_write', { file_path: 'a', content: 'héllo' }))).toBe('a (6 bytes)')
    expect(pcCallText(parsed('pc_shell', { command: 'x'.repeat(5000) })).length).toBe(2000)
    const short = pcCallTimeoutMs(parsed('pc_read', { file_path: 'a' }))
    const long = pcCallTimeoutMs(parsed('pc_shell', { command: 'x', timeout_sec: 1800 }))
    expect(long - short).toBeGreaterThan(1700_000)
    expect(short).toBeGreaterThan(10 * 60_000) // the person has 5 minutes, twice
  })
  test('what comes back is redacted, and a bad input never reaches the app', async () => {
    const seen: unknown[] = []
    const tools = pcTools({
      ctx: h.ctx, project: { id: projectId, folderPath: FOLDER, name: 'x' }, userId: 'alice', turnId: 't', chatId: 'c', windowId: 'w', signal: new AbortController().signal, onWaiting() {},
      redact: (s) => s.replaceAll('tok_live_123', '[hidden]'),
      relay: { call: async (o: unknown) => { seen.push(o); return { callId: 'x', ok: true, content: [{ type: 'text', text: 'value tok_live_123' }], approval: 'chat' } } } as never,
    })
    const shell = tools.find((t) => t.name === 'pc_shell')!
    const bad = await shell.call({ command: '' })
    expect(bad.isError).toBe(true)
    expect(seen.length).toBe(0)
    const r = await shell.call({ command: 'cat x' })
    expect((r.content[0] as { text: string }).text).toBe('value [hidden]')
    expect(seen.length).toBe(1)
  })
  test('step labels', () => {
    expect(stepLabel('pc_shell', { command: 'npm install\nnpm test', background: true }, 'en', new Set())).toBe('Command on this PC · npm install (background)')
    expect(stepLabel('pc_read', { file_path: 'src/a.ts' }, 'ko', new Set())).toBe('내 PC 파일 읽기 · src/a.ts')
    expect(stepLabel('pc_search', { glob: '*.ts' }, 'en', new Set())).toBe('Search on this PC "*.ts"')
  })
  test('settings that are damaged read as off', () => {
    h.ctx.db.query("UPDATE settings SET value = '\"broken\"' WHERE key = ?").run(`pcRunner.project.${projectId}`)
    expect(pcSetting(h.ctx.db, projectId).enabled).toBe(false)
    turnOn()
  })
})
