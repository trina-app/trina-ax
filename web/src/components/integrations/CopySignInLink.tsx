// "Copy link" at the end of a connect wait's small words, in the desktop app only (owner 2026-11-28: Connect always
// opens the default browser; to sign in in another browser or profile, copy the same address and paste it there, as
// Claude Code offers its sign-in address; docs/AGENTS/plan/20261128-0048-connect-copy-link.md "UX spec"). `url`: the
// address the wait opened in the system browser. Once copied it says so, and what to do, until the wait gives another
// address (Try again) or ends. The copied address finishes nothing by itself: a result held for the app is redeemed
// only with the app's own proof (docs/decisions/20261128-held-sign-in-app-key.md). Not in a browser: Connect opened a
// tab of this same browser, and another browser has no session of the team there.
import { useState } from 'react'
import { useT } from '../../i18n'
import { isDesktop } from '../../lib/desktop'
import { execCopy } from '../../lib/copy-in-tap'

export function CopySignInLink({ url, testId }: { url: string | null | undefined; testId?: string }) {
  const t = useT()
  const [copied, setCopied] = useState<string | null>(null)
  if (!url || !isDesktop()) return null
  const done = copied === url
  const copy = () => {
    // the system's copy first; the old copy command when it is refused (a window without the focus); a copy that
    // neither takes changes nothing on screen
    const fallback = () => { if (execCopy(url, document)) setCopied(url) }
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(url).then(() => setCopied(url), fallback)
    else fallback()
  }
  return (
    <>
      {' '}
      <button type="button" onClick={copy} aria-live="polite"
        className="inline text-left text-accent-text hover:underline focus-visible:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
        data-testid={testId} data-copied={done ? '' : undefined}>
        {done ? t('connect.copiedLink') : t('connect.copyLink')}
      </button>
    </>
  )
}
