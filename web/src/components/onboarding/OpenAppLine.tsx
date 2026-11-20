// The one quiet line where "Find work files on this computer" would be in the desktop app (the welcome files step and
// My files): in a Mac or Windows browser it says the app does that, with a link to /open-app (lib/open-app.ts). Never on
// a phone, Linux, inside our apps, or for a guest. One component and one sentence for both places.
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { clientKind } from '../../lib/desktop'
import { platform } from '../../lib/pwa'
import { OPEN_APP_PATH, openAppLineShown, pageOrigin } from '../../lib/open-app'

export function OpenAppLine({ className }: { className?: string }) {
  const t = useT()
  const me = useMe()
  if (!openAppLineShown({ platform: platform(), client: clientKind(), origin: pageOrigin(), guest: isGuestMe(me) })) return null
  return (
    <p className={clsx('text-label text-muted', className)} data-testid="open-app-line">
      {t('openApp.line')}{' '}
      <Link to={OPEN_APP_PATH} state={{ openAppBack: true }} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink" data-testid="open-app-line-link">
        {t('openApp.lineLink')}
      </Link>
    </p>
  )
}
