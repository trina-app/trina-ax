// Who may use the desktop bridge (design tab 5 "데스크톱 앱 규칙"): only the top frame of the team page this window
// opened, at exactly the team address or the team's pinned direct address. iframes (artifacts, previews), other
// origins and pages the team page navigated to get nothing; neither does a page at the team address whose document has
// an opaque origin (a `sandbox` CSP, like /sandbox/frame opened as the whole page: QA TC-220). Pure: unit-tested in tests/unit/e-desktop-common.test.ts.
import { PRODUCT } from '@mycel/shared'
import { originOf } from './address'

export interface SenderFrame {
  /** senderFrame.url */
  url: string
  /** the document's own origin (senderFrame.origin; a CDP frame's securityOrigin): "null" when it is opaque, which a
   * URL at the team address does not show */
  origin: string
  /** senderFrame.parent === null */
  isTop: boolean
  /** the sender webContents is the window's app view */
  isAppView: boolean
}

export function isTrustedAppSender(f: SenderFrame | null | undefined, allowedOrigins: readonly string[]): boolean {
  if (!f || !f.isAppView || !f.isTop) return false
  const o = originOf(f.url)
  return o !== '' && allowedOrigins.includes(o) && f.origin === o
}

/** The desktop app's own screens (welcome, browser pane toolbar) are served from this scheme. */
export const UI_SCHEME = `${PRODUCT.id}-ui`
export const UI_ORIGIN = `${UI_SCHEME}://app`

export function isOwnUiUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === `${UI_SCHEME}:` && u.host === 'app'
  } catch {
    return false
  }
}
