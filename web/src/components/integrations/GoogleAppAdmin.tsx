// Admin › Connectors, one Google app (Gmail, Google Calendar, Google Docs, Google Sheets; docs/GOOGLE-APPS.md): its page
// says whether it is set up and how many members connected, sets it up once in a small dialog (per card: "Use the same
// Google app as Google Drive", or its own Google client), lists the Google APIs to switch on in Google Cloud, and holds
// the members' switch ("Members can connect their own Gmail", on by default). Why it cannot be set up here is said in
// plain words. Google Drive's own page is DriveConnector.tsx DriveAdminDetail.
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { API, type GoogleAppAdminStatus } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { builtInLogo, builtInName } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, Modal, Switch } from '../ui'
import { ConnectorDetail } from './ConnectorsView'
import { clientBody, clientErrorKey, clientReady, emptyClient, GoogleClientFields, type ClientInput } from './DriveConnector'

/** Members can connect it now: set up, and the team switch on. */
export const googleAppAdminOn = (s: GoogleAppAdminStatus) => s.configured && s.membersCanConnect

/** One line for the card and the page: what is on, or why not. */
export function googleAppAdminLine(t: ReturnType<typeof useT>, s: GoogleAppAdminStatus) {
  if (!s.configured) {
    return s.blocked === 'hosted' ? t('appConnectors.blocked.hosted')
      : s.blocked === 'public_host' ? t('appConnectors.blocked.publicHost')
        : s.blocked === 'unsupported' ? t('gapps.admin.unsupported')
          : s.blocked === 'server' ? t('appConnectors.byServer')
            : t('connectors.setUpOnceLine')
  }
  return s.membersCanConnect ? t('appConnectors.connectedMembers', { count: s.connectedMembers }) : t('gapps.admin.membersOffLine')
}

/** A Google app's page in Admin › Connectors. */
export function GoogleAppAdminDetail({ status, onSetUp, onStatus, onBack }: { status: GoogleAppAdminStatus; onSetUp: () => void; onStatus: (s: GoogleAppAdminStatus) => void; onBack: () => void }) {
  const t = useT()
  const name = builtInName(status.id)
  const on = googleAppAdminOn(status)
  const [switching, setSwitching] = useState<boolean | null>(null)
  const membersOn = switching ?? status.membersCanConnect
  const toggle = async (v: boolean) => {
    setSwitching(v)
    try { onStatus(await api.call(API.setGoogleAppMembers, { params: { app: status.id }, body: { on: v } })) }
    catch { toast({ level: 'error', text: t('gapps.saveFailed') }) }
    finally { setSwitching(null) }
  }
  return (
    <ConnectorDetail testId="gapp-admin-detail" logo={builtInLogo(status.id)} name={name} line={googleAppAdminLine(t, status)} official
      action={<>
        <Badge tone={on ? 'ok' : 'neutral'} className="shrink-0"><span data-testid="gapp-admin-state" data-state={on ? 'on' : status.configured ? 'off' : 'not_set_up'}>{t(on ? 'appConnectors.on' : status.configured ? 'appConnectors.off' : 'appConnectors.notSetUp')}</span></Badge>
        {status.canSetUp && <Button variant={status.configured ? 'secondary' : 'primary'} onClick={onSetUp} data-testid="gapp-admin-setup">{t(status.configured ? 'appConnectors.replace' : 'gapps.admin.setUp')}</Button>}
      </>}
      description={t('gapps.admin.about', { name })} toolsNote={t('gapps.admin.toolsNote')} onBack={onBack}>
      <div className="space-y-4">
        {status.configured && status.source === 'drive' && <p className="text-xs text-faint" data-testid="gapp-admin-same">{t('gapps.admin.sameAsDriveOn')}</p>}
        {status.configured && status.source === 'server' && <p className="text-xs text-faint">{t('appConnectors.byServer')}</p>}
        {status.configured && status.source === 'service' && <p className="text-xs text-faint">{t('appConnectors.byService')}</p>}
        {status.configured && (
          <section className="flex items-start gap-4 rounded-2xl border border-line bg-surface p-4" data-testid="gapp-admin-members">
            <div className="min-w-0 flex-1">
              <label htmlFor={`gapp-members-${status.id}`} className="text-sm font-semibold">{t('gapps.admin.members', { name })}</label>
              <p className="mt-0.5 text-xs text-muted">{t('gapps.admin.membersDesc')}</p>
              {membersOn && <p className="mt-1 text-xs text-faint" data-testid="gapp-admin-count">{t('appConnectors.connectedMembers', { count: status.connectedMembers })}</p>}
            </div>
            <Switch id={`gapp-members-${status.id}`} external label={t('gapps.admin.members', { name })} checked={membersOn} disabled={switching !== null} onChange={(v) => void toggle(v)} testId="gapp-admin-members-switch" />
          </section>
        )}
        {status.apis.length > 0 && status.source !== 'service' && <ApiList apis={status.apis} />}
      </div>
    </ConnectorDetail>
  )
}

/** The Google APIs to switch on in Google Cloud for this card, each a link to its page there. */
function ApiList({ apis }: { apis: GoogleAppAdminStatus['apis'] }) {
  const t = useT()
  return (
    <div data-testid="gapp-admin-apis">
      <p className="mb-1.5 text-xs text-muted">{t('gapps.admin.apis')}</p>
      <ul className="flex flex-wrap gap-2">
        {apis.map((a) => (
          <li key={a.url}>
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-xs hover:bg-hover" data-testid="gapp-admin-api">
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
