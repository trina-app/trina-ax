// Connectors (/connectors, an item of the main sidebar and of the phone's drawer): what the AI may use with the person's
// own accounts, like an app store's page. On top the title, one line and a search box; first, what an admin asked the
// person to connect (components/integrations/AnswerDialog.tsx) and "From <team>" (TemplatesView.tsx FromTeam: the team's
// connections they may use); then **Connected**, a row of the apps they connected (Google Drive, Gmail, …, their own MCP
// connections), each opening its page; then **Popular**: Trina's built-in cards first (Google Drive, Gmail, Google
// Calendar, Google Docs, Google Sheets), then the listed MCP services (lib/connectors.ts), with a + that connects at once
// (a Google card opens Google during the click), a ✓ once connected, or why not now. "Add custom connector" in the title
// row takes any MCP server or API by its address: owners and admins only; a member reads "Not listed? Ask an admin to
// add it." under Popular instead (docs/DECISIONS.md "Plain words for members"). A built-in the team has not set up gives
// a member "Ask admin to add it" on its page, and its card then says "Asked" (components/integrations/AskAdmin.tsx). A
// card opens its page, /connectors/<id>: a built-in's (AppDetail.tsx:
// Connect, things to try, About, what the AI can do, Information, the tools), a listed service's (ConnectorDetail), or
// /connectors/mcp/<connection id> for a connection of the person's own (its row, with everything it had before).
// Settings › Connected apps leads here (SettingsDialog.tsx), keeping ?add=1, ?template=, ?request= and ?drive=1 (old Drive
// links: Google Drive's page). The state (the lists, Drive's and the Google apps' sign-ins, the add dialog) lives in
// ConnectorsLayout, so a + can open Google during the click and its page shows the same sign-in.
import clsx from 'clsx'
import { Check, Plus, Search } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { connectorFor, connectorLogo, CONNECTORS, isConnected, type Connector } from '../lib/connectors'
import { builtInLogo, builtInName, BUILT_IN_ORDER, driveCardState, DRIVE_TOOL_LIST, exampleKeys, fits, GOOGLE_PRIVACY, GOOGLE_TERMS, googleAppCardState, isGoogleApp, lineKey, unavailableKeys, type BuiltInId, type CardState } from '../lib/googleApps'
import { canonicalService, splitByScope } from '../lib/integrations'
import { writeDraft } from '../lib/localData'
import { useT } from '../i18n'
import { integrationsChanged, notificationsChanged, reloadAsked } from '../store/live'
import { isAdmin, useMe, useMeStrict } from '../store/session'
import { Button, EmptyState, ErrorNote, IconButton, PageHeader, Skeleton, inputCls, pageColumn } from '../components/ui'
import { Tooltip } from '../components/Tooltip'
import { ConnectorDetail, LogoTile } from '../components/integrations/ConnectorsView'
import { DriveTeamShares, useDriveParts } from '../components/integrations/DriveConnector'
import { AppDetail } from '../components/integrations/AppDetail'
import { GoogleAppDetail, Note, useGoogleApps, type StartChat } from '../components/integrations/GoogleAppConnector'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { SlackAccount } from '../components/settings/SlackAccount'
import { MyRequests } from '../components/integrations/AnswerDialog'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { AskAdminAction, useServiceAsks } from '../components/integrations/AskAdmin'
import { FromTeam } from '../components/integrations/TemplatesView'
import { useLoad } from './admin/common'

/** How many Popular cards show before "Show all": the five built-in ones and five well-known services. */
export const POPULAR_FIRST = 10

