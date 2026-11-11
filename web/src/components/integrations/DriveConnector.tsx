// Google Drive in Connectors, Trina's own connector next to the MCP services (lib/connectors.ts APP_CONNECTORS).
//  - Settings › Connectors: a card first in Discover; its + (or Connect on its page, DriveDetail) goes straight to Google
//    sign-in (components/settings/DriveConnection.tsx). Back from Google, one inline line asks to confirm the account:
//    a security step (the server holds the connection until the same person confirms it, docs/GOOGLE-DRIVE.md). Once
//    linked it is a row among the connections (DriveCard): the account, "Connected" and ⋯ with Reconnect and Disconnect. No Google
//    client on this server yet: "Your admin needs to turn this on".
//    An admin may not let members connect their own (Admin › Connectors › Google Drive): Connect is then off for
//    members, and a connection made before says the admin turned it off. An owner or admin gets one button instead,
//    "팀원도 연결할 수 있게 켜고 내 드라이브 연결하기": their own sign-in, and the switch turns on only once they confirm
//    the account (docs/DECISIONS.md "W6"; the welcome steps' 도구 연결 row does the same). A Drive the team shares with the person shows as "Shared by
//    your team" with its folders, with nothing to connect (DriveTeamShares).
//  - Admin › Connectors: its page (DriveAdminDetail) says Not set up, Ready to set up (a Google client is there, nothing
//    is on yet) or On (members may connect their own, or a Drive is shared with the team), with the one-time setup (or
//    Replace) in a small dialog (DriveSetupDialog) when this page may do it (integrations/google-drive/admin-setup.ts),
//    and below it the members' switch and the shares (DriveShares.tsx). A client alone turns nothing on.
import { Check, Copy, FolderOpen, Upload } from 'lucide-react'
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { API, type DriveAdminStatus, type DriveConnection, type DriveTeamShare } from '@mycel/shared/api'
import { APP_CONNECTORS, appConnectorLogo } from '../../lib/connectors'
import { api, ApiError } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { Badge, Button, Field, inputCls, Modal, useCopy } from '../ui'
import type { DriveConnectionState } from '../settings/DriveConnection'
import { ConnectorDetail, LogoTile } from './ConnectorsView'
import { AppConnectorCard, CardMenu } from './AppConnectorCard'
import { Tooltip } from '../Tooltip'

const DRIVE = APP_CONNECTORS[0]

/** Linked (or linked and needing a new sign-in). */
export const driveLinked = (c: DriveConnection | null) => !!c?.configured && (c.status === 'connected' || c.status === 'needs_reconnect')
/** The team lets members connect their own Drive (an older server does not say: it does). */
export const drivePersonalAllowed = (c: DriveConnection | null) => c?.personalAllowed !== false
/** Something on in Admin › Connectors' Google Drive: members connect their own, or a Drive is shared with the team. An
 * older server does not say: its client is what turned it on. */
export const driveAdminOn = (s: DriveAdminStatus) => s.configured && (s.membersCanConnect === undefined || s.membersCanConnect || (s.sharesOn ?? 0) > 0)

export function DriveLogo({ className }: { className?: string }) {
  return <LogoTile src={appConnectorLogo(DRIVE)} className={className} />
}

/** What Google Drive shows for one person, wherever it is (its row among the connections in Connectors, its page): the line under the
 * name, the action on the right, and the steps while Google is open. Connect goes straight to Google; back from it, one
 * inline line asks to confirm the account (a security step: the server holds the link until the same person confirms
 * it, so a Google sign-in started by someone else can never land in this person's Drive connection). */
