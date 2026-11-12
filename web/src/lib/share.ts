// The phone's share sheet for a text (the team invite message, QA TC-271): the phone app's own sheet when the app
// offers it (share-text-v1, lib/mobile.ts: Android's WebView has no navigator.share), else the browser's
// (navigator.share: the iPhone app's WebView, Safari and Chrome on phones), else none and the caller copies. Phones only
// (below 768 px): a computer keeps its copy button.
import { appSharesText, shareTextToApp } from './mobile'

export const SHARE_PHONE_QUERY = '(max-width: 767.98px)'

/** What a share did: the sheet came up and was used (`shared`), the person closed it (`cancelled`: nothing else to do),
 * or no sheet could open (`failed`: copy instead). */
export type ShareOutcome = 'shared' | 'cancelled' | 'failed'

const browserShares = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/** A share sheet can open here (a phone's width, and the app's sheet or the browser's). */
export function canShareText(): boolean {
  if (typeof window === 'undefined' || window.matchMedia?.(SHARE_PHONE_QUERY).matches !== true) return false
  return appSharesText() || browserShares()
}

const aborted = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError'

/** Open the share sheet with `text`: the app's, else the browser's. */
export async function shareText(text: string): Promise<ShareOutcome> {
  if (appSharesText()) {
    try {
      await shareTextToApp(text)
      return 'shared'
    } catch (e) {
      // the page moved on meanwhile: nothing to do; any other refusal tries the browser's sheet
      if (aborted(e)) return 'cancelled'
    }
  }
  if (!browserShares()) return 'failed'
  try {
    await navigator.share({ text })
    return 'shared'
  } catch (e) {
    // the person closed the sheet (AbortError); anything else (no permission, a busy sheet): copy instead
    return aborted(e) ? 'cancelled' : 'failed'
  }
}
