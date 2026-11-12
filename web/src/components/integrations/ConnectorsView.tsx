// What Admin › Connectors and Connectors (the main sidebar's, pages/Connectors.tsx) share, like Claude's Connectors: the
// title row of Admin's page (the title, the search and Add with its ⌄ menu), which stays at the top while the page
// scrolls; one line of the connected ones (ConnectorRow); one row of Discover (DiscoverCard); and a listed service's
// or a connection's page (ConnectorDetail: a big logo, the main action, what it does and its tools).
import { ArrowLeft, BadgeCheck, Check, ExternalLink, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Integration } from '@mycel/shared/api'
import { connectorLogo, type Connector, type ConnectorDocs } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, IconButton, StickyHeader, inputCls } from '../ui'
import { Tooltip } from '../Tooltip'
import { SplitAction, type AddMenuItem } from '../PageActions'

// the split button (Add ⌄, a connector's Connect ⌄) is every page's now (components/PageActions.tsx)
export { SplitAction, type AddMenuItem } from '../PageActions'

/** `onAdd`: this person may add a connection by its address (owners and admins; without it no Add button, and a
 * member adds from Discover). `moreAdd`: other ways to add (Admin: ask a member to connect), in a small menu next to
 * Add connection. */
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
 * Each page makes its own: a dialog (Settings) opens over the page it came from, which stays mounted under it (App.tsx), so
 * two such pages can be mounted at once. */
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

/** How many Discover rows show before "Show all": the five built-in ones and five well-known services. */
export const DISCOVER_FIRST = 10

/** One card of Discover (Connectors' and Admin › Connectors'): what it is, its state, what opens it and what its +
 * does. `off`: it cannot be connected now (the team has not set it up); `setUp`/`asked` say why on its right. */
export interface DiscoverItem { id: string; name: string; line: string; logo: string; state: 'added' | 'reconnect' | 'available' | 'off'; setUp?: boolean; asked?: boolean; onOpen: () => void; onAdd: () => void }

/** One Discover row: logo, name, one line, and one + on the right (for one the team has not set up yet: an owner or
 * admin "Set up", a member "Not set up yet" or "Asked"). The row opens its page. */
export function DiscoverCard({ c, admin }: { c: DiscoverItem; admin: boolean }) {
  const t = useT()
  return (
    <li className="flex items-center gap-3 border-b border-line py-3" data-testid="connector-card" data-id={c.id} data-state={c.state}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left -outline-offset-2 max-md:min-h-11" onClick={c.onOpen} data-testid="connector-open">
        <LogoTile src={c.logo} className="size-10 rounded-xl p-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{c.name}</span>
          <span className="mt-0.5 line-clamp-1 text-xs text-muted">{c.line}</span>
        </span>
      </button>
      {c.state === 'off' && !admin ? (
        <span className="max-w-28 shrink-0 text-right text-xs text-faint" data-testid="connector-off">{t(c.asked ? 'serviceRequest.asked' : 'gapps.off.notSetUp')}</span>
      ) : c.state === 'off' ? (
        <Link to="/admin/connectors" className="touch-hit shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" data-testid="connector-set-up">{t('connectors.setUp')}</Link>
      ) : (
        <IconButton label={t('integrations.discover.add', { name: c.name })} className="shrink-0 rounded-full border border-line" onClick={c.onAdd} data-testid="connector-add">
          <Plus size={16} aria-hidden />
        </IconButton>
      )}
    </li>
  )
}

/** A connector's page inside the same window, like Claude's: back to the list, a big logo, the name and one line with the
 * main action on the right, a short description, and the tools the AI gets from it. */
