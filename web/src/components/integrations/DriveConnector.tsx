// Google Drive in Connectors, Trina's own connector next to the MCP services (lib/connectors.ts APP_CONNECTORS).
//  - Connectors: a card first in Discover; its + (or Connect on its page, pages/Connectors.tsx) goes straight to Google
//    sign-in (components/settings/DriveConnection.tsx). Back from Google, one inline line asks to confirm the account:
//    a security step (the server holds the connection until the same person confirms it, docs/GOOGLE-DRIVE.md). Once
//    linked it is a row among the connections (DriveCard): the account, "Connected" and ⋯ with Reconnect and Disconnect. No Google
//    client on this server yet: "Your admin needs to turn this on" for a member; an owner or admin is the one to set it
//    up, so they get "not set up yet" and a button to its page in Admin (QA TC-196).
//    Once it is set up every member may connect their own (no members' switch: docs/DECISIONS.md "No members' switch for
//    connectors"). A Drive the team shares with the person shows as "Shared by your team" with its folders, with nothing
//    to connect (DriveTeamShares).
//  - Admin › Connectors: its page (GoogleAdminPage.tsx DriveAdminPage) says Not set up or On (set up: everyone may
//    connect their own), with the one-time setup (or Change setup) in a small dialog (DriveSetupDialog) when this page
//    may do it (integrations/google-drive/admin-setup.ts), and in its Team settings who can use it and the Drives shared
//    with the team (DriveShares.tsx).
import clsx from 'clsx'
import { Check, ChevronDown, Copy, ExternalLink, FolderOpen, Upload } from 'lucide-react'
import { useId, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { API, type DriveAdminStatus, type DriveConnection, type DriveTeamShare } from '@mycel/shared/api'
import { APP_CONNECTORS, appConnectorLogo } from '../../lib/connectors'
import { api, ApiError } from '../../lib/api'
import { useT, type MessageKey } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { Button, Field, inputCls, Modal, useCopy } from '../ui'
import type { DriveConnectionState } from '../settings/DriveConnection'
import { LogoTile } from './ConnectorsView'
import { AppConnectorCard, CardMenu } from './AppConnectorCard'
import { connectionLogo } from './ConnectionRow'
import { BrowserWait } from './BrowserWait'
import { googleLink } from './googleLink'
import { Tooltip } from '../Tooltip'
import { dropOverCls } from '../FileDropZone'
import { useFileDrop } from '../chat/ComposerFiles'

const DRIVE = APP_CONNECTORS[0]

/** Linked (or linked and needing a new sign-in). */
export const driveLinked = (c: DriveConnection | null) => !!c?.configured && (c.status === 'connected' || c.status === 'needs_reconnect')
/** On in Admin › Connectors' Google Drive: set up. Every member may connect their own then, and the admin may share a
 * Drive with the team (no members' switch: docs/DECISIONS.md "No members' switch for connectors"). */
export const driveAdminOn = (s: DriveAdminStatus) => s.configured

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
  const navigate = useNavigate()
  const c = s.connection
  const { d } = s
  const linked = driveLinked(c)
  const reconnect = c?.status === 'needs_reconnect'
  const unavailable = !!c && !c.configured
  const shares = c?.teamShares ?? []
  const flow = d.inProgress ? d.flow : null

  let line: string = t('drive.cardDesc')
  if (!c && s.loadFailed) line = t('drive.loadFailed')
  // not set up on this server: a member waits for an admin; an owner or admin is the one to set it up (QA TC-196)
  else if (unavailable) line = t(admin ? 'drive.setUpFirst' : 'connectors.adminNeeded')
  else if (reconnect) line = t('drive.status.needs_reconnect')
  else if (linked && c?.account) line = c.account.email ?? c.account.name ?? t('drive.status.connected')

  const action = !c
    ? (s.loadFailed ? <Button size="sm" onClick={s.load} data-testid="drive-retry">{t('common.retry')}</Button> : null)
    : unavailable
      ? admin
        ? <Button size="sm" variant="primary" onClick={() => navigate('/admin/connectors?drive=1')} data-testid="drive-set-up">{t('drive.goSetUp')}</Button>
        : <Button size="sm" disabled data-testid="drive-connect">{t('aiApps.connect')}</Button>
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
        <BrowserWait text={t('drive.waitingShort')} testId="drive-waiting" retryTestId="drive-retry-wait" cancelTestId="drive-cancel" busy={d.busy}
          onRetry={s.start} onCancel={() => void d.cancel()} link={googleLink(d, t('drive.openGoogle'))} />
      )}
      {flow?.state === 'ready' && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="drive-confirm-step">
          <span role="status" className="min-w-0 flex-1">{t('drive.confirmAccount')} <span className="font-medium" data-testid="drive-account">{[flow.account?.name, flow.account?.email].filter(Boolean).join(' · ')}</span></span>
          <Button size="sm" variant="primary" busy={d.busy} onClick={() => void d.complete()} data-testid="drive-confirm">{t('drive.confirm')}</Button>
          <Button size="sm" variant="ghost" disabled={d.busy} onClick={d.cancel} data-testid="drive-cancel">{t('common.cancel')}</Button>
        </div>
      )}
      {d.error && !flow && <p className="text-sm text-danger" role="alert" data-testid="drive-error">{t(d.reason === 'timeout' ? 'connect.wait.timedOut' : 'drive.failed')}</p>}
      {s.revokeWarning && <p className="text-xs text-muted" role="status" data-testid="drive-revoke-warning">{t('drive.revokeWarning')}</p>}
    </>
  )
  const state = !c ? 'loading' : unavailable ? 'disabled' : flow ? `flow-${flow.state}` : c.status
  return { line, action, steps, state, linked, reconnect, unavailable, shares, busy: !!flow }
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
    <AppConnectorCard testId="drive-card" state={p.state} logo={<DriveLogo className={connectionLogo} />} name={DRIVE.name} line={p.line} lineTone={p.reconnect ? 'warn' : 'muted'} action={p.action}>
      {p.steps}
      <DriveTeamShares shares={p.shares} />
    </AppConnectorCard>
  )
}

