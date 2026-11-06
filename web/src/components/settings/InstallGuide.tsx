// Settings > Apps: how to add the app to the home screen (iPhone/iPad, Android, computer). The steps for this device
// come first; the other devices' steps open under one "다른 기기" line. An installed app (lib/pwa.ts isStandalone)
// shows no steps, only the way to turn on push. The desktop app and the phone app do not show this guide: they are
// already apps (lib/pwa.ts installGuideShown).
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { guideOrder, isStandalone, platform, useInstallPrompt, type GuidePlatform } from '../../lib/pwa'
import { useT, type MessageKey } from '../../i18n'
import { Button } from '../ui'

const GUIDE: Record<GuidePlatform, { title: MessageKey; steps: MessageKey[]; note?: MessageKey }> = {
  ios: { title: 'apps.guideIos', steps: ['apps.iosStep1', 'apps.iosStep2', 'apps.iosStep3', 'apps.pushStep'], note: 'apps.iosPushNote' },
  android: { title: 'apps.guideAndroid', steps: ['apps.androidStep1', 'apps.androidStep2', 'apps.androidStep3', 'apps.pushStep'] },
  desktop: { title: 'apps.guideDesktop', steps: ['apps.desktopStep1', 'apps.desktopStep2', 'apps.desktopStep3', 'apps.pushStep'], note: 'apps.desktopSafari' },
}

export function InstallGuide() {
  const t = useT()
  const install = useInstallPrompt()
  const [othersOpen, setOthersOpen] = useState(false)
  const notifications = (
    <Link to="/settings/notifications" className="text-sm text-accent-text underline">
      {t('apps.openNotifications')}
    </Link>
  )
  if (isStandalone())
    return (
      <div className="space-y-2" data-testid="install-guide">
        <p className="text-sm text-ok">{t('apps.installed')}</p>
        {notifications}
      </div>
    )
  const [here, ...others] = guideOrder(platform())
  const guide = (g: GuidePlatform, mine: boolean) => (
    <div key={g} data-testid={`install-guide-${g}`}>
      <h3 className="text-sm font-semibold">
        {t(GUIDE[g].title)}
        {/* in words, not a badge */}
        {mine && <span className="font-normal text-muted"> · {t('apps.thisDevice')}</span>}
      </h3>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted">
        {GUIDE[g].steps.map((k) => (
          <li key={k}>{t(k, k === 'apps.pushStep' ? { button: t('push.enable') } : undefined)}</li>
        ))}
      </ol>
      {GUIDE[g].note && <p className="mt-1 text-xs text-muted">{t(GUIDE[g].note)}</p>}
    </div>
  )
  return (
    <div className="space-y-4" data-testid="install-guide">
      {install.canPrompt && (
        <Button variant="primary" onClick={() => void install.prompt()}>
          {t('apps.install')}
        </Button>
      )}
      {guide(here!, true)}
      {/* the other devices' steps one tap away, not three guides in a row */}
      {others.length > 0 && (
        <details className="group" open={othersOpen} onToggle={(e) => setOthersOpen(e.currentTarget.open)} data-testid="install-guide-others">
          <summary className="-mx-2 flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm text-muted hover:bg-hover [&::-webkit-details-marker]:hidden">
            <ChevronDown size={15} className="shrink-0 transition group-open:rotate-180" aria-hidden /> {t('apps.otherDevices')}
          </summary>
          {othersOpen && <div className="mt-2 space-y-4">{others.map((g) => guide(g, false))}</div>}
        </details>
      )}
      {notifications}
    </div>
  )
}
