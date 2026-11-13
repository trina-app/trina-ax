// Settings, scheduled tasks, connectors and two admin switches show each change at once (lib/optimistic.ts;
// docs/DECISIONS.md "Optimistic settings, scheduled tasks and switches"): a scheduled task's on / off, a connection's
// tool on / off, my preferences (the default engine), my status, a memory's correction, an engine's on / off and a
// plugin's turning off change before the server answers; a refusal puts them back with one toast; a read from before
// the change does not undo it on screen.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EnginesResponse, InstalledPlugin, Integration, Me, Memory, MyStatus, PluginList, Schedule } from '@mycel/shared/api'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { statusPreview } from '../../src/components/StatusMessage'
import { translate, useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import Engines from '../../src/pages/admin/Engines'
import Plugins from '../../src/pages/admin/Plugins'
import { ScheduledTask } from '../../src/pages/Scheduled'
import { Memories } from '../../src/pages/Settings'
import { useSession } from '../../src/store/session'
import { changeMyStatus } from '../../src/store/statusMessages'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

setDefaultTimeout(30_000)
const ME_ID = 'acme-owner'
const ID = '01900000-0000-7000-8000-0000000000b1'
const now = '2026-11-13T00:00:00.000Z'
const me = (o: Partial<Me['user']> = {}) => ({
  user: { id: ME_ID, username: 'acme', name: 'Acme', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {}, groupIds: [], createdAt: now, lastSeenAt: null, canChooseEngine: true, ...o },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', timeZone: 'Asia/Seoul' },
} as unknown as Me)
const json = (body: unknown, code = 200) => new Response(code === 204 ? null : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const refused = (message = 'Acme server hiccup.') => json({ error: { code: 'internal', message } }, 500)

/** requests waiting for the test's answer, by "METHOD path"; `reads` answers a GET at once */
const waiting: { key: string; body: unknown; answer: (r: Response) => void }[] = []
let reads: Record<string, () => unknown> = {}
const take = (key: string) => {
  const i = waiting.findIndex((w) => w.key === key)
  if (i < 0) throw new Error(`no request ${key}; waiting: ${waiting.map((w) => w.key).join(', ')}`)
  return waiting.splice(i, 1)[0]!
}
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts
const errors = () => toasts().filter((x) => x.level === 'error').map((x) => x.text)
const myPrefs = () => { const s = useSession.getState().status; return s.kind === 'signed-in' ? s.me.user.prefs : null }
const myStatus = () => { const s = useSession.getState().status; return s.kind === 'signed-in' ? s.me.user.statusMessage ?? null : undefined }

/** a switch (ui.tsx Switch, a checkbox) flipped as a click does: past React's value tracker, then the click */
async function flip(m: Mounted, id: string) {
  const e = m.get(id) as unknown as { checked: boolean }
  let proto = Object.getPrototypeOf(e)
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'checked')) proto = Object.getPrototypeOf(proto)
  Object.getOwnPropertyDescriptor(proto, 'checked')!.set!.call(e, !e.checked)
  await m.click(id)
}
const isOn = (m: Mounted, id: string) => (m.get(id) as unknown as { checked: boolean }).checked

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const session = useSession.getState().status
beforeAll(() => {
  installDom()
  // what a read of my account touches (lib/theme.ts, lib/textSize.ts) and the admin pages' sticky headers
  const root = document.documentElement as unknown as Record<string, unknown>
  root.classList ??= { toggle() {}, add() {}, remove() {}, contains: () => false }
  ;(globalThis as Record<string, unknown>).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const read = reads[key]
    if (read) return Promise.resolve(json(read()))
    if ((init?.method ?? 'GET') === 'GET') return Promise.resolve(json({ error: { code: 'not_found', message: 'none' } }, 404))
    return new Promise<Response>((answer) => waiting.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, answer }))
  }) as unknown as typeof fetch
})
afterEach(() => {
  waiting.length = 0
  reads = {}
  resetOptimistic()
  useUi.setState({ toasts: [] } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status: session })
  useLocaleStore.setState({ locale })
  removeDom()
})

// ---------------- my preferences (store/session.ts updatePrefs) ----------------

