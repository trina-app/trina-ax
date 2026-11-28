// App-led linking of the <app> in Chrome extension (docs/decisions/20261128-chrome-app-led-linking.md): inside the
// desktop app, this signed-in page answers the app's request for a one-time pair code (the app opened a browser
// profile on the extension's pair page; the extension spends the code with its own secret) and shows the quiet notice
// "Chrome profile 'Work' connected · Undo" when that profile linked. The code is made like the in-profile Connect's
// (POST /api/chrome/pair, this page's own session; a guest or a limit: no code). Nothing here sees a link token.
import { useEffect } from 'react'
import { useT } from '../i18n'
import { api, API, isApiError } from './api'
import { desktop } from './desktop'
import { toast } from '../store/ui'

/** a link counts as "just linked" this long */
const FRESH_MS = 5 * 60_000

/** One pair code for the app, or null when this person cannot link a browser (a guest, a limit, offline). */
export async function pairCodeForApp(challenge: string): Promise<{ code: string } | null> {
  try {
    const r = await api.call(API.chromePair, { body: { challenge } })
    return { code: r.code }
  } catch {
    return null
  }
}

/** Mounted once while signed in (App.tsx Gate): nothing outside a desktop app that offers it. */
export function useChromeAppLinking(userId: string | null) {
  const t = useT()
  useEffect(() => {
    const cp = desktop()?.chromeProfiles
    if (!cp || !userId) return
    const offPair = cp.onPairRequest((r) => pairCodeForApp(r.challenge))
    const offLinked = cp.onLinked(async (l) => {
      // only a link of this person that was made or renewed just now gets the notice (Undo disconnects exactly it)
      let fresh = false
      try {
        const got = (await api.call(API.chromeLinks)).links.find((x) => x.id === l.linkId)
        fresh = !!got && Date.parse(got.lastSeenAt ?? got.createdAt) > Date.now() - FRESH_MS
      } catch { fresh = false }
      if (!fresh) return
      toast({
        level: 'success',
        text: t('settings.chrome.linkedByApp', { browser: l.browser, label: l.label }),
        ms: 12_000,
        action: {
          label: t('common.undo'),
          run: () => {
            void api.call(API.chromeUnlink, { params: { id: l.linkId } }).then(
              () => toast({ level: 'info', text: t('settings.chrome.disconnected', { label: l.label }) }),
              (e: unknown) => { if (!isApiError(e, 'not_found')) toast({ level: 'error', text: t('error.network') }) },
            )
          },
        },
      })
    })
    return () => { offPair(); offLinked() }
  }, [userId, t])
}
