// The web page's browser relay (shared/src/desktop-bridge.ts): ack, run once, re-send results after a replay,
// window filtering, cancel, malformed results, old desktop apps.
import { describe, expect, test } from 'bun:test'
import { browserResultChars, ConnectInfo, createBrowserRelay, DESKTOP_BRIDGE_VERSION, getDesktopBridge, IN_APP_BROWSER_UA_MARK, isInAppBrowserUserAgent, type DesktopBridge } from '../../shared/src/desktop-bridge'
import type { BrowserCall, BrowserResult } from '../../shared/src/api/browser'
import type { ClientFrame, ServerFrame } from '../../shared/src/api/ws'
import { uuidv7 } from '../../shared/src/ids'

function fakeBridge(run: (c: BrowserCall) => Promise<BrowserResult>, version = DESKTOP_BRIDGE_VERSION) {
  const cancelled: string[] = []
  let runs = 0
  const bridge = {
    bridgeVersion: version,
    appVersion: '0.1.0',
    platform: 'darwin',
    browser: {
      run: (c: BrowserCall) => {
        runs++
        return run(c)
      },
      cancel: (id: string) => cancelled.push(id),
    },
  } as unknown as DesktopBridge
  return { bridge, cancelled, runs: () => runs }
}

const call = (over: Partial<BrowserCall> = {}): BrowserCall => ({ callId: 'c1', turnId: uuidv7(), chatId: uuidv7(), tool: 'navigate', args: { url: 'https://example.com' }, deadline: Date.now() + 60_000, ...over })
const ev = (windowId: string, c: BrowserCall): ServerFrame => ({ type: 'browser.call', seq: 1, at: Date.now(), data: { windowId, call: c } })
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('createBrowserRelay', () => {
  test('acks, runs, sends the result; a replayed call is not run again and gets the same result', async () => {
    const f = fakeBridge(async (c) => ({ callId: c.callId, ok: true, content: [{ type: 'text', text: 'done' }] }))
    const sent: ClientFrame[] = []
    const relay = createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x) })
    expect(relay.handle(ev('win-aaaaaaaa', call()))).toBe(true)
    await tick()
    expect(sent.map((s) => s.type)).toEqual(['browser.ack', 'browser.result'])
    relay.handle(ev('win-aaaaaaaa', call()))
    await tick()
    expect(f.runs()).toBe(1)
    expect(sent.at(-1)).toEqual(sent[1])
  })

  test('a call replayed while still running is acked again, not run twice', async () => {
    let finish!: (r: BrowserResult) => void
    const f = fakeBridge(() => new Promise((r) => (finish = r)))
    const sent: ClientFrame[] = []
    const relay = createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x) })
    relay.handle(ev('win-aaaaaaaa', call()))
    relay.handle(ev('win-aaaaaaaa', call()))
    expect(relay.running).toBe(1)
    expect(sent.map((s) => s.type)).toEqual(['browser.ack', 'browser.ack'])
    finish({ callId: 'c1', ok: true, content: [] })
    await tick()
    expect(f.runs()).toBe(1)
    expect(relay.running).toBe(0)
  })

  test('calls for other windows are ignored; cancel reaches the bridge only for running calls', async () => {
    let finish!: (r: BrowserResult) => void
    const f = fakeBridge(() => new Promise((r) => (finish = r)))
    const sent: ClientFrame[] = []
    const relay = createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x) })
    expect(relay.handle(ev('win-bbbbbbbb', call()))).toBe(false)
    expect(sent).toHaveLength(0)
    relay.handle(ev('win-aaaaaaaa', call()))
    relay.handle({ type: 'browser.cancel', seq: 2, at: 0, data: { windowId: 'win-aaaaaaaa', callId: 'c1' } })
    relay.handle({ type: 'browser.cancel', seq: 3, at: 0, data: { windowId: 'win-aaaaaaaa', callId: 'other' } })
    expect(f.cancelled).toEqual(['c1'])
    finish({ callId: 'c1', ok: false, content: [], error: 'stopped' })
    await tick()
    expect(relay.handle({ type: 'pong', t: 1 })).toBe(false)
  })

  test('bridge errors and malformed results become ok:false results', async () => {
    const sent: ClientFrame[] = []
    const thrower = fakeBridge(async () => {
      throw new Error('boom')
    })
    createBrowserRelay({ bridge: thrower.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x) }).handle(ev('win-aaaaaaaa', call()))
    await tick()
    const r1 = sent.at(-1) as Extract<ClientFrame, { type: 'browser.result' }>
    expect(r1.result.ok).toBe(false)
    expect(r1.result.error).toContain('boom')

    const wrong = fakeBridge(async () => ({ callId: 'someone-else', ok: true, content: [] }))
    createBrowserRelay({ bridge: wrong.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x) }).handle(ev('win-aaaaaaaa', call({ callId: 'c2' })))
    await tick()
    const r2 = sent.at(-1) as Extract<ClientFrame, { type: 'browser.result' }>
    expect(r2.result).toMatchObject({ callId: 'c2', ok: false })
  })

  test('an older desktop app gets an "update the app" result instead of running the call', async () => {
    const f = fakeBridge(async (c) => ({ callId: c.callId, ok: true, content: [] }), 1)
    const sent: ClientFrame[] = []
    createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x), minBridgeVersion: 2 }).handle(ev('win-aaaaaaaa', call()))
    await tick()
    expect(f.runs()).toBe(0)
    const r = sent.at(-1) as Extract<ClientFrame, { type: 'browser.result' }>
    expect(r.result.error).toContain('update the desktop app')
  })

  test('kept results are bounded by size: big screenshots do not pile up in the web page', async () => {
    const big = 'x'.repeat(1000)
    const f = fakeBridge(async (c) => ({ callId: c.callId, ok: true, content: [{ type: 'image', mime: 'image/jpeg', data: big }] }))
    const sent: ClientFrame[] = []
    const relay = createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send: (x) => sent.push(x), keepChars: 2500 })
    for (const id of ['a', 'b', 'c', 'd']) relay.handle(ev('win-aaaaaaaa', call({ callId: id })))
    await tick()
    expect(f.runs()).toBe(4)
    // c and d (2000 chars) are still remembered: replays are answered without running again
    relay.handle(ev('win-aaaaaaaa', call({ callId: 'd' })))
    relay.handle(ev('win-aaaaaaaa', call({ callId: 'c' })))
    await tick()
    expect(f.runs()).toBe(4)
    // a was forgotten: a replay of it runs again (the desktop app's own dedupe still answers it once)
    relay.handle(ev('win-aaaaaaaa', call({ callId: 'a' })))
    await tick()
    expect(f.runs()).toBe(5)
    expect(browserResultChars({ callId: 'x', ok: false, content: [{ type: 'text', text: 'abc' }], error: 'ab' })).toBe(5)
  })

  test('a closed WebSocket (send throws) or a bridge that throws synchronously does not break the relay', async () => {
    let open = false
    const sent: ClientFrame[] = []
    const send = (x: ClientFrame) => {
      if (!open) throw new Error('WebSocket is closed')
      sent.push(x)
    }
    const f = fakeBridge(async (c) => ({ callId: c.callId, ok: true, content: [{ type: 'text', text: 'done' }] }))
    const relay = createBrowserRelay({ bridge: f.bridge, windowId: 'win-aaaaaaaa', send })
    expect(() => relay.handle(ev('win-aaaaaaaa', call()))).not.toThrow()
    await tick()
    // after the reconnect the server replays the call: the remembered result goes out, nothing runs twice
    open = true
    relay.handle(ev('win-aaaaaaaa', call()))
    await tick()
    expect(f.runs()).toBe(1)
    expect(sent.map((x) => x.type)).toEqual(['browser.result'])

    const sync = fakeBridge(() => {
      throw new Error('ipc gone')
    })
    const out: ClientFrame[] = []
    createBrowserRelay({ bridge: sync.bridge, windowId: 'win-aaaaaaaa', send: (x) => out.push(x) }).handle(ev('win-aaaaaaaa', call({ callId: 'c9' })))
    await tick()
    expect((out.at(-1) as Extract<ClientFrame, { type: 'browser.result' }>).result.error).toContain('ipc gone')
  })

  test('the in-app browser User-Agent mark is recognised (the team server refuses those requests)', () => {
    expect(isInAppBrowserUserAgent(`Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36 ${IN_APP_BROWSER_UA_MARK}`)).toBe(true)
    expect(isInAppBrowserUserAgent('Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36')).toBe(false)
    expect(isInAppBrowserUserAgent(null)).toBe(false)
  })

  test('getDesktopBridge is null outside the desktop app', () => {
    expect(getDesktopBridge()).toBeNull()
  })

  test('ConnectInfo accepts hex fingerprints with or without colons', () => {
    const hex = 'AB'.repeat(32)
    expect(ConnectInfo.safeParse({ teamId: 't', lanCertSha256: hex, lanPort: 8443, lanHosts: ['mac.local'] }).success).toBe(true)
    expect(ConnectInfo.safeParse({ teamId: 't', lanCertSha256: hex.match(/../g)!.join(':'), lanPort: 8443, lanHosts: [] }).success).toBe(true)
    expect(ConnectInfo.safeParse({ teamId: 't', lanCertSha256: 'nope', lanPort: 8443, lanHosts: [] }).success).toBe(false)
  })
})