test('preferences: the engine shows before the answer; a read of my account from before keeps it; refused, back and thrown', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  const done = useSession.getState().updatePrefs({ engine: 'codex', model: null })
  expect(myPrefs()?.engine).toBe('codex')
  await tick()
  // a read of /api/me from before the change lands meanwhile
  useSession.getState().signedIn(me())
  expect(myPrefs()?.engine).toBe('codex')
  take('PATCH /api/me').answer(json(me({ prefs: { engine: 'codex' } })))
  expect(await done).toBe(true)
  expect(myPrefs()?.engine).toBe('codex')

  const failed = useSession.getState().updatePrefs({ engine: 'claude-code', model: null })
  expect(myPrefs()?.engine).toBe('claude-code')
  await tick()
  take('PATCH /api/me').answer(refused())
  await expect(failed).rejects.toBeTruthy()
  // back to what the server last confirmed; the caller says why (no toast of its own)
  expect(myPrefs()?.engine).toBe('codex')
  expect(errors()).toEqual([])
})

// ---------------- my status (store/statusMessages.ts changeMyStatus) ----------------

test('status: set shows at once and the answer settles it; a read from before keeps it; refused, the old one is back with one toast', async () => {
  const old: MyStatus = { emoji: '🏠', text: 'Acme home', clear: 'never' }
  useSession.setState({ status: { kind: 'signed-in', me: me({ statusMessage: old }) } })
  const preview = statusPreview({ emoji: '🍱', text: 'Acme lunch', clear: '1h' }, old, '2026-11-13', Date.parse(now))
  expect(preview.until).toBe('2026-11-13T01:00:00.000Z')
  const done = changeMyStatus(old, preview, () => fetch('/api/me/status', { method: 'PUT' }).then((r) => r.json() as Promise<MyStatus>))
  expect(myStatus()?.text).toBe('Acme lunch')
  await tick()
  useSession.getState().signedIn(me({ statusMessage: old }))
  expect(myStatus()?.text).toBe('Acme lunch')
  const server: MyStatus = { emoji: '🍱', text: 'Acme lunch', clear: '1h', until: '2026-11-13T01:00:02.000Z' }
  take('PUT /api/me/status').answer(json(server))
  expect((await done).ok).toBe(true)
  expect(myStatus()?.until).toBe(server.until)

  const cleared = changeMyStatus(server, null, () => fetch('/api/me/status', { method: 'DELETE' }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error.message); return null }))
  expect(myStatus()).toBeNull()
  await tick()
  take('DELETE /api/me/status').answer(refused())
  expect((await cleared).ok).toBe(false)
  expect(myStatus()?.text).toBe('Acme lunch')
  expect(errors()).toHaveLength(1)
})

test('status preview: words only keep the end; a later first day is kept for later; today ends today', () => {
  const cur: MyStatus = { emoji: '🏝️', text: 'Acme trip', clear: 'dates', untilDay: '2026-11-20', fromDay: '2026-11-15' }
  expect(statusPreview({ text: 'Acme off', clear: 'keep' }, cur, '2026-11-13', 0)).toEqual({ ...cur, emoji: '💬', text: 'Acme off' })
  expect(statusPreview({ text: 'Acme off', clear: 'dates', from: '2026-11-15', to: '2026-11-16' }, null, '2026-11-13', 0)).toMatchObject({ fromDay: '2026-11-15', untilDay: '2026-11-16' })
  expect(statusPreview({ text: 'Acme', clear: 'today' }, null, '2026-11-13', 0)).toMatchObject({ clear: 'today', untilDay: '2026-11-13' })
})

// ---------------- a scheduled task's on / off (pages/Scheduled.tsx) ----------------

const schedule = (o: Partial<Schedule> = {}): Schedule => ({ id: ID, title: 'Acme weekly report', prompt: 'Write it', repeat: 'daily', time: '09:00', date: null, weekday: null, day: null,
  projectId: null, enabled: true, nextRunAt: '2026-11-14T00:00:00.000Z', lastRunAt: null, lastChatId: null, resumeBlockedReason: null, ...o } as Schedule)

