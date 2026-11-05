// Google Drive as an app connector: one card in the App connectors grid (lib/connectors.ts APP_CONNECTORS).
//  - Settings › App connectors (DriveCard): Connect goes straight to Google sign-in (the same flow as before,
//    components/settings/DriveConnection.tsx). Google sends the person back and the card asks to confirm the account
//    they signed in with: that confirmation is a security step (the server holds the connection until the same person
//    confirms it, docs/GOOGLE-DRIVE.md), so it stays, inside the card. Once linked: the account, "Connected" and a ⋯ menu
//    with Reconnect and Disconnect. No Google client on this server: "Not available yet".
//  - Admin › App connectors (DriveAdminCard): On / Not set up, how many members are connected, and Set up (or Replace) when
//    the page may set the client up (integrations/google-drive/admin-setup.ts), in a small dialog (DriveSetupDialog).
import { Check, Copy, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { API, type DriveAdminStatus, type DriveConnection } from '@mycel/shared/api'
import { APP_CONNECTORS, appConnectorLogo } from '../../lib/connectors'
import { api, ApiError } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { useT } from '../../i18n'
import { Badge, Button, Field, inputCls, Modal, useCopy } from '../ui'
import type { DriveConnectionState } from '../settings/DriveConnection'
import { LogoTile } from './ConnectorsView'
import { AppConnectorCard, CardMenu } from './AppConnectorCard'

const DRIVE = APP_CONNECTORS[0]

/** Linked (or linked and needing a new sign-in). */
export const driveLinked = (c: DriveConnection | null) => !!c?.configured && (c.status === 'connected' || c.status === 'needs_reconnect')

export function DriveLogo({ className }: { className?: string }) {
  return <LogoTile src={appConnectorLogo(DRIVE)} className={className} />
}

/** The person's own Google Drive: Connect, the Google step inside the card, then the account with ⋯. */
export function DriveCard({ s }: { s: DriveConnectionState }) {
  const t = useT()
  const c = s.connection
  const { d } = s
  const linked = driveLinked(c)
  const reconnect = c?.status === 'needs_reconnect'
  const unavailable = !!c && !c.configured
  const flow = d.inProgress ? d.flow : null

  let line: string = t('drive.cardDesc')
  if (!c && s.loadFailed) line = t('drive.loadFailed')
  else if (unavailable) line = t('drive.notAvailable')
  else if (reconnect) line = t('drive.status.needs_reconnect')
  else if (linked && c?.account) line = c.account.email ?? c.account.name ?? t('drive.status.connected')

  const action = !c
    ? (s.loadFailed ? <Button size="sm" onClick={s.load} data-testid="drive-retry">{t('common.retry')}</Button> : null)
    : unavailable
      ? <Button size="sm" disabled data-testid="drive-connect">{t('aiApps.connect')}</Button>
      : flow
        ? null
        : linked
          ? <>
              {reconnect
                ? <Button size="sm" variant="primary" busy={d.busy} onClick={s.start} data-testid="drive-reconnect">{t('drive.reconnect')}</Button>
                : <span className="flex items-center gap-1 text-xs text-ok" data-testid="drive-connected"><Check size={14} aria-hidden />{t('drive.status.connected')}</span>}
              <CardMenu label={t('appConnectors.more', { name: DRIVE.name })} testId="drive-menu" items={[
                ...(reconnect ? [] : [{ label: t('drive.reconnect'), onSelect: s.start, disabled: d.busy, testId: 'drive-menu-reconnect' }]),
                { label: t('drive.disconnect'), onSelect: () => void s.disconnect(), danger: true, disabled: d.busy, testId: 'drive-menu-disconnect' },
              ]} />
            </>
          : <Button size="sm" variant="primary" busy={d.busy} onClick={s.start} data-testid="drive-connect">{t('aiApps.connect')}</Button>

  return (
    <AppConnectorCard testId="drive-card" state={!c ? 'loading' : unavailable ? 'disabled' : flow ? `flow-${flow.state}` : c.status}
      logo={<DriveLogo className="size-10" />} name={DRIVE.name} line={line} lineTone={reconnect ? 'warn' : 'muted'} action={action}>
      {flow && flow.state !== 'ready' && (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="status" data-testid="drive-waiting">
          <span className="text-muted">{t('drive.waitingShort')}</span>
          {d.authorizationUrl && (
            <a href={d.authorizationUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline"
              onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>
              {t('drive.openGoogle')}
            </a>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={d.busy} onClick={d.cancel} data-testid="drive-cancel">{t('common.cancel')}</Button>
        </div>
      )}
      {flow?.state === 'ready' && (
        <div className="space-y-2" data-testid="drive-confirm-step">
          <p className="text-sm" role="status">{t('drive.confirmAccount')} <span className="font-medium" data-testid="drive-account">{[flow.account?.name, flow.account?.email].filter(Boolean).join(' · ')}</span></p>
          <p className="text-xs text-faint">{t('drive.privacyShort')}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" busy={d.busy} onClick={d.complete} data-testid="drive-confirm">{t('drive.confirm')}</Button>
            <Button size="sm" disabled={d.busy} onClick={d.cancel} data-testid="drive-cancel">{t('common.cancel')}</Button>
          </div>
        </div>
      )}
      {d.error && !flow && <p className="text-sm text-danger" role="alert" data-testid="drive-error">{t('drive.failed')}</p>}
      {s.revokeWarning && <p className="text-xs text-muted" role="status" data-testid="drive-revoke-warning">{t('drive.revokeWarning')}</p>}
    </AppConnectorCard>
  )
}

/** Admin › App connectors: is Drive on, how many members use it, and Set up / Replace where this page may do it. */
export function DriveAdminCard({ status, onSetUp }: { status: DriveAdminStatus; onSetUp: () => void }) {
  const t = useT()
  const line = status.configured
    ? t('appConnectors.connectedMembers', { count: status.connectedMembers })
    : status.blocked === 'hosted' ? t('appConnectors.blocked.hosted')
      : status.blocked === 'public_host' ? t('appConnectors.blocked.publicHost')
        : t('appConnectors.notSetUpLine')
  return (
    <AppConnectorCard testId="admin-drive" state={status.configured ? 'on' : 'off'} logo={<DriveLogo className="size-10" />} name={DRIVE.name} line={line}
      action={<>
        <Badge tone={status.configured ? 'ok' : 'neutral'} className="shrink-0">{t(status.configured ? 'appConnectors.on' : 'appConnectors.notSetUp')}</Badge>
        {status.canSetUp && <Button size="sm" variant={status.configured ? 'secondary' : 'primary'} onClick={onSetUp} data-testid="drive-setup">{t(status.configured ? 'appConnectors.replace' : 'appConnectors.setUpAction')}</Button>}
      </>}>
      {status.configured && status.source === 'server' && <p className="text-xs text-faint" data-testid="drive-by-server">{t('appConnectors.byServer')}</p>}
    </AppConnectorCard>
  )
}

/** Set up Google Drive: the Google OAuth web client (the file Google Cloud downloads, or its ID and secret). */
export function DriveSetupDialog({ status, onClose, onSaved }: { status: DriveAdminStatus; onClose: () => void; onSaved: (s: DriveAdminStatus) => void }) {
  const t = useT()
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const { copied, copy } = useCopy()
  const ready = !!file || (clientId.trim() !== '' && clientSecret.trim() !== '')
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 16_384) { setError(t('driveSetup.error.invalid')); return }
    setFile({ name: f.name, text: await f.text() }); setError(null)
  }
  const save = async () => {
    if (busy || !ready) return
    setBusy(true); setError(null)
    try {
      const body = file ? { file: file.text } : { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
      onSaved(await api.call(API.setDriveClient, { body }))
    } catch (e) {
      const m = e instanceof ApiError ? e.message : ''
      setError(t(m.includes('client_redirect') ? 'driveSetup.error.redirect' : m.includes('client_invalid') ? 'driveSetup.error.invalid' : 'driveSetup.error.failed'))
    } finally { setBusy(false) }
  }
  return (
    <Modal open title={t(status.configured ? 'driveSetup.replaceTitle' : 'driveSetup.title')} onClose={onClose} width={480}
      footer={<>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()} data-testid="drive-setup-save">{t('common.save')}</Button>
      </>}>
      <div className="space-y-4" data-testid="drive-setup-dialog">
        {status.redirectUri && (
          <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">{t('driveSetup.redirect')}</span>
              <code className="block text-xs break-all" data-testid="drive-setup-redirect">{status.redirectUri}</code>
            </span>
            <Button size="sm" variant="ghost" onClick={() => void copy(status.redirectUri!)} aria-label={t('common.copy')} data-testid="drive-setup-copy">
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </Button>
          </div>
        )}
        <div>
          <input ref={input} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pick(e)} data-testid="drive-setup-file" aria-label={t('driveSetup.file')} />
          <Button onClick={() => input.current?.click()} data-testid="drive-setup-upload"><Upload size={14} aria-hidden />{file ? file.name : t('driveSetup.file')}</Button>
          {file && <Button size="sm" variant="ghost" className="ml-2" onClick={() => setFile(null)}>{t('driveSetup.clearFile')}</Button>}
        </div>
        {!file && (
          <>
            <p className="text-xs text-muted">{t('driveSetup.orPaste')}</p>
            <Field label={t('driveSetup.clientId')}><input className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} data-testid="drive-setup-id" /></Field>
            <Field label={t('driveSetup.clientSecret')}><input className={inputCls} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} data-testid="drive-setup-secret" /></Field>
          </>
        )}
        {status.configured && <p className="text-xs text-muted">{t('driveSetup.replaceNote')}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="drive-setup-error">{error}</p>}
      </div>
    </Modal>
  )
}
