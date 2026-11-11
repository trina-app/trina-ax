// Connectors (/connectors, an item of the main sidebar and of the phone's drawer): what the AI may use with the person's
// own accounts, kept simple like Claude's Connectors page. On top the title, one line, a search box and, for owners and
// admins, "Add custom connector" (any MCP server or API by its address). Then what an admin asked the person to connect
// (components/integrations/AnswerDialog.tsx, only while there is something), and two sections:
// - **Your connectors**: one line each (ConnectorsView.tsx ConnectorRow) for every connection the person can use: the
//   built-in ones they connected (Google Drive, Gmail, …), their own MCP connections, and what the team provides
//   (TemplatesView.tsx useFromTeam, with a "Team" label). One status on the right (Connected, Reconnect, Needs
//   attention, or Connect for a team template not connected yet); the row opens the connection's page, which keeps
//   everything else (switches, errors, "Run without asking", tools, disconnect, the privacy note).
// - **Discover**: only what is not connected yet: Trina's built-in cards first, then the listed MCP services
//   (lib/connectors.ts), each with a + that connects at once (a Google card opens Google during the click). One that
//   cannot be connected now comes last: one the team has not set up yet shows an owner or admin "Set up" (Admin) and a
//   member "Not set up yet" (its page has "Ask admin to add it", and the card then says "Asked":
//   components/integrations/AskAdmin.tsx); one turned off for members is left out for them. A member reads "Not listed?
//   Ask an admin to add it." under it (docs/DECISIONS.md "Plain words for members").
// A card opens its page, /connectors/<id>: a built-in's (AppDetail.tsx), a listed service's (ConnectorDetail), or
// /connectors/mcp/<connection id> for one of the person's connections or a team connection they may use.
// /settings/connectors (old links) leads here (SettingsDialog.tsx), keeping ?add=1, ?template=, ?request= and ?drive=1
// (old Drive links: Google Drive's page). The state (the lists, Drive's and the Google apps' sign-ins, the add dialog)
// lives in ConnectorsLayout, so a + can open Google during the click and its page shows the same sign-in.
import clsx from 'clsx'
import { Plus, Search } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { connectorFor, connectorLogo, CONNECTORS, isConnected, type Connector } from '../lib/connectors'
import { builtInLogo, builtInName, BUILT_IN_ORDER, driveCardState, DRIVE_TOOL_LIST, exampleKeys, fits, GOOGLE_PRIVACY, GOOGLE_TERMS, googleAppCardState, isGoogleApp, lineKey, type BuiltInId, type CardState } from '../lib/googleApps'
import { canonicalService, splitByScope } from '../lib/integrations'
import { writeDraft } from '../lib/localData'
import { useT } from '../i18n'
import { integrationsChanged, notificationsChanged, reloadAsked } from '../store/live'
import { isAdmin, useMe } from '../store/session'
import { Button, EmptyState, ErrorNote, IconButton, PageHeader, Skeleton, inputCls, pageColumn } from '../components/ui'
import { ConnectorDetail, ConnectorRow, LogoTile } from '../components/integrations/ConnectorsView'
import { DriveTeamShares, useDriveParts } from '../components/integrations/DriveConnector'
import { AppDetail } from '../components/integrations/AppDetail'
import { GoogleAppDetail, Note, useGoogleApps, type StartChat } from '../components/integrations/GoogleAppConnector'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { SlackAccount } from '../components/settings/SlackAccount'
import { MyRequests } from '../components/integrations/AnswerDialog'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { AskAdminAction, useServiceAsks } from '../components/integrations/AskAdmin'
import { useFromTeam } from '../components/integrations/TemplatesView'
import { useLoad } from './admin/common'

/** How many Discover cards show before "Show all": the five built-in ones and five well-known services. */
export const POPULAR_FIRST = 10

