// Before Google opens (Google Drive, Gmail, Calendar, Docs, Sheets): one line that Google may show "Google hasn't
// verified this app" and what to press, only where Trina's shared Google app signs in (lib/googleApps.ts
// showUnverifiedHint). Remove this file and its key once Google has verified the app (QA TC-2957).
import { useT } from '../../i18n'

export function GoogleUnverifiedNote() {
  const t = useT()
  return <p className="border-l-2 border-line py-1 pl-3 text-sm text-muted" data-testid="google-unverified">{t('google.unverifiedHint')}</p>
}
