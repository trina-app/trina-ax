// Navigation from outside React components (a banner's "open" button raised by a WebSocket notice): the app's
// router registers its navigate function here (components/Layout.tsx).
type Go = (to: string, o?: { replace?: boolean }) => void

/** 파일 › 휴지통 (pages/Files.tsx; a deleted team skill's links come here, as the server's notice does:
 * server/src/skills/changes.ts). `/trash` is the deleted AI chats. */
export const FILES_TRASH = '/files?view=trash'
/** 팀 스킬 with the ready-made skills the team lacks unfolded (components/AvailableSkills.tsx): where "스킬 넣기" goes
 * from Home's block, the empty-team line and the goal card. */
export const SKILL_CATALOG = '/skills?catalog=open'
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

/** Where a person was heading before signing in (`?next=` of /login and /password): a path on this site only, never
 * another site (`//host`, `/\\host`), else null. */
export function safeNext(search: string): string | null {
  const next = new URLSearchParams(search).get('next')
  // a tab or line break is dropped by the browser's URL parser ("/\t/host" would become "//host")
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !/[\u0000-\u001f]/.test(next) ? next : null
}
