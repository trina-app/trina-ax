// The page's relay for apps on the person's computer (src/lib/localRelay.ts): a window without the desktop app answers
// at once with not_desktop (the server tells the AI in plain words), an older desktop app with too_old, and the desktop
// app runs a call once (a replay after a reconnect gets the ack, then the kept result).
import { describe, expect, test } from 'bun:test'
import type { ClientFrame, LocalCall, LocalResult } from '@mycel/shared/api'
import type { DesktopBridge } from '@mycel/shared'
import { LocalRelay } from '../../src/lib/localRelay'

const call = (callId: string): LocalCall => ({ callId, turnId: null, connectionId: 'c1', name: 'Aside', spec: { adapter: 'mcp', command: 'aside', args: ['mcp'], env: [] }, message: { jsonrpc: '2.0', id: '1', method: 'tools/list' }, deadline: Date.now() + 1000 })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('local relay (page)', () => {
  test('no desktop app: not_desktop at once, again on a replay', () => {
    const sent: ClientFrame[] = []
    const relay = new LocalRelay((f) => sent.push(f), () => null)
    relay.handleCall(call('a'))
    relay.handleCall(call('a'))
    expect(sent.filter((f) => f.type === 'local.result').map((f) => (f as { result: LocalResult }).result.failure)).toEqual(['not_desktop', 'not_desktop'])
  })

  test('a desktop app without apps on this computer: too_old', () => {
    const sent: ClientFrame[] = []
    const relay = new LocalRelay((f) => sent.push(f), () => ({ bridgeVersion: 1 }) as unknown as DesktopBridge)
    relay.handleCall(call('b'))
    expect((sent.at(-1) as { result: LocalResult }).result).toMatchObject({ callId: 'b', ok: false, failure: 'too_old' })
  })

  test('the desktop app runs a call once; cancel reaches it while it runs', async () => {
    const sent: ClientFrame[] = []
    let resolve!: (r: LocalResult) => void
    let runs = 0
    const cancelled: string[] = []
    const app = { bridgeVersion: 1, localApps: { version: 1, run: () => { runs++; return new Promise<LocalResult>((r) => (resolve = r)) }, cancel: (id: string) => cancelled.push(id) } } as unknown as DesktopBridge
    const relay = new LocalRelay((f) => sent.push(f), () => app)
    relay.handleCall(call('c'))
    relay.handleCall(call('c'))
    expect(sent).toEqual([{ type: 'local.ack', callId: 'c' }, { type: 'local.ack', callId: 'c' }])
    relay.cancel('c')
    expect(cancelled).toEqual(['c'])
    resolve({ callId: 'c', ok: true, message: { jsonrpc: '2.0', id: '1', result: { tools: [] } } })
    await tick()
    relay.handleCall(call('c'))
    expect(sent.filter((f) => f.type === 'local.result')).toHaveLength(2)
    expect(runs).toBe(1)
    relay.cancel('c')
    expect(cancelled).toEqual(['c'])
  })
})

describe('the desktop app asks on the computer (watchLocalAsking)', () => {
  test('a notice stays while its "Connect a program" window waits, and goes when it is answered', async () => {
    const { watchLocalAsking } = await import('../../src/lib/localRelay')
    const { useUi } = await import('../../src/store/ui')
    let emit!: (s: { id: string; name: string; asking: boolean }) => void
    let offs = 0
    const bridge = { localApps: { version: 1, onAsking: (cb: typeof emit) => { emit = cb; return () => { offs++ } } } } as unknown as DesktopBridge
    const stop = watchLocalAsking(() => bridge)
    emit({ id: 'c1', name: 'Aside', asking: true })
    const shown = useUi.getState().toasts.filter((x) => x.text.includes('Aside'))
    expect(shown).toHaveLength(1)
    expect(shown[0]!.sticky).toBe(true)
    emit({ id: 'c1', name: 'Aside', asking: false })
    expect(useUi.getState().toasts.filter((x) => x.text.includes('Aside'))).toHaveLength(0)
    emit({ id: 'c1', name: 'Aside', asking: true })
    stop()
    expect(useUi.getState().toasts.filter((x) => x.text.includes('Aside'))).toHaveLength(0)
    expect(offs).toBe(1)
    // an older desktop app without it: nothing to watch
    expect(() => watchLocalAsking(() => ({ localApps: { version: 1 } }) as unknown as DesktopBridge)()).not.toThrow()
  })
})
