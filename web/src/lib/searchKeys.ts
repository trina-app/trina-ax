// ⌘K and ⌘F, the Slack way (docs/decisions/20261120-search-shortcuts-slack.md). One pure rule, so the keys are tested
// without a page (web/test/unit/search-keys.test.ts); components/Layout.tsx calls it on every keydown.
//   ⌘K (Ctrl+K, and ⌘ or Ctrl on a Mac as before): opens search.
//   ⌘F (Ctrl+F off a Mac; on a Mac only ⌘, Ctrl+F there moves the caret): in a room, a DM, a group chat or a thread it
//     opens search with "This conversation" on. Where the page has its own text to read (an AI chat, the file viewer,
//     a file link, an open file or artifact panel) it is left to the browser's find (the desktop app's find bar).
//     Anywhere else it opens search as ⌘K does.
//   Search already open: either key puts the focus back in the box with its text selected (no page find over it).
//   Another dialog open: ⌘F does nothing (the key is left alone); ⌘K opens search over it, as it always has.
// Korean, Japanese and Chinese input: while a word is being composed nothing happens; otherwise the letter is read
// from e.code when e.key is not a Latin letter (⌘ with the Korean input source can give 'ㄹ' for F, 'ㅏ' for K).
// Never take ⌘G here: the desktop app's Find Next is ⌘G (desktop/src/main/main.ts).
import { matchPath } from 'react-router-dom'

export type SearchKey = { do: 'open'; here?: string } | { do: 'focus' } | { do: 'pass' }
export interface SearchKeyEvent { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing?: boolean }
export interface SearchKeyState {
  /** search is open */
  open: boolean
  /** another dialog is open (a [role="dialog"] other than search) */
  dialog: boolean
  /** the page's address (location.pathname) */
  path: string
  /** a file or an artifact is open in the side panel (or the image and file viewer over the window) */
  reading: boolean
  mac: boolean
}

/** The letter pressed: e.key when it is a Latin letter, else the key's place (e.code "KeyF"): an IME's own letter. */
export function keyLetter(e: Pick<SearchKeyEvent, 'key' | 'code'>): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  const m = /^Key([A-Z])$/.exec(e.code ?? '')
  return m ? m[1]!.toLowerCase() : ''
}

/** The room a page is in: a room, DM or group chat, or a thread of one (null elsewhere). */
export function roomOfPath(path: string): string | null {
  return (matchPath('/rooms/:roomId', path) ?? matchPath('/rooms/:roomId/t/:messageId', path))?.params.roomId ?? null
}
/** Pages with their own text to read, where ⌘F stays the browser's find: an AI chat, the file viewer, a file link. */
export const nativeFindPath = (path: string): boolean =>
  !!(matchPath('/c/:chatId', path) || matchPath('/c/:chatId/t/:messageId', path) || matchPath('/files/view', path) || matchPath('/f/:id', path) || matchPath('/f/batch/:id', path))

export function searchShortcut(e: SearchKeyEvent, s: SearchKeyState): SearchKey {
  if (e.isComposing) return { do: 'pass' }
  const letter = keyLetter(e)
  // ⌘K as before (over another dialog too), only now it also brings the focus back to an open box
  if (letter === 'k' && (e.metaKey || e.ctrlKey)) return s.open ? { do: 'focus' } : { do: 'open' }
  if (letter !== 'f' || e.shiftKey || e.altKey) return { do: 'pass' }
  if (s.mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return { do: 'pass' }
  if (s.open) return { do: 'focus' }
  if (s.dialog || s.reading || nativeFindPath(s.path)) return { do: 'pass' }
  const here = roomOfPath(s.path)
  return here ? { do: 'open', here } : { do: 'open' }
}
