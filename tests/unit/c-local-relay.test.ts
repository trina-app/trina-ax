// The window relay's common part (server/src/realtime/call-relay.ts) through its new sibling, the local relay
// (local-relay.ts, docs/decisions/20261118-local-app-connectors.md): a call goes to the one window it names, comes back
// once and only from its own person, is sent again after a reconnect until the window acks it, is cancelled when the
// turn stops or ends, fails when the window stays away, and the long-poll fallback hands it out.
import { describe, expect, test } from 'bun:test'
import type { ClientFrame, ServerEventInput } from '@mycel/shared/api'
import { LocalRelay, LOCAL_NO_WINDOW, LOCAL_WINDOW_GONE } from '../../server/src/realtime/local-relay'
import { BrowserRelay } from '../../server/src/realtime/browser-relay'
import type { Hub } from '../../server/src/realtime/hub'
import { silentLogger } from '../../server/src/log'
import { CHECK_CONFIRM_WAIT_MS, CONFIRM_WAIT_MS, localTransport } from '../../server/src/integrations/connections/local'
import { TIMEOUT_MS } from '../../server/src/integrations/connections/net'

const TURN = '019a0000-0000-7000-8000-000000000001'
const SPEC = { adapter: 'mcp' as const, command: 'aside', args: ['mcp'], env: [] }

/** a hub with windows that are open or not, what was published to whom, and the client frames to feed */
function fakeHub() {
  const open = new Set<string>()
  const sent: { userId: string; windowId: string; ev: ServerEventInput }[] = []
  const frames: ((s: { userId: string }, f: ClientFrame) => void)[] = []
  const windows: ((userId: string, windowId: string, state: 'open' | 'closed') => void)[] = []
  const hub = {
    publishTo(userId: string, windowId: string, ev: ServerEventInput) { sent.push({ userId, windowId, ev }); return 1 },
    isWindowOpen: (userId: string, windowId: string) => open.has(`${userId}/${windowId}`),
    onClientFrame(h: (s: { userId: string }, f: ClientFrame) => void) { frames.push(h) },
    onWindow(l: (userId: string, windowId: string, state: 'open' | 'closed') => void) { windows.push(l) },
  } as unknown as Hub
  return {
    hub, sent,
    open(userId: string, windowId: string) { open.add(`${userId}/${windowId}`); for (const l of windows) l(userId, windowId, 'open') },
    close(userId: string, windowId: string) { open.delete(`${userId}/${windowId}`); for (const l of windows) l(userId, windowId, 'closed') },
    frame(userId: string, f: ClientFrame) { for (const h of frames) h({ userId }, f) },
  }
}
const log = silentLogger
const calls = (sent: { ev: ServerEventInput }[]) => sent.filter((x) => x.ev.type === 'local.call').map((x) => (x.ev as Extract<ServerEventInput, { type: 'local.call' }>).data.call)
const ask = (relay: LocalRelay, o: Partial<Parameters<LocalRelay['call']>[0]> = {}) => relay.call({
  userId: 'alice', windowId: 'win-desk-0001', turnId: TURN, connectionId: 'c1', name: 'Aside', spec: SPEC,
  message: { jsonrpc: '2.0', id: 'x1', method: 'tools/list', params: {} }, timeoutMs: 5000, ...o,
})

