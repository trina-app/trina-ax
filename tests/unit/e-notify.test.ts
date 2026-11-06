// The desktop app's notifications for the team page (desktop/src/common/notify.ts, docs/DECISIONS.md "Session
// markers"): only while the window is not focused, at most 10 a minute, one per tag, and a click shows the window AND
// opens the chat the page named (before, it only focused the window); a team switch closes them all. The dock badge's
// number.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { badgeCountOf, makeNotifier, NOTIFY_PER_MINUTE, openPathOf, tagOf, type NoteLike } from '../../desktop/src/common/notify'

class FakeNote implements NoteLike {
  shown = false
  closed = false
  private clicks: (() => void)[] = []
  private closes: (() => void)[] = []
  constructor(readonly n: { title: string; body: string }) {}
  on(e: 'click' | 'close', f: () => void) { (e === 'click' ? this.clicks : this.closes).push(f) }
  show() { this.shown = true }
  close() { this.closed = true; for (const f of this.closes) f() }
  click() { for (const f of this.clicks) f() }
}

function setup(o: { focused?: boolean; supported?: boolean } = {}) {
  const notes: FakeNote[] = []
  const opened: string[] = []
  let revealed = 0
  let focused = o.focused ?? false
  let clock = 1_000_000
  const notifier = makeNotifier({
    create: (n) => { const x = new FakeNote(n); notes.push(x); return x },
    supported: () => o.supported ?? true,
    focused: () => focused,
    reveal: () => { revealed++ },
    open: (p) => opened.push(p),
    now: () => clock,
  })
  return { notify: notifier.notify, closeAll: notifier.closeAll, notes, opened, revealed: () => revealed, focus: (v: boolean) => { focused = v }, tick: (ms: number) => { clock += ms } }
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

  test('the main process takes the address and the tag from the page, the badge on macOS only, focus from the window', () => {
    const dir = path.join(import.meta.dir, '../../desktop/src')
    const main = fs.readFileSync(path.join(dir, 'main/main.ts'), 'utf8')
    const win = fs.readFileSync(path.join(dir, 'main/app-window.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(dir, 'preload/app.ts'), 'utf8')
    expect(main).toContain("win!.notify({ title: String(n?.title ?? ''), body: String(n?.body ?? ''), tag: n?.tag, open: n?.open })")
    expect(main).toMatch(/bridge:badge[\s\S]{0,120}process\.platform === 'darwin'[\s\S]{0,40}app\.setBadgeCount\(badgeCountOf\(n\)\)/)
    expect(win).toContain("open: (path) => this.send(this.app, 'bridge:open', path)")
    expect(win).toContain("this.send(this.app, 'bridge:focus', false)")
    expect(preload).toContain("onOpen: on('bridge:open')")
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
