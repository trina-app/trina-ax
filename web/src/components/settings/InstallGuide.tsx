// Settings > Apps: how to add the app to the home screen (iPhone/iPad, Android, computer). The steps for this device
// come first, and the phones' steps come with pictures (InstallPictures.tsx). An installed app (lib/pwa.ts isStandalone)
// shows no steps, only the way to turn on push. The desktop app and the phone app do not show this guide: they are
// already apps (lib/pwa.ts installGuideShown).
import { Link } from 'react-router-dom'
import { guideOrder, isStandalone, platform, useInstallPrompt, type GuidePlatform } from '../../lib/pwa'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button } from '../ui'
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
      {order.map((g, i) => {
        const guide = GUIDE[g]
        return (
          <div key={g} data-testid={`install-guide-${g}`}>
            <h3 className="text-sm font-semibold">
              {t(guide.title)}
              {i === 0 && <Badge tone="accent" className="ml-2">{t('apps.thisDevice')}</Badge>}
            </h3>
            {guide.steps ? (
              <ol className="mt-1 list-decimal space-y-1 break-keep pl-5 text-sm text-muted">
                {guide.steps.map((k) => (
                  <li key={k}>{t(k, k === 'apps.pushStep' ? { button: t('push.enable') } : undefined)}</li>
                ))}
              </ol>
            ) : (
              <>
                {guide.start && <p className="mt-1 break-keep text-sm text-muted">{t(guide.start)}</p>}
                {g !== 'desktop' && <InstallPictures platform={g} />}
                <p className="mt-3 break-keep text-sm text-muted">{t('apps.pushStep', { button: t('push.enable') })}</p>
              </>
            )}
            {guide.note && <p className="mt-1 break-keep text-xs text-muted">{t(guide.note)}</p>}
          </div>
        )
      })}
      {notifications}
    </div>
  )
}
