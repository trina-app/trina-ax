// What Admin › Connectors and Settings › Connectors share, like Claude's Connectors: the title row (the page's title,
// the search and Add with its ⌄ menu), which stays at the top while the page scrolls; Discover, the section under the
// connections on the same page ("Top connectors" with Trina's own Google Drive first, then the MCP services of
// lib/connectors.ts, the rest behind Show all); and a connector's page (ConnectorDetail: a big logo, the main action,
// what it does and its tools), which takes the place of both sections until its way back.
import { ArrowLeft, ArrowRight, BadgeCheck, Check, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Integration } from '@mycel/shared/api'
import { connectorLogo, CONNECTORS, isConnected, type Connector } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, IconButton, StickyHeader, inputCls } from '../ui'
import { Tooltip } from '../Tooltip'
import { SplitAction, type AddMenuItem } from '../PageActions'

// the split button (Add ⌄, a connector's Connect ⌄) is every page's now (components/PageActions.tsx)
export { SplitAction, type AddMenuItem } from '../PageActions'

/** `onAdd`: this person may add connections (without it, no adding and no Discover). `moreAdd`: other ways to add
 * (Admin: ask a member to connect), in a small menu next to Add connection. */
export function ConnectorsHeader({ title, query, onQuery, onAdd, moreAdd }: {
  title: string
  query: string
  onQuery: (q: string) => void
  onAdd?: () => void
  moreAdd?: AddMenuItem[]
}) {
  const t = useT()
  return (
    <StickyHeader className="-mt-3 mb-2 flex flex-wrap items-center gap-x-4 gap-y-3 py-3" testId="connectors-header">
      {/* a phone: the bar above says the name (Admin's and Settings' phone bar), so only the search row stays here */}
      <h2 className="text-lg font-semibold tracking-tight max-md:sr-only">{title}</h2>
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('integrations.search')} aria-label={t('integrations.search')} className={`${inputCls} pl-9`} data-testid="connector-search" />
        </div>
        {onAdd && (moreAdd?.length ? (
          <SplitAction label={t('integrations.add')} icon={<Plus size={15} aria-hidden />} onPrimary={onAdd} items={moreAdd} testId="integration-add" menuLabel={t('integrations.addMore')} />
        ) : (
          <Button variant="primary" className="shrink-0" onClick={onAdd} data-testid="integration-add">
            <Plus size={15} aria-hidden /> {t('integrations.add')}
          </Button>
        ))}
      </div>
    </StickyHeader>
  )
}

/** The ids of the headings of a page's two sections (the connections, Discover), for goToSection and aria-labelledby.
 * Each page makes its own: Settings opens over the page it came from, which stays mounted under it (App.tsx), so
 * Settings › Connectors can be on screen over Admin › Connectors. */
export function useSectionIds() {
  return { connected: useId(), discover: useId() }
}

/** A section heading of the page, which takes the keyboard when something leads there (tabIndex -1, no ring: it is not
 * a control). */
export const sectionTitleCls = 'text-sm font-semibold focus:outline-none'

/** Show a section of the page and give its heading the keyboard: back from a connector's page (Discover), and after
 * adding from Discover (the connections, where the new one is). From the next paint on, for a few frames, for a section
 * that only shows once the page has drawn its new state. The scrolling area keeps the title row's height free at its
 * top (useStickyHeader), so the heading lands under it. */
