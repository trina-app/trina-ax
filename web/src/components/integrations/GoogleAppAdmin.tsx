// Admin › Connectors, one Google app (Gmail, Google Calendar, Google Docs, Google Sheets; docs/GOOGLE-APPS.md): what its
// line says (whether it is set up, how many members connected, or why it cannot be set up here, in plain words), its
// setup in a small dialog (per card: "Use the same Google app as Google Drive", or its own Google client) and the Google
// APIs to switch on in Google Cloud. Its page is GoogleAdminPage.tsx.
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { API, type GoogleAppAdminStatus } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { builtInName } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { Button, Modal } from '../ui'
import { clientBody, clientErrorKey, clientReady, emptyClient, GoogleClientFields, type ClientInput } from './DriveConnector'

/** Members can connect it now: set up, and the team switch on. */
export const googleAppAdminOn = (s: GoogleAppAdminStatus) => s.configured

/** One line for the card and the page: what is on, or why not. */
export function googleAppAdminLine(t: ReturnType<typeof useT>, s: GoogleAppAdminStatus) {
  if (!s.configured) {
    return s.blocked === 'hosted' ? t('appConnectors.blocked.hosted')
      : s.blocked === 'public_host' ? t('appConnectors.blocked.publicHost')
        : s.blocked === 'unsupported' ? t('gapps.admin.unsupported')
          : s.blocked === 'server' ? t('appConnectors.byServer')
            : t('connectors.setUpOnceLine')
  }
  return t('appConnectors.connectedMembers', { count: s.connectedMembers })
}

/** The Google APIs to switch on in Google Cloud for this card, each a link to its page there. */
export function ApiList({ apis, bare }: { apis: GoogleAppAdminStatus['apis']; bare?: boolean }) {
  const t = useT()
  return (
    <div data-testid="gapp-admin-apis">
      {!bare && <p className="mb-1.5 text-xs text-muted">{t('gapps.admin.apis')}</p>}
      <ul className="flex flex-wrap gap-2">
        {apis.map((a) => (
          <li key={a.url}>
            {/* a phone: a 44 px tap */}
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-xs hover:bg-hover max-md:min-h-11" data-testid="gapp-admin-api">
              {a.name} <ExternalLink size={11} aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Set up one Google app: the same Google app as Google Drive (on when Drive has one), or its own Google client. */
export function GoogleAppSetupDialog({ status, onClose, onSaved }: { status: GoogleAppAdminStatus; onClose: () => void; onSaved: (s: GoogleAppAdminStatus) => void }) {
  const t = useT()
  const name = builtInName(status.id)
  const [same, setSame] = useState(status.driveAppAvailable)
  const [client, setClient] = useState<ClientInput>(emptyClient)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ready = same || clientReady(client)
  const save = async () => {
    if (busy || !ready) return
    setBusy(true); setError(null)
    try { onSaved(await api.call(API.setGoogleAppClient, { params: { app: status.id }, body: same ? { sameAsDrive: true } : clientBody(client) })) }
    catch (e) { setError(t(clientErrorKey(e))) }
    finally { setBusy(false) }
  }
  return (
    <Modal open title={t('gapps.admin.setUpTitle', { name })} onClose={onClose} width={500}
      footer={<>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()} data-testid="gapp-setup-save">{t('common.save')}</Button>
      </>}>
      <div className="space-y-4" data-testid="gapp-setup-dialog">
        {status.driveAppAvailable && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--c-accent)]" checked={same} onChange={(e) => setSame(e.target.checked)} data-testid="gapp-setup-same" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t('gapps.admin.sameAsDrive')}</span>
              <span className="mt-0.5 block text-xs text-muted">{t('gapps.admin.sameAsDriveLine')}</span>
            </span>
          </label>
        )}
        {!same && <GoogleClientFields redirectUri={status.redirectUri} value={client} onChange={setClient} onError={setError} />}
        {status.apis.length > 0 && <ApiList apis={status.apis} />}
        {status.configured && <p className="text-xs text-muted">{t('driveSetup.replaceNote')}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="gapp-setup-error">{error}</p>}
      </div>
    </Modal>
  )
}
