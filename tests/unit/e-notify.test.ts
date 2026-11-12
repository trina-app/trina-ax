// The desktop app's notifications for the team page (desktop/src/common/notify.ts, docs/DECISIONS.md "Session
// markers"): only while the window is not focused, at most 10 a minute, one per tag, and a click shows the window AND
// opens the chat the page named (before, it only focused the window); a team switch closes them all. The dock badge's
// number. Settings › Notifications' test notification: shown while focused too, and it says what the system answered
// (on macOS "taken" proves nothing: unknown). macOS's one question about notifications is asked while the window is in
// front (ask), not with the first notification, which only comes while it is in the back.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { badgeCountOf, DOCK_DOT, dockBadgeOf, makeNotifier, NOTIFY_PER_MINUTE, openPathOf, platformNotifyDeps, readTokenOf, tagOf, TEST_PER_MINUTE, TEST_WAIT_MS, type NoteLike } from '../../desktop/src/common/notify'
import { STRINGS } from '../../desktop/src/common/i18n'

class FakeNote implements NoteLike {
  shown = false
  closed = false
  private handlers = new Map<string, (() => void)[]>()
  constructor(readonly n: { title: string; body: string; actions?: { type: 'button'; text: string }[] }) {}
  on(e: 'click' | 'close' | 'show' | 'failed' | 'action', f: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), f]) }
  emit(e: 'click' | 'close' | 'show' | 'failed' | 'action') { for (const f of this.handlers.get(e) ?? []) f() }
  show() { this.shown = true }
  close() { this.closed = true; this.emit('close') }
  click() { this.emit('click') }
}

function setup(o: { focused?: boolean; supported?: boolean; testWaitMs?: number; ask?: boolean | 'throws'; showIsSeen?: boolean; markRead?: string | null } = {}) {
  const notes: FakeNote[] = []
  const opened: string[] = []
  const reads: string[] = []
  let revealed = 0
  let asked = 0
  let focused = o.focused ?? false
  let clock = 1_000_000
  const notifier = makeNotifier({
    create: (n) => { const x = new FakeNote(n); notes.push(x); return x },
    supported: () => o.supported ?? true,
    focused: () => focused,
    reveal: () => { revealed++ },
    open: (p) => opened.push(p),
    now: () => clock,
    testWaitMs: o.testWaitMs,
    ask: o.ask ? () => { asked++; if (o.ask === 'throws') throw new Error('no notifications') } : undefined,
    showIsSeen: o.showIsSeen,
    ...(o.markRead !== undefined ? { markReadLabel: () => o.markRead!, read: (t: string) => { reads.push(t) } } : {}),
  })
  return { reads, notify: notifier.notify, test: notifier.test, closeAll: notifier.closeAll, ask: notifier.ask, asked: () => asked, notes, opened, revealed: () => revealed, focus: (v: boolean) => { focused = v }, tick: (ms: number) => { clock += ms } }
}

const CHAT = '01a1b10f-4c39-7478-a2d8-f2d048b335df'

describe('a notification click', () => {
  test('shows the window and opens the chat it names', () => {
    const s = setup()
    expect(s.notify({ title: 'Weekly report', body: 'New answer', tag: `chat-${CHAT}`, open: `/c/${CHAT}` })).toBe(true)
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0]!.shown).toBe(true)
    expect(s.notes[0]!.n).toEqual({ title: 'Weekly report', body: 'New answer' })
    s.notes[0]!.click()
    expect(s.revealed()).toBe(1)
    expect(s.opened).toEqual([`/c/${CHAT}`])
  })

  test('without an address (an older page) or with one that is not an app path, it only shows the window', () => {
    const s = setup()
    for (const open of [undefined, 'https://evil.example/c/1', '//evil.example', '/c/../admin', '/c/x?y=1', 'javascript:alert(1)', '/c/<script>', 42]) {
      s.notify({ title: 't', body: 'b', open })
      s.notes.at(-1)!.click()
    }
    expect(s.opened).toEqual([])
    expect(s.revealed()).toBe(8)
  })
})

