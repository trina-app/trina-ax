// Navigation from outside React components (a banner's "open" button raised by a WebSocket notice): the app's
// router registers its navigate function here (components/Layout.tsx).
type Go = (to: string) => void
let go: Go | null = null

export function setNavigator(fn: Go | null) {
  go = fn
}

/** Open an app address (a path like "/files?path=skills"); outside the router, a normal page load. */
export function navigateTo(to: string) {
  if (!to.startsWith('/') || to.startsWith('//')) return
  if (go) go(to)
  else location.assign(to)
}
