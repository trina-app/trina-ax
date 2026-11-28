// The one quiet line where "Find work files on this computer" would be in the desktop app (the welcome files step and
// My files): in a Mac or Windows browser it says the app does that, with a link to /open-app (lib/open-app.ts), or, at
// this computer's own address (127.0.0.1), to paste that address in the app (openAppLinePaste). Never on
// a phone, Linux, inside our apps, for a guest, or in a free-roam demo (QA TC-5617: the visitor's demo server is not
// theirs to open in an app). One component and one sentence for both places.
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { useFreeRoam } from '../../store/demo'
import { isGuestMe } from '../../lib/guests'
import { clientKind } from '../../lib/desktop'
import { platform } from '../../lib/pwa'
import { OPEN_APP_PATH, openAppLinePaste, openAppLineShown, pageOrigin } from '../../lib/open-app'

export function OpenAppLine({ className }: { className?: string }) {
  const t = useT()
  const me = useMe()
  const freeRoam = useFreeRoam()
  if (freeRoam) return null
  const at = { platform: platform(), client: clientKind(), origin: pageOrigin(), guest: isGuestMe(me) }
  // at this computer's own address the app takes no link from here: the line says to paste the address there instead
  if (openAppLinePaste(at))
    return (
      <p className={clsx('text-label text-muted', className)} data-testid="open-app-line">
        {t('openApp.line')} {t('openApp.linePaste', { address: at.origin })}
      </p>
    )
  if (!openAppLineShown(at)) return null
  return (
    <p className={clsx('text-label text-muted', className)} data-testid="open-app-line">
      {t('openApp.line')}{' '}
      <Link to={OPEN_APP_PATH} state={{ openAppBack: true }} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink" data-testid="open-app-line-link">
        {t('openApp.lineLink')}
      </Link>
    </p>
  )
}
