// Settings › AI apps: the other direction from App connectors. Outside AI apps (Claude, Claude Code, other MCP apps) use
// team files with the person's own permissions through this server's MCP connector (server/src/connectors/remote-mcp):
// one row per app whose Connect opens numbered steps with the real address (components/integrations/AiAppConnect.tsx),
// then each connected app with when it connected and Disconnect. Off on this server: members get one line, owners and
// admins the setup to turn it on. It was part of Settings › App connectors (pages/ConnectorConnections.tsx).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { REMOTE_MCP, type RemoteConnectionInfo } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { accessChanged, reloadAsked } from '../store/live'
import { Button, ErrorNote, IconButton, Skeleton } from '../components/ui'
import { AiAppDialog, AiAppRows, ConnectorOff } from '../components/integrations/AiAppConnect'
import { useMeStrict } from '../store/session'
import type { AiApp } from '../lib/connectors'

export default function AiApps() {
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
  const label = (scope: string) => scope === 'mcp:write' ? t('connectors.write') : scope === 'offline_access' ? t('connectors.offline') : scope === 'mcp:admin' ? t('connectors.admin') : t('connectors.read')
  const on = configured && !!resource
  const isAdmin = me.user.role === 'owner' || me.user.role === 'admin'
  const [openApp, setOpenApp] = useState<AiApp | null>(null)

  return (
    <section className="space-y-4" data-testid="ai-apps" data-on={items ? String(on) : undefined}>
      <div><h2 className="text-base font-semibold">{t('aiApps.title')}</h2><p className="mt-1 text-sm text-muted">{t('aiApps.lead')}</p></div>
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
              {/* an owner's or admin's connection made before group management came, or while they were a member: it
                  never gains it (a refresh only narrows), so a new connection gets it */}
              {isAdmin && !item.scopes.includes('mcp:admin') && <p className="mt-0.5 text-xs text-muted" data-testid="connector-reconnect-groups">{t('aiApps.reconnectForGroups')}</p>}
            </div>
            <Button variant="danger" size="sm" disabled={busy !== null} busy={busy === item.id} onClick={() => void disconnect(item.id)}>{t('connectors.disconnect')}</Button>
          </li>)}</ul>
        </div>
      )}
      {items && on && items.length === 0 && <p className="text-xs text-muted" data-testid="connectors-empty">{t('connectors.empty')}</p>}
      {items && on && <p className="text-xs text-faint">{t('connectors.sessionBound')}</p>}
      {openApp && resource && items && <AiAppDialog app={openApp} resource={resource} known={items.map((x) => x.id)} onClose={() => setOpenApp(null)} onConnected={() => void load()} />}
    </section>
  )
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
