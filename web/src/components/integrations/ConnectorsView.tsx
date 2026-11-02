// What Admin > External services and Settings > External services share: the title row (Connected / Discover, search,
// add by address) and the Discover list of services to add by name (lib/connectors.ts).
import { Check, Plus, Search } from 'lucide-react'
import { useId } from 'react'
import type { Integration } from '@mycel/shared/api'
import { connectorLogo, CONNECTORS, isConnected, type Connector } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, Tabs, inputCls } from '../ui'

export type ConnectorTab = 'connected' | 'discover'

/** `onAdd`: this person may add connections (without it, no adding and no Discover). */
export function ConnectorsHeader({ title, tab, onTab, query, onQuery, onAdd }: {
  title: string
  tab: ConnectorTab
  onTab: (t: ConnectorTab) => void
  query: string
  onQuery: (q: string) => void
  onAdd?: () => void
}) {
  const t = useT()
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {onAdd && (
        <div className="contents" data-connector-tabs>
          <Tabs
            segmented
            value={tab}
            onChange={onTab}
            label={title}
            items={[{ id: 'connected', label: t('integrations.tabConnected') }, { id: 'discover', label: t('integrations.tabDiscover') }]}
          />
        </div>
      )}
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('integrations.search')} aria-label={t('integrations.search')} className={`${inputCls} pl-9`} data-testid="connector-search" />
        </div>
        {onAdd && (
          <Button variant="primary" className="shrink-0" onClick={onAdd} data-testid="integration-add">
            <Plus size={15} aria-hidden /> {t('integrations.add')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Back on Connected after adding from Discover: the search is cleared (it was looking for what the new row may not
 * match) and the keyboard stays on the tabs, because the button that opened the dialog is gone. */
export function afterAdded(setTab: (t: ConnectorTab) => void, setQuery: (q: string) => void) {
  setTab('connected')
  setQuery('')
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-connector-tabs] [role="tab"][aria-selected="true"]')?.focus())
}

/** A connection fits the search box: its name or address. */
export const matchesQuery = (i: Integration, query: string) => {
  const q = query.trim().toLowerCase()
  return !q || `${i.name} ${i.url}`.toLowerCase().includes(q)
}

export function ConnectorDiscover({ connected, query, onAdd, onCustom }: {
  connected: Integration[]
  query: string
  onAdd: (c: Connector) => void
  /** add one that is not listed, by its address */
  onCustom: () => void
}) {
  const t = useT()
  const titleId = useId()
  const urls = connected.map((i) => i.url)
  const q = query.trim().toLowerCase()
  const shown = CONNECTORS.filter((c) => !q || `${c.name} ${t(`integrations.catalog.${c.id}`)}`.toLowerCase().includes(q))
  return (
    <section aria-labelledby={titleId} data-testid="connector-discover">
      <h3 id={titleId} className="mb-3 flex items-center gap-2 text-sm font-medium">
        {t('integrations.discover.title')}
        <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums" data-testid="connector-count">{shown.length}</span>
      </h3>
      {shown.length ? (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="connector-list">
          {shown.map((c) => <ConnectorCard key={c.id} c={c} added={isConnected(c, urls)} onAdd={() => onAdd(c)} />)}
        </ul>
      ) : (
        <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
      )}
      <p className="mt-5 text-sm text-muted">
        {t('integrations.discover.customHint')}{' '}
        <button type="button" className="font-medium text-accent-text underline underline-offset-2" onClick={onCustom} data-testid="connector-custom">
          {t('integrations.discover.custom')}
        </button>
      </p>
    </section>
  )
}

/** A service's logo. On white in both themes, like the logo pages of most of them: they are drawn for a light background. */
export function ConnectorLogo({ c, className }: { c: Connector; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-white p-1.5 ${className ?? ''}`}>
      <img src={connectorLogo(c)} alt="" className="size-full object-contain" data-testid="connector-logo" />
    </span>
  )
}

function ConnectorCard({ c, added, onAdd }: { c: Connector; added: boolean; onAdd: () => void }) {
  const t = useT()
  return (
    <li className="flex items-start gap-3 rounded-xl bg-subtle p-3" data-testid="connector-card" data-id={c.id}>
      <ConnectorLogo c={c} className="size-10" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{c.name}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{t(`integrations.catalog.${c.id}`)}</span>
      </span>
      {added ? (
        <span className="flex size-8 shrink-0 items-center justify-center text-ok" role="img" aria-label={t('integrations.discover.added', { name: c.name })} data-testid="connector-added">
          <Check size={16} aria-hidden />
        </span>
      ) : (
        <IconButton label={t('integrations.discover.add', { name: c.name })} className="shrink-0" onClick={onAdd} data-testid="connector-add">
          <Plus size={16} aria-hidden />
        </IconButton>
      )}
    </li>
  )
}