/** One line for Google Drive in Admin › Connectors: what is on, or why nothing is. */
export function driveAdminLine(t: ReturnType<typeof useT>, status: DriveAdminStatus) {
  if (!status.configured) {
    return status.blocked === 'hosted' ? t('appConnectors.blocked.hosted')
      : status.blocked === 'public_host' ? t('appConnectors.blocked.publicHost')
        : t('connectors.setUpOnceLine')
  }
  return [
    t('appConnectors.connectedMembers', { count: status.connectedMembers }),
    status.sharesOn ? t('driveAdmin.shares', { count: status.sharesOn }) : null,
  ].filter(Boolean).join(' · ')
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

/** One address to paste into Google Cloud, with Copy: Google Drive's and a Google app's redirect URI, and the two return
 * addresses of the company's own Google app (GoogleSignInRow.tsx). */
export function ReturnAddress({ label, value, testId = 'drive-setup-redirect', copyLabel }: { label: string; value: string; testId?: string; copyLabel?: string }) {
  const t = useT()
  const { copied, copy } = useCopy()
  const name = copyLabel ?? t('common.copy')
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2" data-testid={`${testId}-row`}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{label}</span>
        {/* a long address wraps only after a slash (each line ends at one); Copy copies `value` as it is */}
        <code className="block text-xs break-words" data-testid={testId}>{value.split(/(?<=\/)(?!\/)/).map((part, i) => <span key={i}>{i > 0 && <wbr />}{part}</span>)}</code>
      </span>
      <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
        <Button size="sm" variant="ghost" onClick={() => void copy(value)} aria-label={name} data-testid={`${testId === 'drive-setup-redirect' ? 'drive-setup' : testId}-copy`}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </Button>
      </Tooltip>
    </div>
  )
}

/** The redirect URI to add in Google Cloud (with Copy), then the client file or its ID and secret: Google Drive's setup
 * and each Google app's (GoogleAppAdmin.tsx). `drop`: the file may also be dropped on the file part (its line says so);
 * `manual`: the ID and secret are behind a disclosure with these words instead of always shown (the company's own
 * Google app, GoogleSignInRow.tsx). */