export function goToSection(id: string, frames = 10) {
  requestAnimationFrame(() => {
    const h = document.getElementById(id)
    if (!h) { if (frames > 1) goToSection(id, frames - 1); return }
    h.scrollIntoView({ block: 'start' })
    h.focus({ preventScroll: true })
  })
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

/** The Discover cards that fit the search (every card without one): Trina's own, then the listed MCP services. A page
 * hides Discover when nothing fits, and says "nothing matches" once when nothing on the page does. */
export function discoverHits(t: ReturnType<typeof useT>, query: string, builtIns: BuiltInCard[] = []) {
  const q = query.trim().toLowerCase()
  const fits = (text: string) => !q || text.toLowerCase().includes(q)
  const built = builtIns.filter((b) => fits(`${b.name} ${b.line}`))
  const listed = CONNECTORS.filter((c) => fits(`${c.name} ${t(`integrations.catalog.${c.id}`)}`))
  return { built, listed, count: built.length + listed.length }
}

/** Discover, the section under the connections, like Claude's Connectors: "Top connectors" (Trina's own first, then the
 * best-known MCP services) and the rest under "More connectors" behind Show all. A card opens its page (onOpen); its +
 * adds it at once (onAdd / onAddBuiltIn). With a search that nothing here fits, the section is not shown. A phone (below
 * 768 px): one row per service with hairlines between, no framed tiles (docs/DECISIONS.md "Admin and Settings on
 * phones"). */
export function ConnectorDiscover({ titleId, connected, query, onAdd, onCustom, builtIns = [], onAddBuiltIn, onOpen, onOpenBuiltIn, className }: {
  /** its heading's id (useSectionIds) */
  titleId: string
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
  className?: string
}) {
  const t = useT()
  const moreId = useId()
  const [all, setAll] = useState(false)
  const urls = connected.map((i) => i.url)
  const q = query.trim()
  const hits = discoverHits(t, query, builtIns)
  if (!hits.count) return null
  const cards = [
    ...hits.built.map((b) => (
      <DiscoverCard key={b.id} id={b.id} logo={b.logo} name={b.name} line={b.line} by={t('connectors.builtIn')} official state={b.state}
        onOpen={onOpenBuiltIn ? () => onOpenBuiltIn(b.id) : undefined} onAdd={() => onAddBuiltIn?.(b.id)} />
    )),
    ...hits.listed.map((c) => (
      <DiscoverCard key={c.id} id={c.id} logo={connectorLogo(c)} name={c.name} line={t(`integrations.catalog.${c.id}`)} by={t('connectors.by', { maker: c.name })} official
        state={isConnected(c, urls) ? 'added' : 'available'} onOpen={onOpen ? () => onOpen(c) : undefined} onAdd={() => onAdd(c)} />
    )),
  ]
  // a search shows every match in one list; otherwise the best-known first, the rest behind Show all
  const top = q ? cards : cards.slice(0, TOP_CONNECTORS)
  const more = q ? [] : cards.slice(TOP_CONNECTORS)
  return (
    <section aria-labelledby={titleId} className={className} data-testid="connector-discover">
      <h3 id={titleId} tabIndex={-1} className={`mb-3 ${sectionTitleCls}`} data-testid="connector-discover-title">{t('connectors.discover')}</h3>
      <div className="mb-3 flex items-center gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium text-muted">
          {q ? t('connectors.results') : t('connectors.top')}
          <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums" data-testid="connector-count">{hits.count}</span>
        </h4>
        {more.length > 0 && (
          <button type="button" className="ml-auto flex items-center gap-1 text-sm text-muted hover:text-ink" aria-expanded={all} aria-controls={moreId} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
            {all ? t('connectors.showLess') : t('connectors.showAll')} <ArrowRight size={14} aria-hidden className={all ? '-rotate-90' : ''} />
          </button>
        )}
      </div>
      <ul className={listCls} data-testid="connector-list">{top}</ul>
      {more.length > 0 && (
        <div id={moreId} hidden={!all} className="mt-6">
          <h4 className="mb-3 text-sm font-medium text-muted">{t('connectors.more')}</h4>
          <ul className={listCls} data-testid="connector-list-more">{more}</ul>
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

/** The cards' list: two columns of tiles; a phone, one row each with a hairline between. */
const listCls = 'grid gap-3 md:grid-cols-2 max-md:gap-0 max-md:divide-y max-md:divide-line max-md:border-y max-md:border-line'

/** One Discover card: logo, name (a check for an official listing), one line, "by <maker>", and + or ✓ on the right.
 * The card opens the service's page; the + adds it without opening it. A phone: a row, the line cut to one, no "by"
 * (the service's page says it), and a + of 44 px. */
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
      <LogoTile src={logo} className="size-11 max-md:size-9" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          <span className="truncate">{name}</span>
          {official && <Tooltip label={t('connectors.officialTip')} description><BadgeCheck size={14} className="shrink-0 text-muted" role="img" aria-label={t('connectors.official')} /></Tooltip>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted max-md:line-clamp-1">{line}</span>
        <span className="mt-1 block text-xs text-faint max-md:hidden">{by}</span>
      </span>
    </>
  )
  return (
    <li className="relative flex items-start gap-3 rounded-xl bg-subtle p-3 transition hover:bg-hover max-md:items-center max-md:rounded-none max-md:bg-transparent max-md:px-0 max-md:py-1.5 max-md:hover:bg-transparent" data-testid="connector-card" data-id={id}>
      {onOpen ? (
        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left -outline-offset-2 max-md:items-center" onClick={onOpen} data-testid="connector-open">
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-3">{body}</span>
      )}
      {state === 'added' ? (
        <Tooltip label={t('integrations.discover.added', { name })}>
          <span className="flex size-8 shrink-0 items-center justify-center text-ok max-md:size-11" role="img" aria-label={t('integrations.discover.added', { name })} data-testid="connector-added">
            <Check size={16} aria-hidden />
          </span>
        </Tooltip>
      ) : state === 'off' ? (
        <span className="shrink-0 pt-1.5 text-xs text-faint max-md:pt-0" data-testid="connector-off">{t('connectors.notOn')}</span>
      ) : (
        <IconButton label={t('integrations.discover.add', { name })} className="shrink-0 max-md:size-11" onClick={onAdd} data-testid="connector-add">
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
