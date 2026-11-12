// Settings › Connectors (/settings/connectors, a section of the Settings dialog for everyone; it was an item of the main
// sidebar and of the phone's drawer until 2026-11-12, docs/DECISIONS.md "Connectors in Settings"): what the AI may use
// with the person's own accounts, kept simple like Claude's Settings › Connectors. On top the section's title, one line,
// a search box and, for owners and admins, "Add custom connector" (any MCP server or API by its address). Then what an
// admin asked the person to connect
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
// A card opens its page inside Settings, a page under the section (SettingsDialog.tsx): /settings/connectors/<id> for a
// built-in's (AppDetail.tsx) or a listed service's (ConnectorDetail), /settings/connectors/mcp/<connection id> for one
// of the person's connections or a team connection they may use; its way back is the list. The old addresses lead here
// with their query (/connectors, /connectors/<id>, /connectors/mcp/<id>, /settings/integrations: App.tsx and
// SettingsDialog.tsx), keeping ?add=1, ?template=, ?request= and ?drive=1 (old Drive links: Google Drive's page). The
// state (the lists, Drive's and the Google apps' sign-ins, the add dialog) lives in ConnectorsProvider, one for the
// list and its pages, so a + can open Google during the click and its page shows the same sign-in.
// Phones (below 768 px, QA TC-262): the section's top (the line, the search and Add) scrolls away with the list, the
// phone bar says the name, and the small links take a 44 px tap. In the phone app nothing signs in
// to Google here (connecting is done on a computer): a built-in one's + only opens its page, and its page shows what it
// is now, Disconnect, and one line "Connect … on a computer".
import { Check, Plus, Search } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { isRequestableService, type Integration, type IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { CONNECTOR_DOCS, connectionHref, connectorFor, connectorHref, connectorLogo, CONNECTORS, CONNECTORS_HOME, isConnected, servesAt, type Connector } from '../lib/connectors'
import { aboutKey, builtInLogo, builtInName, BUILT_IN_ORDER, driveCardState, DRIVE_TOOL_LIST, fits, GOOGLE, GOOGLE_PRIVACY, GOOGLE_TERMS, googleAppCardState, isGoogleApp, lineKey, type BuiltInId } from '../lib/googleApps'
import { connectionRowStatus, splitByScope } from '../lib/integrations'
import { useT } from '../i18n'
import { integrationsChanged, notificationsChanged, reloadAsked } from '../store/live'
import { isAdmin, useMe } from '../store/session'
import { Button, EmptyState, ErrorNote, Skeleton, inputCls } from '../components/ui'
import { ConnectorDetail, ConnectorRow, DiscoverCard, DISCOVER_FIRST, type DiscoverItem } from '../components/integrations/ConnectorsView'
import { DriveTeamShares, useDriveParts } from '../components/integrations/DriveConnector'
import { AppDetail } from '../components/integrations/AppDetail'
import { GoogleAppDetail, Note, useGoogleApps } from '../components/integrations/GoogleAppConnector'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { SlackAccount } from '../components/settings/SlackAccount'
import { SettingsHold } from '../components/settings/SettingsBar'
import { MyRequests } from '../components/integrations/AnswerDialog'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { AskAdminAction, ListedAsk, useServiceAsks } from '../components/integrations/AskAdmin'
import { useFromTeam } from '../components/integrations/TemplatesView'
import { useLoad } from './admin/common'
import { mobileApp } from '../lib/mobile'

/** How many Discover cards show before "Show all" (ConnectorsView.tsx). */
export const POPULAR_FIRST = DISCOVER_FIRST

function useConnectorsState() {
  const admin = isAdmin(useMe())
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
  return { list, drive, google, asks, requests, reload, actions, dialog, setDialog, admin }
}
type ConnectorsState = ReturnType<typeof useConnectorsState>
const Ctx = createContext<ConnectorsState | null>(null)
const useConnectors = () => useContext(Ctx)!

/** Settings › Connectors and the pages under it (SettingsDialog.tsx, pages/Settings.tsx): one element for the list and
 * every page, so their state stays while the person goes from one to the other (/settings/connectors, …/<id>,
 * …/mcp/<id>). */
export function ConnectorsSettings() {
  const { id, integrationId } = useParams()
  return (
    <ConnectorsProvider>
      {integrationId ? <CustomConnectorPage /> : id ? <ConnectorPage /> : <ConnectorsHome />}
    </ConnectorsProvider>
  )
}

/** The section and the pages under it: one state for all of them. */
function ConnectorsProvider({ children }: { children: ReactNode }) {
  const s = useConnectorsState()
  const navigate = useNavigate()
  const { dialog, setDialog, actions, list } = s
  // a Google sign-in under way (Drive's or an app's): Settings stays open against a stray click beside it or Esc, so its
  // confirm step is not lost (components/settings/SettingsBar.tsx SettingsHold)
  const hold = useContext(SettingsHold)
  const signingIn = s.drive.d.inProgress || Object.values(s.google.flows).some((f) => f.inProgress)
  useEffect(() => { hold(signingIn) }, [hold, signingIn])
  useEffect(() => () => hold(false), [hold])
  return (
    <Ctx.Provider value={s}>
      {children}
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
            if (!dialog.existing) navigate(connectionHref(i.id))
          }}
        />
      )}
    </Ctx.Provider>
  )
}

