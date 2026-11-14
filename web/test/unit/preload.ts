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
//   the real one again. A component that sets its state after its file ended does nothing (dom-host: "A component can
//   set its state after it is gone").
// - The time zone is the one the run started in. Bun 1.3 applies `process.env.TZ` when it is set, but once TZ is
//   deleted the zone stays the last one, and setting TZ again changes nothing for the rest of the run. A file that set
//   TZ and deleted it to put back "no TZ" (audit-dates, usage-range) left every later file in New York. So TZ is set to
//   the zone the run started in (a file puts back that value, never deletes it), and at the start of each file it is
//   that zone again.
// - React's act() is closed. An act, mount, click, type or unmount that was not awaited, or a test that timed out inside
//   one, leaves an act() scope open; two that overlap leave React's act depth above 0 for good. While a scope is open
//   React keeps every render in its act queue, so every page mounted later in the run stays `<div></div>` (2026-11-12:
//   one such file, about 550 failures in the 88 files CI ran after it, none with Bun 1.4.4). React keeps that depth to
//   itself, so it cannot be put back: while it is open, each file fails at once with one line that names the file that
//   most likely left it (the last one that started with act() closed).
// - The theme in use (lib/theme.ts keeps it in its module, not in a store) is 'system' again, as at page load. A file
//   that picked light or dark (session-theme) left it for the next, so mobile.test.ts's appearance-v1 heard
//   system:false. With no fake document, applyTheme only sets that value.
//
// The start of a file is a beforeAll that a loader plugin puts in front of each test file's own code, on its first line
// (line numbers in errors stay right). Tests without installDom still see no `window`: the fake document is taken away
// again right after React DOM is loaded.
import { plugin } from 'bun'
import { mock, setSystemTime } from 'bun:test'
import * as React from 'react'
import * as zustand from 'zustand'
import { applyTheme } from '../../src/lib/theme'
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
// The formatted-text code (components/LazyMarkdown.tsx) is loaded here, as in a page that has shown an answer already:
// every file draws Markdown at once, as before it was its own file; lazy-markdown.test.tsx checks the step before
await (await import('../../src/components/LazyMarkdown')).loadMarkdown()

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

const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone
/** the run's time zone, as TZ names it */
const TZ = process.env.TZ || zoneNow()
process.env.TZ = TZ
const ZONE = zoneNow()

const reactInternals = (React as unknown as Record<string, { actQueue?: unknown } | undefined>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
if (!reactInternals || !('actQueue' in reactInternals)) throw new Error('preload: React no longer keeps its act queue where this file looks (see "React\'s act() is closed")')
/** Is an act() scope still open? A sync act() closes its own scope at once and, with none open around it, leaves no
 * act queue behind; inside one left open the queue stays. */
const actOpen = () => {
  React.act(() => {})
  return reactInternals.actQueue != null
}
/** the last test file that started with act() closed, and, while a scope is open, the file named for it */
let lastFile = ''
let actLeftBy = ''

/** Where every test file starts (`file`: its path, from the loader below). */
export function fileStart(file = '') {
  if (actOpen()) {
    actLeftBy ||= lastFile || 'a file before this one'
    throw new Error(`a React act() is open, most likely left by ${actLeftBy}: an act, mount, click, type or unmount not awaited (React says "overlapping act() calls" or "without await" there), or a test that timed out inside one. While it is open nothing renders, so every file fails here.`)
  }
  actLeftBy = ''
  if (file) lastFile = file
  if (domInstalled()) removeDom()
  if (process.env.TZ !== TZ) process.env.TZ = TZ
  if (zoneNow() !== ZONE) throw new Error(`the time zone is ${zoneNow()}, not the run's ${ZONE}, and cannot be put back: a file deleted process.env.TZ (Bun then keeps the last zone). Put back the value it had instead.`)
  for (const [k, d] of before) {
    if (same(Object.getOwnPropertyDescriptor(g, k), d)) continue
    try {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    } catch { /* not configurable: left as it is */ }
  }
  setSystemTime()
  applyTheme('system') // after removeDom and the globals: with no window it only sets the theme in use
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
      contents: `import { beforeAll as __webTestFileStart } from 'bun:test'; __webTestFileStart(() => (globalThis as any)[Symbol.for('mycel.web-test.file-start')]?.(${JSON.stringify(path.replace(/\\/g, '/').replace(/^.*\/(test\/unit\/)/, '$1'))}));` + (await Bun.file(path).text()),
      loader: path.endsWith('x') ? 'tsx' : 'ts',
    }))
  },
})
