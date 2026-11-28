/// <reference path="../../chrome-extension/src/chrome.d.ts" />
// Stop in the person's Chrome (manual QA 2026-11-28, F and G): a stopped task's window closes (its tabs' debugger goes
// with it, so Chrome's "debugging" bar can go), Disconnect closes every task's window, and a stop holds only the answer
// that was running (a server that stops the chat's answer itself, hello.runStops), so the next message works at once.
// A small stand-in for the chrome.* APIs the worker's run and call code uses.
import { beforeAll, describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'

const removedWindows: number[] = []
let nextWin = 100, nextTab = 1000, nextGroup = 1
const wins = new Set<number>()
const tabs = new Map<number, { id: number; windowId: number; groupId: number; active: boolean; url: string }>()
const noop = { addListener() {} }
const store = new Map<string, unknown>()
const area = {
  get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
  set: async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) store.set(k, v) },
  remove: async (k: string) => { store.delete(k) },
}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { session: area, local: area },
  windows: {
    create: async () => { const id = nextWin++, t = nextTab++; wins.add(id); tabs.set(t, { id: t, windowId: id, groupId: -1, active: true, url: 'about:blank' }); return { id, tabs: [{ id: t }] } },
    get: async (id: number) => { if (!wins.has(id)) throw new Error('no window'); return { id } },
    remove: async (id: number) => { removedWindows.push(id); wins.delete(id); for (const [k, t] of tabs) if (t.windowId === id) tabs.delete(k) },
    onRemoved: noop,
  },
  tabs: {
    query: async (q: { groupId?: number; windowId?: number }) => [...tabs.values()].filter((t) => (q.groupId === undefined || t.groupId === q.groupId) && (q.windowId === undefined || t.windowId === q.windowId)),
    get: async (id: number) => { const t = tabs.get(id); if (!t) throw new Error('no tab'); return t },
    group: async (o: { groupId?: number; tabIds: number[] }) => { const g = o.groupId ?? nextGroup++; for (const id of o.tabIds) tabs.get(id)!.groupId = g; return g },
    create: async (o: { windowId: number }) => { const t = nextTab++; tabs.set(t, { id: t, windowId: o.windowId, groupId: -1, active: false, url: 'about:blank' }); return { id: t } },
    remove: async (id: number) => { tabs.delete(id) },
    onCreated: noop, onRemoved: noop, onUpdated: noop,
  },
  tabGroups: { update: async () => {}, onRemoved: noop },
  debugger: { detach: async () => {}, getTargets: async () => [], onEvent: noop, onDetach: noop, sendCommand: async () => ({}) },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  runtime: { getManifest: () => ({ version: '0.0.0' }) },
}

let calls: typeof import('../../chrome-extension/src/calls')
let runs: typeof import('../../chrome-extension/src/runs')
let state: typeof import('../../chrome-extension/src/state')
beforeAll(async () => {
  calls = await import('../../chrome-extension/src/calls')
  runs = await import('../../chrome-extension/src/runs')
  state = await import('../../chrome-extension/src/state')
})

const link = (runStops: boolean) => ({ origin: 'https://acme.test', token: 't', linkId: 'l', user: { name: 'A', username: 'a' }, team: { name: 'Acme' }, teamHosts: [], runStops })

/** one tabs_context call of a run and answer; its result */
function call(runId: string, turnId = uuidv7()): Promise<{ ok: boolean; stopped?: boolean }> {
  return new Promise((resolve) => {
    calls.handleCall({ callId: `c-${Math.random()}`, turnId, chatId: uuidv7(), tool: 'tabs_context', args: {}, deadline: Date.now() + 60_000, run: { id: runId, title: 'Task' } } as never, (f) => {
      if (f.type === 'browser.result') resolve(f.result as { ok: boolean; stopped?: boolean })
    })
  })
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('Stop in the person\'s Chrome', () => {
  test('a stopped run\'s window closes (G)', async () => {
    state.live.link = link(true)
    const r = await runs.runFor('chat-g', 'Task')
    await runs.createRunTab(r, uuidv7(), false)
    const w = r.windowId!
    expect(wins.has(w)).toBe(true)
    calls.stopRun('chat-g')
    await settle()
    expect(removedWindows).toContain(w)
    expect((await runs.allRuns()).some((x) => x.id === 'chat-g')).toBe(false)
  })

  test('Disconnect: every task\'s window closes', async () => {
    const a = await runs.runFor('chat-a', 'A'), b = await runs.runFor('chat-b', 'B')
    await runs.createRunTab(a, uuidv7(), false)
    await runs.createRunTab(b, uuidv7(), false)
    await runs.closeAllRuns()
    expect(removedWindows).toEqual(expect.arrayContaining([a.windowId, b.windowId].filter((x): x is number => x !== null)))
    expect(await runs.allRuns()).toEqual([])
  })

  test('a server that stops the answer itself: the next message in that chat works at once (F)', async () => {
    state.live.link = link(true)
    calls.stopRun('chat-f')
    const r = await call('chat-f')
    expect(r.stopped).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  test('Stop between two calls of one answer: that answer stays held, a new one is not (F, review)', async () => {
    state.live.link = link(true)
    const turn = uuidv7()
    expect((await call('chat-between', turn)).ok).toBe(true)
    calls.stopRun('chat-between')
    expect((await call('chat-between', turn)).stopped).toBe(true)
    expect((await call('chat-between')).stopped).toBeUndefined()
  })

  test('an older server, or an MCP app\'s run: the whole run waits (as before)', async () => {
    state.live.link = link(false)
    calls.stopRun('chat-old')
    expect((await call('chat-old')).stopped).toBe(true)
    state.live.link = link(true)
    calls.stopRun('mcp:grant-1')
    expect((await call('mcp:grant-1')).stopped).toBe(true)
  })
})
