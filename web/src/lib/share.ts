// The phone's share sheet for a text (the team invite message, QA TC-271): the phone app's own sheet when the app
// offers it (share-text-v1, lib/mobile.ts: Android's WebView has no navigator.share), else the browser's
// (navigator.share: the iPhone app's WebView, Safari and Chrome on phones), else none and the caller copies. Phones only
// (below 768 px): a computer keeps its copy button.
import { appSharesText, shareTextToApp } from './mobile'

export const SHARE_PHONE_QUERY = '(max-width: 767.98px)'

/** What a share did: the sheet came up and was used (`shared`), the person closed it (`cancelled`: nothing else to do),
 * or no sheet could open (`failed`: the caller points at its copy button; copying now, without the press, would copy
 * nothing in WebKit). */
export type ShareOutcome = 'shared' | 'cancelled' | 'failed'

const browserShares = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/** A share sheet can open here (a phone's width, and the app's sheet or the browser's). `anyWidth`: a caller that
 * already knows it is on a phone or tablet (Settings › Apps' send-to-computer row) skips the width check, so a phone
 * held sideways or a tablet keeps its sheet. */
export function canShareText(o: { anyWidth?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false
  if (!o.anyWidth && window.matchMedia?.(SHARE_PHONE_QUERY).matches !== true) return false
  return appSharesText() || browserShares()
}

const aborted = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError'

/** Open the share sheet with `text`: the app's, else the browser's. Never a second try after the app's refused: the
 * press that allowed a sheet (or a copy) is spent once the app answered, so WebKit would refuse it or copy nothing;
 * the caller shows its copy button instead. */
/** `url`: the text is one link; the browser's sheet gets it as a link (`{ url, title }`), so AirDrop to a Mac opens it
 * in Safari instead of giving a text clip. The app's sheet always takes text. */
export async function shareText(text: string, o: { url?: boolean; title?: string } = {}): Promise<ShareOutcome> {
  if (appSharesText()) {
    try {
      await shareTextToApp(text)
      return 'shared'
    } catch (e) {
      // the page moved on meanwhile: nothing to do
      return aborted(e) ? 'cancelled' : 'failed'
    }
  }
  if (!browserShares()) return 'failed'
  try {
    await navigator.share(o.url ? { url: text, ...(o.title ? { title: o.title } : {}) } : { text })
    return 'shared'
  } catch (e) {
    // the person closed the sheet (AbortError); anything else (no permission, a busy sheet): copy instead
    return aborted(e) ? 'cancelled' : 'failed'
  }
}
