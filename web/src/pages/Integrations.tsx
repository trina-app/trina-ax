// Settings > External services: the person's own connections to MCP servers and APIs (used only in their own chats),
// then the team connections an admin lets them use (read-only unless they manage them). Not the "App connectors" tab
// (ConnectorConnections.tsx): that is the other direction, claude.ai using this server's files.
import { Cable, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { splitByScope } from '../lib/integrations'
import { useT } from '../i18n'
import { reloadAsked } from '../store/live'
import { Button, EmptyState } from '../components/ui'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { Loadable, useLoad } from './admin/common'

export default function Integrations() {
  const t = useT()
  const state = useLoad<IntegrationList>(() => api.call(API.listIntegrations))
  const [dialog, setDialog] = useState<{ existing?: Integration } | null>(null)
  const reloadList = state.reload
  const reload = useCallback(() => void reloadList(), [reloadList])
  useEffect(() => reloadAsked.on(() => void reloadList()), [reloadList])
  const actions = useIntegrationActions({
    add: (i) => state.setData((d) => (d ? { ...d, items: [...d.items, i] } : d)),
    replace: (i) => state.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === i.id ? i : x)) } : d)),
    reload,
  })
  return (
    <section className="space-y-5" data-testid="integrations">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h2 className="text-base font-semibold">{t('integrations.title')}</h2>
          <p className="mt-1 text-sm text-muted">{t('integrations.desc')}</p>
        </div>
        {state.data?.personalAllowed && splitByScope(state.data.items).mine.length > 0 && (
          <Button size="sm" variant="primary" onClick={() => setDialog({})} data-testid="integration-add">
            <Plus size={14} aria-hidden /> {t('integrations.add')}
          </Button>
        )}
      </div>
      <Loadable state={state}>
        {(d) => {
          const { mine, team } = splitByScope(d.items)
          return (
            <>
              {!d.personalAllowed && mine.length > 0 && (
                <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="integrations-personal-off">
                  {t('integrations.personalOff')}
                </p>
              )}
              <section aria-labelledby="integrations-mine">
                <h3 id="integrations-mine" className="mb-2 text-sm font-semibold">
                  {t('integrations.mine')}
                </h3>
                {!mine.length ? (
                  <div className="rounded-xl border border-dashed border-line" data-testid="integrations-empty">
                    <EmptyState icon={<Cable size={26} />} title={d.personalAllowed ? t('integrations.empty') : t('integrations.personalOffTitle')}>
                      <p>{d.personalAllowed ? t('integrations.emptyHint') : t('integrations.personalOff')}</p>
                      {d.personalAllowed && (
                        <Button variant="primary" className="mt-4" onClick={() => setDialog({})} data-testid="integration-add">
                          <Plus size={15} aria-hidden /> {t('integrations.add')}
                        </Button>
                      )}
                    </EmptyState>
                  </div>
                ) : (
                  <ul className="divide-y divide-line rounded-xl border border-line" data-testid="integrations-mine">
                    {mine.map((i) => (
                      <IntegrationRow key={i.id} i={i} actions={actions} onEdit={() => setDialog({ existing: i })} />
                    ))}
                  </ul>
                )}
              </section>
              {team.length > 0 && (
                <section aria-labelledby="integrations-team">
                  <h3 id="integrations-team" className="text-sm font-semibold">
                    {t('integrations.team')}
                  </h3>
                  <p className="mt-0.5 mb-2 text-xs text-muted">{t('integrations.teamHint')}</p>
                  <ul className="divide-y divide-line rounded-xl border border-line" data-testid="integrations-team">
                    {team.map((i) => (
                      <IntegrationRow key={i.id} i={i} actions={actions} teamBadge onEdit={() => setDialog({ existing: i })} />
                    ))}
                  </ul>
                </section>
              )}
              <p className="text-xs text-faint">{t('integrations.privacy')}</p>
            </>
          )
        }}
      </Loadable>
      {dialog && (
        <IntegrationDialog
          scope={dialog.existing?.scope ?? 'personal'}
          existing={dialog.existing}
          onClose={() => setDialog(null)}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
          }}
        />
      )}
    </section>
  )
}
