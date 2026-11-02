// Settings > Apps: how to add the app to the home screen (iPhone/iPad, Android, computer). The steps for this device
// come first, and the phones' steps come with pictures (InstallPictures.tsx); on phones the other devices' steps open
// under one "다른 기기" line (computers list them all). An installed app (lib/pwa.ts isStandalone) shows no steps, only
// the way to turn on push. The desktop app and the phone app do not show this guide: they are already apps (lib/pwa.ts
// installGuideShown).
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { guideOrder, isStandalone, platform, useInstallPrompt, type GuidePlatform } from '../../lib/pwa'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button, useMediaQuery } from '../ui'
import { InstallPictures } from './InstallPictures'

/** A phone: where to start, then the pictures. A computer: numbered steps. */
const GUIDE: Record<GuidePlatform, { title: MessageKey; start?: MessageKey; steps?: MessageKey[]; note?: MessageKey }> = {
  ios: { title: 'apps.guideIos', start: 'apps.iosStep1', note: 'apps.iosPushNote' },
  android: { title: 'apps.guideAndroid', start: 'apps.androidStep1' },
  desktop: { title: 'apps.guideDesktop', steps: ['apps.desktopStep1', 'apps.desktopStep2', 'apps.desktopStep3', 'apps.pushStep'], note: 'apps.desktopSafari' },
}

export function InstallGuide() {
  const t = useT()
  const install = useInstallPrompt()
  const [othersOpen, setOthersOpen] = useState(false)
  const phone = useMediaQuery('(max-width: 767.98px)')
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
  const guide = (g: GuidePlatform, mine: boolean) => {
    const d = GUIDE[g]
    return (
      <div key={g} data-testid={`install-guide-${g}`}>
        <h3 className="text-sm font-semibold">
          {t(d.title)}
          {/* phones: in words, not a badge */}
          {mine && (phone ? <span className="font-normal text-muted"> · {t('apps.thisDevice')}</span> : <Badge tone="accent" className="ml-2">{t('apps.thisDevice')}</Badge>)}
        </h3>
        {d.steps ? (
          <ol className="mt-1 list-decimal space-y-1 break-keep pl-5 text-sm text-muted">
            {d.steps.map((k) => (
              <li key={k}>{t(k, k === 'apps.pushStep' ? { button: t('push.enable') } : undefined)}</li>
            ))}
          </ol>
        ) : (
          <>
            {d.start && <p className="mt-1 break-keep text-sm text-muted">{t(d.start)}</p>}
            {g !== 'desktop' && <InstallPictures platform={g} />}
            <p className="mt-3 break-keep text-sm text-muted">{t('apps.pushStep', { button: t('push.enable') })}</p>
          </>
        )}
        {d.note && <p className="mt-1 break-keep text-xs text-muted">{t(d.note)}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-4" data-testid="install-guide">
      {install.canPrompt && (
        <Button variant="primary" onClick={() => void install.prompt()}>
          {t('apps.install')}
        </Button>
      )}
      {guide(here!, true)}
      {/* phones: the other devices' steps one tap away, not three guides in a row */}
      {!phone && others.map((g) => guide(g, false))}
      {phone && others.length > 0 && (
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
