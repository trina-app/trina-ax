// Settings › Notifications › 이 기기, inside the desktop app: no Web Push there (Electron has the browser's push objects
// but no push service, so a subscription always failed with "check your connection"). The desktop app tells about rooms
// and AI answers through the computer's own notifications while its window is not in front (store/sessionMarkers.ts,
// desktop/src/common/notify.ts). This row says so; a desktop app with testNotify adds "Test notification", which sends
// one now and, when the system refused it, says where to turn the app's notifications on. An older desktop app shows
// the row without the button.
import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge, DesktopNotifyTest } from '@mycel/shared'
import { useT } from '../../i18n'
import { desktop } from '../../lib/desktop'
import { Button } from '../ui'

/** The line under the row after a test: what the system said, and where to turn notifications on when that helps. */
export function desktopTestText(outcome: DesktopNotifyTest, platform: DesktopBridge['platform'], t: ReturnType<typeof useT>): string {
  const where = t(platform === 'win32' ? 'desktopNotify.where.win32' : platform === 'linux' ? 'desktopNotify.where.linux' : 'desktopNotify.where.darwin')
  if (outcome === 'shown') return t('desktopNotify.shown')
  if (outcome === 'off') return t('desktopNotify.off', { where })
  if (outcome === 'unsupported') return t('desktopNotify.unsupported')
  if (outcome === 'limited') return t('desktopNotify.limited')
  return t('desktopNotify.unknown', { where })
}

export function DesktopNotifications({ bridge = desktop() }: { bridge?: DesktopBridge | null }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<DesktopNotifyTest | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const testNotify = bridge?.testNotify
  const test = async () => {
    if (!bridge?.testNotify || busy) return
    setBusy(true); setOutcome(null)
    let next: DesktopNotifyTest
    try { next = await bridge.testNotify({ title: t('desktopNotify.testTitle'), body: t('desktopNotify.testBody') }) }
    catch { next = 'unknown' }
    if (alive.current) { setOutcome(next); setBusy(false) }
  }
  const problem = outcome === 'off' || outcome === 'unsupported' || outcome === 'limited'
  return (
    <div className="py-3.5" data-testid="desktop-notifications">
      <div className="flex items-start gap-4 max-sm:flex-col max-sm:gap-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-ink">{t('desktopNotify.title')}</h4>
          <p className="mt-0.5 text-sm text-muted">{t('desktopNotify.desc')}</p>
        </div>
        {testNotify && <div className="flex shrink-0 items-center gap-2"><Button busy={busy} onClick={() => void test()} data-testid="desktop-notify-test">{t('desktopNotify.test')}</Button></div>}
      </div>
      {/* always there, so a screen reader hears the answer when it comes */}
      <div role="status">{outcome && bridge && <p className={problem ? 'mt-2 text-sm text-danger' : 'mt-2 text-sm text-muted'} data-testid="desktop-notify-result" data-outcome={outcome}>{desktopTestText(outcome, bridge.platform, t)}</p>}</div>
    </div>
  )
}
