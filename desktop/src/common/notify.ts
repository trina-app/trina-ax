// The desktop app's system notifications for the team page (DesktopBridge.notify, docs/DECISIONS.md "Session
// markers"): shown only while the window is not focused, at most 10 a minute, one per tag (a newer one with the same
// tag replaces the old one: one per chat), and a click brings the window up and opens the address the page named
// ("/c/<chatId>": that chat; "/rooms/<id>": that room). Before, a click only focused the window. A team switch closes
// every notification the team page made (closeAll): they name that team's chats, and a click must not open an address
// in the next team's page. Also the dock badge's number, and Settings › Notifications' test notification (test): shown
// even while the window is focused, and it says whether the system took it.
// Pure (Electron is passed in): unit-tested in tests/unit/e-notify.test.ts; used by main/app-window.ts.

/** at most this many notifications a minute (a page cannot flood the system's list) */
export const NOTIFY_PER_MINUTE = 10

/** An address of the team page a notification may open: an app path ("/c/<chat id>", "/rooms/<id>"), never another
 * origin, a protocol or a path with dots, a query or odd characters. Anything else: null (the click only focuses). */
export function openPathOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200) return null
  return /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(v) ? v : null
}

/** A tag as the page gave it (one notification per tag), or null. */
export function tagOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 100 && /^[A-Za-z0-9_:.-]+$/.test(v) ? v : null
}

/** The dock badge: a whole number 0..9999 (anything else: 0, which clears it). */
export function badgeCountOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, 9999) : 0
}

/** how long a test notification waits for the system's answer (show / failed) before it says 'unknown' */
export const TEST_WAIT_MS = 5000
/** test notifications a minute: a budget of their own, so clicking the button never holds back a real notification */
export const TEST_PER_MINUTE = 3
/** the tag of the test notification: a newer test replaces the older one */
export const TEST_TAG = 'notify-test'

export interface NoteLike {
  /** show: the system took it; failed (macOS, Windows): the system refused it (notifications off for the app) */
  on(event: 'click' | 'close' | 'show' | 'failed', listener: () => void): void
  show(): void
  close(): void
}
export interface NotifierDeps {
  /** a system notification (Electron's Notification) */
  create(n: { title: string; body: string }): NoteLike
  supported(): boolean
  /** is the window focused now (BaseWindow.isFocused): then nothing shows */
  focused(): boolean
  /** show and focus the window */
  reveal(): void
  /** the team page goes to this address (bridge:open) */
  open(path: string): void
  now?: () => number
  /** TEST_WAIT_MS (tests pass less) */
  testWaitMs?: number
}
export interface NotifyInput { title: string; body: string; tag?: unknown; open?: unknown }
export type TestOutcome = 'shown' | 'off' | 'unsupported' | 'limited' | 'unknown'
export interface Notifier {
  /** the bridge's notify: false when nothing was shown (focused, unsupported, too many) */
  notify(n: NotifyInput): boolean
  /** the bridge's testNotify: one notification now, focused or not (the person asked for it), at most TEST_PER_MINUTE a
   * minute apart from the others; the main process gives its words (never the page). A click only brings the window
   * up. Resolves with what the system said (DesktopNotifyTest). */
  test(n: { title: string; body: string }): Promise<TestOutcome>
  /** a team switch (or the team page closing): every notification it made goes, and a click on one that the system
   * still shows only brings the window up */
  closeAll(): void
}

export function makeNotifier(d: NotifierDeps): Notifier {
  const now = d.now ?? Date.now
  let times: number[] = []
  const byTag = new Map<string, NoteLike>()
  /** every notification shown and not closed yet (tagged or not) */
  const live = new Set<NoteLike>()
  /** a team switch moves it on: a click on an older one opens nothing */
  let generation = 0
  const close = (note: NoteLike) => {
    live.delete(note)
    try { note.close() } catch { /* already gone */ }
  }
  let testTimes: number[] = []
  /** one more this minute in `list`, or false when its limit is reached (the list kept is returned through `set`) */
  const take = (list: number[], limit: number, set: (l: number[]) => void) => {
    const at = now()
    const recent = list.filter((x) => x > at - 60_000)
    set(recent)
    if (recent.length >= limit) return false
    recent.push(at)
    return true
  }
  const allowed = () => take(times, NOTIFY_PER_MINUTE, (l) => { times = l })
  /** a system notification, one per tag; a click brings the window up and opens `open` (when the team is still the same) */
  const post = (n: { title: unknown; body: unknown }, tag: string | null, open: string | null, events?: (note: NoteLike) => void) => {
    const born = generation
    const note = d.create({ title: String(n.title ?? '').slice(0, 200), body: String(n.body ?? '').slice(0, 1000) })
    if (tag) {
      const before = byTag.get(tag)
      byTag.delete(tag)
      byTag.set(tag, note)
      if (byTag.size > 100) byTag.delete(byTag.keys().next().value!)
      if (before) close(before)
    }
    live.add(note)
    if (live.size > 200) live.delete(live.values().next().value!)
    note.on('close', () => live.delete(note))
    note.on('click', () => {
      live.delete(note)
      if (tag && byTag.get(tag) === note) byTag.delete(tag)
      d.reveal()
      if (open && born === generation) d.open(open)
    })
    events?.(note)
    note.show()
  }
  return {
    notify(n) {
      if (d.focused() || !d.supported()) return false
      if (!allowed()) return false
      post(n, tagOf(n.tag), openPathOf(n.open))
      return true
    },
    test(n) {
      if (!d.supported()) return Promise.resolve('unsupported')
      if (!take(testTimes, TEST_PER_MINUTE, (l) => { testTimes = l })) return Promise.resolve('limited')
      return new Promise<TestOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const answer = (o: TestOutcome) => {
          if (!timer) return
          clearTimeout(timer)
          timer = undefined
          resolve(o)
        }
        timer = setTimeout(() => answer('unknown'), d.testWaitMs ?? TEST_WAIT_MS)
        try {
          post(n, TEST_TAG, null, (note) => {
            note.on('show', () => answer('shown'))
            note.on('failed', () => answer('off'))
          })
        } catch {
          answer('off')
        }
      })
    },
    closeAll() {
      generation++
      byTag.clear()
      for (const note of [...live]) close(note)
    },
  }
}
