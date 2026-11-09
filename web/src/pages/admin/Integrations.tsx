// Admin › Connectors (/admin/connectors; MCP and App connectors were two pages before, their addresses lead here):
// Yours is the team's connections (company accounts), templates and requests, and who may use each one in their chats —
// the whole team, groups, people. Admins manage them all but use one in their own chats only when the rule includes
// them, so each row says so. Members' personal connections are not listed (nobody but the owner can use those).
// Discover lists Google Drive first (its page: on or not, how many members use it, the one-time Google setup), then known
// MCP services; a card opens its page, whose Connect adds it with one team key and whose ⌄ makes it a template.
// "Add" takes any MCP server or API by its address, either for the
// team with one key or as a template each member connects with their own key (components/integrations/TemplatesView.tsx).
// Its ⌄ menu also asks one member to connect a service as their own (a popup, components/integrations/RequestDialog.tsx);
// such a request is a row in the same list while it waits, and for a while after it was declined or expired.
import { Cable, Plus, Send } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { DriveAdminStatus, Group, Integration, IntegrationRequest, IntegrationTemplate, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { APP_CONNECTORS, appConnectorLogo, type Connector } from '../../lib/connectors'
import { canonicalService, covers, isEmptyAccess, NOBODY, type RequestForm } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { reloadAsked } from '../../store/live'
import { Badge, EmptyState, TabPanel } from '../../components/ui'
import { afterAdded, ConnectorDetail, ConnectorDiscover, ConnectorsHeader, matchesQuery, SplitAction, type ConnectorTab } from '../../components/integrations/ConnectorsView'
import { DriveAdminDetail, driveAdminLine, driveAdminOn, DriveSetupDialog } from '../../components/integrations/DriveConnector'
import { DriveAdminSettings } from '../../components/integrations/DriveShares'
import { useSearchParams } from 'react-router-dom'
import { IntegrationDialog } from '../../components/integrations/IntegrationDialog'
import { RequestDialog, RequestRow, requestFormOf, shownRequests, useTeamRequests } from '../../components/integrations/RequestDialog'
import { IntegrationRow, useIntegrationActions } from '../../components/integrations/IntegrationRow'
import { TemplateRow } from '../../components/integrations/TemplatesView'
import { toast } from '../../store/ui'
import { Loadable, PageScope, useLoad } from './common'

export default function AdminIntegrations() {
  const t = useT()
  const me = useMeStrict()
  const state = useLoad(async () => (await api.call(API.listTeamIntegrations)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  // an older server has no templates: the page works without them
  const templates = useLoad(async () => { try { return (await api.call(API.listTeamIntegrationTemplates)).items } catch { return [] as IntegrationTemplate[] } })
  const [dialog, setDialog] = useState<{ existing?: Integration; template?: IntegrationTemplate; connector?: Connector; startAs?: 'team' | 'template' } | null>(null)
  // Google Drive on this server (an older server has no such address: Drive is then left out)
  const drive = useLoad(async () => { try { return await api.call(API.driveAdminStatus) } catch { return null as DriveAdminStatus | null } })
  const [driveSetup, setDriveSetup] = useState(false)
  // a connector's page, opened from Discover (or ?drive=1)
  const [open, setOpen] = useState<{ kind: 'drive' } | { kind: 'mcp'; c: Connector } | null>(null)
  const [params, setParams] = useSearchParams()
  const requests = useTeamRequests()
  const [ask, setAsk] = useState<{ initial?: RequestForm } | null>(null)
  const [tab, setTab] = useState<ConnectorTab>('connected')
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
  const panels = useId()
  useEffect(() => {
    if (params.get('drive') !== '1') return
    setTab('discover')
    setOpen({ kind: 'drive' })
    setParams((p) => { p.delete('drive'); return p }, { replace: true })
  }, [params, setParams])
  const DRIVE = APP_CONNECTORS[0]
  const back = () => setOpen(null)
  return (
    <>
      <ConnectorsHeader
        title={t('admin.integrations')}
        scope={<PageScope />}
        tab={tab}
        onTab={(x) => { setTab(x); setOpen(null) }}
        query={query}
        onQuery={setQuery}
        onAdd={() => setDialog({})}
        moreAdd={[
          { label: t('integrations.addTeam'), icon: <Plus size={15} aria-hidden />, onSelect: () => setDialog({}), testId: 'integration-add-team' },
          { label: t('integrations.requests.add'), icon: <Send size={15} aria-hidden />, onSelect: () => setAsk({}), testId: 'integration-request-add' },
        ]}
        panels={panels}
      />
      {/* what this page is for, right under its title (not lost between the list and the requests) */}
      {tab === 'connected' && <p className="mb-4 text-sm text-muted" data-testid="team-integrations-note">{t('integrations.admin.desc')}</p>}
      <TabPanel base={panels} value={tab}>
      <Loadable state={state}>
        {(list) => {
          const tpls = templates.data ?? []
          if (tab === 'discover') {
            const d = drive.data
            if (open?.kind === 'drive' && d) return (
              <DriveAdminDetail status={d} onSetUp={() => setDriveSetup(true)} onBack={back}>
                <DriveAdminSettings status={d} onStatus={(st) => drive.setData(st)} />
              </DriveAdminDetail>
            )
            if (open?.kind === 'mcp') {
              const c = open.c
              const have = [...list, ...tpls].find((i) => canonicalService(i.url) === canonicalService(c.url))
              const tools = list.find((i) => canonicalService(i.url) === canonicalService(c.url))?.tools.map((x) => x.name)
              return (
                <ConnectorDetail testId="connector-detail" logo={`/icons/connectors/${c.logo}`} name={c.name} line={t(`integrations.catalog.${c.id}`)} official onBack={back}
                  action={have ? <span className="text-sm text-ok" data-testid="connector-detail-added">{t('drive.status.connected')}</span> : (
                    <SplitAction label={t('aiApps.connect')} testId="connector-connect" onPrimary={() => setDialog({ connector: c })}
                      items={[
                        { label: t('connectors.connectTeam'), onSelect: () => setDialog({ connector: c }), testId: 'connector-connect-team' },
                        { label: t('connectors.connectTemplate'), onSelect: () => setDialog({ connector: c, startAs: 'template' }), testId: 'connector-connect-template' },
                      ]} />
                  )}
                  description={t('connectors.mcp.about', { name: c.name })} tools={tools} />
              )
            }
            // a Google client alone is "Ready to set up", not on: on is members connecting their own, or a share
            const driveCard = d ? [{ id: DRIVE.id, name: DRIVE.name, logo: appConnectorLogo(DRIVE), line: d.configured && !driveAdminOn(d) ? t('driveAdmin.ready') : driveAdminLine(t, d), state: driveAdminOn(d) ? 'added' as const : 'available' as const }] : []
            return <ConnectorDiscover connected={[...list, ...tpls]} query={query} onAdd={(c) => setDialog({ connector: c })} onCustom={() => setDialog({})}
              builtIns={driveCard} onOpenBuiltIn={() => setOpen({ kind: 'drive' })} onAddBuiltIn={() => { setOpen({ kind: 'drive' }); if (d?.canSetUp && !d.configured) setDriveSetup(true) }}
              onOpen={(c) => setOpen({ kind: 'mcp', c })} />
          }
          const reqs = shownRequests(requests.list)
          if (!list.length && !tpls.length && !reqs.length) {
            return (
              <EmptyState icon={<Cable size={26} />} title={t('integrations.admin.empty')}>
                <p>{t('integrations.admin.emptyHint')}</p>
              </EmptyState>
            )
          }
          const shown = [...list].filter((i) => matchesQuery(i, query)).sort((a, b) => a.name.localeCompare(b.name))
          const q = query.trim().toLocaleLowerCase()
          const shownTpls = tpls.filter((x) => !q || x.name.toLocaleLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))
          const shownReqs = reqs.filter((r) => !q || `${r.name} ${r.url} ${r.user.name}`.toLocaleLowerCase().includes(q))
          if (!shown.length && !shownTpls.length && !shownReqs.length) return <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
          return (
            <ul className="-mx-2 divide-y divide-line" data-testid="team-integrations">
              {shownTpls.map((x) => (
                <TemplateRow key={x.id} tpl={x} groups={groups.data ?? []} users={users.data ?? []} onEdit={() => setDialog({ template: x })} onDeleted={() => void templates.reload()} />
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
          )
        }}
      </Loadable>
      </TabPanel>
      {ask && (
        <RequestDialog
          users={users.data ?? []}
          initial={ask.initial}
          onClose={() => setAsk(null)}
          onSent={(r) => {
            requests.sent(r)
            if (tab === 'discover') setTab('connected')
          }}
        />
      )}
      {driveSetup && drive.data && (
        <DriveSetupDialog status={drive.data} onClose={() => setDriveSetup(false)} onSaved={(st) => { drive.setData(st); setDriveSetup(false) }} />
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
            void templates.reload()
            toast({ level: 'success', text: t(made ? 'integrations.template.made' : 'common.saved') })
            if (tab === 'discover') { setOpen(null); afterAdded(setTab, setQuery) }
          }}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
            if (tab === 'discover') { setOpen(null); afterAdded(setTab, setQuery) }
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
