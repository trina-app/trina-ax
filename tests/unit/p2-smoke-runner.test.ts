import { expect, test } from 'bun:test'
import { SmokeGate, runSmoke, type SmokeInput, type SmokeDriver, type SmokeTurn, type SmokeSchedule, type SmokeCleanup } from '../linux/p2-smoke-runner'

const input = (): SmokeInput => ({
  runId: 'p2-unit', users: Object.fromEntries(['owner', 'alice', 'bob'].map((id) => [id, { id, username: id, password: 'synthetic-only' }])) as SmokeInput['users'],
  credentialId: 'fixture-connection', model: 'sonnet',
  files: { sharedRead: 'shared/input.txt', sharedText: 'read-marker', aliceWrite: 'users/alice/out.txt', aliceText: 'write-marker', bobPrivate: 'users/bob/private.txt', bobCanary: 'CANARY-private', scheduleWrite: 'users/alice/schedule.txt', scheduleText: 'schedule-marker' },
  limits: { providerRequests: 20, engineAttempts: 6, toolTurns: 6, turnTimeoutMs: 120_000, totalTimeoutMs: 900_000 },
  persistAdmission() {},
})
const binding = { credentialId: 'fixture-connection', userId: 'alice', family: 'anthropic' as const }
const clean = (): SmokeCleanup => ({ schedulesRemaining: 0, queuedOrRunning: 0, liveHandles: 0, activeProxyTokens: 0, contextClosed: true, launcherIdle: true })

test('receipts persist the next count before provider or engine admission; budgets are independent', () => {
  const i = input(); i.limits.providerRequests = 2; i.limits.engineAttempts = 1
  const written: unknown[] = []
  i.persistAdmission = (n) => { written.push({ ...n }) }
  const g = new SmokeGate(i, () => 0)
  g.admitProvider(binding); g.admitEngine(); g.admitProvider(binding)
  expect(written).toEqual([{ providerRequests: 1, engineAttempts: 0 }, { providerRequests: 1, engineAttempts: 1 }, { providerRequests: 2, engineAttempts: 1 }])
  expect(() => g.admitProvider(binding)).toThrow('provider_limit')
  expect(g.counts).toEqual({ providerRequests: 2, engineAttempts: 1 })
  expect(() => g.admitEngine()).toThrow()
})
test('failed persistence closes admission before any external action', () => {
  const i = input(); i.persistAdmission = () => { throw new Error('secret must never escape') }
  const g = new SmokeGate(i, () => 0)
  expect(() => g.admitEngine()).toThrow('receipt_failed')
  expect(g.counts.engineAttempts).toBe(0)
  expect(() => g.admitProvider(binding)).toThrow('receipt_failed')
})
test('an async receipt is refused, never treated as durable', () => {
  const i = input(); i.persistAdmission = (() => Promise.resolve()) as unknown as SmokeInput['persistAdmission']
  expect(() => new SmokeGate(i, () => 0).admitEngine()).toThrow('receipt_failed')
})
for (const bad of [{ credentialId: 'different' }, { userId: 'bob' }, { family: 'openai' }]) {
  test(`wrong provider binding closes admission: ${Object.keys(bad)[0]}`, () => {
    let writes = 0; const i = input(); i.persistAdmission = () => { writes++ }
    const g = new SmokeGate(i, () => 0)
    expect(() => g.admitProvider({ ...binding, ...bad })).toThrow('credential_mismatch')
    expect(writes).toBe(0)
    expect(() => g.admitProvider(binding)).toThrow('credential_mismatch')
  })
}
test('global time limit and explicit engine-attempt cap close admission', () => {
  const i = input(); i.limits.engineAttempts = 1
  let now = 0; const g = new SmokeGate(i, () => now)
  g.admitEngine(); expect(() => g.admitEngine()).toThrow('engine_limit')
  const t = new SmokeGate(input(), () => now); now = 900_000
  expect(() => t.admitProvider(binding)).toThrow('total_timeout')
})