function useConnectorsState() {
  const me = useMe()
  const admin = isAdmin(me)
  const navigate = useNavigate()
  const list = useLoad<IntegrationList>(() => api.call(API.listIntegrations))
  // an admin's "From <team>" also lists the team's connections not for them ("Off for you"): the team list, admins only
  const teamAll = useLoad(async () => {
    if (!admin) return [] as Integration[]
    try { return (await api.call(API.listTeamIntegrations)).items } catch { return [] as Integration[] }
  }, [admin])
  const drive = useDriveConnection()
  const google = useGoogleApps()
  // a member's asks to add an app the team has not set up (none for an owner or admin)
  const asks = useServiceAsks(admin)
  // the admin's requests load again with the list: a sign-in that finished may have connected one
  const [requests, setRequests] = useState(0)
  const reloadList = list.reload, reloadTeam = teamAll.reload, reloadGoogle = google.load, reloadAsks = asks.reload
  const reload = useCallback(() => { void reloadList(); void reloadTeam(); void reloadGoogle(); void reloadAsks(); setRequests((n) => n + 1) }, [reloadList, reloadTeam, reloadGoogle, reloadAsks])
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
  return { list, teamAll, drive, google, asks, requests, reload, actions, dialog, setDialog, startChat, admin }
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

interface Card { id: string; name: string; line: string; logo: string; state: CardState; off?: string; onOpen: () => void; onAdd: () => void }

/** /connectors */
export function ConnectorsHome() {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const { list, teamAll, drive, google, asks, requests, actions, setDialog, admin } = useConnectors()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [fromTeamShown, setFromTeamShown] = useState<boolean | null>(null)
  const [params, setParams] = useSearchParams()
  const personalAllowed = list.data?.personalAllowed
  // ?add=1 (Search's "Connect an app") opens the add dialog once the list says members may add their own, for owners
  // and admins (a member's Search comes here without it); ?drive=1 (old Drive links, a notice) opens Google Drive's page
  useEffect(() => {
    if (params.get('add') !== '1' || personalAllowed === undefined) return
    if (personalAllowed && admin) setDialog({})
    setParams((p) => { p.delete('add'); return p }, { replace: true })
  }, [params, personalAllowed, admin, setParams, setDialog])
  if (params.get('drive') === '1') return <Navigate to="/connectors/google-drive" replace />

  const mine = list.data ? splitByScope(list.data.items).mine : []
  const team = list.data ? splitByScope(list.data.items).team : null
  // (null while an admin's team list is still on its way: the block waits for it, so nothing flashes)
  const offForMe = !admin ? [] : team && teamAll.data ? teamAll.data.filter((x) => !team.some((y) => y.id === x.id)) : null
  const q = query.trim()

  // the built-in cards: Google Drive (its own connection), then the Google apps this server knows (none on an older one)
  const dState = driveCardState(drive.connection, admin)
  const builtIns: Card[] = BUILT_IN_ORDER.flatMap((id): Card[] => {
    const name = builtInName(id)
    const open = () => navigate(`/connectors/${id}`)
    // a member who asked an admin to add it: "Asked" in place of "Not set up yet"
    const asked = !admin && asks.stateOf(id) !== 'none'
    if (id === 'google-drive') {
      const notSetUp = !!drive.connection && !drive.connection.configured
      const off = dState === 'off' ? t(notSetUp && asked ? 'serviceRequest.asked' : notSetUp ? 'gapps.off.notSetUp' : 'gapps.off.membersOff') : undefined
      return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state: dState, off, onOpen: open,
        onAdd: () => { open(); if (dState === 'available') drive.start() } }]
    }
    const v = google.apps?.find((x) => x.id === id)
    if (!v) return []
    const state = googleAppCardState(v)
    const why = unavailableKeys(v.reason, admin)
    const off = v.reason === 'not_set_up' && asked ? t('serviceRequest.asked') : why ? t(why.short) : undefined
    return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state, off, onOpen: open,
      onAdd: () => { open(); void google.flows[id].start() } }]
  })
  // the listed services: added from their page or with + (the add dialog, filled in); only while members may add their own
  const urls = mine.map((i) => i.url)
  const listed: Card[] = personalAllowed ? CONNECTORS.map((c) => ({
    id: c.id, name: c.name, line: t(`integrations.catalog.${c.id}`), logo: connectorLogo(c),
    state: isConnected(c, urls) ? 'added' as const : 'available' as const,
    onOpen: () => navigate(`/connectors/${c.id}`), onAdd: () => setDialog({ connector: c }),
  })) : []
  const cards = [...builtIns, ...listed].filter((c) => fits(q, c.name, c.line))
  const shownCards = q || all ? cards : cards.slice(0, POPULAR_FIRST)

  // Connected: the built-in ones connected (or needing a new sign-in), then the person's own connections
  const connected: { id: string; name: string; logo: string; warn: boolean; to: string }[] = [
    ...builtIns.filter((c) => c.state === 'added' || c.state === 'reconnect').map((c) => ({ id: c.id, name: c.name, logo: c.logo, warn: c.state === 'reconnect', to: `/connectors/${c.id}` })),
    ...mine.map((i) => {
      const c = connectorFor(i.url)
      return { id: i.id, name: i.name, logo: c ? connectorLogo(c) : '', warn: i.status !== 'connected', to: `/connectors/mcp/${i.id}` }
    }),
  ].filter((x) => fits(q, x.name))

  const loading = !list.data && !list.error
  const nothing = !!q && !cards.length && !connected.length && !fromTeamShown
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
        <div className="space-y-5 empty:hidden">
          {/* answered: its own page, with its row (like a connection added here) */}
          <MyRequests version={requests} onConnected={(i, signIn) => { actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id)); navigate(`/connectors/mcp/${i.id}`) }} />
          <FromTeam teamName={me.team.name} team={team} offForMe={offForMe} latest={list.data?.items} manage={admin} version={requests} query={query}
            actions={actions} onEdit={(i) => setDialog({ existing: i })}
            onConnected={(i, signIn) => actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id))}
            onShown={setFromTeamShown} />
        </div>
        {list.error && <ErrorNote onRetry={() => void list.reload()}>{list.error}</ErrorNote>}
        {/* a service a member looked for and did not find: where to go next (an owner or admin has Add above) */}
        {loading ? <Skeleton lines={4} /> : nothing ? (
          <EmptyState title={t('integrations.noMatch', { q })}>
            {personalAllowed && !admin && <p data-testid="connector-ask-admin">{t('integrations.discover.customHint')} {t('integrations.discover.askAdmin')}</p>}
          </EmptyState>
        ) : (
          <>
            {personalAllowed === false && mine.length > 0 && (
              <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="integrations-personal-off">{t('integrations.personalOff')}</p>
            )}
            {connected.length > 0 && (
              <section aria-labelledby="connectors-connected">
                <h2 id="connectors-connected" className="mb-3 text-sm font-semibold">{t('connectors.connected')}</h2>
                <ul className="flex flex-wrap gap-x-2 gap-y-3" data-testid="connected-apps">
                  {connected.map((x) => (
                    <li key={x.id}>
                      <button type="button" onClick={() => navigate(x.to)} className="group flex w-[5.5rem] flex-col items-center gap-1.5 rounded-xl p-1.5 text-center hover:bg-hover" data-testid="connected-app" data-id={x.id} data-warn={x.warn ? 'yes' : undefined}>
                        <span className="relative">
                          {x.logo ? <LogoTile src={x.logo} className="size-12 rounded-xl p-2" /> : <InitialTile name={x.name} />}
                          {x.warn && <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--c-canvas)] bg-warn" aria-hidden />}
                        </span>
                        <span className="line-clamp-2 w-full text-xs leading-tight break-words">{x.name}</span>
                        {x.warn && <span className="sr-only">{t('drive.status.needs_reconnect')}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!q && <SlackAccount />}
            {cards.length > 0 && (
              <section aria-labelledby="connectors-popular" data-testid="connector-discover">
                <div className="mb-3 flex items-center gap-2">
                  <h2 id="connectors-popular" className="text-sm font-semibold" data-testid="connector-discover-title">{q ? t('connectors.results') : t('connectorsPage.popular')}</h2>
                  {!q && cards.length > POPULAR_FIRST && (
                    <button type="button" className="ml-auto text-sm text-muted hover:text-ink" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
                      {all ? t('connectors.showLess') : t('connectorsPage.showAll', { count: cards.length })}
                    </button>
                  )}
                </div>
                <ul className="grid gap-x-6 sm:grid-cols-2" data-testid="connector-list">
                  {shownCards.map((c) => <PopularCard key={c.id} c={c} />)}
                </ul>
                {/* members: the address form (kind, sign-in method, headers, scopes) is an admin's job */}
                {personalAllowed && !admin && (
                  <p className="mt-5 text-sm text-muted" data-testid="connector-not-listed">
                    {t('integrations.discover.customHint')} <span data-testid="connector-ask-admin">{t('integrations.discover.askAdmin')}</span>
                  </p>
                )}
              </section>
            )}
            <p className="text-xs text-faint">{t('integrations.privacy')}</p>
          </>
        )}
      </div>
    </div>
  )
}

/** A connection without a listed logo: its first letter. */
function InitialTile({ name }: { name: string }) {
  return <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-subtle text-lg font-semibold text-muted" aria-hidden>{name.trim().charAt(0).toUpperCase() || '?'}</span>
}

/** One Popular card: logo, name, one line; on the right +, ✓, "Reconnect" or why not now. The card opens its page. */
function PopularCard({ c }: { c: Card }) {
  const t = useT()
  return (
    <li className="flex items-center gap-3 border-b border-line py-3" data-testid="connector-card" data-id={c.id} data-state={c.state}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left -outline-offset-2" onClick={c.onOpen} data-testid="connector-open">
        <LogoTile src={c.logo} className="size-11 rounded-xl p-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{c.name}</span>
          <span className="mt-0.5 line-clamp-2 text-xs text-muted">{c.line}</span>
        </span>
      </button>
      {c.state === 'added' ? (
        <Tooltip label={t('integrations.discover.added', { name: c.name })}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-ok" role="img" aria-label={t('integrations.discover.added', { name: c.name })} data-testid="connector-added">
            <Check size={16} aria-hidden />
          </span>
        </Tooltip>
      ) : c.state === 'reconnect' ? (
        <button type="button" className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-warn hover:bg-hover" onClick={c.onOpen} data-testid="connector-reconnect">{t('drive.reconnect')}</button>
      ) : c.state === 'off' ? (
        <span className="max-w-28 shrink-0 text-right text-xs text-faint" data-testid="connector-off">{c.off ?? t('connectors.notOn')}</span>
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

/** /connectors/mcp/:integrationId: one of the person's own connections (added by address or from the list). */
export function CustomConnectorPage() {
  const t = useT()
  const navigate = useNavigate()
  const { integrationId = '' } = useParams()
  const { list } = useConnectors()
  if (!list.data) return <PageSkeleton />
  const i = list.data.items.find((x) => x.id === integrationId && x.scope === 'personal')
  if (!i) return <Navigate to="/connectors" replace />
  const c = connectorFor(i.url)
  return (
    <McpShell>
      <ConnectorDetail testId="connector-detail" logo={c ? connectorLogo(c) : '/favicon.svg'} name={i.name} line={c ? t(`integrations.catalog.${c.id}`) : i.url} official={!!c} onBack={() => navigate('/connectors')}
        description={t('connectors.mcp.about', { name: i.name })} noTools>
        <MineRows items={[i]} />
      </ConnectorDetail>
    </McpShell>
  )
}

function McpShell({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col overflow-y-auto"><div className="mx-auto w-full max-w-4xl p-4 pb-10 sm:p-6">{children}</div></div>
}

/** The person's own connection(s) to a service, with what their row always offered: check, tools, edit, delete. */
function MineRows({ items }: { items: Integration[] }) {
  const { actions, setDialog } = useConnectors()
  const navigate = useNavigate()
  // deleted: back to the list (the page has nothing left to show)
  const ids = useMemo(() => items.map((i) => i.id).join(','), [items])
  useEffect(() => { if (!ids) navigate('/connectors', { replace: true }) }, [ids, navigate])
  return (
    <ul className="-mx-2 divide-y divide-line rounded-xl bg-surface" data-testid="integrations-mine">
      {items.map((i) => <IntegrationRow key={i.id} i={i} actions={actions} onEdit={() => setDialog({ existing: i })} />)}
    </ul>
  )
}