describe('when it shows', () => {
  test('never while the window is focused, or where the system has none', () => {
    const focused = setup({ focused: true })
    expect(focused.notify({ title: 't', body: 'b' })).toBe(false)
    expect(focused.notes).toEqual([])
    const none = setup({ supported: false })
    expect(none.notify({ title: 't', body: 'b' })).toBe(false)
  })

  test('one per tag: a newer one for the same chat replaces the older one; other chats stay', () => {
    const s = setup()
    s.notify({ title: 'a', body: '1', tag: 'chat-a', open: '/c/a' })
    s.notify({ title: 'b', body: '1', tag: 'chat-b', open: '/c/b' })
    s.notify({ title: 'a', body: '2', tag: 'chat-a', open: '/c/a' })
    expect(s.notes.map((n) => n.closed)).toEqual([true, false, false])
    // the replaced one's click (a stale banner) still opens its chat
    s.notes[2]!.click()
    expect(s.opened).toEqual(['/c/a'])
  })

  test(`at most ${NOTIFY_PER_MINUTE} a minute`, () => {
    const s = setup()
    for (let i = 0; i < NOTIFY_PER_MINUTE + 3; i++) s.notify({ title: 't', body: String(i), tag: `chat-${i}` })
    expect(s.notes).toHaveLength(NOTIFY_PER_MINUTE)
    s.tick(60_001)
    expect(s.notify({ title: 't', body: 'later' })).toBe(true)
  })

  test('long titles and bodies are cut', () => {
    const s = setup()
    s.notify({ title: 'T'.repeat(500), body: 'B'.repeat(5000) })
    expect(s.notes[0]!.n.title).toHaveLength(200)
    expect(s.notes[0]!.n.body).toHaveLength(1000)
  })
})

const ROOM = '01a1b10f-4c39-7478-a2d8-f2d048b335aa', ROOT = '01a1b10f-4c39-7478-a2d8-f2d048b335bb'

describe('"Mark as read" (macOS)', () => {
  test('a room notification with a place gets the button; pressing it marks that place read and opens nothing', () => {
    const s = setup({ markRead: 'Mark as read' })
    s.notify({ title: 'Ben', body: 'hi', tag: `room-${ROOM}`, open: `/rooms/${ROOM}`, read: `${ROOM}@42` })
    expect(s.notes[0]!.n.actions).toEqual([{ type: 'button', text: 'Mark as read' }])
    s.notes[0]!.emit('action')
    expect(s.reads).toEqual([`${ROOM}@42`])
    expect(s.opened).toEqual([])
    expect(s.revealed()).toBe(0)
    // a reply in a thread: the thread's place
    s.notify({ title: 'Ben', body: 'reply', tag: `room-${ROOM}`, read: `${ROOM}/${ROOT}@43` })
    s.notes[1]!.emit('action')
    expect(s.reads).toEqual([`${ROOM}@42`, `${ROOM}/${ROOT}@43`])
  })

  test('no button: no place, an odd place, a system without buttons (Windows, Linux), an older app; none after a team switch', () => {
    const none = (o: Parameters<typeof setup>[0], read?: unknown) => { const s = setup(o); s.notify({ title: 'x', body: 'y', read }); return s.notes[0]!.n.actions }
    expect(none({ markRead: 'Mark as read' })).toBeUndefined()
    expect(none({ markRead: 'Mark as read' }, 'javascript:alert(1)')).toBeUndefined()
    expect(none({ markRead: 'Mark as read' }, `${ROOM}@-1`)).toBeUndefined()
    expect(none({ markRead: null }, `${ROOM}@1`)).toBeUndefined()
    expect(none({}, `${ROOM}@1`)).toBeUndefined()
    const s = setup({ markRead: 'Mark as read' })
    s.notify({ title: 'x', body: 'y', read: `${ROOM}@1` })
    s.closeAll()
    s.notes[0]!.emit('action')
    expect(s.reads).toEqual([])
    expect(readTokenOf(`${ROOM}@7`)).toBe(`${ROOM}@7`)
    expect(readTokenOf(`${ROOM}/${ROOT}@7`)).toBe(`${ROOM}/${ROOT}@7`)
    expect(readTokenOf(`${ROOM}@7x`)).toBeNull()
  })

  test('the words are the app\'s own, in every language', () => {
    for (const s of Object.values(STRINGS)) expect(s['notify.markRead']).toBeTruthy()
  })
})

