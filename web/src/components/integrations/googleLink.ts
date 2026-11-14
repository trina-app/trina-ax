// Google's sign-in page as a link beside a waiting Google sign-in (BrowserWait): only where the browser refused the
// window opened for it, so the person still has a way there. Otherwise Try again opens it anew.
import { mobileApp, openExternal } from '../../lib/mobile'

export function googleLink(d: { popupBlocked?: boolean; authorizationUrl: string | null; setError?: (v: boolean) => void }, label: string, url = d.authorizationUrl) {
  if (!d.popupBlocked || !url) return null
  return {
    href: url,
    label,
    onClick: mobileApp() ? (e: { preventDefault: () => void }) => { e.preventDefault(); void openExternal(url, { purpose: 'google-oauth' }).catch(() => d.setError?.(true)) } : undefined,
  }
}