export function ConnectorDetail({ logo, name, line, official, action, description, address, docs, tools, toolsNote, noTools, onBack, children, testId }: {
  logo: string
  name: string
  line: string
  official?: boolean
  action?: ReactNode
  description: string
  /** before it is connected: the address it signs in at (QA TC-132) */
  address?: string
  /** before it is connected: the service's own links and, where it lists them, its tools (lib/connectors.ts) */
  docs?: ConnectorDocs
  /** the tool names (once connected, the service's own list) */
  tools?: string[]
  /** instead of tools: why there are none to show yet */
  toolsNote?: string
  /** no tools section: the connection's own row (children) lists them with their switches */
  noTools?: boolean
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
        {/* a phone: the bar's ‹ above is the way back (the page has its own address), so not a second one here */}
        <button ref={back} type="button" className="mb-4 flex items-center gap-1.5 text-sm text-muted hover:text-ink max-md:hidden" onClick={onBack} data-testid="connector-back">
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
      {!noTools && <div>
        <h4 className="mb-3 text-base font-semibold">{t('connectors.tools')}</h4>
        {tools?.length ? (
          <ul className="flex flex-wrap gap-2" data-testid="connector-tools">
            {tools.map((x) => <li key={x} className={`rounded-full border border-line px-3 py-1 text-xs${/^[\w.-]+$/.test(x) ? ' font-mono' : ''}`}>{x}</li>)}
          </ul>
        ) : docs?.tools?.length ? (
          // before it is connected: the tools the service lists on its own page (the first ones, the rest there)
          <>
            <ul className="flex flex-wrap gap-2" data-testid="connector-tools-listed">
              {docs.tools.slice(0, LISTED_TOOLS).map((x) => <li key={x} className="rounded-full border border-line px-3 py-1 font-mono text-xs">{x}</li>)}
            </ul>
            <p className="mt-2 text-sm text-muted">
              {docs.tools.length > LISTED_TOOLS && <>{t('connectors.toolsMore', { count: docs.tools.length - LISTED_TOOLS })} </>}
              {docs.toolsUrl && <a href={docs.toolsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline max-md:min-h-11" data-testid="connector-tools-link">{t('connectors.toolsAll', { name })} <ExternalLink size={12} aria-hidden /></a>}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted" data-testid="connector-tools-note">{toolsNote ?? t('connectors.toolsAfter')}</p>
        )}
        {address && <p className="mt-2 text-xs break-all text-faint" data-testid="connector-address">{t('connectors.addressLine', { address })}</p>}
        {docs && (
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="connector-links">
            <DocLink href={docs.privacy} name={t('connectors.linkPrivacyName', { name })} testId="connector-privacy-link">{t('connectors.linkPrivacy')}</DocLink>
            <DocLink href={docs.terms} name={t('connectors.linkTermsName', { name })} testId="connector-terms-link">{t('connectors.linkTerms')}</DocLink>
            <DocLink href={docs.docs} name={t('connectors.linkDocsName', { name })} testId="connector-docs-link">{t('connectors.linkDocs')}</DocLink>
          </p>
        )}
      </div>}
    </section>
  )
}

/** How many tools a listed service's page shows before it is connected; the rest are on the service's page. */
const LISTED_TOOLS = 12

/** One of a service's own pages (privacy, terms, help), in a new tab; a phone: a 44 px tap */
function DocLink({ href, name, testId, children }: { href: string; name: string; testId: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} className="inline-flex items-center gap-1 text-accent-text hover:underline max-md:min-h-11" data-testid={testId}>
      {children} <ExternalLink size={12} aria-hidden />
    </a>
  )
}

/** A service's logo. On white in both themes, like the logo pages of most of them: they are drawn for a light background. */
export function ConnectorLogo({ c, className }: { c: Connector; className?: string }) {
  return <LogoTile src={connectorLogo(c)} className={className} />
}

/** A connection without a listed logo: its first letter. */
export function InitialTile({ name, className }: { name: string; className?: string }) {
  return <span className={`flex shrink-0 items-center justify-center rounded-xl border border-line bg-subtle text-base font-semibold text-muted ${className ?? 'size-10'}`} aria-hidden>{name.trim().charAt(0).toUpperCase() || '?'}</span>
}

/** What one row of "Your connectors" says on its right: one status or one button, nothing else. */
export type RowStatus = 'connected' | 'on' | 'signin' | 'reconnect' | 'attention' | 'connect'

/** One row of Connectors' "Your connectors", like Claude's list: logo, name (a small "Team" label for what the team
 * provides) and one status on the right. The row opens the connector's page, where everything else is (switches,
 * errors, "Run without asking", disconnect). `onConnect`: the Connect button (a team template not connected yet). */
export function ConnectorRow({ id, logo, name, team, note, status, onOpen, onConnect, testId = 'connected-app' }: {
  id: string
  logo?: string
  name: string
  team?: boolean
  /** after the name: what needs attention (Admin: nobody may use it) */
  note?: ReactNode
  status: RowStatus
  onOpen: () => void
  onConnect?: () => void
  testId?: string
}) {
  const t = useT()
  return (
    // a phone: the row's open button and its status link are 44 px tall, the row as tall as before
    <li className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0 max-md:py-2" data-testid={testId} data-id={id} data-state={status}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left -outline-offset-2 max-md:min-h-11" onClick={onOpen} data-testid="connector-row-open">
        {logo ? <LogoTile src={logo} className="size-10 rounded-xl p-2" /> : <InitialTile name={name} />}
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        {team && <span className="shrink-0 rounded-full border border-line px-1.5 text-micro text-muted" data-testid="connector-row-team">{t('connectors.team')}</span>}
      </button>
      {note}
      {status === 'connected' || status === 'on' ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted" data-testid="connector-row-status">
          <Check size={14} className="text-ok" aria-hidden /> {t(status === 'on' ? 'appConnectors.on' : 'drive.status.connected')}
        </span>
      ) : status === 'signin' ? (
        <button type="button" className="touch-hit shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-warn hover:bg-hover max-md:min-h-11" onClick={onOpen} aria-label={`${t('integrations.status.needs_auth')}: ${name}`} data-testid="connector-row-status">{t('integrations.status.needs_auth')}</button>
      ) : status === 'reconnect' ? (
        <button type="button" className="touch-hit shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-warn hover:bg-hover max-md:min-h-11" onClick={onOpen} aria-label={`${t('drive.reconnect')}: ${name}`} data-testid="connector-row-status">{t('drive.reconnect')}</button>
      ) : status === 'attention' ? (
        <button type="button" className="touch-hit shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-warn hover:bg-hover max-md:min-h-11" onClick={onOpen} aria-label={`${t('connectors.state.attention')}: ${name}`} data-testid="connector-row-status">{t('connectors.state.attention')}</button>
      ) : (
        <Button size="sm" variant="primary" className="shrink-0" onClick={onConnect ?? onOpen} aria-label={`${t('aiApps.connect')}: ${name}`} data-testid="template-connect">{t('aiApps.connect')}</Button>
      )}
    </li>
  )
}

export function LogoTile({ src, className }: { src: string; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-white p-1.5 ${className ?? ''}`}>
      <img src={src} alt="" className="size-full object-contain" data-testid="connector-logo" />
    </span>
  )
}