class FakeDriver implements SmokeDriver {
  nowMs = Date.UTC(2026, 9, 26); turnRows: SmokeTurn[] = []; records: SmokeSchedule[] = []
  files = new Map<string, { text: string | null; versions: number }>(); sends = 0; cleaned = false; gateClosedAtCleanup = false
  wrongDue = false; earlySchedule = false; wrongDenial = false; differentDuplicate = false; requireReadFirst = false
  failAt = 0; badCredential = false; leak = false; denyMissing = false; duplicateSchedule = false; hang = false; dirtyCleanup = false
  constructor(readonly i: SmokeInput, readonly gate: SmokeGate) {
    this.files.set(i.files.sharedRead, { text: i.files.sharedText, versions: 0 }); this.files.set(i.files.bobPrivate, { text: i.files.bobCanary, versions: 0 })
  }
  now = () => this.nowMs
  sleep = async (ms: number) => {
    this.nowMs += ms
    if (this.records[0] && !this.records[0].lastChatId && (this.earlySchedule || this.nowMs >= Date.parse(this.records[0].nextRunAt!))) {
      const chat = 'scheduled-chat'; this.records[0].lastChatId = chat; this.records[0].nextRunAt = null
      this.makeTurn(chat, 'schedule'); if (this.differentDuplicate) this.makeTurn('second-scheduled-chat', 'schedule'); if (this.duplicateSchedule) this.makeTurn(chat, 'schedule')
      this.files.set(this.i.files.scheduleWrite, { text: this.i.files.scheduleText, versions: 1 })
    }
  }
  createChat = async (title: string) => title
  makeTurn(chatId: string, clientKind = 'web') {
    this.gate.admitEngine(); this.gate.admitProvider(binding)
    const id = `turn-${this.turnRows.length}`
    const t: SmokeTurn = { id, chatId, messageId: `message-${id}`, userId: 'alice', credentialId: this.badCredential ? 'wrong' : this.i.credentialId, engine: 'claude-code', model: this.i.model, clientKind, startedAt: this.nowMs, status: this.hang ? 'running' : 'done', inputTokens: 4, outputTokens: 2, usageSource: 'proxy', text: 'answer', streamed: true, audit: [], changedPaths: [], allWritePaths: [], canaryAbsent: !this.leak }
    if (clientKind === 'schedule') { t.audit = [{ tool: 'write', summary: this.i.files.scheduleWrite, ok: 1 }]; t.changedPaths = t.allWritePaths = [this.i.files.scheduleWrite] }
    this.turnRows.push(t); return t
  }
  send = async (chatId: string, _content: string) => {
    this.sends++
    if (this.requireReadFirst && [2, 4].includes(this.sends) && !_content.includes(`read ${this.sends === 2 ? this.i.files.aliceWrite : this.i.files.scheduleWrite}`)) throw new Error('destination read missing')
    if (this.sends === this.failAt) throw new Error('SECRET-provider-output')
    const t = this.makeTurn(chatId)
    if (this.sends === 2) {
      t.audit = [{ tool: 'read', summary: this.i.files.sharedRead, ok: 1 }, { tool: 'write', summary: this.i.files.aliceWrite, ok: 1 }]
      t.changedPaths = t.allWritePaths = [this.i.files.aliceWrite]
      this.files.set(this.i.files.aliceWrite, { text: this.i.files.aliceText, versions: 1 })
    }
    if (this.sends === 3 && !this.denyMissing) t.audit = [{ tool: 'read', summary: `read ${this.i.files.bobPrivate} -> ${this.wrongDenial ? 'internal' : 'denied'}: synthetic`, ok: 0 }]
    if (this.sends === 4) {
      t.audit = [{ tool: 'schedule_create', summary: 'schedule_create s1 once', ok: 1 }]
      this.records.push({ id: 's1', title: this.i.runId, repeat: 'once', date: (_content.match(/date "([^"]+)"/) ?? [])[1], time: (_content.match(/time "([^"]+)"/) ?? [])[1], nextRunAt: new Date(Math.ceil((this.nowMs + this.i.limits.turnTimeoutMs + 60_000) / 60_000) * 60_000 + (this.wrongDue ? 60_000 : 0)).toISOString(), lastChatId: null })
    }
    return { turnId: t.id, messageId: t.messageId }
  }
  turn = (id: string) => this.turnRows.find((t) => t.id === id) ?? null
  scheduledTurns = () => this.turnRows.filter(t => t.clientKind === 'schedule')
  turnsForChat = (id: string) => this.turnRows.filter((t) => t.chatId === id)
  file = (rel: string) => this.files.get(rel) ?? { text: null, versions: 0 }
  schedules = async (who: 'alice' | 'bob') => ({ items: who === 'alice' ? this.records.map((s) => ({ ...s })) : [], timeZone: 'UTC' })
  cardsApproved: string[] = []; noCard = false
  approveScheduleCard = async (turnId: string) => { this.cardsApproved.push(turnId); return !this.noCard }
  cleanup = async () => {
    this.cleaned = true; this.gateClosedAtCleanup = this.gate.closed
    this.records = []; for (const t of this.turnRows) if (t.status === 'running') t.status = 'stopped'
    return { ...clean(), queuedOrRunning: this.dirtyCleanup ? 1 : 0 }
  }
}
const fixture = () => { const i = input(); let d: FakeDriver; const g = new SmokeGate(i, () => d?.nowMs ?? Date.UTC(2026, 9, 26)); d = new FakeDriver(i, g); return { i, g, d } }
test('L1-L4 include the scheduled turn, per-turn credential, audit, content and cleanup evidence', async () => {
  const { i, g, d } = fixture(); const r = await runSmoke(d, i, g)
  expect(r.ok).toBe(true); expect(r.cases.map((c) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed'])
  expect(d.cardsApproved).toEqual(['turn-3']) // only L4 answers the schedule's card
  expect(r.counts).toEqual({ providerRequests: 5, engineAttempts: 5 }); expect(d.gateClosedAtCleanup).toBe(true)
})
for (const field of ['badCredential', 'leak', 'denyMissing', 'duplicateSchedule', 'hang', 'dirtyCleanup', 'noCard'] as const) {
  test(`rejects ${field}; always closes admission and cleans up`, async () => {
    const { i, g, d } = fixture(); d[field] = true
    const r = await runSmoke(d, i, g)
    expect(r.ok).toBe(false); expect(d.cleaned).toBe(true); expect(d.gateClosedAtCleanup).toBe(true)
    expect(JSON.stringify(r)).not.toContain('CANARY-private')
  })
}
for (const failAt of [1, 2, 3, 4]) test(`failure in step ${failAt} is sanitized and cleanup still runs`, async () => {
  const { i, g, d } = fixture(); d.failAt = failAt
  const r = await runSmoke(d, i, g)
  expect(r.ok).toBe(false); expect(d.cleaned).toBe(true); expect(JSON.stringify(r)).not.toContain('SECRET')
})
test('scheduled work cannot bypass the persisted provider budget', async () => {
  const { i, g, d } = fixture(); i.limits.providerRequests = 4
  const r = await runSmoke(d, i, g)
  expect(r.ok).toBe(false); expect(r.counts.providerRequests).toBe(4); expect(d.cleaned).toBe(true)
})


test('abort closes gate before receipt or launcher admission', () => {
  const controller = new AbortController(), i = input(); i.signal = controller.signal
  const g = new SmokeGate(i, () => 0); controller.abort()
  expect(() => g.admitProvider(binding)).toThrow('aborted'); expect(g.counts.providerRequests).toBe(0)
})
test('aborting a pending operation promptly runs cleanup', async () => {
  const { i, g, d } = fixture(), controller = new AbortController(); i.signal = controller.signal
  d.createChat = async () => { controller.abort(); return await new Promise<string>(() => {}) }
  const r = await runSmoke(d, i, g)
  expect(r.failure).toBe('aborted'); expect(d.cleaned).toBe(true)
})

import { guardBroker, guardLauncher } from '../linux/p2-smoke-installed'
import type { CredentialBroker } from '../../server/src/credentials/broker'
import type { Launcher, LaunchHandle } from '../../server/src/native'
import type { LaunchRequest } from '@mycel/shared'
const tokenBinding = { ...binding, turnId: 'fixture-turn' }
const launchRequest = { timeoutMs: 500, turnId: 'fixture-turn' } as LaunchRequest

test('broker wrapper persists before calling the production broker and blocks all later requests at cap', async () => {
  const i = input(), order: string[] = []; i.limits.providerRequests = 1; i.persistAdmission = () => { order.push('persist') }
  const g = new SmokeGate(i)
  const broker = { forRequest: async () => { order.push('broker'); return { ok: false } } } as unknown as CredentialBroker
  guardBroker(broker, g, () => { order.push('binding') })
  await broker.forRequest(tokenBinding, 'anthropic'); expect(order).toEqual(['binding', 'persist', 'broker'])
  await expect(broker.forRequest(tokenBinding, 'anthropic')).rejects.toThrow('provider_limit')
  expect(order.filter(x => x === 'broker').length).toBe(1)
})
test('broker rejects wrong request family and post-await shutdown without releasing an injection', async () => {
  const g = new SmokeGate(input()); let calls = 0
  const broker = { forRequest: async () => { calls++; g.close('finished'); return { ok: true, credentialId: 'fixture-connection', kind: 'anthropic-oauth' } } } as unknown as CredentialBroker
  guardBroker(broker, g, () => {})
  await expect(broker.forRequest(tokenBinding, 'anthropic')).rejects.toThrow('finished'); expect(calls).toBe(1)
  const g2 = new SmokeGate(input()); guardBroker(broker, g2, () => {})
  await expect(broker.forRequest(tokenBinding, 'openai')).rejects.toThrow('credential_mismatch'); expect(calls).toBe(1)
})
test('launcher wrapper never invokes the real launcher when persistence or binding verification fails', () => {
  let launches = 0; const launcher = { launch: () => { launches++; throw new Error('must not launch') } } as Launcher
  const i = input(); i.persistAdmission = () => { throw new Error('synthetic secret') }
  guardLauncher(launcher, new SmokeGate(i), () => {}, new Set())
  expect(() => launcher.launch(launchRequest)).toThrow('receipt_failed'); expect(launches).toBe(0)
  const launcher2 = { launch: () => { launches++; throw new Error('must not launch') } } as Launcher
  guardLauncher(launcher2, new SmokeGate(input()), () => { throw new Error('bad binding') }, new Set())
  expect(() => launcher2.launch(launchRequest)).toThrow(); expect(launches).toBe(0)
})
test('launcher tracks real event lifecycle and delegates cancellation', async () => {
  let killed = false; const handles = new Set<LaunchHandle>()
  const launcher: Launcher = { launch: () => ({ kill() { killed = true }, events: { async *[Symbol.asyncIterator]() { yield { ev: 'exit' as const, code: 0 } } } }) }
  const g = new SmokeGate(input()); guardLauncher(launcher, g, () => {}, handles)
  const handle = launcher.launch(launchRequest); expect(handles.size).toBe(1); handle.kill(); expect(killed).toBe(true)
  for await (const _ of handle.events) {}
  expect(handles.size).toBe(0); expect(g.counts.engineAttempts).toBe(1)
})

import { runInstalledSmoke, type InstalledSmokeInput } from '../linux/p2-smoke-installed'
test('already aborted installed entry touches no DB or context', async () => {
  let touched = false; const controller = new AbortController(); controller.abort()
  const i = { ...input(), signal: controller.signal, cfg: {}, db: { query() { touched = true; throw new Error('must not touch') } }, assertToolsSocket() { touched = true } } as unknown as InstalledSmokeInput
  const result = await runInstalledSmoke(i)
  expect(result.failure).toBe('aborted'); expect(touched).toBe(false); expect(result.counts.engineAttempts).toBe(0)
})
test('non-Linux installed entry performs no fixture writes', async () => {
  if (process.platform === 'linux') return
  let touched = false
  const i = { ...input(), cfg: {}, db: { query() { touched = true; throw new Error('must not touch') } }, assertToolsSocket() { touched = true } } as unknown as InstalledSmokeInput
  const result = await runInstalledSmoke(i)
  expect(result.failure).toBe('installed_linux_required'); expect(touched).toBe(false)
})

for (const field of ['wrongDenial', 'wrongDue', 'earlySchedule', 'differentDuplicate'] as const) test(`regression rejects ${field}`, async () => {
  const { i, g, d } = fixture(); d[field] = true
  const result = await runSmoke(d, i, g)
  expect(result.ok).toBe(false); expect(d.cleaned).toBe(true)
})
test('prompts read existing destination before write for both direct and scheduled turns', async () => {
  const { i, g, d } = fixture(); d.requireReadFirst = true
  expect((await runSmoke(d, i, g)).ok).toBe(true)
})

import { boundedCleanup, safeFailure, SmokeFailure } from '../linux/p2-smoke-runner'
test('cleanup deadline returns a sanitized failure even if cleanup never settles', async () => {
  await expect(boundedCleanup(() => new Promise<SmokeCleanup>(() => {}), 5)).rejects.toThrow('cleanup_timeout')
})
test('cleanup summary projects only validated scalars; arbitrary failure text never leaves report', async () => {
  const summary = await boundedCleanup(async () => ({ ...clean(), token: 'never-output' }))
  expect(JSON.stringify(summary)).not.toContain('never-output')
  expect(safeFailure(new SmokeFailure('secret-in-failure-code'))).toBe('runtime_error')
  await expect(boundedCleanup(async () => ({ ...clean(), queuedOrRunning: NaN }))).rejects.toThrow('cleanup_failed')
})
test('unexpected writes make a completed L1 fail', async () => {
  const { i, g, d } = fixture(), send = d.send
  d.send = async (chat, prompt) => { const result = await send(chat, prompt); d.turn(result.turnId)!.allWritePaths.push('shared/unrequested.txt'); return result }
  const report = await runSmoke(d, i, g)
  expect(report.failure).toBe('unexpected_write'); expect(d.cleaned).toBe(true)
})

import { Database } from 'bun:sqlite'
import { fileMutationEvidence } from '../linux/p2-smoke-installed'
import type { ServerEvent } from '@mycel/shared/api'
test('adapter mutation evidence includes deletions and rejected mutations, scoped to the exact turn', () => {
  const db = new Database(':memory:')
  try {
    db.run('CREATE TABLE file_events (turn_id TEXT, path TEXT, action TEXT)')
    const put = db.query('INSERT INTO file_events VALUES (?, ?, ?)')
    put.run('t1', 'users/alice/out.txt', 'update'); put.run('t1', 'shared/unrequested.txt', 'delete')
    put.run('t1', 'users/bob/no.txt', 'rejected'); put.run('t2', 'shared/other-turn.txt', 'update')
    const frames = [{ type: 'files.changed', data: { changes: [{ path: 'users/alice/out.txt', turnId: 't1' }, { path: 'shared/unrequested.txt', turnId: 't2' }] } }] as ServerEvent[]
    expect(fileMutationEvidence(db, 't1', frames)).toEqual({ allWritePaths: ['users/alice/out.txt', 'shared/unrequested.txt', 'users/bob/no.txt'], changedPaths: ['users/alice/out.txt'] })
  } finally { db.close() }
})
test('binding validation failures close both transport admission gates', async () => {
  const g = new SmokeGate(input()), g2 = new SmokeGate(input())
  const broker = { forRequest: async () => { throw new Error('must not call') } } as unknown as CredentialBroker
  const launcher = { launch: () => { throw new Error('must not call') } } as Launcher
  guardBroker(broker, g, () => { throw new Error('synthetic-only') })
  guardLauncher(launcher, g2, () => { throw new Error('synthetic-only') }, new Set())
  await expect(broker.forRequest(tokenBinding, 'anthropic')).rejects.toThrow()
  expect(() => launcher.launch(launchRequest)).toThrow()
  expect(g.closed).toBe(true); expect(g2.closed).toBe(true)
})
