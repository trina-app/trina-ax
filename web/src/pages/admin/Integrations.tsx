// Admin › Connectors (/admin/connectors; MCP and App connectors were two pages before, their addresses lead here), in the
// same layout as the Connectors page (pages/Connectors.tsx), with what only an admin does inside it. The Admin shell says
// whose these are ("Applies to everyone in <team>" above every Admin page, AdminLayout.tsx). On top the title, the
// search and Add (any MCP server or API by its address, for the team with one key or as a template each member connects
// with their own key; its ⌄ also asks one member to connect a service as their own, RequestDialog.tsx). Then two
// sections, one line each:
// - **Connected**: the Google connectors that are on (members may connect their own, or a Drive is shared with the
//   team), the team's connections (a warning on the line when nobody may use one, or not the admin looking), its
//   templates (TemplatesView.tsx) and the requests to members while they wait (and for a while after).
// - **Discover**: what is not on yet: Google Drive, Gmail, Google Calendar, Google Docs, Google Sheets, then the listed
//   MCP services (lib/connectors.ts), the first ten and Show all. A row opens its page; its + sets a Google one up (or
//   opens its page) and adds a listed service for the team.
// Pages, each its own address: a Google connector's (/admin/connectors/<id>, GoogleAdminPage.tsx: the member's page with
// Team settings; the old ?drive=1 and ?app=gmail lead there, AdminLayout.tsx), a listed service's (ConnectorDetail:
// Connect ⌄ for the team or as a template) and a team connection's (/admin/connectors/mcp/<id>: its row with who may use
// it, test, edit, delete and its tools). Members' personal connections are not listed (nobody but the owner can use
// those).
import { Plus, Send } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { DriveAdminStatus, GoogleAppAdminStatus, GoogleAppId, GoogleAppView, Group, Integration, IntegrationRequest, IntegrationTemplate, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { connectorFor, connectorLogo, CONNECTORS, isConnected, type Connector } from '../../lib/connectors'
import { canonicalService, connectionRowStatus, covers, isEmptyAccess, NOBODY, type RequestForm } from '../../lib/integrations'
import { builtInLogo, builtInName, BUILT_IN_ORDER, fits, isGoogleApp, type BuiltInId } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { reloadAsked } from '../../store/live'
import { Badge, EmptyState, useMediaQuery } from '../../components/ui'
import { ConnectorDetail, ConnectorRow, ConnectorsHeader, DiscoverCard, DISCOVER_FIRST, goToSection, matchesQuery, sectionTitleCls, SplitAction, useSectionIds, type DiscoverItem } from '../../components/integrations/ConnectorsView'
import { driveAdminLine, driveAdminOn, DriveSetupDialog } from '../../components/integrations/DriveConnector'
import { googleAppAdminLine, googleAppAdminOn, GoogleAppSetupDialog } from '../../components/integrations/GoogleAppAdmin'
import { DriveAdminPage, GoogleAppAdminPage } from '../../components/integrations/GoogleAdminPage'
import { IntegrationDialog } from '../../components/integrations/IntegrationDialog'
import { RequestDialog, RequestRow, requestFormOf, shownRequests, useTeamRequests } from '../../components/integrations/RequestDialog'
import { AudienceChip, IntegrationRow, useIntegrationActions } from '../../components/integrations/IntegrationRow'
import { TemplateRow } from '../../components/integrations/TemplatesView'
import { toast } from '../../store/ui'
import { Loadable, useLoad } from './common'
import { useAdminBar, useUpTo } from './phoneBar'

type Open = { kind: 'drive' } | { kind: 'gapp'; id: GoogleAppId } | { kind: 'listed'; c: Connector } | { kind: 'team'; id: string }

export default function AdminIntegrations() {
  const t = useT()
  const me = useMeStrict()
  const state = useLoad(async () => (await api.call(API.listTeamIntegrations)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  // an older server has no templates: the page works without them
  const templates = useLoad(async () => { try { return (await api.call(API.listTeamIntegrationTemplates)).items } catch { return [] as IntegrationTemplate[] } })
  // toList: opened from Discover or while a connector's page is open; once added, the page shows the list with it
  const [dialog, setDialog] = useState<{ existing?: Integration; template?: IntegrationTemplate; connector?: Connector; startAs?: 'team' | 'template'; toList?: boolean } | null>(null)
  // Google Drive on this server (an older server has no such address: Drive is then left out)
  const drive = useLoad(async () => { try { return await api.call(API.driveAdminStatus) } catch { return null as DriveAdminStatus | null } })
  const [driveSetup, setDriveSetup] = useState(false)
  // Gmail, Google Calendar, Google Docs and Google Sheets on this server (an older server has none): set up per card
  const gapps = useLoad(async () => { try { return (await api.call(API.googleAppsAdminStatus)).apps } catch { return [] as GoogleAppAdminStatus[] } })
  // the admin's own view of them (Connectors'), for each page's tools
  const views = useLoad(async () => { try { return (await api.call(API.myGoogleApps)).apps } catch { return [] as GoogleAppView[] } })
  const [gappSetup, setGappSetup] = useState<GoogleAppId | null>(null)
  const setGapp = (st: GoogleAppAdminStatus) => gapps.setData((a) => a?.map((x) => (x.id === st.id ? st : x)) ?? a)
  // a page: /admin/connectors/<id> (a Google connector, a listed service) or /admin/connectors/mcp/<id> (a team
  // connection), in place of the list; the way back returns to the list
  const { sub, item } = useParams()
  const navigate = useNavigate()
  const upTo = useUpTo()
  const open: Open | null = !sub ? null
    : sub === 'google-drive' ? { kind: 'drive' }
      : isGoogleApp(sub) ? { kind: 'gapp', id: sub }
        : sub === 'mcp' ? (item ? { kind: 'team', id: item } : null)
          : (() => { const c = CONNECTORS.find((x) => x.id === sub); return c ? { kind: 'listed' as const, c } : null })()
  const pathOf = (o: Open) => (o.kind === 'drive' ? '/admin/connectors/google-drive' : o.kind === 'gapp' ? `/admin/connectors/${o.id}` : o.kind === 'listed' ? `/admin/connectors/${o.c.id}` : `/admin/connectors/mcp/${o.id}`)
  const setOpen = (o: Open | null) => {
    if (!o) { if (sub) upTo('/admin/connectors'); return }
    navigate(pathOf(o))
  }
  // an address of a connector this page does not know (a typo, an old link), or a team connection that is gone: the list
  const teamGone = open?.kind === 'team' && !!state.data && !state.data.some((i) => i.id === open.id)
  useEffect(() => { if ((sub && !open) || teamGone) navigate('/admin/connectors', { replace: true }) }, [sub, open, teamGone, navigate])
  // the phone's bar names the connector whose page this is
  const teamOpen = open?.kind === 'team' ? state.data?.find((i) => i.id === open.id) : undefined
  useAdminBar(open ? (open.kind === 'drive' || open.kind === 'gapp' ? builtInName(open.kind === 'drive' ? 'google-drive' : open.id) : open.kind === 'listed' ? open.c.name : teamOpen?.name ?? '') : null)
  const requests = useTeamRequests()
  const [ask, setAsk] = useState<{ initial?: RequestForm } | null>(null)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const reloadList = state.reload
  const reload = useCallback(() => void reloadList(), [reloadList])
  useEffect(() => reloadAsked.on(() => void reloadList()), [reloadList])
  const actions = useIntegrationActions({
    add: (i) => state.setData((d) => (d ? [...d, i] : d)),
    replace: (i) => state.setData((d) => d?.map((x) => (x.id === i.id ? i : x)) ?? d),
    reload,
  })
  const person = { id: me.user.id, groupIds: me.groups.map((g) => g.id) }
  const ids = useSectionIds()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const back = () => setOpen(null)
  // added from Discover (or from Add over a connector's page): the search is cleared (it was looking for what the new
  // row may not match) and the keyboard goes to the list the new row is in (once it is there: a template comes with the
  // list loaded again), since the button that opened the dialog is gone
  const added = (toList: boolean | undefined, listed?: Promise<unknown>) => {
    if (!toList) return
    setOpen(null)
    setQuery('')
    void Promise.resolve(listed).then(() => goToSection(ids.connected))
  }
  /** what needs the admin's attention stays on the line: nobody may use it, or the admin cannot */
  const accessWarning = (i: Integration) => {
    const nobody = isEmptyAccess(i.access ?? NOBODY)
    const notMine = !nobody && !covers(i.access, person)
    return (nobody || notMine) ? (
      <span className="inline-flex shrink-0" data-testid="integration-access-warning">
        <Badge tone="warn">{t(nobody ? 'integrations.users.nobody' : 'integrations.users.notMe')}</Badge>
      </span>
    ) : null
  }
  return (
    <>
      <ConnectorsHeader
        title={t('admin.integrations')}
        query={query}
        onQuery={(q) => { setQuery(q); setOpen(null) }}
        // a phone: adding a service by its address (kind, sign-in, headers) is a computer's job; Discover's line says so
        onAdd={phone ? undefined : () => setDialog({ toList: !!open })}
        moreAdd={[
          { label: t('integrations.addTeam'), icon: <Plus size={15} aria-hidden />, onSelect: () => setDialog({ toList: !!open }), testId: 'integration-add-team' },
          { label: t('integrations.requests.add'), icon: <Send size={15} aria-hidden />, onSelect: () => setAsk({}), testId: 'integration-request-add' },
        ]}
      />
      <Loadable state={state}>
        {(list) => {
          const tpls = templates.data ?? []
          const d = drive.data
          if (open?.kind === 'drive' && d) return <DriveAdminPage status={d} onSetUp={() => setDriveSetup(true)} onStatus={(st) => drive.setData(st)} />
          const gs = open?.kind === 'gapp' ? gapps.data?.find((x) => x.id === open.id) : undefined
          if (gs) return <GoogleAppAdminPage status={gs} view={views.data?.find((x) => x.id === gs.id)} onSetUp={() => setGappSetup(gs.id)} />
          if (open?.kind === 'listed') {
            const c = open.c
            const have = [...list, ...tpls].find((i) => canonicalService(i.url) === canonicalService(c.url))
            const tools = list.find((i) => canonicalService(i.url) === canonicalService(c.url))?.tools.map((x) => x.name)
            return (
              <ConnectorDetail testId="connector-detail" logo={connectorLogo(c)} name={c.name} line={t(`integrations.catalog.${c.id}`)} official onBack={back}
                action={have ? <span className="text-sm text-ok" data-testid="connector-detail-added">{t('drive.status.connected')}</span> : (
                  <SplitAction label={t('aiApps.connect')} menuLabel={t('connectors.connectMore')} testId="connector-connect" onPrimary={() => setDialog({ connector: c, toList: true })}
                    items={[
                      { label: t('connectors.connectTeam'), onSelect: () => setDialog({ connector: c, toList: true }), testId: 'connector-connect-team' },
                      { label: t('connectors.connectTemplate'), onSelect: () => setDialog({ connector: c, startAs: 'template', toList: true }), testId: 'connector-connect-template' },
                    ]} />
                )}
                description={t('connectors.mcp.about', { name: c.name })} tools={tools} />
            )
          }
          if (open?.kind === 'team') {
            if (!teamOpen) return null
            const c = connectorFor(teamOpen.url)
            return (
              <ConnectorDetail testId="connector-detail" logo={c ? connectorLogo(c) : '/favicon.svg'} name={teamOpen.name} line={c ? t(`integrations.catalog.${c.id}`) : teamOpen.url} official={!!c} onBack={back}
                description={t('connectors.mcp.about', { name: teamOpen.name })} noTools>
                <ul className="-mx-2 divide-y divide-line rounded-xl bg-surface" data-testid="team-integrations">
                  <IntegrationRow i={teamOpen} actions={actions} onEdit={() => setDialog({ existing: teamOpen })}
                    audience={<AudienceChip access={teamOpen.access ?? NOBODY} groups={groups.data} users={users.data} />}
                    alert={accessWarning(teamOpen)}
                    extra={<AccessLine i={teamOpen} groups={groups.data ?? []} users={users.data ?? []} />} />
                </ul>
              </ConnectorDetail>
            )
          }

          const q = query.trim()
          // Google Drive and the Google apps this server knows: on (set up: everyone may connect their own; Connected) or
          // not yet (Discover)
          const builtIns: (DiscoverItem & { on: boolean })[] = BUILT_IN_ORDER.flatMap((id: BuiltInId): (DiscoverItem & { on: boolean })[] => {
            const openIt = () => setOpen(id === 'google-drive' ? { kind: 'drive' } : { kind: 'gapp', id })
            if (id === 'google-drive') {
              if (!d) return []
              const on = driveAdminOn(d)
              return [{ id, name: builtInName(id), logo: builtInLogo(id), line: driveAdminLine(t, d), on, state: on ? 'added' as const : 'available' as const,
                onOpen: openIt, onAdd: () => { openIt(); if (d.canSetUp && !d.configured) setDriveSetup(true) } }]
            }
            const g = gapps.data?.find((x) => x.id === id)
            if (!g) return []
            const on = googleAppAdminOn(g)
            return [{ id, name: builtInName(id), logo: builtInLogo(id), line: googleAppAdminLine(t, g), on, state: on ? 'added' as const : 'available' as const,
              onOpen: openIt, onAdd: () => { openIt(); if (g.canSetUp && !g.configured) setGappSetup(id) } }]
          })
          // Connected: one line each, by name; then the templates and the requests
          const rows: { name: string; row: ReactNode }[] = [
            ...builtIns.filter((b) => b.on && fits(q, b.name)).map((b) => ({ name: b.name, row: (
              <ConnectorRow key={b.id} id={b.id} logo={b.logo} name={b.name} status="on" onOpen={b.onOpen} />
            ) })),
            ...list.filter((i) => matchesQuery(i, query)).map((i) => {
              const c = connectorFor(i.url)
              return { name: i.name, row: (
                <ConnectorRow key={i.id} id={i.id} logo={c ? connectorLogo(c) : undefined} name={i.name} note={accessWarning(i)} testId="team-connection"
                  status={connectionRowStatus(i)}
                  onOpen={() => setOpen({ kind: 'team', id: i.id })} />
              ) }
            }),
          ].sort((a, b) => a.name.localeCompare(b.name))
          const shownTpls = tpls.filter((x) => fits(q, x.name)).sort((a, b) => a.name.localeCompare(b.name))
          const shownReqs = shownRequests(requests.list).filter((r) => fits(q, r.name, r.url, r.user.name))
          const connected = rows.length + shownTpls.length + shownReqs.length
          // Discover: what is not on yet, the Google ones first; the listed services the team has not connected
          const urls = [...list, ...tpls].map((i) => i.url)
          const listed: DiscoverItem[] = CONNECTORS.filter((c) => !isConnected(c, urls)).map((c) => ({
            id: c.id, name: c.name, line: t(`integrations.catalog.${c.id}`), logo: connectorLogo(c), state: 'available' as const,
            onOpen: () => setOpen({ kind: 'listed', c }), onAdd: () => setDialog({ connector: c, toList: true }),
          }))
          const cards = [...builtIns.filter((b) => !b.on), ...listed].filter((c) => fits(q, c.name, c.line))
          const shownCards = q || all ? cards : cards.slice(0, DISCOVER_FIRST)
          if (q && !connected && !cards.length) return <EmptyState title={t('integrations.noMatch', { q })} />
          return (
            <div className="space-y-8 pb-10">
              {/* nothing connected yet: no heading and no empty box, Discover leads under the title */}
              {connected > 0 && (
                <section aria-labelledby={ids.connected} data-testid="team-connected">
                  <h3 id={ids.connected} tabIndex={-1} className={`mb-1 ${sectionTitleCls}`}>{t('connectors.connected')}</h3>
                  <ul data-testid="connected-apps">{rows.map((x) => x.row)}</ul>
                  {(shownTpls.length > 0 || shownReqs.length > 0) && (
                    <ul className="-mx-2 divide-y divide-line border-t border-line" data-testid="team-integrations">
                      {shownTpls.map((x) => (
                        <TemplateRow key={x.id} tpl={x} groups={groups.data} users={users.data} onEdit={() => setDialog({ template: x })} onDeleted={() => void templates.reload()} />
                      ))}
                      {shownReqs.map((r: IntegrationRequest) => (
                        <RequestRow key={r.id} r={r} onWithdraw={() => void requests.withdraw(r)} onAskAgain={() => setAsk({ initial: requestFormOf(r) })} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
              {cards.length > 0 && (
                <section aria-labelledby={ids.discover} data-testid="connector-discover">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 id={ids.discover} tabIndex={-1} className={sectionTitleCls} data-testid="connector-discover-title">{q ? t('connectors.results') : t('connectors.discover')}</h3>
                    {!q && cards.length > DISCOVER_FIRST && (
                      // a text link; on a phone 44 px tall (and at least as wide), still without a box
                      <button type="button" className="touch-hit ml-auto text-sm text-muted hover:text-ink max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-end" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="connector-show-all">
                        {all ? t('connectors.showLess') : t('connectorsPage.showAll', { count: cards.length })}
                      </button>
                    )}
                  </div>
                  <ul className="grid gap-x-6 sm:grid-cols-2" data-testid="connector-list">
                    {shownCards.map((c) => <DiscoverCard key={c.id} c={c} admin />)}
                  </ul>
                  <p className="mt-5 text-sm text-muted" data-testid="connector-not-listed">
                    {t('integrations.discover.customHint')}{' '}
                    {phone ? <span data-testid="connector-custom-note">{t('admin.onComputerAdd')}</span> : (
                      <button type="button" className="font-medium text-accent-text underline underline-offset-2" onClick={() => setDialog({ toList: true })} data-testid="connector-custom">
                        {t('integrations.discover.custom')}
                      </button>
                    )}
                  </p>
                </section>
              )}
            </div>
          )
        }}
      </Loadable>
      {ask && (
        <RequestDialog
          users={users.data ?? []}
          initial={ask.initial}
          onClose={() => setAsk(null)}
          onSent={(r) => requests.sent(r)}
        />
      )}
      {driveSetup && drive.data && (
        <DriveSetupDialog status={drive.data} onClose={() => setDriveSetup(false)} onSaved={(st) => { drive.setData(st); setDriveSetup(false) }} />
      )}
      {gappSetup && gapps.data?.find((x) => x.id === gappSetup) && (
        <GoogleAppSetupDialog status={gapps.data.find((x) => x.id === gappSetup)!} onClose={() => setGappSetup(null)} onSaved={(st) => { setGapp(st); setGappSetup(null) }} />
      )}
      {dialog && (
        <IntegrationDialog
          scope="team"
          existing={dialog.existing}
          template={dialog.template}
          connector={dialog.connector}
          startAs={dialog.startAs}
          onClose={() => setDialog(null)}
          onSavedTemplate={() => {
            const made = !dialog.template
            setDialog(null)
            const listed = templates.reload()
            toast({ level: 'success', text: t(made ? 'integrations.template.made' : 'common.saved') })
            added(dialog.toList, listed)
          }}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
            added(dialog.toList)
          }}
        />
      )}
    </>
  )
}

/** "Used by: Finance, Bob" and who added it, in the details. Whether nobody or not the admin may use it is on the line. */
function AccessLine({ i, groups, users }: { i: Integration; groups: Group[]; users: User[] }) {
  const t = useT()
  const a = i.access ?? NOBODY
  if (isEmptyAccess(a) && !i.createdBy) return null
  const names = [
    ...a.groups.map((id) => groups.find((g) => g.id === id)?.name ?? '?'),
    ...a.users.map((id) => users.find((u) => u.id === id)?.name ?? '?'),
  ]
  const who = a.everyone ? t('integrations.access.everyone') : names.join(', ')
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="integration-access-line">
      {!isEmptyAccess(a) && <span className="text-muted">{t('integrations.users', { who })}</span>}
      {i.createdBy && <span className="text-faint">{t('integrations.createdBy', { name: i.createdBy.name })}</span>}
    </p>
  )
}
