// Navigation from outside React components (a banner's "open" button raised by a WebSocket notice): the app's
// router registers its navigate function here (components/Layout.tsx).
type Go = (to: string, o?: { replace?: boolean }) => void

/** 파일 › 휴지통 (pages/Files.tsx; a deleted team skill's links come here, as the server's notice does:
 * server/src/skills/changes.ts). `/trash` is the deleted AI chats. */
export const FILES_TRASH = '/files?view=trash'
let go: Go | null = null

export function setNavigator(fn: Go | null) {
  go = fn
}

/** Open an app address (a path like "/files?path=skills"); outside the router, a normal page load. `replace`: in place
 * of this entry (a room that is no longer for me: Back must not lead to it). */
export function navigateTo(to: string, o?: { replace?: boolean }) {
  if (!to.startsWith('/') || to.startsWith('//')) return
  if (go) go(to, o)
  else if (o?.replace) location.replace(to)
  else location.assign(to)
}