test('scheduled task: off shows before the answer; a flip back waits its turn; an older answer writes nothing', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/schedules': () => ({ items: [schedule()], timeZone: 'Asia/Seoul' }), 'GET /api/projects': () => ({ items: [] }) }
  const m = await mount(<MemoryRouter initialEntries={[`/scheduled/${ID}`]}><Routes><Route path="/scheduled/:id" element={<ScheduledTask />} /></Routes></MemoryRouter>)
  const checked = () => m.get('schedule-toggle').getAttribute('aria-checked')
  try {
    await m.until(() => m.find('schedule-toggle'), 'the switch')
    expect(checked()).toBe('true')
    await m.click('schedule-toggle')
    expect(checked()).toBe('false')
    await m.settle()
    await m.click('schedule-toggle')
    expect(checked()).toBe('true')
    await m.settle()
    // one at a time, in the order of the taps
    expect(waiting.map((w) => w.key)).toEqual([`PATCH /api/schedules/${ID}`])
    take(`PATCH /api/schedules/${ID}`).answer(json(schedule({ enabled: false })))
    await m.settle()
    expect(checked()).toBe('true')
    expect(take(`PATCH /api/schedules/${ID}`).body).toEqual({ enabled: true } as never)
    expect(errors()).toEqual([])
  } finally { await m.unmount() }
})

test('scheduled task: refused, back to the server\'s value with one toast; the answer settles it', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/schedules': () => ({ items: [schedule()], timeZone: 'Asia/Seoul' }), 'GET /api/projects': () => ({ items: [] }) }
  const m = await mount(<MemoryRouter initialEntries={[`/scheduled/${ID}`]}><Routes><Route path="/scheduled/:id" element={<ScheduledTask />} /></Routes></MemoryRouter>)
  try {
    await m.until(() => m.find('schedule-toggle'), 'the switch')
    await m.click('schedule-toggle')
    expect(m.get('schedule-toggle').getAttribute('aria-checked')).toBe('false')
    await m.until(() => waiting.length, 'the PATCH')
    take('PATCH /api/schedules/' + ID).answer(refused())
    await m.until(() => m.get('schedule-toggle').getAttribute('aria-checked') === 'true', 'back on')
    expect(errors()).toEqual(['Acme server hiccup.'])
    await m.click('schedule-toggle')
    await m.until(() => waiting.length, 'the PATCH')
    take('PATCH /api/schedules/' + ID).answer(json(schedule({ enabled: false, nextRunAt: null })))
    await m.settle()
    expect(m.get('schedule-toggle').getAttribute('aria-checked')).toBe('false')
    expect(errors()).toHaveLength(1)
  } finally { await m.unmount() }
})

// ---------------- a connection's tool on / off (components/integrations/IntegrationRow.tsx) ----------------

const integration = (tools: { name: string; enabled?: boolean }[]): Integration => ({
  id: ID, scope: 'team', kind: 'mcp', name: 'Acme board', slug: 'acmeboard', url: 'https://board.example.com/mcp', auth: 'bearer', authHeader: null, hasSecret: true, account: null,
  notes: null, writePolicy: 'ask', status: 'connected', lastError: null, lastErrorReason: null, tools: tools.map((x) => ({ title: null, description: '', readOnly: false, ...x })),
  toolsTotal: tools.length, toolsUpdatedAt: null, access: null, createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: now, canManage: true,
} as unknown as Integration)

test('connection tools: two switches flipped close together both show at once; one answer keeps the other on its way; the other refused puts back only its own, with one toast', async () => {
  const out: { i?: Integration; set?: (i: Integration, name: string, on: boolean) => Promise<void> } = {}
  function Probe() {
    const [i, setI] = useState(integration([{ name: 'read' }, { name: 'write' }]))
    out.i = i
    out.set = useIntegrationActions({ add: () => {}, replace: setI, reload: () => {} }).setTool
    return null
  }
  const m = await mount(<Probe />)
  const on = () => Object.fromEntries(out.i!.tools.map((x) => [x.name, x.enabled !== false]))
  try {
    const first = out.set!(out.i!, 'read', false)
    await m.settle()
    const second = out.set!(out.i!, 'write', false)
    await m.settle()
    expect(on()).toEqual({ read: false, write: false })
    const sent = waiting.splice(0)
    expect(sent.map((w) => w.body)).toEqual([{ name: 'read', enabled: false }, { name: 'write', enabled: false }] as never)
    // the first answer is from before the second change: the write tool stays off on screen
    sent[0]!.answer(json(integration([{ name: 'read', enabled: false }, { name: 'write' }])))
    await first
    await m.settle()
    expect(on()).toEqual({ read: false, write: false })
    sent[1]!.answer(refused())
    await second
    await m.settle()
    expect(on()).toEqual({ read: false, write: true })
    expect(errors()).toEqual(['Acme server hiccup.'])
  } finally { await m.unmount() }
})