function useConnectorsState() {
  const me = useMe()
  const admin = isAdmin(me)
  const navigate = useNavigate()
  const list = useLoad<IntegrationList>(() => api.call(API.listIntegrations))
  const drive = useDriveConnection()
  const google = useGoogleApps()
  // a member's asks to add an app the team has not set up (none for an owner or admin)
  const asks = useServiceAsks(admin)
  // the admin's requests load again with the list: a sign-in that finished may have connected one
  const [requests, setRequests] = useState(0)
  const reloadList = list.reload, reloadGoogle = google.load, reloadAsks = asks.reload
  const reload = useCallback(() => { void reloadList(); void reloadGoogle(); void reloadAsks(); setRequests((n) => n + 1) }, [reloadList, reloadGoogle, reloadAsks])
  useEffect(() => reloadAsked.on(reload), [reload])
  // a connection of mine went without me (its template changed or went): the lists again, so no stale row stays
  useEffect(() => integrationsChanged.on(reload), [reload])
  // an app I asked for may be ready now (its notice comes with notifications.changed): only while I have an ask open,
  // the asks again, and when fewer are open the apps too, so its page offers Connect without a reload
  const onNotice = useRef(() => {})
  onNotice.current = () => {
    const before = asks.open
    if (before) void reloadAsks().then((n) => { if (n !== null && n < before) { void reloadGoogle(); drive.load() } })
  }
  useEffect(() => notificationsChanged.on(() => onNotice.current()), [])
  const actions = useIntegrationActions({
    add: (i) => list.setData((d) => (d ? { ...d, items: [...d.items, i] } : d)),
    replace: (i) => list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === i.id ? i : x)) } : d)),
    reload,
  })
  const [dialog, setDialog] = useState<{ existing?: Integration; connector?: Connector } | null>(null)
  const startChat: StartChat = useCallback((text) => {
    if (!me) return
    writeDraft(me.user.id, 'new', text)
    navigate('/')
  }, [me, navigate])
  return { list, drive, google, asks, requests, reload, actions, dialog, setDialog, startChat, admin }
}
type ConnectorsState = ReturnType<typeof useConnectorsState>
const Ctx = createContext<ConnectorsState | null>(null)
const useConnectors = () => useContext(Ctx)!

/** /connectors and the pages under it: one state for all of them. */
export function ConnectorsLayout() {
  const s = useConnectorsState()
  const navigate = useNavigate()
  const { dialog, setDialog, actions, list } = s
  return (
    <Ctx.Provider value={s}>
      <Outlet />
      {dialog && (
        <IntegrationDialog
          scope={dialog.existing?.scope ?? 'personal'}
          existing={dialog.existing}
          connector={dialog.connector}
          onClose={() => setDialog(null)}
          onSaved={(i, next) => {
            setDialog(null)
            const created = !dialog.existing && !list.data?.items.some((x) => x.id === i.id)
            actions.saved(i, next, created)
            // a new connection: its page, where its row is (the button that opened the dialog may be gone)
            if (!dialog.existing) navigate(`/connectors/mcp/${i.id}`)
          }}
        />
      )}
    </Ctx.Provider>
  )
}

/** `setUp`: off because the team has not set it up yet, which an owner or admin does in Admin (a member asks an admin
 * from its page); `asked`: a member who asked an admin to add it */
interface Card { id: string; name: string; line: string; logo: string; state: CardState; setUp?: boolean; asked?: boolean; onOpen: () => void; onAdd: () => void }

