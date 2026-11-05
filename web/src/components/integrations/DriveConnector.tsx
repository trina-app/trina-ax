// Google Drive in Settings › App connectors (pages/ConnectorConnections.tsx): the first app connector in the list, a
// row with its logo and + (or, once the person's own Google account is linked, its email, ✓, Reconnect and Disconnect),
// and a dialog with the connect flow (the same API and steps as before, components/settings/DriveConnection.tsx). It was
// its own Settings section; /settings/drive now opens the dialog there. Admin › App connectors shows whether the server
// has a Google client (pages/admin/AppConnectors.tsx); that is set up by the operator (docs/GOOGLE-DRIVE.md).
import clsx from 'clsx'
import { Check, ChevronDown, ExternalLink, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import type { DriveConnection } from '@mycel/shared/api'
import { SOURCE_CODE } from '@mycel/shared'
import { BUILT_IN, builtInLogo } from '../../lib/connectors'
import { mobileApp } from '../../lib/mobile'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { Badge, Button, ErrorNote, IconButton, Modal, Skeleton } from '../ui'
import { DriveFlowPanel, type DriveConnectionState } from '../settings/DriveConnection'
import { LogoTile } from './ConnectorsView'

const DRIVE = BUILT_IN[0]
export const DRIVE_SETUP_GUIDE = `${SOURCE_CODE.repository}/blob/main/docs/GOOGLE-DRIVE.md`

/** Linked (or linked and needing a new sign-in): the connection has a row under Connected. */
export const driveLinked = (c: DriveConnection | null) => !!c?.configured && (c.status === 'connected' || c.status === 'needs_reconnect')

export function DriveLogo({ className }: { className?: string }) {
  return <LogoTile src={builtInLogo('google-drive')} className={className} />
}

const admin = (role: string) => role === 'owner' || role === 'admin'

/** The list row while Drive is not linked: logo, name, what it does, and + to open the dialog. Not set up on this
 * server: one line instead of the + (an owner or admin also gets the setup guide). */
export function DriveItem({ s, onOpen }: { s: DriveConnectionState; onOpen: () => void }) {
  const t = useT()
  const me = useMeStrict()
  const c = s.connection
  const unavailable = !!c && !c.configured
  return (
    <li className="flex items-center gap-3 p-2" data-testid="drive-item" data-status={c ? (c.configured ? c.status : 'disabled') : 'loading'}>
      <DriveLogo className="size-9" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{DRIVE.name}</span>
        {unavailable ? (
          <span className="mt-0.5 block text-xs text-muted" data-testid="drive-item-unavailable">
            {admin(me.user.role) ? (
              <>
                {t('drive.adminNotSet')}{' '}
                <a href={DRIVE_SETUP_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent-text underline underline-offset-2" data-testid="drive-setup-guide">
                  {t('drive.setupGuide')}
                  <ExternalLink size={11} aria-hidden />
                </a>
              </>
            ) : t('drive.notAvailable')}
          </span>
        ) : (
          <span className="mt-0.5 block truncate text-xs text-muted">{s.loadFailed ? t('drive.loadFailed') : t('drive.cardDesc')}</span>
        )}
      </span>
      {!unavailable && (
        <IconButton label={t('integrations.discover.add', { name: DRIVE.name })} className="shrink-0" onClick={onOpen} data-testid="drive-add">
          <Plus size={16} aria-hidden />
        </IconButton>
      )}
    </li>
  )
}

/** The connect flow in a dialog: status, account, connect or reconnect, the Google step, disconnect. */
export function DriveDialog({ s, onClose }: { s: DriveConnectionState; onClose: () => void }) {
  const t = useT()
  const me = useMeStrict()
  const c = s.connection
  const { d } = s
  const linked = driveLinked(c)
  return (
    <Modal open title={DRIVE.name} onClose={onClose} width={480}>
      <div className="space-y-4" data-testid="drive-connection">
        <div className="flex items-start gap-3">
          <DriveLogo className="size-10" />
          <p className="text-sm text-muted">{t('drive.description')}</p>
        </div>
        {!c && s.loadFailed && <ErrorNote onRetry={s.load}>{t('drive.loadFailed')}</ErrorNote>}
        {!c && !s.loadFailed && <Skeleton lines={3} />}
        {c && !c.configured && (
          <p role="note" className="text-sm" data-testid="drive-unavailable">
            {t('drive.notConfigured')}
            {admin(me.user.role) && (
              <>
                {' '}
                <a href={DRIVE_SETUP_GUIDE} target="_blank" rel="noopener noreferrer" className="text-accent-text underline underline-offset-2">{t('drive.setupGuide')}</a>
              </>
            )}
          </p>
        )}
        {c?.configured && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm" data-testid="drive-status">{t(`drive.status.${c.status}`)}</span>
                {c.account && <span className="block truncate text-xs text-muted" data-testid="drive-connected-account">{c.account.name} · {c.account.email}</span>}
              </span>
              {c.status === 'connected' && <Check size={16} className="shrink-0 text-ok" aria-hidden />}
              {c.status === 'needs_reconnect' && <Badge tone="warn" className="shrink-0">{t('drive.status.needs_reconnect')}</Badge>}
            </div>
            {d.error && <ErrorNote>{t('drive.failed')}</ErrorNote>}
            {s.revokeWarning && <p role="status" className="text-sm text-muted" data-testid="drive-revoke-warning">{t('drive.revokeWarning')}</p>}
            {d.inProgress && d.flow ? <DriveFlowPanel d={d} flow={d.flow} /> : (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" busy={d.busy} onClick={s.start} data-testid="drive-connect">{t(linked ? 'drive.reconnect' : 'drive.connect')}</Button>
                {c.status !== 'disconnected' && <Button disabled={d.busy} onClick={() => void s.disconnect()} data-testid="drive-disconnect">{t('drive.disconnect')}</Button>}
              </div>
            )}
            {mobileApp() && <p className="text-xs text-muted">{t('drive.mobileBrowserLogin')}</p>}
            <p className="text-xs text-faint">{t('drive.privacy')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

/** The row while linked: like an MCP connection's row, details open in place. A Drive that needs
 * a new sign-in says so on the row with Reconnect beside it. */
export function DriveRow({ s, inDialog }: { s: DriveConnectionState; inDialog: boolean }) {
  const t = useT()
  const [details, setDetails] = useState(false)
  const detailsId = useId()
  const c = s.connection!
  const { d } = s
  const reconnect = c.status === 'needs_reconnect'
  return (
    <li className="py-1" data-testid="drive-row" data-status={c.status}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={details}
          aria-controls={details ? detailsId : undefined}
          onClick={() => setDetails((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left hover:bg-hover"
          data-testid="drive-row-toggle"
        >
          <DriveLogo className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{DRIVE.name}</span>
            <span className={clsx('mt-0.5 block truncate text-xs', reconnect ? 'text-warn' : 'text-muted')}>
              {reconnect ? t('drive.status.needs_reconnect') : c.account ? c.account.email : t('drive.status.connected')}
            </span>
          </span>
          {reconnect ? (
            <Badge tone="warn" className="shrink-0 max-sm:hidden">{t('drive.status.needs_reconnect')}</Badge>
          ) : (
            <span className="flex shrink-0 items-center text-ok" title={t('drive.status.connected')}>
              <Check size={16} aria-hidden />
              <span className="sr-only">{t('drive.status.connected')}</span>
            </span>
          )}
          <ChevronDown size={15} className={clsx('shrink-0 text-faint transition-transform', details && 'rotate-180')} aria-hidden />
        </button>
        {reconnect && !d.inProgress && (
          <Button size="sm" variant="primary" className="shrink-0" busy={d.busy} onClick={s.start} data-testid="drive-row-reconnect">{t('drive.reconnect')}</Button>
        )}
      </div>
      {/* a reconnect started from this row (not from the dialog) shows its Google step here */}
      {!inDialog && d.inProgress && d.flow && <div className="px-2 pb-2 sm:pl-14"><DriveFlowPanel d={d} flow={d.flow} /></div>}
      {!inDialog && d.error && <div className="px-2 pb-2 sm:pl-14"><ErrorNote onRetry={s.start}>{t('drive.failed')}</ErrorNote></div>}
      {details && (
        <div id={detailsId} className="pr-2 pb-3 pl-2 sm:pl-14" data-testid="drive-details">
          {c.account && <p className="text-xs text-muted">{c.account.name} · {c.account.email}</p>}
          <p className="mt-1 text-xs text-faint">{t('drive.privacy')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {!reconnect && <Button size="sm" busy={d.busy} disabled={d.inProgress} onClick={s.start} data-testid="drive-row-reconnect-details">{t('drive.reconnect')}</Button>}
            <Button size="sm" disabled={d.busy} onClick={() => void s.disconnect()} data-testid="drive-row-disconnect">{t('drive.disconnect')}</Button>
          </div>
        </div>
      )}
    </li>
  )
}
