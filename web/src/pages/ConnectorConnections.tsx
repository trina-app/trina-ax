import { useCallback, useEffect, useRef, useState } from 'react'
import { Plug } from 'lucide-react'
import { REMOTE_MCP, type RemoteConnectionInfo } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { accessChanged, reloadAsked } from '../store/live'
import { Button, EmptyState, ErrorNote, Skeleton } from '../components/ui'
import { SlackAccount } from '../components/settings/SlackAccount'

export default function ConnectorConnections() {
  const t = useT(), locale = useLocale()
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
  return <section className="space-y-5" data-testid="connector-connections">
    <div><h2 className="text-base font-semibold">{t('connectors.title')}</h2><p className="mt-1 text-sm text-muted">{t('connectors.description')}</p></div>
    {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
    {!items && !error && <Skeleton lines={3} />}
    {items && <>
      {!configured && items.length > 0 && <p className="text-sm text-muted">{t('connectors.disabled')}</p>}
      {resource && <div className="rounded-xl border border-line p-4"><p className="mb-1 text-sm font-medium">{t('connectors.address')}</p><code className="break-all text-sm">{resource}</code></div>}
      {/* no connected app: the same dashed empty card as the MCP tab; when the server has no connectors, it says why */}
      {items.length === 0 && <div className="rounded-xl border border-dashed border-line" data-testid="connectors-empty">
        <EmptyState icon={<Plug size={26} aria-hidden />} title={t('connectors.empty')}>
          <p>{t(configured ? 'connectors.emptyHint' : 'connectors.disabled')}</p>
        </EmptyState>
      </div>}
      {items.length > 0 && <ul className="divide-y divide-line">{items.map(item => <li key={item.id} className="flex items-start gap-3 py-4" data-testid="connector-item">
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.clientName}</p><p className="mt-1 text-xs text-muted">{item.scopes.map(label).join(' · ')}</p><p className="mt-1 text-xs text-faint">{t('connectors.expires', { date: formatDateTime(item.expiresAt, locale) })}</p>{item.currentSession && <p className="mt-1 text-xs text-faint">{t('connectors.currentSession')}</p>}</div>
        <Button variant="danger" size="sm" disabled={busy !== null} busy={busy === item.id} onClick={() => void disconnect(item.id)}>{t('connectors.disconnect')}</Button>
      </li>)}</ul>}
      {configured && <p className="text-xs text-muted">{t('connectors.sessionBound')}</p>}
    </>}
    <SlackAccount />
  </section>
}
