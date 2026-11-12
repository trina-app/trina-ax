// The phone app's Back (nav-v1, lib/appNav.ts; QA TC-246): where Back goes from the history entry on show, and a tapped
// notification opened by the router. The messages to the app: web/test/unit/mobile.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { appNavOf, initAppNav, resetAppNavForTest } from '../../src/lib/appNav'
import { setNavigator } from '../../src/lib/nav'

const item = (p: string, k = p) => ({ k, p })
/** an entry of a tab's stack: the router's idx, the stack's first entry at `base`, its trail up to this one */
const entry = (tab: string | null, idx: number, base: number, ...trail: string[]) => ({
  idx, key: `k${idx}`, usr: null,
  scr: { tab, sid: 's1', base, root: item(trail[0]!), trail: trail.map((p) => item(p)) },
})

describe('where Back goes', () => {
  test('a tab\'s root: nowhere (no swipe); Android goes to the start tab from another tab, else leaves', () => {
    expect(appNavOf(entry('ai', 0, 0, '/'), '/', true)).toEqual({ canGoBack: false, home: true })
    expect(appNavOf(entry('chats', 4, 4, '/rooms'), '/rooms', true)).toEqual({ canGoBack: false, home: false })
    // 프로젝트 (QA TC-255): its list is a root like the others; Android's Back goes to 트리나 from there
    expect(appNavOf(entry('projects', 2, 2, '/projects'), '/projects', true)).toEqual({ canGoBack: false, home: false })
    expect(appNavOf(entry('me', 1, 1, '/settings'), '/settings', true)).toEqual({ canGoBack: false, home: false })
    // an entry kept from before 프로젝트 (the old 파일 tab's): not taken for the start tab
    expect(appNavOf(entry('files', 2, 2, '/files'), '/files', true)).toEqual({ canGoBack: false, home: false })
  })

  test('the team folder under 프로젝트 goes back to the list, then nowhere', () => {
    expect(appNavOf(entry('projects', 4, 2, '/projects', '/files', '/files?path=a'), '/files', true)).toEqual({ canGoBack: true, home: false })
    expect(appNavOf(entry('projects', 3, 2, '/projects', '/files'), '/files', true)).toEqual({ canGoBack: true, home: false })
  })

  test('a screen above its tab\'s root goes back, also one the trail no longer reaches', () => {
    expect(appNavOf(entry('chats', 5, 4, '/rooms', '/rooms/r1'), '/rooms/r1', true)).toEqual({ canGoBack: true, home: false })
    expect(appNavOf(entry('ai', 1, 0, '/', '/c/x'), '/c/x', true)).toEqual({ canGoBack: true, home: true })
    // a page of another tab pushed onto this stack (a room's link in an AI chat): back to where it came from
    expect(appNavOf(entry('ai', 2, 0, '/', '/c/x', '/rooms/r1'), '/rooms/r1', true)).toEqual({ canGoBack: true, home: true })
    // an entry with no base of its own: as far back as its trail goes
    const { base: _base, ...noBase } = entry('projects', 7, 0, '/files', '/files?path=a').scr
    expect(appNavOf({ idx: 7, scr: noBase }, '/files', true)).toEqual({ canGoBack: true, home: false })
    expect(appNavOf({ idx: 7, scr: { ...noBase, trail: [item('/files')] } }, '/files', true)).toEqual({ canGoBack: false, home: false })
  })

  test('an open sheet, dialog or viewer: Back closes it, also at a tab\'s root', () => {
    expect(appNavOf({ ...entry('chats', 4, 4, '/rooms'), mycelOverlay: 12, mycelOverlayDepth: 1 }, '/rooms', true)).toEqual({ canGoBack: true, home: false })
    expect(appNavOf({ ...entry('ai', 0, 0, '/'), __imageViewer: true }, '/', true)).toEqual({ canGoBack: true, home: true })
    expect(appNavOf({ idx: 0, mycelOverlay: 3 }, '/', false)).toEqual({ canGoBack: true, home: true })
  })

  test('pages in no tab (sign-in, an invite) and computer-width pages: Back leaves the app with nothing under it', () => {
    expect(appNavOf(entry(null, 0, 0, '/login'), '/login', true)).toEqual({ canGoBack: false, home: true })
    // computer width (an Android tablet): the router's own entries, no tabs
    expect(appNavOf({ idx: 0, key: 'a' }, '/rooms', false)).toEqual({ canGoBack: false, home: true })
    expect(appNavOf({ idx: 2, key: 'c' }, '/rooms/r1', false)).toEqual({ canGoBack: true, home: true })
    expect(appNavOf(entry('chats', 5, 4, '/rooms', '/rooms/r1'), '/rooms/r1', false)).toEqual({ canGoBack: true, home: true })
    // a phone entry made before the stacks (no scr): its tab by its address
    expect(appNavOf({ idx: 0 }, '/rooms', true)).toEqual({ canGoBack: false, home: false })
    expect(appNavOf(null, '/', true)).toEqual({ canGoBack: false, home: true })
  })
})

describe('a tapped notification (mycel:open)', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  afterEach(() => {
    setNavigator(null)
    resetAppNavForTest()
    if (prior) Object.defineProperty(globalThis, 'window', prior)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  test('the router opens an id path and the event is cancelled (no load); anything else is left to the app\'s load', () => {
    const win = new EventTarget()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
    const went: [string, unknown][] = []
    setNavigator((to, o) => went.push([to, o]))
    resetAppNavForTest()
    initAppNav()
    const open = (path: unknown) => win.dispatchEvent(new CustomEvent('mycel:open', { detail: { path }, cancelable: true }))
    // taken: dispatchEvent says false, so the app's script does not load the path
    expect(open('/rooms/r1')).toBe(false)
    expect(open('/rooms/r1/t/m1')).toBe(false)
    expect(went).toEqual([['/rooms/r1', undefined], ['/rooms/r1/t/m1', undefined]])
    // not an id path on this team: not taken (the app loads it as before, or its own checks refuse it)
    for (const path of ['//evil.example/x', 'https://evil.example/', '/join#t=abc', '/files?path=a', '/../x', 42, null]) expect(open(path)).toBe(true)
    expect(win.dispatchEvent(new CustomEvent('mycel:open', { cancelable: true }))).toBe(true)
    expect(went).toHaveLength(2)
  })
})