describe('local relay', () => {
  test('one window gets the call; its own person answers once; someone else cannot', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    f.open('alice', 'win-other-001')
    const p = ask(relay)
    const [call] = calls(f.sent)
    expect(f.sent.filter((x) => x.ev.type === 'local.call').map((x) => x.windowId)).toEqual(['win-desk-0001'])
    expect(call).toMatchObject({ turnId: TURN, connectionId: 'c1', name: 'Aside', spec: SPEC, message: { method: 'tools/list' } })
    // bob answering alice's call changes nothing
    f.frame('bob', { type: 'local.result', result: { callId: call!.callId, ok: true, message: { jsonrpc: '2.0', id: 'x1', result: { tools: ['bad'] } } } })
    f.frame('alice', { type: 'local.ack', callId: call!.callId })
    f.frame('alice', { type: 'local.result', result: { callId: call!.callId, ok: true, message: { jsonrpc: '2.0', id: 'x1', result: { tools: [] } } } })
    expect(await p).toMatchObject({ ok: true, message: { result: { tools: [] } } })
    // a second answer goes nowhere
    expect(relay.result('alice', { callId: call!.callId, ok: true })).toBe(false)
    expect(relay.openCalls()).toBe(0)
    relay.close()
  })

  test('no window: fails at once with the plain reason; a window that stays away fails the call', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 20, windowGoneMs: 100 })
    expect(await ask(relay)).toMatchObject({ ok: false, error: LOCAL_NO_WINDOW })
    expect(calls(f.sent)).toHaveLength(0)
    f.open('alice', 'win-desk-0001')
    const p = ask(relay)
    f.close('alice', 'win-desk-0001')
    expect(await p).toMatchObject({ ok: false, error: LOCAL_WINDOW_GONE })
    relay.close()
  })

  test('a reconnect sends an open call again until it is acked; Stop and the turn\'s end cancel it on the window', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    const p = ask(relay)
    f.open('alice', 'win-desk-0001')
    expect(calls(f.sent)).toHaveLength(2)
    f.frame('alice', { type: 'local.ack', callId: calls(f.sent)[0]!.callId })
    f.open('alice', 'win-desk-0001')
    expect(calls(f.sent)).toHaveLength(2)
    relay.cancelTurn(TURN)
    expect(await p).toMatchObject({ ok: false, error: 'the turn ended' })
    expect(f.sent.at(-1)!.ev).toMatchObject({ type: 'local.cancel', data: { windowId: 'win-desk-0001', callId: calls(f.sent)[0]!.callId } })
    const stop = new AbortController()
    const q = ask(relay, { signal: stop.signal })
    stop.abort()
    expect(await q).toMatchObject({ ok: false, error: 'the turn was stopped' })
    expect(f.sent.at(-1)!.ev.type).toBe('local.cancel')
    relay.close()
  })

  test('a call that gets no answer in its time fails with its own words', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    expect(await ask(relay, { timeoutMs: 50 })).toMatchObject({ ok: false, error: 'Aside did not answer in time' })
    relay.close()
  })

  test('long-poll: a polling window counts as there, gets its open calls once per repoll, and answers by POST', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50, repollMs: 10_000 })
    const first = relay.poll('alice', 'win-poll-0001', 1000)
    await Bun.sleep(10)
    const p = ask(relay, { windowId: 'win-poll-0001' })
    const got = await first
    expect(got.map((c) => c.connectionId)).toEqual(['c1'])
    expect(await relay.poll('alice', 'win-poll-0001', 0)).toEqual([])
    expect(await relay.poll('bob', 'win-poll-0001', 0)).toEqual([])
    expect(relay.result('alice', { callId: got[0]!.callId, ok: false, failure: 'declined', error: 'Cancel' })).toBe(true)
    expect(await p).toMatchObject({ ok: false, failure: 'declined' })
    relay.close()
  })

  test('the browser relay on the same base still sends browser.call and reads browser.result', async () => {
    const f = fakeHub()
    const relay = new BrowserRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    const p = relay.call({ userId: 'alice', windowId: 'win-desk-0001', turnId: TURN, chatId: TURN, tool: 'navigate', args: { url: 'https://example.com' } })
    const ev = f.sent.find((x) => x.ev.type === 'browser.call')!.ev as Extract<ServerEventInput, { type: 'browser.call' }>
    expect(ev.data.call).toMatchObject({ tool: 'navigate', turnId: TURN })
    // a local frame is not a browser answer
    f.frame('alice', { type: 'local.result', result: { callId: ev.data.call.callId, ok: true } })
    f.frame('alice', { type: 'browser.result', result: { callId: ev.data.call.callId, ok: true, content: [{ type: 'text', text: 'opened' }] } })
    expect(await p).toMatchObject({ ok: true, content: [{ type: 'text', text: 'opened' }] })
    relay.close()
  })
  test('a client\'s initialize waits for the person on the computer (the one-time confirm), other messages a network\'s time', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    const send = localTransport({ relay, userId: 'alice', via: { windowId: 'win-desk-0001', turnId: TURN }, row: { id: 'c1', name: 'Aside' }, spec: SPEC })
    const post = (m: Record<string, unknown>) => send('https://local-app.invalid/c1', { method: 'POST', headers: [], body: Buffer.from(JSON.stringify(m)) }).catch(() => null)
    void post({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {} })
    void post({ jsonrpc: '2.0', id: 'l1', method: 'tools/list', params: {} })
    const [init, list] = calls(f.sent)
    const left = (c: { deadline: number }) => c.deadline - Date.now()
    expect(left(init!)).toBeGreaterThan(CONFIRM_WAIT_MS - 5000)
    expect(left(list!)).toBeLessThanOrEqual(TIMEOUT_MS)
    relay.close()
  })

  test('a Settings check (no turn): its initialize ends with the check, so a late Connect is told and checked again', async () => {
    const f = fakeHub()
    const relay = new LocalRelay(f.hub, log, { sweepMs: 50 })
    f.open('alice', 'win-desk-0001')
    const send = localTransport({ relay, userId: 'alice', via: { windowId: 'win-desk-0001', turnId: null }, row: { id: 'c1', name: 'Aside' }, spec: SPEC })
    void send('https://local-app.invalid/c1', { method: 'POST', headers: [], body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {} })) }).catch(() => null)
    const [init] = calls(f.sent)
    const left = init!.deadline - Date.now()
    expect(left).toBeLessThanOrEqual(CHECK_CONFIRM_WAIT_MS)
    expect(left).toBeGreaterThan(CHECK_CONFIRM_WAIT_MS - 5000)
    expect(CHECK_CONFIRM_WAIT_MS).toBeLessThan(90_000)
    relay.close()
  })
})
