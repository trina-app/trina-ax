// Admin > MCP (called "External services" before; the address is still /admin/integrations):
// the team's connections (company accounts) and who may use each one in their chats —
// the whole team, groups, people. Admins manage them all but use one in their own chats only when the rule includes
// them, so each row says so. Members' personal connections are not listed (nobody but the owner can use those); below,
// the requests that ask a member to connect a service as their own (components/integrations/RequestDialog.tsx).
// "Discover" adds a known service by name; "Add connection" takes any MCP server or API by its address.
import { Cable } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { Group, Integration, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import type { Connector } from '../../lib/connectors'
import { covers, isEmptyAccess, NOBODY } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { reloadAsked } from '../../store/live'
import { Badge, EmptyState, TabPanel } from '../../components/ui'
import { afterAdded, ConnectorDiscover, ConnectorsHeader, matchesQuery, type ConnectorTab } from '../../components/integrations/ConnectorsView'
import { IntegrationDialog } from '../../components/integrations/IntegrationDialog'
import { TeamRequests } from '../../components/integrations/RequestDialog'
import { IntegrationRow, useIntegrationActions } from '../../components/integrations/IntegrationRow'
import { Loadable, PageScope, useLoad } from './common'

export default function AdminIntegrations() {
  const t = useT()
  const me = useMeStrict()
  const state = useLoad(async () => (await api.call(API.listTeamIntegrations)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [dialog, setDialog] = useState<{ existing?: Integration; connector?: Connector } | null>(null)
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
  return (
    <>
      <ConnectorsHeader title={t('admin.integrations')} scope={<PageScope />} tab={tab} onTab={setTab} query={query} onQuery={setQuery} onAdd={() => setDialog({})} panels={panels} />
      {/* what this page is for, right under its title (not lost between the list and the requests) */}
      {tab === 'connected' && <p className="mb-4 text-sm text-muted" data-testid="team-integrations-note">{t('integrations.admin.desc')}</p>}
      <TabPanel base={panels} value={tab}>
      <Loadable state={state}>
        {(list) => {
          if (tab === 'discover') return <ConnectorDiscover connected={list} query={query} onAdd={(c) => setDialog({ connector: c })} onCustom={() => setDialog({})} />
          if (!list.length) {
            return (
              <EmptyState icon={<Cable size={26} />} title={t('integrations.admin.empty')}>
                <p>{t('integrations.admin.emptyHint')}</p>
              </EmptyState>
            )
          }
          const shown = [...list].filter((i) => matchesQuery(i, query)).sort((a, b) => a.name.localeCompare(b.name))
          if (!shown.length) return <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
          return (
            <ul className="-mx-2 divide-y divide-line" data-testid="team-integrations">
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
            </ul>
          )
        }}
      </Loadable>
      {tab === 'connected' && <div className="mt-8"><TeamRequests /></div>}
      </TabPanel>
      {dialog && (
        <IntegrationDialog
          scope="team"
          existing={dialog.existing}
          connector={dialog.connector}
          onClose={() => setDialog(null)}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
            if (tab === 'discover') afterAdded(setTab, setQuery)
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
