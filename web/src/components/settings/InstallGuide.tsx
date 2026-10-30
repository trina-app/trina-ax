// Settings > Apps: how to add the app to the home screen (iPhone/iPad, Android, computer). The steps for this device
// come first. An installed app (lib/pwa.ts isStandalone) shows no steps, only the way to turn on push. The desktop
// app and the phone app do not show this guide: they are already apps (lib/pwa.ts installGuideShown).
import { Link } from 'react-router-dom'
import { guideOrder, isStandalone, platform, useInstallPrompt, type GuidePlatform } from '../../lib/pwa'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button } from '../ui'

const GUIDE: Record<GuidePlatform, { title: MessageKey; steps: MessageKey[]; note?: MessageKey }> = {
  ios: { title: 'apps.guideIos', steps: ['apps.iosStep1', 'apps.iosStep2', 'apps.iosStep3', 'apps.pushStep'], note: 'apps.iosPushNote' },
  android: { title: 'apps.guideAndroid', steps: ['apps.androidStep1', 'apps.androidStep2', 'apps.androidStep3', 'apps.pushStep'] },
  desktop: { title: 'apps.guideDesktop', steps: ['apps.desktopStep1', 'apps.desktopStep2', 'apps.desktopStep3', 'apps.pushStep'], note: 'apps.desktopSafari' },
}

export function InstallGuide() {
  const t = useT()
  const install = useInstallPrompt()
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
  const order = guideOrder(platform())
  return (
    <div className="space-y-4" data-testid="install-guide">
      {install.canPrompt && (
        <Button variant="primary" onClick={() => void install.prompt()}>
          {t('apps.install')}
        </Button>
      )}
      {order.map((g, i) => (
        <div key={g} data-testid={`install-guide-${g}`}>
          <h3 className="text-sm font-semibold">
            {t(GUIDE[g].title)}
            {i === 0 && <Badge tone="accent" className="ml-2">{t('apps.thisDevice')}</Badge>}
          </h3>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted">
            {GUIDE[g].steps.map((k) => (
              <li key={k}>{t(k, k === 'apps.pushStep' ? { button: t('push.enable') } : undefined)}</li>
            ))}
          </ol>
          {GUIDE[g].note && <p className="mt-1 text-xs text-muted">{t(GUIDE[g].note)}</p>}
        </div>
      ))}
      {notifications}
    </div>
  )
}