export function useDriveParts(s: DriveConnectionState) {
  const t = useT()
  const admin = isAdmin(useMe())
  const c = s.connection
  const { d } = s
  const linked = driveLinked(c)
  const reconnect = c?.status === 'needs_reconnect'
  const unavailable = !!c && !c.configured
  // the admin did not let members connect their own: Connect is off, and one made before is not used
  const off = !!c && c.configured && !drivePersonalAllowed(c)
  // an owner or admin connects their own anyway, and turns the switch on with it at the confirm (docs/DECISIONS.md "W6")
  const turnOn = off && admin && !linked
  const shares = c?.teamShares ?? []
  const flow = d.inProgress ? d.flow : null

  let line: string = t('drive.cardDesc')
  if (!c && s.loadFailed) line = t('drive.loadFailed')
  else if (unavailable) line = t('connectors.adminNeeded')
  else if (off && linked) line = t('drive.membersOffLinked')
  else if (off && shares.length) line = t('drive.teamShared', { name: shares.map((x) => x.name).join(', ') })
  else if (turnOn) line = t('drive.cardDesc')
  else if (off) line = t('connectors.adminNeeded')
  else if (reconnect) line = t('drive.status.needs_reconnect')
  else if (linked && c?.account) line = c.account.email ?? c.account.name ?? t('drive.status.connected')

  const action = !c
    ? (s.loadFailed ? <Button size="sm" onClick={s.load} data-testid="drive-retry">{t('common.retry')}</Button> : null)
    : unavailable
      ? <Button size="sm" disabled data-testid="drive-connect">{t('aiApps.connect')}</Button>
      : turnOn
        ? (flow ? null : <Button size="sm" variant="primary" busy={d.busy} onClick={s.start} data-testid="drive-connect">{t('drive.turnOnConnect')}</Button>)
      : off
        ? linked
          ? <CardMenu label={t('appConnectors.more', { name: DRIVE.name })} testId="drive-menu" items={[
              { label: t('drive.disconnect'), onSelect: () => void s.disconnect(), danger: true, disabled: d.busy, testId: 'drive-menu-disconnect' },
            ]} />
          : shares.length ? null : <Button size="sm" disabled data-testid="drive-connect">{t('aiApps.connect')}</Button>
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

  const steps = (
    <>
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
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="drive-confirm-step">
          <span role="status" className="min-w-0 flex-1">{t('drive.confirmAccount')} <span className="font-medium" data-testid="drive-account">{[flow.account?.name, flow.account?.email].filter(Boolean).join(' · ')}</span></span>
          <Button size="sm" variant="primary" busy={d.busy} onClick={() => void d.complete(admin ? { membersOn: true } : {})} data-testid="drive-confirm">{t('drive.confirm')}</Button>
          <Button size="sm" variant="ghost" disabled={d.busy} onClick={d.cancel} data-testid="drive-cancel">{t('common.cancel')}</Button>
        </div>
      )}
      {d.error && !flow && <p className="text-sm text-danger" role="alert" data-testid="drive-error">{t('drive.failed')}</p>}
      {s.revokeWarning && <p className="text-xs text-muted" role="status" data-testid="drive-revoke-warning">{t('drive.revokeWarning')}</p>}
    </>
  )
  const state = !c ? 'loading' : unavailable ? 'disabled' : flow ? `flow-${flow.state}` : turnOn ? 'turn-on' : off && !linked ? (shares.length ? 'team' : 'off') : c.status
  return { line, action, steps, state, linked, reconnect, unavailable, off, turnOn, shares, busy: !!flow }
}

