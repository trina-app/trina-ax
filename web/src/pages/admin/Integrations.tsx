// Admin › Connectors (/admin/connectors; MCP and App connectors were two pages before, their addresses lead here). The
// Admin shell says whose these are ("Applies to everyone in <team>" above every Admin page, AdminLayout.tsx); the title
// is the same noun as Settings'. One page: first, under "Connected", the team's connections (company accounts),
// templates and requests, each with who may use it in a chip after its name (the whole team, groups, people). Admins
// manage them all but use one in their own chats only when the rule includes them, so each row says so. Members'
// personal connections are not listed (nobody but the owner can use those). Then Discover: Google Drive first (its page:
// on or not, how many members use it, the one-time Google setup), Gmail, Google Calendar, Google Docs and Google Sheets
// (each its own setup, GoogleAppAdmin.tsx; ?app=gmail opens one), then known MCP services; a card opens its page, whose
// Connect adds it with one team key and whose ⌄ makes it a template. Nothing connected yet: Discover right under the
// title. The search filters both sections. "Add" takes any MCP server or API by its address, either for the team with
// one key or as a template each member connects with their own key (components/integrations/TemplatesView.tsx). Its ⌄
// menu also asks one member to connect a service as their own (a popup, components/integrations/RequestDialog.tsx); such
// a request is a row in the same list while it waits, and for a while after it was declined or expired. ?drive=1 (a
// notice, the old App connectors address) opens Google Drive's page.
import { Plus, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { DriveAdminStatus, GoogleAppAdminStatus, GoogleAppId, Group, Integration, IntegrationRequest, IntegrationTemplate, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { APP_CONNECTORS, appConnectorLogo, CONNECTORS, type Connector } from '../../lib/connectors'
import { canonicalService, covers, isEmptyAccess, NOBODY, type RequestForm } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { reloadAsked } from '../../store/live'
import { Badge, EmptyState, useMediaQuery } from '../../components/ui'
import { ConnectorDetail, ConnectorDiscover, ConnectorsHeader, discoverHits, goToSection, matchesQuery, sectionTitleCls, SplitAction, useSectionIds } from '../../components/integrations/ConnectorsView'
import { DriveAdminDetail, driveAdminLine, driveAdminOn, DriveSetupDialog } from '../../components/integrations/DriveConnector'
import { DriveAdminSettings } from '../../components/integrations/DriveShares'
import { GoogleAppAdminDetail, googleAppAdminLine, googleAppAdminOn, GoogleAppSetupDialog } from '../../components/integrations/GoogleAppAdmin'
import { builtInLogo, builtInName, GOOGLE_APP_ORDER, isGoogleApp } from '../../lib/googleApps'
import { IntegrationDialog } from '../../components/integrations/IntegrationDialog'
import { RequestDialog, RequestRow, requestFormOf, shownRequests, useTeamRequests } from '../../components/integrations/RequestDialog'
import { AudienceChip, IntegrationRow, useIntegrationActions } from '../../components/integrations/IntegrationRow'
import { TemplateRow } from '../../components/integrations/TemplatesView'
import { toast } from '../../store/ui'
import { Loadable, useLoad } from './common'
import { useAdminBar, useUpTo } from './phoneBar'

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
  const [gappSetup, setGappSetup] = useState<GoogleAppId | null>(null)
  const setGapp = (st: GoogleAppAdminStatus) => gapps.setData((a) => a?.map((x) => (x.id === st.id ? st : x)) ?? a)
  // a connector's page, opened from Discover: its own address, /admin/connectors/<id> (the old ?drive=1 and ?app=gmail
  // lead there, AdminLayout.tsx), in place of the list; Back or its way back return to the list
  const { sub } = useParams()
  const navigate = useNavigate()
  const upTo = useUpTo()
  const open: { kind: 'drive' } | { kind: 'gapp'; id: GoogleAppId } | { kind: 'mcp'; c: Connector } | null = !sub ? null
    : sub === APP_CONNECTORS[0].id ? { kind: 'drive' }
      : isGoogleApp(sub) ? { kind: 'gapp', id: sub }
        : (() => { const c = CONNECTORS.find((x) => x.id === sub); return c ? { kind: 'mcp' as const, c } : null })()
  const setOpen = (o: { kind: 'drive' } | { kind: 'gapp'; id: GoogleAppId } | { kind: 'mcp'; c: Connector } | null) => {
    if (!o) { if (sub) upTo('/admin/connectors'); return }
    const id = o.kind === 'drive' ? APP_CONNECTORS[0].id : o.kind === 'gapp' ? o.id : o.c.id
    if (id !== sub) navigate(`/admin/connectors/${id}`)
  }
  // an address of a connector this page does not know (a typo, an old link): the list
  useEffect(() => { if (sub && !open) navigate('/admin/connectors', { replace: true }) }, [sub, open, navigate])
  // the phone's bar names the connector whose page this is
  useAdminBar(open ? (open.kind === 'drive' ? APP_CONNECTORS[0].name : open.kind === 'gapp' ? builtInName(open.id) : open.c.name) : null)
  const requests = useTeamRequests()
  const [ask, setAsk] = useState<{ initial?: RequestForm } | null>(null)
  const [query, setQuery] = useState('')
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
  const DRIVE = APP_CONNECTORS[0]
  // back from a connector's page: where it was opened from
  // (a computer: the keyboard to Discover; a phone keeps the list's place, lib/backStack.ts useKeptScroll)
  const back = () => { setOpen(null); if (!phone) goToSection(ids.discover) }
  // added from Discover (or from Add over a connector's page): the search is cleared (it was looking for what the new
  // row may not match) and the keyboard goes to the list the new row is in (once it is there: a template comes with the
  // list loaded again), since the button that opened the dialog is gone
  const added = (toList: boolean | undefined, listed?: Promise<unknown>) => {
    if (!toList) return
    setOpen(null)
    setQuery('')
    void Promise.resolve(listed).then(() => goToSection(ids.connected))
  }
  return (
    <>
      <ConnectorsHeader
        title={t('admin.integrations')}
        query={query}
        onQuery={(q) => { setQuery(q); setOpen(null) }}
        onAdd={() => setDialog({ toList: !!open })}
        moreAdd={[
          { label: t('integrations.addTeam'), icon: <Plus size={15} aria-hidden />, onSelect: () => setDialog({ toList: !!open }), testId: 'integration-add-team' },
          { label: t('integrations.requests.add'), icon: <Send size={15} aria-hidden />, onSelect: () => setAsk({}), testId: 'integration-request-add' },
        ]}
      />
      <Loadable state={state}>
        {(list) => {
          const tpls = templates.data ?? []
          const d = drive.data
          if (open?.kind === 'drive' && d) return (
            <DriveAdminDetail status={d} onSetUp={() => setDriveSetup(true)} onBack={back}>
              <DriveAdminSettings status={d} onStatus={(st) => drive.setData(st)} />
            </DriveAdminDetail>
          )
          const gs = open?.kind === 'gapp' ? gapps.data?.find((x) => x.id === open.id) : undefined
          if (gs) return <GoogleAppAdminDetail status={gs} onSetUp={() => setGappSetup(gs.id)} onStatus={setGapp} onBack={back} />
          if (open?.kind === 'mcp') {
            const c = open.c
            const have = [...list, ...tpls].find((i) => canonicalService(i.url) === canonicalService(c.url))
            const tools = list.find((i) => canonicalService(i.url) === canonicalService(c.url))?.tools.map((x) => x.name)
            return (
              <ConnectorDetail testId="connector-detail" logo={`/icons/connectors/${c.logo}`} name={c.name} line={t(`integrations.catalog.${c.id}`)} official onBack={back}
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
          // a Google client alone is "Ready to set up", not on: on is members connecting their own, or a share
          const driveCard = [
            ...(d ? [{ id: DRIVE.id, name: DRIVE.name, logo: appConnectorLogo(DRIVE), line: d.configured && !driveAdminOn(d) ? t('driveAdmin.ready') : driveAdminLine(t, d), state: driveAdminOn(d) ? 'added' as const : 'available' as const }] : []),
            ...GOOGLE_APP_ORDER.flatMap((id) => {
              const g = gapps.data?.find((x) => x.id === id)
              return g ? [{ id, name: builtInName(id), logo: builtInLogo(id), line: googleAppAdminLine(t, g), state: googleAppAdminOn(g) ? 'added' as const : 'available' as const }] : []
            }),
          ]
          const reqs = shownRequests(requests.list)
          const q = query.trim().toLocaleLowerCase()
          const shown = [...list].filter((i) => matchesQuery(i, query)).sort((a, b) => a.name.localeCompare(b.name))
          const shownTpls = tpls.filter((x) => !q || x.name.toLocaleLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))
          const shownReqs = reqs.filter((r) => !q || `${r.name} ${r.url} ${r.user.name}`.toLocaleLowerCase().includes(q))
          const rows = shown.length + shownTpls.length + shownReqs.length
          if (q && !rows && !discoverHits(t, query, driveCard).count) return <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
          // nothing connected yet: no heading and no empty box, Discover leads under the line above
          return (
            <>
              {rows > 0 && (
                <section aria-labelledby={ids.connected} data-testid="team-connected">
                  <h3 id={ids.connected} tabIndex={-1} className={`mb-1 ${sectionTitleCls}`}>{t('connectors.connected')}</h3>
                  <ul className="-mx-2 divide-y divide-line" data-testid="team-integrations">
                    {shownTpls.map((x) => (
                      <TemplateRow key={x.id} tpl={x} groups={groups.data} users={users.data} onEdit={() => setDialog({ template: x })} onDeleted={() => void templates.reload()} />
                    ))}
                    {shown.map((i) => {
                      // what needs the admin's attention stays on the line: nobody may use it, or the admin cannot
                      const nobody = isEmptyAccess(i.access ?? NOBODY)
                      const notMine = !nobody && !covers(i.access, person)
                      return (
                        <IntegrationRow
                          key={i.id}
                          i={i}
                          actions={actions}
                          onEdit={() => setDialog({ existing: i })}
                          audience={<AudienceChip access={i.access ?? NOBODY} groups={groups.data} users={users.data} />}
                          alert={(nobody || notMine) && (
                            <span className="inline-flex" data-testid="integration-access-warning">
                              <Badge tone="warn">{t(nobody ? 'integrations.users.nobody' : 'integrations.users.notMe')}</Badge>
                            </span>
                          )}
                          extra={<AccessLine i={i} groups={groups.data ?? []} users={users.data ?? []} />}
                        />
                      )
                    })}
                    {shownReqs.map((r: IntegrationRequest) => (
                      <RequestRow key={r.id} r={r} onWithdraw={() => void requests.withdraw(r)} onAskAgain={() => setAsk({ initial: requestFormOf(r) })} />
                    ))}
                  </ul>
                </section>
              )}
              <ConnectorDiscover titleId={ids.discover} className={rows > 0 ? 'mt-6 border-t border-line pt-6' : undefined} connected={[...list, ...tpls]} query={query}
                onAdd={(c) => setDialog({ connector: c, toList: true })} onCustom={() => setDialog({ toList: true })}
                builtIns={driveCard}
                onOpenBuiltIn={(id) => setOpen(isGoogleApp(id) ? { kind: 'gapp', id } : { kind: 'drive' })}
                onAddBuiltIn={(id) => {
                  if (isGoogleApp(id)) {
                    setOpen({ kind: 'gapp', id })
                    const g = gapps.data?.find((x) => x.id === id)
                    if (g?.canSetUp && !g.configured) setGappSetup(id)
                    return
                  }
                  setOpen({ kind: 'drive' }); if (d?.canSetUp && !d.configured) setDriveSetup(true)
                }}
                onOpen={(c) => setOpen({ kind: 'mcp', c })} />
            </>
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
