// The right-click menu of a picture or a file (components/FileMenu.tsx, docs/DECISIONS.md "A right-click menu on
// pictures and files"): in the image viewer, under a room's or a thread's message, on an AI chat's attachment. Like
// Slack's: 이미지 복사 (pictures only), 링크 복사, 내려받기, 트리나에게 묻기. What applies, and the addresses it uses,
// are decided here, pure and unit-tested (tests/unit/file-menu.test.ts).
// - 링크 복사 is the app's own address of the place: the message it was sent in (`/rooms/<id>?m=<message>`, a reply at its
//   thread) or the team file (`/files/view?path=…`). It names the place, never a key or token: someone who cannot open
//   the room or the file gets the app's usual "not found" or sign-in page.
// - 이미지 복사 reads the picture only through the app's own file routes on this page's own address (the room file
//   with its member check, the team file with its access check), the same requests the page makes to show it. Any other
//   address (another site, a data: or blob: one) is never fetched.
import type { RoomPlace, ViewerItem } from './imageViewer'

export type FileMenuAction = 'copyImage' | 'copyLink' | 'download' | 'ask'

/** What the menu needs of a picture or file; absent parts are items it does not show. */
export interface FileMenuTarget {
  name: string
  /** a picture: the address its bytes are read from (one of the app's file routes), and whether that is only its
   * thumbnail (the original cannot be drawn here: a HEIC photo, one past the preview limit) */
  image?: { src: string; thumb: boolean } | null
  /** a copy of its own (the image viewer copies the picture it drew) */
  copyImage?: (() => void) | null
  /** the app's own address of it (messageLink, teamFileLink) */
  link?: string | null
  download?: (() => void) | null
  /** 트리나에게 묻기 */
  ask?: (() => void) | null
}

/** The items, in Slack's order; `canCopy`: this page can put a picture on the clipboard (lib/copyImage.ts). */
export function fileMenuActions(t: FileMenuTarget, canCopy: boolean): FileMenuAction[] {
  const out: FileMenuAction[] = []
  if (canCopy && (t.copyImage || (t.image && ownFileAddress(t.image.src)))) out.push('copyImage')
  if (t.link) out.push('copyLink')
  if (t.download) out.push('download')
  if (t.ask) out.push('ask')
  return out
}

const pageOrigin = () => (typeof location === 'undefined' ? '' : location.origin)

/** The address of a message as people open it: the room at the message (pages/Room.tsx `?m=`), or a reply at its
 * thread (`/rooms/<id>/t/<root>?m=<reply>`). */
export function messageLink(roomId: string, messageId: string, rootId?: string | null, origin = pageOrigin()): string {
  const m = encodeURIComponent(messageId)
  const room = encodeURIComponent(roomId)
  return rootId && rootId !== messageId ? `${origin}/rooms/${room}/t/${encodeURIComponent(rootId)}?m=${m}` : `${origin}/rooms/${room}?m=${m}`
}

/** The address of a team file or folder as people open it (App.tsx /files/view, lib/markdown.ts). */
export const teamFileLink = (path: string, origin = pageOrigin()): string => `${origin}/files/view?path=${encodeURIComponent(path)}`

/** A room's file: the message it was sent in (no message yet, a picture in a message box: none). */
export const roomPlaceLink = (place: RoomPlace | undefined, origin = pageOrigin()): string | null => (place?.messageId ? messageLink(place.roomId, place.messageId, place.rootId, origin) : null)

/** The link of a picture or file the image viewer shows: its message's, or the team file's. */
export function itemLink(item: Pick<ViewerItem, 'room' | 'path'>, origin = pageOrigin()): string | null {
  if (item.room) return roomPlaceLink(item.room, origin)
  return item.path ? teamFileLink(item.path, origin) : null
}

/** Where 이미지 복사 reads a viewer item's picture: the original when it can be drawn here, else its thumbnail. A picture
 * the page holds as bytes (a message box's) or one without either: none. */
export function itemImage(item: Pick<ViewerItem, 'kind' | 'original' | 'thumb' | 'blob'>): FileMenuTarget['image'] {
  if (item.kind === 'file' || item.blob) return null
  if (item.original) return { src: item.original, thumb: false }
  return item.thumb ? { src: item.thumb, thumb: true } : null
}

/** Whether 이미지 복사 may read this address: one of the app's own `/api/` routes on this page's origin. */
export function ownFileAddress(src: string, origin = pageOrigin()): boolean {
  if (!origin || origin === 'null') return false
  let u: URL
  try {
    u = new URL(src, origin)
  } catch {
    return false
  }
  return u.origin === origin && (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname.startsWith('/api/') && !u.username && !u.password
}

/** The keyboard's own way to a right-click menu: the menu key, or Shift+F10. */
export const isMenuKey = (e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean =>
  !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