export function GoogleClientFields({ redirectUri, value, onChange, onError, drop, manual }: { redirectUri: string | null; value: ClientInput; onChange: (c: ClientInput) => void; onError: (text: string | null) => void; drop?: string; manual?: string }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const fieldsId = useId()
  const [open, setOpen] = useState(!!value.clientId || !!value.clientSecret)
  const take = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 16_384) { onError(t('driveSetup.error.invalid')); return }
    onChange({ ...value, file: { name: f.name, text: await f.text() } }); onError(null)
  }
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    await take(f)
  }
  const { drag, dropProps } = useFileDrop({ files: drop ? (files) => void take(files[0]) : undefined })
  const fields = (
    <>
      <Field label={t('driveSetup.clientId')}><input className={inputCls} value={value.clientId} onChange={(e) => onChange({ ...value, clientId: e.target.value })} autoComplete="off" spellCheck={false} data-testid="drive-setup-id" /></Field>
      <Field label={t('driveSetup.clientSecret')}><input className={inputCls} type="password" value={value.clientSecret} onChange={(e) => onChange({ ...value, clientSecret: e.target.value })} autoComplete="off" spellCheck={false} data-testid="drive-setup-secret" /></Field>
    </>
  )
  return (
    <>
      {redirectUri && <ReturnAddress label={t('driveSetup.redirect')} value={redirectUri} />}
      <div {...(drop ? dropProps : {})} className={clsx(drop && 'space-y-2 rounded-xl transition', drag && dropOverCls)} data-testid="drive-setup-drop" data-over={drag || undefined}>
        <input ref={input} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pick(e)} data-testid="drive-setup-file" aria-label={t('driveSetup.file')} />
        <div>
          <Button onClick={() => input.current?.click()} data-testid="drive-setup-upload"><Upload size={14} aria-hidden />{value.file ? value.file.name : t('driveSetup.file')}</Button>
          {value.file && <Button size="sm" variant="ghost" className="ml-2" onClick={() => onChange({ ...value, file: null })}>{t('driveSetup.clearFile')}</Button>}
        </div>
        {drop && !value.file && <p className="text-xs text-muted" data-testid="drive-setup-drop-hint">{drop}</p>}
      </div>
      {!value.file && !manual && (
        <>
          <p className="text-xs text-muted">{t('driveSetup.orPaste')}</p>
          {fields}
        </>
      )}
      {!value.file && manual && (
        <div>
          <button type="button" aria-expanded={open} aria-controls={fieldsId} onClick={() => setOpen(!open)}
            className="touch-hit inline-flex items-center gap-1 text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline" data-testid="drive-setup-manual">
            {manual}<ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} aria-hidden />
          </button>
          <div id={fieldsId} hidden={!open} className="mt-3 space-y-4">{fields}</div>
        </div>
      )}
    </>
  )
}

/** What an admin does in Google Cloud for Drive, in order, each with the page it happens on (QA TC-197): a project, the
 * Drive API, the sign-in (consent) screen, a web client with this server's address, and its JSON file. Google's own
 * labels are quoted in the words, as the person has to find them there. */
export interface CloudStep { key: MessageKey; link: MessageKey | null; href: string | null; links?: readonly { name: string; href: string }[] }
export const DRIVE_CLOUD_STEPS: readonly CloudStep[] = [
  { key: 'driveSetup.step.project', link: 'driveSetup.link.project', href: 'https://console.cloud.google.com/projectcreate' },
  { key: 'driveSetup.step.api', link: 'driveSetup.link.api', href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
  { key: 'driveSetup.step.consent', link: 'driveSetup.link.consent', href: 'https://console.cloud.google.com/apis/credentials/consent' },
  { key: 'driveSetup.step.client', link: 'driveSetup.link.client', href: 'https://console.cloud.google.com/apis/credentials/oauthclient' },
  { key: 'driveSetup.step.json', link: null, href: null },
]

const stepLink = 'inline-flex items-center gap-0.5 whitespace-nowrap text-accent-text underline-offset-2 hover:underline'

/** The steps in Google Cloud, numbered, each with the Google Cloud page it happens on (a new tab): Google Drive's own
 * setup, or the company's own Google app for all five (`steps`, GoogleSignInRow.tsx). `title` null: the dialog's own
 * heading says it. */
export function DriveCloudSteps({ steps = DRIVE_CLOUD_STEPS, title = 'driveSetup.stepsTitle' }: { steps?: readonly CloudStep[]; title?: MessageKey | null }) {
  const t = useT()
  return (
    <div data-testid="drive-setup-steps">
      {title && <p className="mb-2 text-sm font-medium">{t(title)}</p>}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {steps.map((x) => (
          <li key={x.key} data-testid="drive-setup-step">
            {t(x.key)}
            {x.href && x.link && (
              <> <a href={x.href} target="_blank" rel="noopener noreferrer" className={stepLink} data-testid="drive-setup-step-link">
                {t(x.link)}<ExternalLink size={12} aria-hidden />
              </a></>
            )}
            {x.links && (
              <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {x.links.map((l) => (
                  <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={stepLink} data-testid="drive-setup-step-link">
                    {l.name}<ExternalLink size={12} aria-hidden />
                  </a>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Set up Google Drive: the steps in Google Cloud, then the Google OAuth web client (the file Google Cloud downloads, or
 * its ID and secret). */
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
        <DriveCloudSteps />
        <GoogleClientFields redirectUri={status.redirectUri} value={client} onChange={setClient} onError={setError} />
        {status.configured && <p className="text-xs text-muted">{t('driveSetup.replaceNote')}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="drive-setup-error">{error}</p>}
      </div>
    </Modal>
  )
}