test('connection tool refused: back on, one toast', async () => {
  const out: { i?: Integration; set?: (i: Integration, name: string, on: boolean) => Promise<void> } = {}
  function Probe() {
    const [i, setI] = useState(integration([{ name: 'read' }]))
    out.i = i
    out.set = useIntegrationActions({ add: () => {}, replace: setI, reload: () => {} }).setTool
    return null
  }
  const m = await mount(<Probe />)
  try {
    const done = out.set!(out.i!, 'read', false)
    await m.settle()
    expect(out.i!.tools[0]!.enabled).toBe(false)
    take(`POST /api/integrations/${ID}/tools`).answer(refused())
    await done
    await m.settle()
    expect(out.i!.tools[0]!.enabled).toBe(true)
    expect(errors()).toEqual(['Acme server hiccup.'])
  } finally { await m.unmount() }
})

// ---------------- a memory's correction (pages/Settings.tsx Memories) ----------------

const memory = (text: string): Memory => ({ id: ID, text, sourceChatId: null, createdAt: now } as Memory)

test('memory: a correction shows at once and the form closes; a read from before keeps it; refused, the old text is back with one toast', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/memories': () => ({ items: [memory('Acme likes short reports')], nextCursor: null }) }
  const m = await mount(<MemoryRouter><Memories /></MemoryRouter>)
  try {
    await m.until(() => m.find('memory-edit'), 'the row')
    await m.click('memory-edit')
    await m.type('memory-input', 'Acme likes one-page reports')
    await m.click('memory-save')
    expect(m.find('memory-form')).toBeNull()
    expect(m.get('memory-text').textContent).toBe('Acme likes one-page reports')
    await m.settle()
    expect(take(`PATCH /api/memories/${ID}`).body).toEqual({ text: 'Acme likes one-page reports' } as never)
    expect(waiting).toHaveLength(0)
  } finally { await m.unmount() }
})

test('memory correction refused: the old text is back, one toast in the server\'s words; a read from before does not undo a pending one', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/memories': () => ({ items: [memory('Acme likes short reports')], nextCursor: null }) }
  const { memoryChanged } = await import('../../src/store/live')
  const m = await mount(<MemoryRouter><Memories /></MemoryRouter>)
  try {
    await m.until(() => m.find('memory-edit'), 'the row')
    await m.click('memory-edit')
    await m.type('memory-input', 'Acme likes long reports')
    await m.click('memory-save')
    await m.settle()
    // the list is read again (another window) while the correction is on its way: the old text does not come back
    memoryChanged.emit({ change: 'created', memory: null })
    await m.settle()
    expect(m.get('memory-text').textContent).toBe('Acme likes long reports')
    take(`PATCH /api/memories/${ID}`).answer(refused())
    await m.until(() => m.get('memory-text').textContent === 'Acme likes short reports', 'the old text')
    expect(errors()).toEqual(['Acme server hiccup.'])
  } finally { await m.unmount() }
})

// ---------------- an engine's on / off (pages/admin/Engines.tsx) ----------------

const engines = (codex: boolean): EnginesResponse => ({
  engines: [
    { id: 'claude-code', label: 'Claude Code', enabled: true, authMode: 'managed', installed: true, version: '1', status: 'ok', detail: null, models: [], checkedAt: null },
    { id: 'codex', label: 'Codex', enabled: codex, authMode: 'managed', installed: true, version: '1', status: 'ok', detail: null, models: [], checkedAt: null },
  ],
  defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, accounts: [], memberChoice: { mode: 'off', groupIds: [], userIds: [] }, limitFallback: false, limitFallbackAvailable: true,
} as unknown as EnginesResponse)