describe('checks', () => {
  test('addresses, tags and badge counts', () => {
    expect(openPathOf(`/c/${CHAT}`)).toBe(`/c/${CHAT}`)
    expect(openPathOf('/rooms/abc')).toBe('/rooms/abc')
    expect(openPathOf('/')).toBe('/')
    expect(openPathOf('/c/' + 'x'.repeat(300))).toBeNull()
    expect(tagOf(`chat-${CHAT}`)).toBe(`chat-${CHAT}`)
    expect(tagOf('a b')).toBeNull()
    expect(tagOf('')).toBeNull()
    expect(badgeCountOf(3)).toBe(3)
    expect(badgeCountOf(0)).toBe(0)
    expect(badgeCountOf(-2)).toBe(0)
    expect(badgeCountOf(2.5)).toBe(0)
    expect(badgeCountOf('5')).toBe(0)
    expect(badgeCountOf(100_000)).toBe(9999)
  })

  test('the dock badge takes a number or the dot, nothing else: the dot only at 0 and only for a flag that is exactly true', () => {
    expect(DOCK_DOT).toBe('•')
    expect(dockBadgeOf(0, true)).toBe('•')
    expect(dockBadgeOf(3, true)).toBe(3) // the number wins
    expect(dockBadgeOf(3, false)).toBe(3)
    expect(dockBadgeOf(0, false)).toBe(0)
    expect(dockBadgeOf(0, undefined)).toBe(0) // an older page: as before
    for (const odd of ['•', 'true', 1, {}, [true], null]) expect(dockBadgeOf(0, odd)).toBe(0)
    // a page's text never reaches the Dock: an odd count is 0, so the flag decides
    expect(dockBadgeOf('hello', false)).toBe(0)
    expect(dockBadgeOf('hello', true)).toBe('•')
    expect(dockBadgeOf(-1, true)).toBe('•')
    expect(dockBadgeOf(2.5, false)).toBe(0)
    expect(dockBadgeOf(100_000, true)).toBe(9999)
  })

  test('the main process takes the address and the tag from the page, the badge on macOS only, focus from the window showing the team page', () => {
    const dir = path.join(import.meta.dir, '../../desktop/src')
    const main = fs.readFileSync(path.join(dir, 'main/main.ts'), 'utf8')
    const win = fs.readFileSync(path.join(dir, 'main/app-window.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(dir, 'preload/app.ts'), 'utf8')
    expect(main).toContain("win!.notify({ title: String(n?.title ?? ''), body: String(n?.body ?? ''), tag: n?.tag, open: n?.open, read: n?.read })")
    expect(main).toMatch(/bridge:badge', \(e, n: unknown, dot: unknown\) => \{\s*if \(!fromApp\(e\) \|\| process\.platform !== 'darwin'\) return\s*const badge = dockBadgeOf\(n, dot\)\s*if \(badge === DOCK_DOT\) app\.dock\?\.setBadge\(DOCK_DOT\)\s*else app\.setBadgeCount\(badge\)/)
    expect(preload).toContain("setBadgeCount: (n, dot) => ipcRenderer.send('bridge:badge', Number(n), dot === true)")
    expect(win).toContain("open: (path) => this.send(this.app, 'bridge:open', path)")
    // the focus word: the window's focus while the team page is shown (not under the team list or the offline screen),
    // told on focus, blur and every layout, and answered the same (docs/DECISIONS.md "화면에 연 대화는 울리지 않는다")
    expect(win).toContain("this.win.on('blur', () => this.sendFocus(false))")
    expect(win).toContain("this.send(app, 'bridge:focus', focused)")
    expect(win).toMatch(/teamFocused\(windowFocused\?: boolean\): boolean \{\s*if \(this\.win\.isDestroyed\(\) \|\| !this\.app \|\| this\.mode !== 'team'\) return false/)
    expect(main).toContain("ipcMain.handle('bridge:focus', (e) => (fromApp(e) ? win!.teamFocused() : false))")
    expect(preload).toContain("onOpen: on('bridge:open')")
    expect(preload).toContain("onRead: on('bridge:read')")
    expect(win).toContain("read: (token) => this.send(this.app, 'bridge:read', token)")
    expect(win).toMatch(/markReadLabel: \(\) => process\.platform === 'darwin'/)
    expect(preload).toContain("open: n?.open === undefined ? undefined : String(n.open)")
  })
})

describe('a team switch', () => {
  test('closes every notification the team page made (tagged or not), and a click on one the system still shows opens nothing', () => {
    const s = setup()
    s.notify({ title: 'a', body: '1', tag: 'chat-a', open: '/c/a' })
    s.notify({ title: 'room', body: '1', tag: 'room-r', open: '/rooms/r' })
    s.notify({ title: 'plain', body: 'an admin alert' })
    s.closeAll()
    expect(s.notes.map((n) => n.closed)).toEqual([true, true, true])
    // a stale banner of the old team: the window comes up, its address is not opened in the new team's page
    s.notes[0]!.click()
    expect(s.revealed()).toBe(1)
    expect(s.opened).toEqual([])
    // the new team's own notifications open as before; the old tag is free again
    s.notify({ title: 'a', body: 'new team', tag: 'chat-a', open: '/c/a' })
    expect(s.notes[1]!.closed).toBe(true)
    s.notes[3]!.click()
    expect(s.opened).toEqual(['/c/a'])
  })

  test('the window closes them in disposeTeam, with the dock badge', () => {
    const win = fs.readFileSync(path.join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toMatch(/private disposeTeam\(\) \{[\s\S]{0,400}this\.notifier\.closeAll\(\)[\s\S]{0,80}electronApp\.setBadgeCount\(0\)/)
  })
})

describe('the test notification (Settings › Notifications)', () => {
  test('shown while the window is focused (the person asked for it); the system took it: shown', async () => {
    const s = setup({ focused: true })
    const answer = s.test({ title: 'Trina AX test notification', body: 'New messages show up like this.' })
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0]!.shown).toBe(true)
    expect(s.notes[0]!.n).toEqual({ title: 'Trina AX test notification', body: 'New messages show up like this.' })
    s.notes[0]!.emit('show')
    expect(await answer).toBe('shown')
    // a click only brings the window up
    s.notes[0]!.click()
    expect(s.revealed()).toBe(1)
    expect(s.opened).toEqual([])
  })

  test('the system refused it (notifications off for the app): off; no answer at all: unknown', async () => {
    const s = setup({ testWaitMs: 20 })
    const refused = s.test({ title: 't', body: 'b' })
    s.notes[0]!.emit('failed')
    expect(await refused).toBe('off')
    expect(await s.test({ title: 't', body: 'b' })).toBe('unknown')
    expect(TEST_WAIT_MS).toBe(5000)
  })

  test('no notifications on this system: unsupported; a small budget of its own that never holds back a real one', async () => {
    expect(await setup({ supported: false }).test({ title: 't', body: 'b' })).toBe('unsupported')
    const s = setup({ testWaitMs: 1 })
    // a busy minute of real notifications leaves the button working
    for (let i = 0; i < NOTIFY_PER_MINUTE; i++) s.notify({ title: 't', body: String(i), tag: `chat-${i}` })
    expect(await s.test({ title: 't', body: 'b' })).toBe('unknown')
    // and clicking the button over and over never uses up the real ones
    const t = setup({ testWaitMs: 1 })
    for (let i = 0; i < TEST_PER_MINUTE; i++) expect(await t.test({ title: 't', body: String(i) })).toBe('unknown')
    expect(await t.test({ title: 't', body: 'more' })).toBe('limited')
    expect(t.notes).toHaveLength(TEST_PER_MINUTE)
    for (let i = 0; i < NOTIFY_PER_MINUTE; i++) expect(t.notify({ title: 't', body: String(i), tag: `chat-${i}` })).toBe(true)
    t.tick(60_001)
    expect(await t.test({ title: 't', body: 'a minute later' })).toBe('unknown')
    expect(TEST_PER_MINUTE).toBe(3)
  })

  test('a newer test replaces the older one; only the first answer counts', async () => {
    const s = setup({ testWaitMs: 1000 })
    const first = s.test({ title: 't', body: '1' })
    const second = s.test({ title: 't', body: '2' })
    expect(s.notes.map((n) => n.closed)).toEqual([true, false])
    s.notes[1]!.emit('show')
    s.notes[1]!.emit('failed')
    expect(await second).toBe('shown')
    s.notes[0]!.emit('show')
    expect(await first).toBe('shown')
  })

  test('the main process answers only the team page and writes the words itself (the page sends none)', () => {
    const dir = path.join(import.meta.dir, '../../desktop/src')
    const main = fs.readFileSync(path.join(dir, 'main/main.ts'), 'utf8')
    const win = fs.readFileSync(path.join(dir, 'main/app-window.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(dir, 'preload/app.ts'), 'utf8')
    expect(main).toContain("ipcMain.handle('bridge:notify-test', (e) => (fromApp(e) ? win!.testNotify() : 'unsupported'))")
    expect(preload).toContain("testNotify: () => ipcRenderer.invoke('bridge:notify-test'),")
    expect(win).toContain("return this.notifier.test({ title: t(L, 'notify.test.title'), body: t(L, 'notify.test.body') })")
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(STRINGS[l]['notify.test.title']).toContain('{app}')
      expect(STRINGS[l]['notify.test.body'].length).toBeGreaterThan(5)
    }
  })
})

describe("macOS's question about notifications", () => {
  test('asked once, and only while the window is focused: a team page opened in the back asks at the next focus', () => {
    const s = setup({ ask: true, focused: false })
    s.ask()
    expect(s.asked()).toBe(0)
    s.focus(true)
    s.ask()
    expect(s.asked()).toBe(1)
    // a team switch, a reload, every focus after that: the system answers itself (macOS asks only once)
    s.closeAll()
    s.ask()
    s.focus(false)
    s.focus(true)
    s.ask()
    expect(s.asked()).toBe(1)
    // the notifications themselves are unchanged
    expect(s.notify({ title: 't', body: 'b' })).toBe(false)
    s.focus(false)
    expect(s.notify({ title: 't', body: 'b' })).toBe(true)
  })

  test('nothing to ask (Windows, Linux) does nothing; a system without notifications does not throw', () => {
    const none = setup({ focused: true })
    expect(() => none.ask()).not.toThrow()
    const s = setup({ ask: 'throws', focused: true })
    expect(() => s.ask()).not.toThrow()
    expect(s.asked()).toBe(1)
  })

  test('macOS takes a notification it will not show (off, or the question unanswered): the test says unknown, never shown', async () => {
    const s = setup({ focused: true, showIsSeen: false, testWaitMs: 1000 })
    const taken = s.test({ title: 't', body: 'b' })
    s.notes[0]!.emit('show')
    expect(await taken).toBe('unknown')
    const refused = s.test({ title: 't', body: 'b' })
    s.notes[1]!.emit('failed')
    expect(await refused).toBe('off')
  })

  test('macOS: touching notifications is the question and "taken" proves nothing; elsewhere nothing to ask', async () => {
    let touched = 0
    const mac = platformNotifyDeps('darwin', () => { touched++; return true })
    expect(mac.showIsSeen).toBe(false)
    mac.ask!()
    expect(touched).toBe(1)
    for (const p of ['win32', 'linux']) {
      const other = platformNotifyDeps(p, () => { touched++; return true })
      expect(other).toEqual({ showIsSeen: true })
    }
    expect(touched).toBe(1)
    // with the notifier: a Mac asks once while focused and its test says unknown; Windows asks nothing and says shown
    const note = () => { const x = new FakeNote({ title: '', body: '' }); queueMicrotask(() => x.emit('show')); return x }
    let macAsked = 0
    const onMac = makeNotifier({ create: note, supported: () => true, focused: () => true, reveal() {}, open() {}, ...platformNotifyDeps('darwin', () => { macAsked++; return true }) })
    onMac.ask()
    onMac.ask()
    expect(macAsked).toBe(1)
    expect(await onMac.test({ title: 't', body: 'b' })).toBe('unknown')
    const onWindows = makeNotifier({ create: note, supported: () => true, focused: () => true, reveal() {}, open() {}, ...platformNotifyDeps('win32', () => { throw new Error('never asked') }) })
    expect(() => onWindows.ask()).not.toThrow()
    expect(await onWindows.test({ title: 't', body: 'b' })).toBe('shown')
  })

  // Deliberately textual: AppWindow needs a running Electron (BaseWindow, WebContentsView), so where it calls ask() is
  // pinned by its source, as the other wiring checks in this file do. What ask() and the platform part do is tested
  // above for real.
  test('the window asks after the team page loads and at focus with a team open, with the platform part', () => {
    const win = fs.readFileSync(path.join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toContain('...platformNotifyDeps(process.platform, () => Notification.isSupported()),')
    expect(win).toMatch(/await this\.loadOrigin\(origin, entryPath\)\n[\s\S]{0,240}if \(this\.app === app\) this\.notifier\.ask\(\)/)
    expect(win).toMatch(/this\.win\.on\('focus', \(\) => \{[\s\S]{0,400}if \(this\.app\) this\.notifier\.ask\(\)/)
  })
})
