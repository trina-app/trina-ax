// What Admin › Connectors and Settings › Connectors share, like Claude's Connectors: the title row (Yours / Discover,
// search, Add with its ⌄ menu), which stays at the top while the page scrolls; Discover ("Top connectors" with Trina's
// own Google Drive first, then the MCP services of lib/connectors.ts, the rest behind Show all); and a connector's page
// (ConnectorDetail: a big logo, the main action, what it does and its tools).
import { ArrowLeft, ArrowRight, BadgeCheck, Check, ChevronDown, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Integration } from '@mycel/shared/api'
import { connectorLogo, CONNECTORS, isConnected, type Connector } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, StickyHeader, Tabs, inputCls } from '../ui'
import { Tooltip } from '../Tooltip'

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
export function ConnectorsHeader({ title, scope, tab, onTab, query, onQuery, onAdd, moreAdd, panels }: {
  title: string
  /** next to the title: Admin's "For the whole team" */
  scope?: ReactNode
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
      {scope}
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

/** A primary button with a ⌄ menu of other ways to do it (a connector's page: Connect, or as a template). */
export function SplitAction({ label, onPrimary, items, testId }: { label: string; onPrimary: () => void; items: AddMenuItem[]; testId: string }) {
  return (
    <div className="flex shrink-0 items-stretch" data-testid={`${testId}-group`}>
      <Button variant="primary" className="rounded-r-none" onClick={onPrimary} data-testid={testId}>{label}</Button>
      <AddMenu items={items} label="connectors.connectMore" />
    </div>
  )
}

/** The ⌄ half of the split Add button: a small menu of the other ways to add. A dialog opened from it gets the focus
 * back on this button when it closes (the item is gone with the menu). */
function AddMenu({ items, label = 'integrations.addMore' }: { items: AddMenuItem[]; label?: 'integrations.addMore' | 'connectors.connectMore' }) {
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
      <Tooltip label={t(label)}>
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t(label)}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 items-center rounded-r-lg border-l border-accent-ink/20 bg-accent px-2 text-accent-ink transition hover:bg-accent-hover max-sm:min-h-10"
          data-testid="integration-add-more"
        >
          <ChevronDown size={15} aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label={t(label)} className="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
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

/** Trina's own connectors (Google Drive), listed first in Discover: they connect with a sign-in built into this server,
 * not an MCP server someone adds. `state`: added (✓), available (+) or off (the server is not set up for it). */
export interface BuiltInCard { id: string; name: string; line: string; logo: string; state: 'added' | 'available' | 'off' }

/** How many cards "Top connectors" shows before "More connectors". */
export const TOP_CONNECTORS = 8

/** Discover, like Claude's Connectors: "Top connectors" (Trina's own first, then the best-known MCP services) and the rest
 * under "More connectors" behind Show all. A card opens its page (onOpen); its + adds it at once (onAdd / onAddBuiltIn). */
export function ConnectorDiscover({ connected, query, onAdd, onCustom, builtIns = [], onAddBuiltIn, onOpen, onOpenBuiltIn }: {
  connected: Pick<Integration, 'url'>[]
  query: string
  onAdd: (c: Connector) => void
  /** add one that is not listed, by its address */
  onCustom: () => void
  builtIns?: BuiltInCard[]
  onAddBuiltIn?: (id: string) => void
  /** open a service's page */
  onOpen?: (c: Connector) => void
  onOpenBuiltIn?: (id: string) => void
}) {
  const t = useT()
  const titleId = useId()
  const moreId = useId()
  const [all, setAll] = useState(false)
  const urls = connected.map((i) => i.url)
  const q = query.trim().toLowerCase()
  const fits = (text: string) => !q || text.toLowerCase().includes(q)
  const shownBuilt = builtIns.filter((b) => fits(`${b.name} ${b.line}`))
  const shown = CONNECTORS.filter((c) => fits(`${c.name} ${t(`integrations.catalog.${c.id}`)}`))
  const cards = [
    ...shownBuilt.map((b) => (
      <DiscoverCard key={b.id} id={b.id} logo={b.logo} name={b.name} line={b.line} by={t('connectors.builtIn')} official state={b.state}
        onOpen={onOpenBuiltIn ? () => onOpenBuiltIn(b.id) : undefined} onAdd={() => onAddBuiltIn?.(b.id)} />
    )),
    ...shown.map((c) => (
      <DiscoverCard key={c.id} id={c.id} logo={connectorLogo(c)} name={c.name} line={t(`integrations.catalog.${c.id}`)} by={t('connectors.by', { maker: c.name })} official
        state={isConnected(c, urls) ? 'added' : 'available'} onOpen={onOpen ? () => onOpen(c) : undefined} onAdd={() => onAdd(c)} />
    )),
  ]
  const total = cards.length
  // a search shows every match in one list; otherwise the best-known first, the rest behind Show all
  const top = q ? cards : cards.slice(0, TOP_CONNECTORS)
  const more = q ? [] : cards.slice(TOP_CONNECTORS)
  return (
    <section aria-labelledby={titleId} data-testid="connector-discover">
      <div className="mb-3 flex items-center gap-2">
        <h3 id={titleId} className="flex items-center gap-2 text-sm font-medium">
          {q ? t('connectors.results') : t('connectors.top')}
          <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums" data-testid="connector-count">{total}</span>
        </h3>
        {more.length > 0 && (
          <button type="button" className="ml-auto flex items-center gap-1 text-sm text-muted hover:text-ink" aria-expanded={all} aria-controls={moreId} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
            {all ? t('connectors.showLess') : t('connectors.showAll')} <ArrowRight size={14} aria-hidden className={all ? '-rotate-90' : ''} />
          </button>
        )}
      </div>
      {total ? (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="connector-list">{top}</ul>
      ) : (
        <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
      )}
      {more.length > 0 && (
        <div id={moreId} hidden={!all} className="mt-6">
          <h3 className="mb-3 text-sm font-medium">{t('connectors.more')}</h3>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="connector-list-more">{more}</ul>
        </div>
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

/** One Discover card: logo, name (a check for an official listing), one line, "by <maker>", and + or ✓ on the right.
 * The card opens the service's page; the + adds it without opening it. */
function DiscoverCard({ id, logo, name, line, by, official, state, onOpen, onAdd }: {
  id: string
  logo: string
  name: string
  line: string
  by: string
  official?: boolean
  state: 'added' | 'available' | 'off'
  onOpen?: () => void
  onAdd: () => void
}) {
  const t = useT()
  const body = (
    <>
      <LogoTile src={logo} className="size-11" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          <span className="truncate">{name}</span>
          {official && <Tooltip label={t('connectors.officialTip')} description><BadgeCheck size={14} className="shrink-0 text-muted" role="img" aria-label={t('connectors.official')} /></Tooltip>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted">{line}</span>
        <span className="mt-1 block text-xs text-faint">{by}</span>
      </span>
    </>
  )
  return (
    <li className="relative flex items-start gap-3 rounded-xl bg-subtle p-3 transition hover:bg-hover" data-testid="connector-card" data-id={id}>
      {onOpen ? (
        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left -outline-offset-2" onClick={onOpen} data-testid="connector-open">
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-3">{body}</span>
      )}
      {state === 'added' ? (
        <Tooltip label={t('integrations.discover.added', { name })}>
          <span className="flex size-8 shrink-0 items-center justify-center text-ok" role="img" aria-label={t('integrations.discover.added', { name })} data-testid="connector-added">
            <Check size={16} aria-hidden />
          </span>
        </Tooltip>
      ) : state === 'off' ? (
        <span className="shrink-0 pt-1.5 text-xs text-faint" data-testid="connector-off">{t('connectors.notOn')}</span>
      ) : (
        <IconButton label={t('integrations.discover.add', { name })} className="shrink-0" onClick={onAdd} data-testid="connector-add">
          <Plus size={16} aria-hidden />
        </IconButton>
      )}
    </li>
  )
}

/** A connector's page inside the same window, like Claude's: back to the list, a big logo, the name and one line with the
 * main action on the right, a short description, and the tools the AI gets from it. */
export function ConnectorDetail({ logo, name, line, official, action, description, tools, toolsNote, onBack, children, testId }: {
  logo: string
  name: string
  line: string
  official?: boolean
  action?: ReactNode
  description: string
  /** the tool names (once connected, the service's own list) */
  tools?: string[]
  /** instead of tools: why there are none to show yet */
  toolsNote?: string
  onBack: () => void
  children?: ReactNode
  testId: string
}) {
  const t = useT()
  const titleId = useId()
  const back = useRef<HTMLButtonElement>(null)
  // the card that opened this page is gone: the keyboard starts on the way back
  useEffect(() => { back.current?.focus() }, [])
  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid={testId}>
      <div className="rounded-2xl bg-subtle p-5 sm:p-6">
        <button ref={back} type="button" className="mb-4 flex items-center gap-1.5 text-sm text-muted hover:text-ink" onClick={onBack} data-testid="connector-back">
          <ArrowLeft size={15} aria-hidden /> {t('integrations.title')}
        </button>
        <div className="flex flex-wrap items-center gap-4">
          <LogoTile src={logo} className="size-16 rounded-xl p-2.5" />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="truncate">{name}</span>
              {official && <Tooltip label={t('connectors.officialTip')} description><BadgeCheck size={18} className="shrink-0 text-muted" role="img" aria-label={t('connectors.official')} /></Tooltip>}
            </h3>
            <p className="mt-0.5 text-sm text-muted" data-testid={`${testId}-line`}>{line}</p>
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-ink/90">{description}</p>
      <div>
        <h4 className="mb-3 text-base font-semibold">{t('connectors.tools')}</h4>
        {tools?.length ? (
          <ul className="flex flex-wrap gap-2" data-testid="connector-tools">
            {tools.map((x) => <li key={x} className="rounded-full border border-line px-3 py-1 font-mono text-xs">{x}</li>)}
          </ul>
        ) : (
          <p className="text-sm text-muted" data-testid="connector-tools-note">{toolsNote ?? t('connectors.toolsAfter')}</p>
        )}
      </div>
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
