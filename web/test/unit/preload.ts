// Preloaded before every web unit test file (web/bunfig.toml). Bun 1.3 runs all the files in one process with one global
// object and one module registry, in the order the file system lists them (another order on another machine): what a
// file leaves behind is what the next one starts with. This makes every file start from the same place, whatever ran
// before it:
//
// - React DOM is loaded once here, with a fake document present. React decides at load whether the browser has the
//   "input" event; loaded first by a file without a document, it would take a fallback for the whole run that reports a
//   text field's change only on keyup of a field that got focusin, so typing in tests would depend on file order.
// - Every zustand store is recorded when it is made (zustand's create, wrapped) and put back the way it was made at the
//   start of each file; a store's own reset() runs first, so what it keeps beside its state (maps, a counter that drops
//   answers to an earlier request) is cleared too. Without this, a store loaded by one file (the AI access a page asked
//   for) stays loaded in the next, which then never asks.
// - The globals tests replace (fetch, location, history, matchMedia, the fake DOM's) are put back, a fake document a
//   file left installed is taken away (dom-host.removeDom, which also unmounts what is still mounted), and Bun's clock is
//   the real one again.
//
// The start of a file is a beforeAll that a loader plugin puts in front of each test file's own code, on its first line
// (line numbers in errors stay right). Tests without installDom still see no `window`: the fake document is taken away
// again right after React DOM is loaded.
import { plugin } from 'bun'
import { mock, setSystemTime } from 'bun:test'
import * as zustand from 'zustand'
import { domInstalled, installDom, removeDom } from './dom-host'

type Store = { getState(): unknown; getInitialState(): unknown; setState(state: unknown, replace: true): void }
const stores = new Set<Store>()
const made = <T extends Store>(store: T) => {
  stores.add(store)
  return store
}
// zustand's own module as it is now (the import is live: after mock.module it would be this wrapper)
const real = { ...zustand }
type Init = zustand.StateCreator<unknown, [], []>
const make = (init: Init) => made(real.create(init) as unknown as Store)
// create(init) and create<T>()(init), as zustand's own
const create = ((init?: Init) => (init ? make(init) : make)) as unknown as typeof real.create
mock.module('zustand', () => ({ ...real, create }))

installDom()
await import('react-dom/client')
removeDom()

/** the globals tests replace, as they are with no fake document */
const GLOBALS = [
  'fetch', 'location', 'history', 'navigator', 'matchMedia', 'localStorage', 'sessionStorage', 'window', 'document', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'XMLHttpRequest', 'Notification',
  'showDirectoryPicker', 'mycelDesktop', 'open', 'scrollTo', 'getSelection', 'top', 'self', 'isSecureContext', 'IS_REACT_ACT_ENVIRONMENT',
  'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Text', 'Event', 'KeyboardEvent', 'MouseEvent', 'addEventListener', 'removeEventListener', 'dispatchEvent',
]
const g = globalThis as Record<string, unknown>
const before = new Map(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]))
const same = (a?: PropertyDescriptor, b?: PropertyDescriptor) => (!a && !b) || (!!a && !!b && a.value === b.value && a.get === b.get && a.set === b.set)

/** Where every test file starts. */
export function fileStart() {
  if (domInstalled()) removeDom()
  for (const [k, d] of before) {
    if (same(Object.getOwnPropertyDescriptor(g, k), d)) continue
    try {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    } catch { /* not configurable: left as it is */ }
  }
  setSystemTime()
  for (const s of stores) {
    const state = s.getState() as { reset?: unknown }
    if (typeof state?.reset === 'function' && state.reset.length === 0) {
      try { (state.reset as () => void)() } catch { /* a reset that needs a page: the state below is enough */ }
    }
    s.setState(s.getInitialState(), true)
  }
}
const START = Symbol.for('mycel.web-test.file-start')
g[START as unknown as string] = fileStart

plugin({
  name: 'web-test-file-start',
  setup(build) {
    build.onLoad({ filter: /[\\/]test[\\/]unit[\\/][^\\/]+\.test\.tsx?$/ }, async ({ path }) => ({
      contents: `import { beforeAll as __webTestFileStart } from 'bun:test'; __webTestFileStart(() => (globalThis as any)[Symbol.for('mycel.web-test.file-start')]?.());` + (await Bun.file(path).text()),
      loader: path.endsWith('x') ? 'tsx' : 'ts',
    }))
  },
})
