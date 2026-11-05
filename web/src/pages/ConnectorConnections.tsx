// Settings › App connectors: one list of the app connectors this person has, in the same row style as MCP.
//  - Google Drive: the person's own Google account, which this server's AI can search and read
//    (components/integrations/DriveConnector.tsx). ?drive=1 (the old /settings/drive, a notice) opens its dialog.
//  - AI apps such as Claude: the other direction, an outside AI app using team files with the person's own permissions
//    through this server's MCP connector (server/src/connectors/remote-mcp): the connector address, one row per app
//    (Claude, Claude Code, other MCP apps) whose Connect opens numbered steps (components/integrations/AiAppConnect.tsx),
//    then each connected app with when it connected and Disconnect. Off on this server: members get one line, owners and
//    admins the setup to turn it on.
// Whether either is set up on this server is the operator's choice (Admin › App connectors shows it).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Copy, Plug } from 'lucide-react'
import { REMOTE_MCP, type RemoteConnectionInfo } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { accessChanged, reloadAsked } from '../store/live'
import { Badge, Button, ErrorNote, IconButton, Skeleton } from '../components/ui'
import { DriveDialog, DriveItem, DriveRow, driveLinked } from '../components/integrations/DriveConnector'
import { AiAppDialog, AiAppRows, ConnectorOff } from '../components/integrations/AiAppConnect'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { useMeStrict } from '../store/session'
import type { AiApp } from '../lib/connectors'

export default function ConnectorConnections() {
  const t = useT(), locale = useLocale()
  const me = useMeStrict()
  const [items, setItems] = useState<RemoteConnectionInfo[] | null>(null), [configured, setConfigured] = useState(false), [resource, setResource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null)
  const life = useRef(0), sequence = useRef(0), writing = useRef(false)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])
  const load = useCallback(async () => {
    const generation = life.current, seq = ++sequence.current
    try {
      const response = await api.call(REMOTE_MCP.listRemoteConnectors)
      if (generation !== life.current || seq !== sequence.current) return
      setItems(response.items); setConfigured(response.configured); setResource(response.resource); setError(null)
    } catch (e) { if (generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const reload = reloadAsked.on(() => void load()), access = accessChanged.on(() => { setItems(null); void load() })
    return () => { reload(); access() }
  }, [load])
  const disconnect = async (id: string) => {
    if (writing.current) return
    writing.current = true; setBusy(id); sequence.current++
    const generation = life.current
    try { await api.call(REMOTE_MCP.revokeRemoteConnector, { params: { id } }); if (generation === life.current) await load() }
    catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
    finally { writing.current = false; if (generation === life.current) setBusy(null) }
  }
  const label = (scope: string) => scope === 'mcp:write' ? t('connectors.write') : scope === 'offline_access' ? t('connectors.offline') : t('connectors.read')
  const on = configured && !!resource
  const isAdmin = me.user.role === 'owner' || me.user.role === 'admin'
  const [openApp, setOpenApp] = useState<AiApp | null>(null)

  // Google Drive: a connect finished in its dialog closes it (the row then shows the account)
  const [driveOpen, setDriveOpen] = useState(false)
  const driveOpenRef = useRef(false)
  driveOpenRef.current = driveOpen
  const drive = useDriveConnection(() => { if (driveOpenRef.current) setDriveOpen(false) })
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('drive') !== '1') return
    setDriveOpen(true)
    setParams((p) => { p.delete('drive'); return p }, { replace: true })
  }, [params, setParams])

  return <section className="space-y-4" data-testid="connector-connections">
    <div><h2 className="text-base font-semibold">{t('connectors.title')}</h2><p className="mt-1 text-sm text-muted">{t('connectors.description')}</p></div>
    {drive.revokeWarning && !driveOpen && <p role="status" className="text-sm text-muted" data-testid="drive-revoke-warning">{t('drive.revokeWarning')}</p>}
    <ul className="-mx-2 divide-y divide-line" data-testid="app-connectors">
      {driveLinked(drive.connection) ? <DriveRow s={drive} inDialog={driveOpen} /> : <DriveItem s={drive} onOpen={() => setDriveOpen(true)} />}
      <li className="py-1" data-testid="ai-apps" data-on={items ? String(on) : undefined}>
        <div className="flex items-center gap-3 p-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted"><Plug size={16} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{t('appConnectors.appsName')}</span>
            <span className="mt-0.5 block text-xs text-muted">{t('aiApps.lead')}</span>
          </span>
          {items && items.length > 0 && <Badge className="shrink-0">{items.length}</Badge>}
        </div>
        <div className="space-y-3 pr-2 pb-2 pl-2 sm:pl-14">
          {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
          {!items && !error && <Skeleton lines={2} />}
          {items && !on && <ConnectorOff admin={isAdmin} />}
          {items && on && resource && <ConnectorAddress resource={resource} />}
          {items && <ul className="-mx-2 divide-y divide-line" data-testid="ai-app-list"><AiAppRows on={on} onConnect={setOpenApp} /></ul>}
          {items && items.length > 0 && (
            <div data-testid="connected-apps">
              <p className="mb-1 text-xs font-medium text-muted">{t('aiApps.connectedApps')}</p>
              <ul className="divide-y divide-line rounded-xl border border-line">{items.map(item => <li key={item.id} className="flex items-start gap-3 px-3 py-2.5" data-testid="connector-item">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{item.clientName}</p>
                  <p className="mt-0.5 text-xs text-muted">{t('aiApps.connectedOn', { date: formatDateTime(item.createdAt, locale) })} · {item.scopes.map(label).join(' · ')}</p>
                  <p className="mt-0.5 text-xs text-faint">{t('connectors.expires', { date: formatDateTime(item.expiresAt, locale) })}{item.currentSession ? ` · ${t('connectors.currentSession')}` : ''}</p>
                </div>
                <Button variant="danger" size="sm" disabled={busy !== null} busy={busy === item.id} onClick={() => void disconnect(item.id)}>{t('connectors.disconnect')}</Button>
              </li>)}</ul>
            </div>
          )}
          {items && on && items.length === 0 && <p className="text-xs text-muted" data-testid="connectors-empty">{t('connectors.empty')}</p>}
          {items && on && <p className="text-xs text-faint">{t('connectors.sessionBound')}</p>}
        </div>
      </li>
    </ul>
    {driveOpen && <DriveDialog s={drive} onClose={() => setDriveOpen(false)} />}
    {openApp && resource && items && <AiAppDialog app={openApp} resource={resource} known={items.map((x) => x.id)} onClose={() => setOpenApp(null)} onConnected={() => void load()} />}
  </section>
}

/** The address to add in the AI app, with Copy. */
export function ConnectorAddress({ resource }: { resource: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(resource); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* the address stays selectable */ }
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2" data-testid="connector-address">
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{t('connectors.address')}</span>
        <code className="block text-sm break-all">{resource}</code>
      </span>
      <IconButton label={copied ? t('common.copied') : t('common.copy')} className="shrink-0" onClick={() => void copy()} data-testid="connector-address-copy">
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      </IconButton>
    </div>
  )
}