/** /connectors */
export function ConnectorsHome() {
  const t = useT()
  const navigate = useNavigate()
  const { list, drive, google, asks, requests, actions, setDialog, admin } = useConnectors()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [params, setParams] = useSearchParams()
  const personalAllowed = list.data?.personalAllowed
  // ?add=1 (Search's "Connect an app") opens the add dialog once the list says members may add their own, for owners
  // and admins (a member's Search comes here without it); ?drive=1 (old Drive links, a notice) opens Google Drive's page
  useEffect(() => {
    if (params.get('add') !== '1' || personalAllowed === undefined) return
    if (personalAllowed && admin) setDialog({})
    setParams((p) => { p.delete('add'); return p }, { replace: true })
  }, [params, personalAllowed, admin, setParams, setDialog])

  const mine = list.data ? splitByScope(list.data.items).mine : []
  const team = list.data ? splitByScope(list.data.items).team : null
  const fromTeam = useFromTeam({
    team, latest: list.data?.items, version: requests, query,
    onOpen: (i) => navigate(`/connectors/mcp/${i.id}`),
    onConnected: (i, signIn) => actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id)),
  })
  if (params.get('drive') === '1') return <Navigate to="/connectors/google-drive" replace />
  const q = query.trim()

  // the built-in cards: Google Drive (its own connection), then the Google apps this server knows (none on an older one)
  const dState = driveCardState(drive.connection, admin)
  const builtIns: Card[] = BUILT_IN_ORDER.flatMap((id): Card[] => {
    const name = builtInName(id)
    const open = () => navigate(`/connectors/${id}`)
    // a member who asked an admin to add it: "Asked" in place of "Not set up yet"
    const asked = !admin && asks.stateOf(id) !== 'none'
    if (id === 'google-drive') {
      const setUp = !!drive.connection && !drive.connection.configured
      return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state: dState, setUp, asked: setUp && asked, onOpen: open,
        onAdd: () => { open(); if (dState === 'available') drive.start() } }]
    }
    const v = google.apps?.find((x) => x.id === id)
    if (!v) return []
    // one that needs a new sign-in stays in Your connectors even when it cannot be connected now: its page disconnects it
    const setUp = v.reason === 'not_set_up'
    return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state: v.status === 'needs_reconnect' ? 'reconnect' : googleAppCardState(v), setUp, asked: setUp && asked, onOpen: open,
      onAdd: () => { open(); void google.flows[id].start() } }]
  })
  // the listed services: added from their page or with + (the add dialog, filled in); only while members may add their own
  // (every connection the person can use counts as connected: their own, the team's, the ones made from a template)
  const urls = (list.data?.items ?? []).map((i) => i.url)
  const listed: Card[] = personalAllowed ? CONNECTORS.map((c) => ({
    id: c.id, name: c.name, line: t(`integrations.catalog.${c.id}`), logo: connectorLogo(c),
    state: isConnected(c, urls) ? 'added' as const : 'available' as const,
    onOpen: () => navigate(`/connectors/${c.id}`), onAdd: () => setDialog({ connector: c }),
  })) : []
  // Discover: only what is not connected yet (connected ones are in Your connectors). One that cannot be connected now
  // ("off") comes after the ones that can be added now, and only while the team has not set it up yet: an owner or
  // admin sees "Set up", which goes to Admin, where it is set up; a member sees "Not set up yet" ("Asked" once they
  // asked), and its page has "Ask admin to add it". One turned off for members is left out (nothing to do there).
  const cards = [...builtIns, ...listed]
    .filter((c) => c.state === 'available' || (c.state === 'off' && c.setUp))
    .filter((c) => fits(q, c.name, c.line))
    .sort((a, b) => Number(a.state === 'off') - Number(b.state === 'off'))
  const shownCards = q || all ? cards : cards.slice(0, POPULAR_FIRST)

  // Your connectors: the built-in ones connected (or needing a new sign-in), the person's own connections, and what the
  // team provides (useFromTeam), one line each, by name
  const yours: { name: string; row: ReactNode }[] = [
    ...builtIns.filter((c) => c.state === 'added' || c.state === 'reconnect').filter((c) => fits(q, c.name)).map((c) => ({ name: c.name, row: (
      <ConnectorRow key={c.id} id={c.id} logo={c.logo} name={c.name} status={c.state === 'reconnect' ? 'reconnect' : 'connected'} onOpen={c.onOpen} />
    ) })),
    ...mine.filter((i) => fits(q, i.name, i.url)).map((i) => {
      const c = connectorFor(i.url)
      return { name: i.name, row: (
        <ConnectorRow key={i.id} id={i.id} logo={c ? connectorLogo(c) : undefined} name={i.name}
          status={i.status === 'connected' ? 'connected' : i.status === 'needs_auth' ? 'reconnect' : 'attention'} onOpen={() => navigate(`/connectors/mcp/${i.id}`)} />
      ) }
    }),
    ...fromTeam.rows,
  ].sort((a, b) => a.name.localeCompare(b.name))

  const loading = !list.data && !list.error
  const nothing = !!q && fromTeam.ready && !cards.length && !yours.length
  // nothing connected and nothing this person can add (the team has set nothing up for members): say so once
  const empty = !q && !loading && fromTeam.ready && !cards.length && !yours.length
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="integrations">
      <PageHeader testId="connectors-header" title={t('integrations.title')} desc={t('connectorsPage.desc')}
        actions={<>
          <div className="relative w-[calc(100vw-2rem)] min-w-0 sm:w-60">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('integrations.search')} aria-label={t('integrations.search')} className={`${inputCls} pl-9`} data-testid="connector-search" />
          </div>
          {personalAllowed && admin && (
            <Button onClick={() => setDialog({})} data-testid="integration-add">
              <Plus size={15} aria-hidden /> {t('connectorsPage.addCustom')}
            </Button>
          )}
        </>} />
      <div className={clsx(pageColumn, 'space-y-8 p-4 pb-10 sm:p-6')}>
        {/* what an admin asked this person to connect: answered, its own page, with its row */}
        <MyRequests version={requests} onConnected={(i, signIn) => { actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id)); navigate(`/connectors/mcp/${i.id}`) }} />
        {list.error && <ErrorNote onRetry={() => void list.reload()}>{list.error}</ErrorNote>}
        {/* a service a member looked for and did not find: where to go next (an owner or admin has Add above) */}
        {loading ? <Skeleton lines={4} /> : nothing ? (
          <EmptyState title={t('integrations.noMatch', { q })}>
            {personalAllowed && !admin && <p data-testid="connector-ask-admin">{t('integrations.discover.customHint')} {t('integrations.discover.askAdmin')}</p>}
          </EmptyState>
        ) : empty ? (
          <EmptyState title={t('connectors.none')}>
            {!admin && <p data-testid="connector-ask-admin">{t('connectors.noneMember')}</p>}
          </EmptyState>
        ) : (
          <>
            {personalAllowed === false && mine.length > 0 && (
              <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="integrations-personal-off">{t('integrations.personalOff')}</p>
            )}
            {yours.length > 0 && (
              <section aria-labelledby="connectors-yours">
                <h2 id="connectors-yours" className="mb-1 text-sm font-semibold">{t('connectors.yours')}</h2>
                <ul data-testid="connected-apps">{yours.map((x) => x.row)}</ul>
              </section>
            )}
            {!q && <SlackAccount />}
            {cards.length > 0 && (
              <section aria-labelledby="connectors-discover" data-testid="connector-discover">
                <div className="mb-1 flex items-center gap-2">
                  <h2 id="connectors-discover" className="text-sm font-semibold" data-testid="connector-discover-title">{q ? t('connectors.results') : t('connectors.discover')}</h2>
                  {!q && cards.length > POPULAR_FIRST && (
                    <button type="button" className="ml-auto text-sm text-muted hover:text-ink" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
                      {all ? t('connectors.showLess') : t('connectorsPage.showAll', { count: cards.length })}
                    </button>
                  )}
                </div>
                <ul className="grid gap-x-6 sm:grid-cols-2" data-testid="connector-list">
                  {shownCards.map((c) => <DiscoverCard key={c.id} c={c} admin={admin} />)}
                </ul>
                {/* members: the address form (kind, sign-in method, headers, scopes) is an admin's job */}
                {personalAllowed && !admin && (
                  <p className="mt-5 text-sm text-muted" data-testid="connector-not-listed">
                    {t('integrations.discover.customHint')} <span data-testid="connector-ask-admin">{t('integrations.discover.askAdmin')}</span>
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {fromTeam.dialog}
    </div>
  )
}

/** One Discover card: logo, name, one line, and one + on the right (for one the team has not set up yet: an owner or
 * admin "Set up", a member "Not set up yet" or "Asked"). The card opens its page. */
function DiscoverCard({ c, admin }: { c: Card; admin: boolean }) {
  const t = useT()
  return (
    <li className="flex items-center gap-3 border-b border-line py-3" data-testid="connector-card" data-id={c.id} data-state={c.state}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left -outline-offset-2" onClick={c.onOpen} data-testid="connector-open">
        <LogoTile src={c.logo} className="size-10 rounded-xl p-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{c.name}</span>
          <span className="mt-0.5 line-clamp-1 text-xs text-muted">{c.line}</span>
        </span>
      </button>
      {c.state === 'off' && !admin ? (
        <span className="max-w-28 shrink-0 text-right text-xs text-faint" data-testid="connector-off">{t(c.asked ? 'serviceRequest.asked' : 'gapps.off.notSetUp')}</span>
      ) : c.state === 'off' ? (
        <Link to="/admin/connectors" className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-ink" data-testid="connector-set-up">{t('connectors.setUp')}</Link>
      ) : (
        <IconButton label={t('integrations.discover.add', { name: c.name })} className="shrink-0 rounded-full border border-line" onClick={c.onAdd} data-testid="connector-add">
          <Plus size={16} aria-hidden />
        </IconButton>
      )}
    </li>
  )
}

/** /connectors/:id: a built-in card's page, or a listed service's. */
export function ConnectorPage() {
  const { id = '' } = useParams()
  const { google, asks, admin, startChat } = useConnectors()
  if (id === 'google-drive') return <DrivePage />
  if (isGoogleApp(id)) {
    if (!google.apps) return <PageSkeleton />
    const v = google.apps.find((x) => x.id === id)
    if (!v) return <Navigate to="/connectors" replace />
    // a member, the team has not set it up, never connected: ask an admin to add it (once the server says what was asked)
    const ask = !admin && asks.ready && v.reason === 'not_set_up' && v.status === 'disconnected'
      ? { state: asks.stateOf(v.id), busy: asks.busy === v.id, onAsk: () => void asks.ask(v.id, builtInName(v.id), () => void google.load()), error: asks.error?.service === v.id ? asks.error.text : null }
      : undefined
    return <GoogleAppDetail v={v} g={google} onChat={startChat} ask={ask} />
  }
  const c = CONNECTORS.find((x) => x.id === id)
  return c ? <ListedPage c={c} /> : <Navigate to="/connectors" replace />
}

function PageSkeleton() {
  return <div className={clsx(pageColumn, 'p-4 sm:p-6')}><Skeleton lines={6} /></div>
}

/** Google Drive's page: Trina's own connector, the same layout as the Google apps'. */
function DrivePage() {
  const t = useT()
  const { drive, asks, admin, startChat } = useConnectors()
  const p = useDriveParts(drive)
  const id: BuiltInId = 'google-drive'
  const name = builtInName(id)
  const examples = exampleKeys(id).map((k) => t(k))
  const ready = p.linked && !p.reconnect && !p.off
  // a member, the team has not set Google Drive up: "Ask admin to add it" in place of the Connect button that cannot
  // work and of "Your admin needs to turn this on"; once asked, when they will hear
  const ask = !admin && asks.ready && p.unavailable && !p.linked && !p.shares.length ? asks.stateOf(id) : null
  const askError = ask && asks.error?.service === id ? asks.error.text : null
  const line = ask === 'none' ? null : ask ? t('serviceRequest.waiting', { name }) : p.line !== t('drive.cardDesc') ? p.line : null
  return (
    <AppDetail testId="drive-detail" state={p.state} logo={builtInLogo(id)} name={name} byLine={t('gapps.byLineDrive', { line: t(lineKey(id)) })}
      actions={ask ? <AskAdminAction state={ask} busy={asks.busy === id} onAsk={() => void asks.ask(id, name, drive.load)} />
        : <>{ready && <Button variant="primary" onClick={() => startChat(examples[0]!)} data-testid="drive-try">{t('gapps.tryInChat')}</Button>}{p.action}</>}
      status={(line || askError || p.busy || p.shares.length > 0 || drive.d.error || drive.revokeWarning) ? <>
        {line && <Note tone={p.reconnect || (p.off && p.linked) ? 'warn' : undefined} testId={ask ? 'service-asked-note' : 'drive-detail-line'}>{line}</Note>}
        {askError && <Note tone="warn" testId="service-ask-error">{askError}</Note>}
        <div className="empty:hidden">{p.steps}</div>
        <DriveTeamShares shares={p.shares} />
      </> : undefined}
      examples={examples} onExample={startChat}
      about={t('connectors.drive.about')} canChange={false}
      developer={t('gapps.dev.trina')} category={t('gapps.drive.category')} links={{ privacy: GOOGLE_PRIVACY, terms: GOOGLE_TERMS }}
      tools={DRIVE_TOOL_LIST.map((x) => ({ name: x.name, title: t(`gapps.drive.tool.${x.name}`), changes: x.changes }))} />
  )
}

/** A listed service's page (its connection, once there is one, with everything its row offers). */
function ListedPage({ c }: { c: Connector }) {
  const t = useT()
  const navigate = useNavigate()
  const { list, setDialog } = useConnectors()
  const mine = list.data ? splitByScope(list.data.items).mine : []
  const have = mine.filter((i) => canonicalService(i.url) === canonicalService(c.url))
  return (
    <McpShell>
      <ConnectorDetail testId="connector-detail" logo={connectorLogo(c)} name={c.name} line={t(`integrations.catalog.${c.id}`)} official onBack={() => navigate('/connectors')}
        action={have.length ? <span className="text-sm text-ok" data-testid="connector-detail-added">{t('drive.status.connected')}</span>
          : list.data?.personalAllowed ? <Button variant="primary" onClick={() => setDialog({ connector: c })} data-testid="connector-connect">{t('aiApps.connect')}</Button> : null}
        description={t('connectors.mcp.about', { name: c.name })} noTools={have.length > 0}>
        {have.length > 0 && <MineRows items={have} />}
      </ConnectorDetail>
    </McpShell>
  )
}

/** /connectors/mcp/:integrationId: one of the person's own connections (added by address, from the list or from a
 * team template), or a team connection they may use (read-only: its state, its tools, "Run without asking"). */
export function CustomConnectorPage() {
  const t = useT()
  const navigate = useNavigate()
  const { integrationId = '' } = useParams()
  const { list } = useConnectors()
  if (!list.data) return <PageSkeleton />
  const i = list.data.items.find((x) => x.id === integrationId)
  if (!i) return <Navigate to="/connectors" replace />
  const c = connectorFor(i.url)
  return (
    <McpShell>
      <ConnectorDetail testId="connector-detail" logo={c ? connectorLogo(c) : '/favicon.svg'} name={i.name} line={c ? t(`integrations.catalog.${c.id}`) : i.url} official={!!c} onBack={() => navigate('/connectors')}
        description={t('connectors.mcp.about', { name: i.name })} noTools>
        <MineRows items={[i]} readOnly={i.scope === 'team'} />
      </ConnectorDetail>
    </McpShell>
  )
}

/** A connection's page; the privacy note (moved off the list) at its end. */
function McpShell({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-4 pb-10 sm:p-6">
        {children}
        <p className="mt-8 text-xs text-faint" data-testid="connector-privacy">{t('integrations.privacy')}</p>
      </div>
    </div>
  )
}

/** The person's own connection(s) to a service, with what their row always offered: check, tools, edit, delete; a
 * team connection read-only, as the team provides it. */
function MineRows({ items, readOnly }: { items: Integration[]; readOnly?: boolean }) {
  const { actions, setDialog } = useConnectors()
  const navigate = useNavigate()
  // deleted: back to the list (the page has nothing left to show)
  const ids = useMemo(() => items.map((i) => i.id).join(','), [items])
  useEffect(() => { if (!ids) navigate('/connectors', { replace: true }) }, [ids, navigate])
  return (
    <ul className="-mx-2 divide-y divide-line rounded-xl bg-surface" data-testid="integrations-mine">
      {items.map((i) => <IntegrationRow key={i.id} i={i} actions={actions} readOnly={readOnly} onEdit={() => setDialog({ existing: i })} />)}
    </ul>
  )
}
