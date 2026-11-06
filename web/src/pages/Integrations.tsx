// Settings > MCP (called "External services" before; the address is still /settings/integrations):
// the person's own connections to MCP servers and APIs (used only in their own chats),
// then the team connections an admin lets them use (read-only unless they manage them); above them, services an admin
// asked them to connect as their own (components/integrations/AnswerDialog.tsx), and the templates an admin shared with
// them to connect with their own key ("From your team", components/integrations/TemplatesView.tsx). Not the "App connectors" tab
// (ConnectorConnections.tsx): that is the other direction, claude.ai using this server's files. "Discover" adds a known
// service by name; "Add connection" takes any MCP server or API by its address.
import { Cable } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import type { Connector } from '../lib/connectors'
import { splitByScope } from '../lib/integrations'
import { useT } from '../i18n'
import { reloadAsked } from '../store/live'
import { EmptyState, TabPanel } from '../components/ui'
import { afterAdded, ConnectorDiscover, ConnectorsHeader, matchesQuery, type ConnectorTab } from '../components/integrations/ConnectorsView'
import { MyRequests } from '../components/integrations/AnswerDialog'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { MyTemplates } from '../components/integrations/TemplatesView'
import { Loadable, useLoad } from './admin/common'

export default function Integrations() {
  const t = useT()
  const state = useLoad<IntegrationList>(() => api.call(API.listIntegrations))
  const [dialog, setDialog] = useState<{ existing?: Integration; connector?: Connector } | null>(null)
  const [tab, setTab] = useState<ConnectorTab>('connected')
  const [query, setQuery] = useState('')
  // the admin's requests load again with the list: a sign-in that finished may have connected one
  const [requests, setRequests] = useState(0)
  const reloadList = state.reload
  const reload = useCallback(() => { void reloadList(); setRequests((n) => n + 1) }, [reloadList])
  useEffect(() => reloadAsked.on(reload), [reload])
  const actions = useIntegrationActions({
    add: (i) => state.setData((d) => (d ? { ...d, items: [...d.items, i] } : d)),
    replace: (i) => state.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === i.id ? i : x)) } : d)),
    reload,
  })
  // ?add=1 (from Search's "Add MCP") opens the add dialog once the list says members may add their own
  const [params, setParams] = useSearchParams()
  const personalAllowed = state.data?.personalAllowed
  useEffect(() => {
    if (params.get('add') !== '1' || personalAllowed === undefined) return
    if (personalAllowed) setDialog({})
    setParams((p) => { p.delete('add'); return p }, { replace: true })
  }, [params, personalAllowed, setParams])
  const panels = useId()
  return (
    <section data-testid="integrations">
      <ConnectorsHeader title={t('integrations.title')} tab={tab} onTab={setTab} query={query} onQuery={setQuery} onAdd={state.data?.personalAllowed ? () => setDialog({}) : undefined} panels={panels} />
      {/* with tabs (adding allowed), what the chosen one shows */}
      <TabPanel base={state.data?.personalAllowed ? panels : null} value={tab}>
      <div className="[&:not(:empty)]:mb-5">
        <MyRequests
          version={requests}
          onConnected={(i, signIn) => actions.saved(i, signIn, !state.data?.items.some((x) => x.id === i.id))}
        />
      </div>
      {(tab === 'connected' || !state.data?.personalAllowed) && (
        <div className="[&:not(:empty)]:mb-5">
          <MyTemplates
            version={requests}
            query={query}
            actions={actions}
            onEdit={(i) => setDialog({ existing: i })}
            onConnected={(i, signIn) => actions.saved(i, signIn, !state.data?.items.some((x) => x.id === i.id))}
          />
        </div>
      )}
      <Loadable state={state}>
        {(d) => {
          const { mine, team } = splitByScope(d.items)
          // a team connection a member may use is the company's account, so their own stays addable
          if (tab === 'discover' && d.personalAllowed) return <ConnectorDiscover connected={mine} query={query} onAdd={(c) => setDialog({ connector: c })} onCustom={() => setDialog({})} />
          const shownMine = mine.filter((i) => matchesQuery(i, query))
          const shownTeam = team.filter((i) => matchesQuery(i, query))
          if (query.trim() && !shownMine.length && !shownTeam.length) return <EmptyState title={t('integrations.noMatch', { q: query.trim() })} />
          return (
            <div className="space-y-5">
              {!d.personalAllowed && mine.length > 0 && (
                <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="integrations-personal-off">
                  {t('integrations.personalOff')}
                </p>
              )}
              {(!query.trim() || shownMine.length > 0) && <section aria-labelledby="integrations-mine">
                <h3 id="integrations-mine" className="mb-2 text-sm font-semibold">
                  {t('integrations.mine')}
                </h3>
                {!mine.length ? (
                  // phones: no frame around the empty state (it is the only thing under its heading)
                  <div className="md:rounded-xl md:border md:border-dashed md:border-line" data-testid="integrations-empty">
                    <EmptyState icon={<Cable size={26} />} title={d.personalAllowed ? t('integrations.empty') : t('integrations.personalOffTitle')}>
                      <p>{d.personalAllowed ? t('integrations.emptyHint') : t('integrations.personalOff')}</p>
                    </EmptyState>
                  </div>
                ) : (
                  <ul className="-mx-2 divide-y divide-line" data-testid="integrations-mine">
                    {shownMine.map((i) => (
                      <IntegrationRow key={i.id} i={i} actions={actions} onEdit={() => setDialog({ existing: i })} />
                    ))}
                  </ul>
                )}
              </section>}
              {shownTeam.length > 0 && (
                <section aria-labelledby="integrations-team">
                  <h3 id="integrations-team" className="text-sm font-semibold">
                    {t('integrations.team')}
                  </h3>
                  <p className="mt-0.5 mb-2 text-xs text-muted">{t('integrations.teamHint')}</p>
                  <ul className="-mx-2 divide-y divide-line" data-testid="integrations-team">
                    {shownTeam.map((i) => (
                      <IntegrationRow key={i.id} i={i} actions={actions} teamBadge onEdit={() => setDialog({ existing: i })} />
                    ))}
                  </ul>
                </section>
              )}
              <p className="text-xs text-faint">{t('integrations.privacy')}</p>
            </div>
          )
        }}
      </Loadable>
      </TabPanel>
      {dialog && (
        <IntegrationDialog
          scope={dialog.existing?.scope ?? 'personal'}
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
    </section>
  )
}
