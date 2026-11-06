// What Admin > MCP and Settings > MCP share: the title row (Connected / Discover, search, add by address), which stays
// at the top while the page scrolls, and the Discover list of services to add by name (lib/connectors.ts).
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Integration } from '@mycel/shared/api'
import { connectorLogo, CONNECTORS, isConnected, type Connector } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, StickyHeader, Tabs, inputCls } from '../ui'

export type ConnectorTab = 'connected' | 'discover'

export interface AddMenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  testId: string
}

/** `onAdd`: this person may add connections (without it, no adding and no Discover, and no tabs). `panels`: the ids
 * that tie the tabs to the TabPanel below them (`useId()`). `moreAdd`: other ways to add (Admin: ask a member to
 * connect), in a small menu next to Add connection. */
export function ConnectorsHeader({ title, tab, onTab, query, onQuery, onAdd, moreAdd, panels }: {
  title: string
  panels: string
  tab: ConnectorTab
  onTab: (t: ConnectorTab) => void
  query: string
  onQuery: (q: string) => void
  onAdd?: () => void
  moreAdd?: AddMenuItem[]
}) {
  const t = useT()
  return (
    <StickyHeader className="-mt-3 mb-2 flex flex-wrap items-center gap-x-4 gap-y-3 py-3" testId="connectors-header">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {onAdd && (
        <div className="contents" data-connector-tabs>
          <Tabs
            segmented
            value={tab}
            onChange={onTab}
            label={title}
            panels={panels}
            items={[{ id: 'connected', label: t('integrations.tabConnected') }, { id: 'discover', label: t('integrations.tabDiscover') }]}
          />
        </div>
      )}
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('integrations.search')} aria-label={t('integrations.search')} className={`${inputCls} pl-9`} data-testid="connector-search" />
        </div>
        {onAdd && (moreAdd?.length ? (
          <div className="flex shrink-0 items-stretch" data-testid="integration-add-group">
            <Button variant="primary" className="rounded-r-none" onClick={onAdd} data-testid="integration-add">
              <Plus size={15} aria-hidden /> {t('integrations.add')}
            </Button>
            <AddMenu items={moreAdd} />
          </div>
        ) : (
          <Button variant="primary" className="shrink-0" onClick={onAdd} data-testid="integration-add">
            <Plus size={15} aria-hidden /> {t('integrations.add')}
          </Button>
        ))}
      </div>
    </StickyHeader>
  )
}

/** The ⌄ half of the split Add button: a small menu of the other ways to add. A dialog opened from it gets the focus
 * back on this button when it closes (the item is gone with the menu). */
function AddMenu({ items }: { items: AddMenuItem[] }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems()
      const at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  return (
    <div ref={box} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('integrations.addMore')}
        title={t('integrations.addMore')}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center rounded-r-lg border-l border-accent-ink/20 bg-accent px-2 text-accent-ink transition hover:bg-accent-hover max-sm:min-h-10"
        data-testid="integration-add-more"
      >
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={t('integrations.addMore')} className="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover"
              onClick={() => {
                setOpen(false)
                // the dialog this opens returns the focus to the button it was opened from
                button.current?.focus()
                it.onSelect()
              }}
              data-testid={it.testId}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
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
  connected: Pick<Integration, 'url'>[]
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
  return <LogoTile src={connectorLogo(c)} className={className} />
}

export function LogoTile({ src, className }: { src: string; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-white p-1.5 ${className ?? ''}`}>
      <img src={src} alt="" className="size-full object-contain" data-testid="connector-logo" />
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
        <span className="mt-0.5 line-clamp-2 text-xs text-muted">{t(`integrations.catalog.${c.id}`)}</span>
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
