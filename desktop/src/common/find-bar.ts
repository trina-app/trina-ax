// Find on the screen in front (Cmd+F, Ctrl+F on Windows and Linux): the decisions of the desktop app's find bar
// (main/find-bar.ts, ui/findbar.ts), like a browser's own find.
//
// The bar is its own small view (mycel-ui://app/findbar.html) over the top-right corner of the view it searches, not
// part of that page: what is typed into it is never text of the page, so it never finds itself.
//
// findTarget: which view a Cmd+F searches. The view that has the keyboard: the team page, or a tab of the in-app
// browser (its toolbar, the address field, means its tab). The host strip above the sign-in pages means the team page.
// The bar itself keeps the view it searches. Nothing of those: the team page, else the app's own screen (team list).
//
// The menu's Cmd/Ctrl+F only runs for a key the page did not take (Chromium gives the page the key first and the
// window's menu only what the page left; desktop/README.md "Find on the page"): a site with its own find (a document
// editor in the in-app browser) keeps it, and so does the team web app where its Cmd/Ctrl+F opens its own search (a
// room, a DM or a thread, and pages with no text of their own; web/src/lib/searchKeys.ts). In an AI chat, the file
// viewer and with a file or artifact panel open the page leaves the key, and the bar opens; Edit › Find… always does.
// Pure (no Electron, no DOM globals): unit-tested in tests/unit/e-find-bar.test.ts.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface FindScene<V> {
  /** the views in the window now */
  shown: readonly V[]
  /** the view that had the keyboard last */
  last?: V
  /** the find bar's own view, and the view it searches while it is open */
  bar?: V
  searching?: V
  /** the in-app browser's toolbar and the tab on screen under it */
  toolbar?: V
  paneTab?: V
  /** the host strip above the team's sign-in pages */
  strip?: V
  /** the team page (when the window shows it), the app's own screen */
  page?: V
  screen?: V
}

/** The view a Cmd+F searches now, or null (nothing on screen to search). */
export function findTarget<V>(s: FindScene<V>): V | null {
  const on = (v: V | undefined): v is V => v !== undefined && s.shown.includes(v)
  if (s.last !== undefined && s.last === s.bar && on(s.searching)) return s.searching
  if (on(s.last)) {
    if (s.last === s.toolbar) {
      if (on(s.paneTab)) return s.paneTab
    } else if (s.last === s.strip) {
      if (on(s.page)) return s.page
    } else if (s.last !== s.bar) return s.last
  }
  if (on(s.searching)) return s.searching
  if (on(s.page)) return s.page
  if (on(s.screen)) return s.screen
  return null
}

/** the bar's own size: the card plus a margin for its shadow (the view is transparent around it) */
export const FIND_BAR = { width: 384, height: 56, inset: 8 } as const

/** Where the bar's view goes over the view it searches: its top-right corner, as wide as fits. */
export function findBarRect(target: Rect): Rect {
  const room = Math.max(0, target.width - 2 * FIND_BAR.inset)
  const width = Math.round(Math.min(FIND_BAR.width, room))
  return { x: Math.round(target.x + target.width - FIND_BAR.inset - width), y: Math.round(target.y), width, height: FIND_BAR.height }
}

/** at most this many characters of a selection go into the field (a browser takes the first line, not a whole page) */
export const FIND_PREFILL_MAX = 200

/** The selected text the bar opens with: its first non-empty line, spaces squeezed, cut at FIND_PREFILL_MAX; null for
 * none (the bar keeps its last text). */
export function findPrefill(selection: unknown): string | null {
  if (typeof selection !== 'string') return null
  const line = selection.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0)
  if (!line) return null
  return [...line].slice(0, FIND_PREFILL_MAX).join('')
}

/** A key in the bar's own field: the next match, the one before, or close. Cmd/Ctrl+G are the menu's (they reach the
 * bar's view only when the menu did not run them) and work here too. */
export function findKey(k: { key: string; shift: boolean; meta: boolean; ctrl: boolean; alt: boolean; mac: boolean; composing?: boolean }): 'next' | 'prev' | 'close' | null {
  if (k.composing) return null
  const mod = k.mac ? k.meta && !k.ctrl : k.ctrl && !k.meta
  if (k.key === 'Escape' && !k.meta && !k.ctrl && !k.alt) return 'close'
  if (k.key === 'Enter' && !k.meta && !k.ctrl && !k.alt) return k.shift ? 'prev' : 'next'
  if ((k.key === 'g' || k.key === 'G') && mod && !k.alt) return k.shift ? 'prev' : 'next'
  return null
}

export interface FindResult {
  /** the match shown now, from 1; 0 while none */
  active: number
  matches: number
}

/** What the bar says next to the field: nothing while it is empty, "N of M", or "No results". */
export function findCount(text: string, r: FindResult | null): { kind: 'empty' } | { kind: 'none' } | { kind: 'count'; n: number; m: number } {
  if (!text) return { kind: 'empty' }
  if (!r) return { kind: 'empty' }
  if (r.matches <= 0) return { kind: 'none' }
  return { kind: 'count', n: Math.min(Math.max(1, r.active), r.matches), m: r.matches }
}
