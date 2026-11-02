// The team page's part of the PC runner (lib/pcRelay.ts): inside a desktop app with the bridge it passes calls on; anywhere
// else it answers at once, so the turn does not wait for a window that cannot run anything.
import { describe, expect, test } from 'bun:test'
import type { DesktopBridge } from '@mycel/shared'
import type { ClientFrame, PcCall, PcResult } from '@mycel/shared/api'
import { NO_APP_ERROR, OLD_APP_ERROR, PcRelay } from '../../src/lib/pcRelay'

const CALL: PcCall = { callId: 'c1', turnId: '0190a1a0-0000-7000-8000-000000000001', chatId: '0190a1a0-0000-7000-8000-000000000002', project: { id: 'p1', name: 'P' }, tool: 'pc_read', args: { file_path: 'a' } }
const OK: PcResult = { callId: 'c1', ok: true, content: [{ type: 'text', text: 'hi' }], approval: 'once' }
const results = (sent: ClientFrame[]) => sent.flatMap((f) => (f.type === 'pc.result' ? [f.result] : []))

describe('PcRelay', () => {
  test('a window outside the desktop app answers at once, also when the call is replayed', () => {
    const sent: ClientFrame[] = []
    const r = new PcRelay((f) => sent.push(f), () => null)
    r.handleCall(CALL)
    r.handleCall(CALL)
    expect(results(sent)).toEqual([
      { callId: 'c1', ok: false, content: [], error: NO_APP_ERROR, approval: 'none' },
      { callId: 'c1', ok: false, content: [], error: NO_APP_ERROR, approval: 'none' },
    ])
  })
  test('a desktop app from before the PC runner says so', () => {
    const sent: ClientFrame[] = []
    new PcRelay((f) => sent.push(f), () => ({ bridgeVersion: 1 }) as DesktopBridge).handleCall(CALL)
    expect(results(sent)[0]?.error).toBe(OLD_APP_ERROR)
  })
  test('the desktop app runs the call once and its result goes back; cancel reaches it', async () => {
    const sent: ClientFrame[] = []
    let runs = 0
    const cancelled: string[] = []
    let finish = (_: PcResult) => {}
    const pc: NonNullable<DesktopBridge['pc']> = { run: () => { runs++; return new Promise((res) => { finish = res }) }, cancel: (id) => cancelled.push(id), onWaiting: () => () => {} }
    const r = new PcRelay((f) => sent.push(f), () => ({ bridgeVersion: 1, pc }) as DesktopBridge)
    r.handleCall(CALL)
    r.handleCall(CALL)
    r.cancel('c1')
    expect(runs).toBe(1)
    expect(cancelled).toEqual(['c1'])
    finish(OK)
    await new Promise((res) => setTimeout(res, 0))
    await new Promise((res) => setTimeout(res, 0))
    expect(results(sent)).toEqual([OK])
  })
})
