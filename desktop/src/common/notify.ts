// The desktop app's system notifications for the team page (DesktopBridge.notify, docs/DECISIONS.md "Session
// markers"): shown only while the window is not focused, at most 10 a minute, one per tag (a newer one with the same
// tag replaces the old one: one per chat), and a click brings the window up and opens the address the page named
// ("/c/<chatId>": that chat; "/rooms/<id>": that room). Before, a click only focused the window. A team switch closes
// every notification the team page made (closeAll): they name that team's chats, and a click must not open an address
// in the next team's page. Also the dock badge's number.
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

export interface NoteLike {
  on(event: 'click' | 'close', listener: () => void): void
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
}
export interface NotifyInput { title: string; body: string; tag?: unknown; open?: unknown }
export interface Notifier {
  /** the bridge's notify: false when nothing was shown (focused, unsupported, too many) */
  notify(n: NotifyInput): boolean
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
  return {
    notify(n) {
      if (d.focused() || !d.supported()) return false
      const at = now()
      times = times.filter((x) => x > at - 60_000)
      if (times.length >= NOTIFY_PER_MINUTE) return false
      times.push(at)
      const tag = tagOf(n.tag)
      const open = openPathOf(n.open)
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
      note.show()
      return true
    },
    closeAll() {
      generation++
      byTag.clear()
      for (const note of [...live]) close(note)
    },
  }
}