/** `setUp`: off because the team has not set it up yet, which an owner or admin does in Admin (a member asks an admin
 * from its page); `asked`: a member who asked an admin to add it */
type Card = DiscoverItem

/** Settings › Connectors: the list */
function ConnectorsHome() {
  const t = useT()
  const navigate = useNavigate()
  const { list, drive, google, asks, requests, actions, setDialog, admin } = useConnectors()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [params, setParams] = useSearchParams()
  // the phone app: Google's sign-in is not started from here (connecting is done on a computer, QA TC-262)
  const inApp = !!mobileApp()
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
    onOpen: (i) => navigate(connectionHref(i.id)),
    onConnected: (i, signIn) => actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id)),
  })
  if (params.get('drive') === '1') return <Navigate to={connectorHref('google-drive')} replace />
  const q = query.trim()

  // the built-in cards: Google Drive (its own connection), then the Google apps this server knows (none on an older one)
  const dState = driveCardState(drive.connection)
  const builtIns: Card[] = BUILT_IN_ORDER.flatMap((id): Card[] => {
    const name = builtInName(id)
    const open = () => navigate(connectorHref(id))
    // a member who asked an admin to add it: "Asked" in place of "Not set up yet"
    const asked = !admin && asks.stateOf(id) !== 'none'
    if (id === 'google-drive') {
      const setUp = !!drive.connection && !drive.connection.configured
      return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state: dState, setUp, asked: setUp && asked, onOpen: open,
        onAdd: () => { open(); if (dState === 'available' && !inApp) drive.start() } }]
    }
    const v = google.apps?.find((x) => x.id === id)
    if (!v) return []
    // one that needs a new sign-in stays in Your connectors even when it cannot be connected now: its page disconnects it
    const setUp = v.reason === 'not_set_up'
    return [{ id, name, line: t(lineKey(id)), logo: builtInLogo(id), state: v.status === 'needs_reconnect' ? 'reconnect' : googleAppCardState(v), setUp, asked: setUp && asked, onOpen: open,
      onAdd: () => { open(); if (!inApp) void google.flows[id].start() } }]
  })
  // the listed services: added from their page or with + (the add dialog, filled in); only while members may add their own
  // (every connection the person can use counts as connected: their own, the team's, the ones made from a template;
  // and a template the team set up for them, connected or not, is in Your connectors, never in Discover as well: QA
  // TC-179)
  const urls = [...(list.data?.items ?? []).map((i) => i.url), ...fromTeam.urls]
  const listed: Card[] = personalAllowed ? CONNECTORS.map((c) => ({
    id: c.id, name: c.name, line: t(`integrations.catalog.${c.id}`), logo: connectorLogo(c),
    state: isConnected(c, urls) ? 'added' as const : 'available' as const,
    onOpen: () => navigate(connectorHref(c.id)), onAdd: () => setDialog({ connector: c }),
  })) : []
  // Discover: only what is not connected yet (connected ones are in Your connectors). The Google ones first, always in
  // their order (Drive, Gmail, Calendar, Docs, Sheets: QA TC-138), also one that cannot be connected yet because the
  // team has not set it up ("off"): an owner or admin sees "Set up", which goes to Admin, where it is set up; a member
  // sees "Not set up yet" ("Asked" once they asked), and its page has "Ask admin to add it".
  const cards = [...builtIns, ...listed]
    .filter((c) => c.state === 'available' || (c.state === 'off' && c.setUp))
    .filter((c) => fits(q, c.name, c.line))
  const shownCards = q || all ? cards : cards.slice(0, POPULAR_FIRST)

  // Your connectors: the built-in ones connected (or needing a new sign-in), the person's own connections, and what the
  // team provides (useFromTeam), one line each, by name
  const yours: { name: string; row: ReactNode }[] = [
    ...builtIns.filter((c) => c.state === 'added' || c.state === 'reconnect').filter((c) => fits(q, c.name)).map((c) => ({ name: c.name, row: (
      <ConnectorRow key={c.id} id={c.id} logo={c.logo} name={c.name} status={c.state === 'reconnect' ? 'reconnect' : 'connected'} onOpen={c.onOpen} />
    ) })),
    ...mine.filter((i) => fits(q, i.name, i.url)).map((i) => {
      // added but never signed in: not connected yet, so its line says what its page says ("로그인 필요", QA TC-205),
      // never "Connected" or "Reconnect"
      const c = connectorFor(i.url)
      return { name: i.name, row: (
        <ConnectorRow key={i.id} id={i.id} logo={c ? connectorLogo(c) : undefined} name={i.name}
          status={connectionRowStatus(i)} onOpen={() => navigate(connectionHref(i.id))} />
      ) }
    }),
    ...fromTeam.rows,
  ].sort((a, b) => a.name.localeCompare(b.name))

  const loading = !list.data && !list.error
  const nothing = !!q && fromTeam.ready && !cards.length && !yours.length
  // nothing connected and nothing this person can add (the team has set nothing up for members): say so once
  const empty = !q && !loading && fromTeam.ready && !cards.length && !yours.length
  const headActions = (
    <>
      <div className="relative w-[calc(100vw-2rem)] min-w-0 sm:w-60">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('integrations.search')} aria-label={t('integrations.search')} className={`${inputCls} pl-9`} data-testid="connector-search" />
      </div>
      {personalAllowed && admin && (
        <Button onClick={() => setDialog({})} data-testid="integration-add">
          <Plus size={15} aria-hidden /> {t('connectorsPage.addCustom')}
        </Button>
      )}
    </>
  )
  return (
    <div data-testid="integrations">
      {/* the section's top, like Settings' other sections: its name (a phone's bar says it, so there for screen readers
          only), one line, the search and Add; it scrolls with the list (QA TC-262) */}
      <div data-testid="connectors-header">
        <h2 className="text-base font-semibold max-md:sr-only">{t('integrations.title')}</h2>
        <p className="mt-1 text-sm text-muted max-md:mt-0">{t('connectorsPage.desc')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">{headActions}</div>
      </div>
      <div className="mt-6 space-y-8 pb-6">
        {/* what an admin asked this person to connect: answered, its own page, with its row */}
        <MyRequests version={requests} onConnected={(i, signIn) => { actions.saved(i, signIn, !list.data?.items.some((x) => x.id === i.id)); navigate(connectionHref(i.id)) }} />
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
                <h3 id="connectors-yours" className="mb-1 text-sm font-semibold">{t('connectors.yours')}</h3>
                <ul data-testid="connected-apps">{yours.map((x) => x.row)}</ul>
              </section>
            )}
            {!q && <SlackAccount />}
            {cards.length > 0 && (
              <section aria-labelledby="connectors-discover" data-testid="connector-discover">
                <div className="mb-1 flex items-center gap-2">
                  <h3 id="connectors-discover" className="text-sm font-semibold" data-testid="connector-discover-title">{q ? t('connectors.results') : t('connectors.discover')}</h3>
                  {!q && cards.length > POPULAR_FIRST && (
                    // a text link; on a phone 44 px tall (and at least as wide), still without a box
                    <button type="button" className="touch-hit ml-auto text-sm text-muted hover:text-ink max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-end" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
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

/** /settings/connectors/:id: a built-in card's page, or a listed service's. */
function ConnectorPage() {
  const { id = '' } = useParams()
  const { google, asks, admin } = useConnectors()
  if (id === 'google-drive') return <DrivePage />
  if (isGoogleApp(id)) {
    if (!google.apps) return <PageSkeleton />
    const v = google.apps.find((x) => x.id === id)
    if (!v) return <Navigate to={CONNECTORS_HOME} replace />
    // a member, the team has not set it up, never connected: ask an admin to add it (once the server says what was asked)
    const ask = !admin && asks.ready && v.reason === 'not_set_up' && v.status === 'disconnected'
      ? { state: asks.stateOf(v.id), busy: asks.busy === v.id, onAsk: () => void asks.ask(v.id, builtInName(v.id), () => void google.load()), onWithdraw: () => void asks.withdraw(v.id), error: asks.error?.service === v.id ? asks.error.text : null }
      : undefined
    return <GoogleAppDetail v={v} g={google} ask={ask} />
  }
  const c = CONNECTORS.find((x) => x.id === id)
  return c ? <ListedPage c={c} /> : <Navigate to={CONNECTORS_HOME} replace />
}

function PageSkeleton() {
  return <Skeleton lines={6} />
}

/** Google Drive's page: Trina's own connector, the same layout as the Google apps'. */
function DrivePage() {
  const t = useT()
  const { drive, asks, admin } = useConnectors()
  const p = useDriveParts(drive)
  const id: BuiltInId = 'google-drive'
  const name = builtInName(id)
  const ready = p.linked && !p.reconnect
  // a member, the team has not set Google Drive up: "Ask admin to add it" in place of the Connect button that cannot
  // work and of "Your admin needs to turn this on"; once asked, when they will hear
  const ask = !admin && asks.ready && p.unavailable && !p.linked && !p.shares.length ? asks.stateOf(id) : null
  const askError = ask && asks.error?.service === id ? asks.error.text : null
  const line = ask === 'none' ? null : ask ? t('serviceRequest.waiting', { name }) : p.line !== t('drive.cardDesc') ? p.line : null
  // the phone app (QA TC-262): no Google sign-in here, connecting is done on a computer. What it is now (Connected and
  // the account, Reconnect required, why it is off), Disconnect once there is a connection, and one line to connect (or
  // connect again) on a computer when that can be done there. A member's "Ask admin to add it" and an owner or admin's
  // "Set it up" stay: they work on a phone.
  const inApp = !!mobileApp() && !!drive.connection && !ask && !(p.unavailable && admin)
  const onComputer = inApp && !p.unavailable && (!p.linked || p.reconnect)
    ? t(p.linked ? 'integrations.reconnectOnComputer' : 'integrations.onComputer', { name }) : null
  const appActions = p.linked ? (
    <>
      {ready && <span className="flex items-center gap-1 text-sm text-ok" data-testid="drive-connected"><Check size={14} aria-hidden />{t('drive.status.connected')}</span>}
      <Button busy={drive.d.busy} onClick={() => void drive.disconnect()} data-testid="drive-disconnect">{t('drive.disconnect')}</Button>
    </>
  ) : null
  return (
    <AppDetail embedded inSettings testId="drive-detail" state={p.state} logo={builtInLogo(id)} name={name} byLine={t('gapps.byLineDrive', { line: t(lineKey(id)) })}
      actions={ask ? <AskAdminAction state={ask} busy={asks.busy === id} onAsk={() => void asks.ask(id, name, drive.load)} onWithdraw={() => void asks.withdraw(id)} />
        : inApp ? appActions
        : p.action}
      status={(line || onComputer || askError || p.busy || p.shares.length > 0 || drive.d.error || drive.revokeWarning) ? <>
        {line && <Note tone={p.reconnect ? 'warn' : undefined} testId={ask ? 'service-asked-note' : 'drive-detail-line'}>{line}</Note>}
        {onComputer && <Note testId="drive-on-computer">{onComputer}</Note>}
        {askError && <Note tone="warn" testId="service-ask-error">{askError}</Note>}
        <div className="empty:hidden">{p.steps}</div>
        <DriveTeamShares shares={p.shares} />
      </> : undefined}
      about={t(aboutKey(id))} canChange={false}
      developer={t('gapps.dev.trina')} category={t('gapps.drive.category')} signIn={GOOGLE} links={{ by: GOOGLE, privacy: GOOGLE_PRIVACY, terms: GOOGLE_TERMS }}
      tools={DRIVE_TOOL_LIST.map((x) => ({ name: x.name, title: t(`gapps.drive.tool.${x.name}`), changes: x.changes }))} />
  )
}

/** A listed service's page (its connection, once there is one, with everything its row offers). */
function ListedPage({ c }: { c: Connector }) {
  const t = useT()
  const navigate = useNavigate()
  const { list, setDialog, asks, admin } = useConnectors()
  const mine = list.data ? splitByScope(list.data.items).mine : []
  const have = mine.filter((i) => servesAt(c, i.url))
  // a member whose team has no working connection to it they may use (at any of its official addresses): ask an admin
  // to add it for the team (QA TC-133); one who may connect their own keeps Connect, with the ask under it. Their own
  // open request always shows ("Request sent", "Cancel request"), whatever team connections exist meanwhile (one not
  // connected yet does not end it: QA final)
  const teamWorks = !!list.data && splitByScope(list.data.items).team.some((i) => servesAt(c, i.url) && i.status === 'connected')
  const asked = isRequestableService(c.id) && asks.stateOf(c.id) !== 'none'
  const askFor = !admin && asks.ready && !!list.data && !have.length && isRequestableService(c.id) && (asked || !teamWorks) ? c.id : null
  const own = !!list.data?.personalAllowed
  return (
    <McpShell>
      <ConnectorDetail testId="connector-detail" logo={connectorLogo(c)} name={c.name} line={t(`integrations.catalog.${c.id}`)} official onBack={() => navigate(CONNECTORS_HOME)}
        action={have.length ? <span className="text-sm text-ok" data-testid="connector-detail-added">{t('drive.status.connected')}</span>
          : own ? <Button variant="primary" onClick={() => setDialog({ connector: c })} data-testid="connector-connect">{t('aiApps.connect')}</Button>
          : askFor ? <AskAdminAction state={asks.stateOf(askFor)} busy={asks.busy === askFor} onAsk={() => void asks.ask(askFor, c.name)} onWithdraw={() => void asks.withdraw(askFor)} /> : null}
        description={t('connectors.mcp.about', { name: c.name })} address={have.length ? undefined : c.url} docs={have.length ? undefined : CONNECTOR_DOCS[c.id]} noTools={have.length > 0}>
        {askFor && <ListedAsk asks={asks} service={askFor} name={c.name} inline={own} />}
        {have.length > 0 && <MineRows items={have} />}
      </ConnectorDetail>
    </McpShell>
  )
}

/** /settings/connectors/mcp/:integrationId: one of the person's own connections (added by address, from the list or
 * from a team template), or a team connection they may use (read-only: its state, its tools, "Run without asking"). */
function CustomConnectorPage() {
  const t = useT()
  const navigate = useNavigate()
  const { integrationId = '' } = useParams()
  const { list } = useConnectors()
  if (!list.data) return <PageSkeleton />
  const i = list.data.items.find((x) => x.id === integrationId)
  if (!i) return <Navigate to={CONNECTORS_HOME} replace />
  const c = connectorFor(i.url)
  return (
    <McpShell>
      <ConnectorDetail testId="connector-detail" logo={c ? connectorLogo(c) : '/favicon.svg'} name={i.name} line={c ? t(`integrations.catalog.${c.id}`) : i.url} official={!!c} onBack={() => navigate(CONNECTORS_HOME)}
        description={t(i.scope === 'team' ? 'connectors.mcp.aboutTeam' : 'connectors.mcp.about', { name: i.name })} noTools>
        <MineRows items={[i]} readOnly={i.scope === 'team'} />
      </ConnectorDetail>
    </McpShell>
  )
}

/** A connection's page (inside Settings' column, which scrolls it); the privacy note (moved off the list) at its end. */
function McpShell({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="pb-6">
      {children}
      <p className="mt-8 text-xs text-faint" data-testid="connector-privacy">{t('integrations.privacy')}</p>
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
  useEffect(() => { if (!ids) navigate(CONNECTORS_HOME, { replace: true }) }, [ids, navigate])
  return (
    <ul className="-mx-2 divide-y divide-line rounded-xl bg-surface" data-testid="integrations-mine">
      {items.map((i) => <IntegrationRow key={i.id} i={i} actions={actions} readOnly={readOnly} onEdit={() => setDialog({ existing: i })} />)}
    </ul>
  )
}
