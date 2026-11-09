// Settings > Apps: how to install the app (iPhone/iPad, Android, computer), each step with a picture
// (InstallPictures.tsx). The steps for this device come first; the other devices' steps open under one "다른 기기"
// line. On a computer the steps follow the browser: Chrome and Edge install from the address bar, Safari on a Mac from
// File → Add to Dock, and Firefox cannot install a web app (one line says which browsers can). An installed app
// (lib/pwa.ts isStandalone) shows no steps, only the way to turn on push. The desktop app and the phone app do not show
// this guide: they are already apps (lib/pwa.ts installGuideShown).
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { browser, canInstallIn, guideOrder, isStandalone, platform, useInstallPrompt, type Browser, type GuidePlatform, type Platform } from '../../lib/pwa'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button, useMediaQuery } from '../ui'
import { ComputerPictures, InstallPictures, type ComputerFlow, type ComputerOs } from './InstallPictures'

/** A computer's steps: Safari's on a Mac in Safari, else Chrome's and Edge's (also shown to a phone, as "other device") */
export function computerFlow(p: Platform, b: Browser): ComputerFlow {
  return p === 'mac' && b === 'safari' ? 'safari' : 'chromium'
}

const PHONE_GUIDE: Record<'ios' | 'android', { title: MessageKey; start: MessageKey; note?: MessageKey }> = {
  ios: { title: 'apps.guideIos', start: 'apps.iosStep1', note: 'apps.iosPushNote' },
  android: { title: 'apps.guideAndroid', start: 'apps.androidStep1' },
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
  const p = platform()
  const b = browser()
  const [here, ...others] = guideOrder(p)
  const push = <p className="mt-3 break-keep text-sm text-muted">{t('apps.pushStep', { button: t('push.enable') })}</p>
  const title = (key: MessageKey, mine: boolean) => (
    <h3 className="text-sm font-semibold">
      {t(key)}
      {/* phones: in words, not a badge */}
      {mine && (phone ? <span className="font-normal text-muted"> · {t('apps.thisDevice')}</span> : <Badge tone="accent" className="ml-2">{t('apps.thisDevice')}</Badge>)}
    </h3>
  )
  const guide = (g: GuidePlatform, mine: boolean) => {
    if (g !== 'desktop') {
      const d = PHONE_GUIDE[g]
      return (
        <div key={g} data-testid={`install-guide-${g}`}>
          {title(d.title, mine)}
          <p className="mt-1 break-keep text-sm text-muted">{t(d.start)}</p>
          <InstallPictures platform={g} />
          {push}
          {d.note && <p className="mt-1 break-keep text-xs text-muted">{t(d.note)}</p>}
        </div>
      )
    }
    // this computer's browser decides the steps; seen from a phone, Chrome's and Edge's
    const flow = mine ? computerFlow(p, b) : 'chromium'
    const os: ComputerOs = mine && (p === 'mac' || p === 'windows') ? p : 'other'
    // a browser that cannot install (Firefox): the one line naming those that can, and no steps that would not work
    if (mine && !canInstallIn(b)) return (
      <div key={g} data-testid={`install-guide-${g}`}>
        {title('apps.guideDesktop', mine)}
        <p className="mt-1 break-keep text-sm" data-testid="install-browser-cannot">{t(p === 'mac' ? 'apps.browserCannotMac' : 'apps.browserCannot')}</p>
      </div>
    )
    return (
      <div key={g} data-testid={`install-guide-${g}`} data-flow={flow}>
        {title(flow === 'safari' ? 'apps.guideSafari' : 'apps.guideDesktop', mine)}
        {!mine && <p className="mt-1 break-keep text-sm text-muted">{t('apps.desktopStep1')}</p>}
        <ComputerPictures flow={flow} os={os} />
        {push}
        <p className="mt-1 break-keep text-xs text-muted">
          {t(flow === 'safari' ? 'apps.safariNote' : 'apps.desktopNoIcon')}
          {flow === 'chromium' && os === 'mac' && <> {t('apps.desktopSafari')}</>}
        </p>
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
      {/* the other devices' steps one tap away, not three guides of pictures in a row */}
      {others.length > 0 && (
        <details className="group" open={othersOpen} onToggle={(e) => setOthersOpen(e.currentTarget.open)} data-testid="install-guide-others">
          <summary className="-mx-2 flex h-9 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm text-muted hover:bg-hover [&::-webkit-details-marker]:hidden">
            <ChevronDown size={15} className="shrink-0 transition group-open:rotate-180" aria-hidden /> {t('apps.otherDevices')}
          </summary>
          {othersOpen && <div className="mt-2 space-y-4">{others.map((g) => guide(g, false))}</div>}
        </details>
      )}
      {notifications}
    </div>
  )
}
