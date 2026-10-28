// Admin > External services: the team's connections (company accounts) and who may use each one in their chats —
// the whole team, groups, people. Admins manage them all but use one in their own chats only when the rule includes
// them, so each row says so. Members' personal connections are not listed (nobody but the owner can use those).
import { Cable, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Group, Integration, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { covers, isEmptyAccess, NOBODY } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { reloadAsked } from '../../store/live'
import { Badge, Button, EmptyState } from '../../components/ui'
import { IntegrationDialog } from '../../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../../components/integrations/IntegrationRow'
import { Card, Loadable, useLoad } from './common'

export default function AdminIntegrations() {
  const t = useT()
  const me = useMeStrict()
  const state = useLoad(async () => (await api.call(API.listTeamIntegrations)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [dialog, setDialog] = useState<{ existing?: Integration } | null>(null)
  const reloadList = state.reload
  const reload = useCallback(() => void reloadList(), [reloadList])
  useEffect(() => reloadAsked.on(() => void reloadList()), [reloadList])
  const actions = useIntegrationActions({
    add: (i) => state.setData((d) => (d ? [...d, i] : d)),
    replace: (i) => state.setData((d) => d?.map((x) => (x.id === i.id ? i : x)) ?? d),
    reload,
  })
  const person = { id: me.user.id, groupIds: me.groups.map((g) => g.id) }
  return (
    <>
      <Card
        title={t('admin.integrations')}
        desc={t('integrations.admin.desc')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setDialog({})} data-testid="integration-add">
            <Plus size={14} aria-hidden /> {t('integrations.add')}
          </Button>
        }
      >
        <Loadable state={state}>
          {(list) =>
            !list.length ? (
              <EmptyState icon={<Cable size={26} />} title={t('integrations.admin.empty')}>
                <p>{t('integrations.admin.emptyHint')}</p>
              </EmptyState>
            ) : (
              <ul className="-m-4 divide-y divide-line" data-testid="team-integrations">
                {[...list].sort((a, b) => a.name.localeCompare(b.name)).map((i) => (
                  <IntegrationRow
                    key={i.id}
                    i={i}
                    actions={actions}
                    onEdit={() => setDialog({ existing: i })}
                    extra={<AccessLine i={i} groups={groups.data ?? []} users={users.data ?? []} mine={covers(i.access, person)} />}
                  />
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>
      {dialog && (
        <IntegrationDialog
          scope="team"
          existing={dialog.existing}
          onClose={() => setDialog(null)}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
          }}
        />
      )}
    </>
  )
}

/** "Used by: Finance, Bob", and whether the admin looking at it can use it in their own chats */
function AccessLine({ i, groups, users, mine }: { i: Integration; groups: Group[]; users: User[]; mine: boolean }) {
  const t = useT()
  const a = i.access ?? NOBODY
  const names = [
    ...a.groups.map((id) => groups.find((g) => g.id === id)?.name ?? '?'),
    ...a.users.map((id) => users.find((u) => u.id === id)?.name ?? '?'),
  ]
  const who = a.everyone ? t('integrations.access.everyone') : names.join(', ')
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="integration-access-line">
      {isEmptyAccess(a) ? (
        <Badge tone="warn">{t('integrations.users.nobody')}</Badge>
      ) : (
        <span className="text-muted">{t('integrations.users', { who })}</span>
      )}
      {!mine && !isEmptyAccess(a) && <Badge tone="warn">{t('integrations.users.notMe')}</Badge>}
      {i.createdBy && <span className="text-faint">{t('integrations.createdBy', { name: i.createdBy.name })}</span>}
    </p>
  )
}
