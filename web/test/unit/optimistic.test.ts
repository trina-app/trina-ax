// The shared optimistic change (lib/optimistic.ts, docs/DECISIONS.md "Optimistic changes: the screen first, the server
// after"): the new value on screen before the request, a failure puts back what the server last agreed to with one
// toast in the person's language, a reply that is no longer the newest writes nothing, and changes of one item reach
// the server in the order they were made.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { ApiError } from '../../src/lib/api'
import { optimistic, optimisticEdits, optimisticPending, resetOptimistic } from '../../src/lib/optimistic'
import { useUi } from '../../src/store/ui'

const locale = useLocaleStore.getState().locale
beforeEach(() => {
  useLocaleStore.setState({ locale: 'ko' })
  useUi.setState({ toasts: [] } as never)
})
afterEach(() => {
  resetOptimistic()
  useLocaleStore.setState({ locale })
})

const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts

/** a request the test answers by hand */
function later<R>() {
  let ok!: (r: R) => void
  let fail!: (e: unknown) => void
  const p = new Promise<R>((a, b) => { ok = a; fail = b })
  return { p, ok, fail }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

test('the value is on screen before the request answers, and the reply settles it', async () => {
  let shown = false
  const settled: string[] = []
  const req = later<string>()
  const done = optimistic({ key: 'chat:a:pin', from: false, to: true, show: (v) => (shown = v), send: () => req.p, settle: (r) => settled.push(r) })
  expect(shown).toBe(true)
  expect(optimisticPending('chat:a:pin')).toBe(true)
  req.ok('server copy')
  expect(await done).toEqual({ ok: true, reply: 'server copy', newest: true })
  expect(settled).toEqual(['server copy'])
  expect(optimisticPending('chat:a:pin')).toBe(false)
  expect(toasts()).toEqual([])
})

test('a failure puts the value back and says so once, in the person\'s language', async () => {
  let shown = false
  const r = await optimistic({ key: 'chat:a:pin', from: false, to: true, show: (v) => (shown = v), send: () => Promise.reject(new TypeError('Failed to fetch')) })
  expect(r.ok).toBe(false)
  expect(shown).toBe(false)
  expect(toasts().map((x) => [x.level, x.text])).toEqual([['error', translate('ko', 'error.network')]])
})

test("a refusal shows the server's words; failText replaces them; false says nothing", async () => {
  const refused = () => Promise.reject(new ApiError(403, { code: 'forbidden', message: 'Not yours to change.' }))
  await optimistic({ key: 'k1', from: 0, to: 1, show: () => {}, send: refused })
  await optimistic({ key: 'k2', from: 0, to: 1, show: () => {}, send: refused, failText: 'Could not pin it.' })
  await optimistic({ key: 'k3', from: 0, to: 1, show: () => {}, send: refused, failText: false })
  expect(toasts().map((x) => x.text)).toHaveLength(2)
  expect(toasts()[1]!.text).toBe('Could not pin it.')
})

test('pin then unpin at once: the requests go in order, only the newest reply is written', async () => {
  const shown: boolean[] = []
  const sent: string[] = []
  const settled: string[] = []
  const pin = later<string>()
  const unpin = later<string>()
  const a = optimistic({ key: 'chat:a:pin', from: false, to: true, show: (v) => shown.push(v), send: () => (sent.push('pin'), pin.p), settle: (r) => settled.push(r) })
  const b = optimistic({ key: 'chat:a:pin', from: true, to: false, show: (v) => shown.push(v), send: () => (sent.push('unpin'), unpin.p), settle: (r) => settled.push(r) })
  expect(shown).toEqual([true, false])
  await tick()
  // the second waits for the first: the server ends where the last tap left it
  expect(sent).toEqual(['pin'])
  pin.ok('pinned copy')
  expect(await a).toEqual({ ok: true, reply: 'pinned copy', newest: false })
  await tick()
  expect(sent).toEqual(['pin', 'unpin'])
  unpin.ok('unpinned copy')
  await b
  // the older reply never put "pinned" back over the newer tap
  expect(settled).toEqual(['unpinned copy'])
  expect(shown).toEqual([true, false])
})

test('an older change failing under a newer one undoes nothing; the newer failing goes back to what was confirmed', async () => {
  const shown: boolean[] = []
  const fail = () => Promise.reject(new TypeError('Failed to fetch'))
  // pin fails, unpin fails: the server never moved, so the screen ends unpinned (as before both)
  const a = optimistic({ key: 'x', from: false, to: true, show: (v) => shown.push(v), send: fail })
  const b = optimistic({ key: 'x', from: true, to: false, show: (v) => shown.push(v), send: fail })
  await Promise.all([a, b])
  expect(shown).toEqual([true, false, false])
  expect(toasts()).toHaveLength(1)
  // pin works, unpin fails: the screen goes back to pinned, what the server has
  shown.length = 0
  const c = optimistic({ key: 'y', from: false, to: true, show: (v) => shown.push(v), send: () => Promise.resolve('ok') })
  const d = optimistic({ key: 'y', from: true, to: false, show: (v) => shown.push(v), send: fail })
  await Promise.all([c, d])
  expect(shown).toEqual([true, false, true])
})

test('different items do not wait for each other', async () => {
  const sent: string[] = []
  const slow = later<string>()
  void optimistic({ key: 'chat:a:pin', from: false, to: true, show: () => {}, send: () => (sent.push('a'), slow.p) })
  void optimistic({ key: 'chat:b:pin', from: false, to: true, show: () => {}, send: () => (sent.push('b'), Promise.resolve('b')) })
  await tick()
  expect(sent).toEqual(['a', 'b'])
  slow.ok('a')
})

test('every change counts: a list read asked before one can tell its answer may be older', async () => {
  const before = optimisticEdits()
  await optimistic({ key: 'z', from: 0, to: 1, show: () => {}, send: () => Promise.resolve(null) })
  expect(optimisticEdits()).toBe(before + 1)
})