test('engine: off shows before the answer; a list read from an engines notice meanwhile does not undo it; refused, on again with one toast', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/admin/engines': () => engines(true) }
  const { enginesChanged } = await import('../../src/store/live')
  const m = await mount(<MemoryRouter><Engines /></MemoryRouter>)
  try {
    await m.until(() => m.find('engine-switch-codex'), 'the switch')
    expect(isOn(m, 'engine-switch-codex')).toBe(true)
    await flip(m, 'engine-switch-codex')
    expect(isOn(m, 'engine-switch-codex')).toBe(false)
    await m.settle()
    enginesChanged.emit()
    await m.settle()
    expect(isOn(m, 'engine-switch-codex')).toBe(false)
    expect(take('PATCH /api/admin/engines').body).toEqual({ enabled: { codex: false } } as never)
  } finally { await m.unmount() }
})

test('engine refused: on again with one toast in the server\'s words', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/admin/engines': () => engines(true) }
  const m = await mount(<MemoryRouter><Engines /></MemoryRouter>)
  try {
    await m.until(() => m.find('engine-switch-codex'), 'the switch')
    await flip(m, 'engine-switch-codex')
    await m.until(() => waiting.length, 'the PATCH')
    take('PATCH /api/admin/engines').answer(refused('Acme default engine.'))
    await m.until(() => isOn(m, 'engine-switch-codex'), 'back on')
    expect(errors()).toEqual(['Acme default engine.'])
  } finally { await m.unmount() }
})

// ---------------- a plugin's turning off (pages/admin/Plugins.tsx) ----------------

const plugin = (enabled: boolean): InstalledPlugin => ({
  id: 'acme-pack', name: 'Acme pack', description: 'Acme', publisher: { id: 'acme', name: 'Acme' }, version: '1.0.0', kinds: ['skill-pack'], trust: 'official', verifiedBy: 'release', keyId: null,
  manifestSha256: 'a', archiveSha256: 'b', enabled, access: { everyone: true, groups: [], users: [] }, status: enabled ? 'enabled' : 'disabled', unsupported: null, permissions: [],
  platforms: null, license: 'MIT', components: [], source: 'catalog', previousVersion: null, previousTrusted: false, skills: [], installedBy: null, installedAt: now, updatedAt: now,
} as unknown as InstalledPlugin)
const plugins = (enabled: boolean): PluginList => ({ installed: [plugin(enabled)], catalog: [], catalogSource: 'release', imports: [], host: { os: 'linux', arch: 'x64', libc: null },
  trust: { productionKeys: 1, testKeys: 0, allowUnsigned: false, hosted: true }, trustWarnings: [], fileInstall: false } as unknown as PluginList)

test('plugin: turning off shows at once (Turn on, held until the answer); refused, on again with one toast; done, the toast and a read', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: me() } })
  reads = { 'GET /api/admin/plugins': () => plugins(true) }
  const m = await mount(<MemoryRouter><Plugins /></MemoryRouter>)
  try {
    await m.until(() => m.find('plugin-disable'), 'the button')
    await m.click('plugin-disable')
    expect(m.find('plugin-disable')).toBeNull()
    expect(m.get('plugin-enable').hasAttribute('disabled')).toBe(true)
    await m.until(() => waiting.length, 'the POST')
    take('POST /api/admin/plugins/acme-pack/disable').answer(refused())
    await m.until(() => m.find('plugin-disable'), 'back on')
    // (the plugins page's own words for a refusal, as before)
    expect(errors()).toEqual([translate('ko', 'plugins.error')])

    reads = { 'GET /api/admin/plugins': () => plugins(false) }
    await m.click('plugin-disable')
    await m.until(() => waiting.length, 'the POST')
    take('POST /api/admin/plugins/acme-pack/disable').answer(json(plugin(false)))
    await m.until(() => m.find('plugin-enable') && !m.get('plugin-enable').hasAttribute('disabled'), 'Turn on free again')
    expect(toasts().filter((x) => x.level === 'success')).toHaveLength(1)
  } finally { await m.unmount() }
})
