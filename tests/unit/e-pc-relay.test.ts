// The team page's side of the PC runner (shared/src/desktop-bridge.ts createPcRelay): a call replayed after a reconnect runs
// once, the result is sent again, waiting reaches the server only for a call that is open, and what the app returns is
// checked against the contract.
import { describe, expect, test } from 'bun:test'
import { createPcRelay, type DesktopPcBridge } from '../../shared/src/desktop-bridge'
import type { ClientFrame, PcCall, PcResult } from '@mycel/shared/api'

const CALL: PcCall = { callId: 'c1', turnId: '0190a1a0-0000-7000-8000-000000000001', chatId: '0190a1a0-0000-7000-8000-000000000002', project: { id: 'p1', name: 'P' }, tool: 'pc_read', args: { file_path: 'a' } }
const OK: PcResult = { callId: 'c1', ok: true, content: [{ type: 'text', text: 'hi' }], approval: 'once' }

function setup(run: (c: PcCall) => Promise<PcResult>) {
  const sent: ClientFrame[] = []
  const cancelled: string[] = []
  let waiting: ((w: { callId: string; waiting: boolean }) => void) | null = null
  const pc: DesktopPcBridge = { run, cancel: (id) => cancelled.push(id), onWaiting: (cb) => { waiting = cb; return () => { waiting = null } } }
  const relay = createPcRelay({ pc, send: (f) => sent.push(f) })
  return { relay, sent, cancelled, say: (callId: string, w: boolean) => waiting?.({ callId, waiting: w }), hooked: () => waiting !== null }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createPcRelay', () => {
  test('ack, then the result; a replay of a running call acks again and does not run it', async () => {
    let runs = 0
    let finish = (_: PcResult) => {}
    const s = setup(() => { runs++; return new Promise((r) => { finish = r }) })
    s.relay.run(CALL)
    s.relay.run(CALL)
    expect(runs).toBe(1)
    expect(s.sent).toEqual([{ type: 'pc.ack', callId: 'c1' }, { type: 'pc.ack', callId: 'c1' }])
    finish(OK)
    await tick(); await tick()
    expect(s.sent.at(-1)).toEqual({ type: 'pc.result', result: OK })
    s.relay.run(CALL) // finished: the kept result again
    expect(runs).toBe(1)
    expect(s.sent.at(-1)).toEqual({ type: 'pc.result', result: OK })
  })
  test('waiting goes out for an open call only', async () => {
    let finish = (_: PcResult) => {}
    const s = setup(() => new Promise((r) => { finish = r }))
    s.say('c1', true)
    expect(s.sent).toEqual([])
    s.relay.run(CALL)
    s.say('c1', true)
    expect(s.sent.at(-1)).toEqual({ type: 'pc.waiting', callId: 'c1', waiting: true })
    finish(OK)
    await tick(); await tick()
    const n = s.sent.length
    s.say('c1', false)
    expect(s.sent.length).toBe(n)
  })
  test('cancel reaches the app only for a running call', async () => {
    const s = setup(() => new Promise(() => {}))
    s.relay.cancel('c1')
    expect(s.cancelled).toEqual([])
    s.relay.run(CALL)
    s.relay.cancel('c1')
    expect(s.cancelled).toEqual(['c1'])
  })
  test('a malformed answer of the app becomes an error, and a throw too', async () => {
    const bad = setup(async () => ({ callId: 'c1', ok: 'yes' }) as unknown as PcResult)
    bad.relay.run(CALL)
    await tick(); await tick()
    expect(bad.sent.at(-1)).toMatchObject({ type: 'pc.result', result: { ok: false, error: 'The desktop app returned a malformed result.' } })
    const thrown = setup(() => { throw new Error('boom') })
    thrown.relay.run(CALL)
    await tick(); await tick()
    expect(thrown.sent.at(-1)).toMatchObject({ type: 'pc.result', result: { ok: false, error: 'Desktop app error: boom' } })
  })
  test('a call the contract does not know is dropped', () => {
    const s = setup(async () => OK)
    s.relay.run({ ...CALL, tool: 'rm' } as unknown as PcCall)
    expect(s.sent).toEqual([])
  })
  test('dispose unhooks from the app', () => {
    const s = setup(async () => OK)
    expect(s.hooked()).toBe(true)
    s.relay.dispose()
    expect(s.hooked()).toBe(false)
  })
})