/** The Drives the team shares with this person: nothing to connect, the AI can use them in their chats. */
export function DriveTeamShares({ shares }: { shares: DriveTeamShare[] }) {
  const t = useT()
  if (!shares.length) return null
  return (
    <ul className="space-y-2" data-testid="drive-team-shares">
      {shares.map((x) => (
        <li key={x.id} className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm" data-testid="drive-team-share">
          <FolderOpen size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{t('drive.teamShared', { name: x.name })}</span>
            <span className="block text-xs text-muted break-words">{x.wholeDrive ? t('drive.teamWhole') : t('drive.teamFolders', { list: x.folders.map((f) => f.name).join(', ') || '—' })}</span>
            <span className="block text-xs text-faint">{t('drive.teamHint')}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The person's own Google Drive as one row among the connections in Connectors: the account, Connected and ⋯. */
export function DriveCard({ s }: { s: DriveConnectionState }) {
  const p = useDriveParts(s)
  return (
    <AppConnectorCard testId="drive-card" state={p.state} logo={<DriveLogo className="size-10" />} name={DRIVE.name} line={p.line} lineTone={p.reconnect || (p.off && p.linked) ? 'warn' : 'muted'} action={p.action}>
      {p.steps}
      <DriveTeamShares shares={p.shares} />
    </AppConnectorCard>
  )
}

/** The tools the AI gets from Google Drive here (server/src/tools/drive.ts): read only. */
export const DRIVE_TOOLS = ['drive_search', 'drive_list', 'drive_read']

/** Google Drive's page in Connectors (a member's): Connect goes straight to Google. */
export function DriveDetail({ s, onBack }: { s: DriveConnectionState; onBack: () => void }) {
  const t = useT()
  const p = useDriveParts(s)
  return (
    <ConnectorDetail testId="drive-detail" logo={appConnectorLogo(DRIVE)} name={DRIVE.name} line={p.line} official action={p.action}
      description={t('connectors.drive.about')} tools={DRIVE_TOOLS} onBack={onBack}>
      {p.steps}
      {p.shares.length > 0 && <div className={p.steps ? 'mt-3' : undefined}><DriveTeamShares shares={p.shares} /></div>}
    </ConnectorDetail>
  )
}

/** One line for Google Drive in Admin › Connectors: what is on, or why nothing is. */
export function driveAdminLine(t: ReturnType<typeof useT>, status: DriveAdminStatus) {
  if (!status.configured) {
    return status.blocked === 'hosted' ? t('appConnectors.blocked.hosted')
      : status.blocked === 'public_host' ? t('appConnectors.blocked.publicHost')
        : t('connectors.setUpOnceLine')
  }
  if (!driveAdminOn(status)) return t('driveAdmin.readyLine')
  return [
    status.membersCanConnect !== false ? t('appConnectors.connectedMembers', { count: status.connectedMembers }) : null,
    status.sharesOn ? t('driveAdmin.shares', { count: status.sharesOn }) : null,
  ].filter(Boolean).join(' · ')
}

/** Google Drive's page in Admin › Connectors: whether anything is on (a Google client alone is only "Ready to set up"),
 * the one-time setup, and (children) the members' switch and the Drives shared with the team. */
export function DriveAdminDetail({ status, onSetUp, onBack, children }: { status: DriveAdminStatus; onSetUp: () => void; onBack: () => void; children?: ReactNode }) {
  const t = useT()
  const on = driveAdminOn(status)
  return (
    <ConnectorDetail testId="drive-admin-detail" logo={appConnectorLogo(DRIVE)} name={DRIVE.name} line={driveAdminLine(t, status)} official
      action={<>
        <Badge tone={on ? 'ok' : 'neutral'} className="shrink-0"><span data-testid="drive-admin-state" data-state={on ? 'on' : status.configured ? 'ready' : 'not_set_up'}>{t(on ? 'appConnectors.on' : status.configured ? 'driveAdmin.ready' : 'appConnectors.notSetUp')}</span></Badge>
        {status.canSetUp && <Button variant={status.configured ? 'secondary' : 'primary'} onClick={onSetUp} data-testid="drive-setup">{t(status.configured ? 'appConnectors.replace' : 'connectors.setUpOnce')}</Button>}
      </>}
      description={t('connectors.drive.about')} tools={DRIVE_TOOLS} onBack={onBack}>
      {status.configured && status.source === 'server' && <p className="text-xs text-faint" data-testid="drive-by-server">{t('appConnectors.byServer')}</p>}
      {status.configured && status.source === 'service' && <p className="text-xs text-faint" data-testid="drive-by-service">{t('appConnectors.byService')}</p>}
      {status.configured && <div className={status.source === 'server' || status.source === 'service' ? 'mt-4' : undefined}>{children}</div>}
    </ConnectorDetail>
  )
}

/** The Google OAuth web client an admin gives: the file Google Cloud downloads, or its client ID and secret. */
export interface ClientInput { file: { name: string; text: string } | null; clientId: string; clientSecret: string }
export const emptyClient: ClientInput = { file: null, clientId: '', clientSecret: '' }
export const clientReady = (c: ClientInput) => !!c.file || (c.clientId.trim() !== '' && c.clientSecret.trim() !== '')
export const clientBody = (c: ClientInput) => (c.file ? { file: c.file.text } : { clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim() })
/** What the server said about a client that it refused, in words. */
export const clientErrorKey = (e: unknown) => {
  const m = e instanceof ApiError ? e.message : ''
  return m.includes('client_redirect') ? 'driveSetup.error.redirect' as const : m.includes('client_invalid') ? 'driveSetup.error.invalid' as const : 'driveSetup.error.failed' as const
}

/** The redirect URI to add in Google Cloud (with Copy), then the client file or its ID and secret: Google Drive's setup
 * and each Google app's (GoogleAppAdmin.tsx). */
export function GoogleClientFields({ redirectUri, value, onChange, onError }: { redirectUri: string | null; value: ClientInput; onChange: (c: ClientInput) => void; onError: (text: string | null) => void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const { copied, copy } = useCopy()
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 16_384) { onError(t('driveSetup.error.invalid')); return }
    onChange({ ...value, file: { name: f.name, text: await f.text() } }); onError(null)
  }
  return (
    <>
      {redirectUri && (
        <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">{t('driveSetup.redirect')}</span>
            <code className="block text-xs break-all" data-testid="drive-setup-redirect">{redirectUri}</code>
          </span>
          <Tooltip label={t('common.copy')}>
            <Button size="sm" variant="ghost" onClick={() => void copy(redirectUri)} aria-label={t('common.copy')} data-testid="drive-setup-copy">
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </Button>
          </Tooltip>
        </div>
      )}
      <div>
        <input ref={input} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pick(e)} data-testid="drive-setup-file" aria-label={t('driveSetup.file')} />
        <Button onClick={() => input.current?.click()} data-testid="drive-setup-upload"><Upload size={14} aria-hidden />{value.file ? value.file.name : t('driveSetup.file')}</Button>
        {value.file && <Button size="sm" variant="ghost" className="ml-2" onClick={() => onChange({ ...value, file: null })}>{t('driveSetup.clearFile')}</Button>}
      </div>
      {!value.file && (
        <>
          <p className="text-xs text-muted">{t('driveSetup.orPaste')}</p>
          <Field label={t('driveSetup.clientId')}><input className={inputCls} value={value.clientId} onChange={(e) => onChange({ ...value, clientId: e.target.value })} autoComplete="off" spellCheck={false} data-testid="drive-setup-id" /></Field>
          <Field label={t('driveSetup.clientSecret')}><input className={inputCls} type="password" value={value.clientSecret} onChange={(e) => onChange({ ...value, clientSecret: e.target.value })} autoComplete="off" spellCheck={false} data-testid="drive-setup-secret" /></Field>
        </>
      )}
    </>
  )
}

/** Set up Google Drive: the Google OAuth web client (the file Google Cloud downloads, or its ID and secret). */
export function DriveSetupDialog({ status, onClose, onSaved }: { status: DriveAdminStatus; onClose: () => void; onSaved: (s: DriveAdminStatus) => void }) {
  const t = useT()
  const [client, setClient] = useState<ClientInput>(emptyClient)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ready = clientReady(client)
  const save = async () => {
    if (busy || !ready) return
    setBusy(true); setError(null)
    try { onSaved(await api.call(API.setDriveClient, { body: clientBody(client) })) }
    catch (e) { setError(t(clientErrorKey(e))) }
    finally { setBusy(false) }
  }
  return (
    <Modal open title={t(status.configured ? 'driveSetup.replaceTitle' : 'driveSetup.title')} onClose={onClose} width={480}
      footer={<>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()} data-testid="drive-setup-save">{t('common.save')}</Button>
      </>}>
      <div className="space-y-4" data-testid="drive-setup-dialog">
        <GoogleClientFields redirectUri={status.redirectUri} value={client} onChange={setClient} onError={setError} />
        {status.configured && <p className="text-xs text-muted">{t('driveSetup.replaceNote')}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="drive-setup-error">{error}</p>}
      </div>
    </Modal>
  )
}
