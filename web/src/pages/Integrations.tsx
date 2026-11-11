// Settings › Connected apps (/settings/connectors; Connectors before, and MCP and App connectors before that, their addresses lead
// here): one page, like Claude's Connectors. Settings says "Just for you" above it (SettingsDialog.tsx); the title is the
// same noun as Admin's. First, services an admin asked the person to connect as their own
// (components/integrations/AnswerDialog.tsx), then "From <team>" (components/integrations/TemplatesView.tsx FromTeam):
// the team's connections the person may use, read-only with their state ("Ready"), for an admin also the ones not for
// them ("Off for you") and a Manage link, and the templates an admin shared with them ("Connect your account"). Then the
// person's own: Google Drive (Trina's own connector, components/integrations/DriveConnector.tsx), Slack, and under
// "Connected" their connections to MCP servers and APIs (used only in their own chats). Then Discover: Google Drive
// first, then known MCP services; a card opens its page (ConnectorDetail, in the place of the list until its way back)
// and its + adds it at once. Nothing connected yet: one quiet line, then Discover. The search filters everything.
// "Add" takes any MCP server or API by its address: owners and admins only. A member reads "Not listed? Ask an admin
// to add it." instead (the form's kind, sign-in method, headers and scopes are an admin's job; docs/DECISIONS.md "Plain
// words for members"). Without personal connections allowed there is no Add and no Discover. Not AI apps
// (pages/AiApps.tsx): that is the other direction, Claude using this server. ?drive=1 (old Drive links, a notice) opens
// Google Drive's page.
import { Cable } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { APP_CONNECTORS, appConnectorLogo, type Connector } from '../lib/connectors'
import { canonicalService, splitByScope } from '../lib/integrations'
import { useT } from '../i18n'
import { reloadAsked } from '../store/live'
import { isAdmin, useMe } from '../store/session'
import { EmptyState } from '../components/ui'
import { ConnectorDetail, ConnectorDiscover, ConnectorsHeader, discoverHits, goToSection, matchesQuery, sectionTitleCls, useSectionIds } from '../components/integrations/ConnectorsView'
import { DriveCard, DriveDetail, driveLinked, drivePersonalAllowed } from '../components/integrations/DriveConnector'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { SlackAccount } from '../components/settings/SlackAccount'
import { Button } from '../components/ui'
import { MyRequests } from '../components/integrations/AnswerDialog'
import { IntegrationDialog } from '../components/integrations/IntegrationDialog'
import { IntegrationRow, useIntegrationActions } from '../components/integrations/IntegrationRow'
import { FromTeam } from '../components/integrations/TemplatesView'
import { Loadable, useLoad } from './admin/common'

export default function Integrations() {
  const t = useT()
  const me = useMe()
  const state = useLoad<IntegrationList>(() => api.call(API.listIntegrations))
  // toList: opened from Discover or while a connector's page is open; once added, the page shows the list with it
  const [dialog, setDialog] = useState<{ existing?: Integration; connector?: Connector; toList?: boolean } | null>(null)
  const [query, setQuery] = useState('')
  // a connector's page, opened from Discover (or ?drive=1): it takes the place of the list until its way back
  const [open, setOpen] = useState<{ kind: 'drive' } | { kind: 'mcp'; c: Connector } | null>(null)
  const drive = useDriveConnection()
  const ids = useSectionIds()
  // the admin's requests load again with the list: a sign-in that finished may have connected one
  const [requests, setRequests] = useState(0)
  // whether "From <team>" shows anything (for the search's "nothing matches" and the empty line); null until it knows
  const [fromTeamShown, setFromTeamShown] = useState<boolean | null>(null)
  // an admin's "From <team>" also lists the team's connections not for them ("Off for you"): the team list, which only
  // admins may read (a member's list has just the ones they may use, and nothing here widens that)
  const admin = isAdmin(me)
  const teamAll = useLoad(async () => {
    if (!admin) return [] as Integration[]
    try { return (await api.call(API.listTeamIntegrations)).items } catch { return [] as Integration[] }
  }, [admin])
  const reloadList = state.reload
  const reloadTeam = teamAll.reload
  const reload = useCallback(() => { void reloadList(); void reloadTeam(); setRequests((n) => n + 1) }, [reloadList, reloadTeam])
  useEffect(() => reloadAsked.on(reload), [reload])
  const actions = useIntegrationActions({
    add: (i) => state.setData((d) => (d ? { ...d, items: [...d.items, i] } : d)),
    replace: (i) => state.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === i.id ? i : x)) } : d)),
    reload,
  })
  // ?add=1 (from Search's "Connect an app") opens the add dialog once the list says members may add their own, for
  // owners and admins (a member's Search goes to this page without it)
  const [params, setParams] = useSearchParams()
  const personalAllowed = state.data?.personalAllowed
  useEffect(() => {
    if (params.get('add') !== '1' || personalAllowed === undefined) return
    if (personalAllowed && admin) setDialog({})
    setParams((p) => { p.delete('add'); return p }, { replace: true })
  }, [params, personalAllowed, admin, setParams])
  useEffect(() => {
    if (params.get('drive') !== '1') return
    setOpen({ kind: 'drive' })
    setParams((p) => { p.delete('drive'); return p }, { replace: true })
  }, [params, setParams])
  const DRIVE = APP_CONNECTORS[0]
  // members connect their own only while the admin allows it; a Drive the team shares with them needs no Connect. An
  // owner or admin may connect theirs anyway: the confirm turns the switch on (docs/DECISIONS.md "W6")
  const driveOn = !!drive.connection?.configured && (drivePersonalAllowed(drive.connection) || isAdmin(me))
  const teamShares = drive.connection?.teamShares ?? []
  const driveCard = { id: DRIVE.id, name: DRIVE.name, logo: appConnectorLogo(DRIVE), line: teamShares.length && !driveOn ? t('drive.teamShared', { name: teamShares.map((x) => x.name).join(', ') }) : t('drive.cardDesc'),
    state: driveLinked(drive.connection) || (teamShares.length > 0 && !driveOn) ? 'added' as const : driveOn || !drive.connection ? 'available' as const : 'off' as const }
  // "just sign in": Drive's + goes straight to Google, on its page so the person sees it finish
  const connectDrive = () => { setOpen({ kind: 'drive' }); if (!driveLinked(drive.connection) && driveOn) drive.start() }
  // back from a connector's page: where it was opened from
  const back = () => { setOpen(null); goToSection(ids.discover) }
  // Drive shows in the connections once it is linked or on its way (the steps of a sign-in in progress), and right
  // after a disconnect whose revocation at Google could not be done (the row says so)
  const driveListed = driveLinked(drive.connection) || drive.d.inProgress || drive.revokeWarning || teamShares.length > 0
  // a connector's page stands alone: what is asked of the person and what the team provides come back with the list
  const detail = !!open && !!personalAllowed
  const team = state.data ? splitByScope(state.data.items).team : null
  // (null while an admin's team list is still on its way: the block waits for it, so nothing flashes)
  const offForMe = !admin ? [] : team && teamAll.data ? teamAll.data.filter((x) => !team.some((y) => y.id === x.id)) : null
  return (
    <section data-testid="integrations">
      <ConnectorsHeader title={t('integrations.title')} query={query} onQuery={(q) => { setQuery(q); setOpen(null) }} onAdd={personalAllowed && admin ? () => setDialog({ toList: !!open }) : undefined} />
      {/* hidden, not unmounted, while a connector's page is open: back on the list they are there at once */}
      <div hidden={detail}>
        <div className="[&:not(:empty)]:mb-5">
          <MyRequests
            version={requests}
            onConnected={(i, signIn) => actions.saved(i, signIn, !state.data?.items.some((x) => x.id === i.id))}
          />
        </div>
        <div className="[&:not(:empty)]:mb-5">
          <FromTeam
            teamName={me?.team.name ?? ''}
            team={team}
            offForMe={offForMe}
            latest={state.data?.items}
            manage={admin}
            version={requests}
            query={query}
            actions={actions}
            onEdit={(i) => setDialog({ existing: i })}
            onConnected={(i, signIn) => actions.saved(i, signIn, !state.data?.items.some((x) => x.id === i.id))}
            onShown={setFromTeamShown}
          />
        </div>
      </div>
      <Loadable state={state}>
        {(d) => {
          const { mine } = splitByScope(d.items)
          // a team connection a member may use is the company's account, so their own stays addable
          if (d.personalAllowed && open?.kind === 'drive') return <DriveDetail s={drive} onBack={back} />
          if (d.personalAllowed && open?.kind === 'mcp') {
            const have = mine.find((i) => canonicalService(i.url) === canonicalService(open.c.url))
            return (
              <ConnectorDetail testId="connector-detail" logo={`/icons/connectors/${open.c.logo}`} name={open.c.name} line={t(`integrations.catalog.${open.c.id}`)} official onBack={back}
                action={have ? <span className="text-sm text-ok" data-testid="connector-detail-added">{t('drive.status.connected')}</span>
                  : <Button variant="primary" onClick={() => setDialog({ connector: open.c, toList: true })} data-testid="connector-connect">{t('aiApps.connect')}</Button>}
                description={t('connectors.mcp.about', { name: open.c.name })} tools={have?.tools.map((x) => x.name)} />
            )
          }
          const q = query.trim()
          const shownMine = mine.filter((i) => matchesQuery(i, query))
          const driveShown = driveListed && DRIVE.name.toLowerCase().includes(q.toLowerCase())
          const connections = shownMine.length > 0 || driveShown || !!fromTeamShown
          // a service a member looked for and did not find: where to go next (an owner or admin has Add above)
          if (q && !connections && !(d.personalAllowed && discoverHits(t, query, [driveCard]).count)) return (
            <EmptyState title={t('integrations.noMatch', { q })}>
              {d.personalAllowed && !admin && <p data-testid="connector-ask-admin">{t('integrations.discover.customHint')} {t('integrations.discover.askAdmin')}</p>}
            </EmptyState>
          )
          // (not before "From <team>" has answered: the line would flash and go)
          const nothingYet = !mine.length && !driveListed && fromTeamShown === false
          return (
            <div className="space-y-5">
              {!d.personalAllowed && mine.length > 0 && (
                <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="integrations-personal-off">
                  {t('integrations.personalOff')}
                </p>
              )}
              {driveShown && <ul className="grid gap-3" data-testid="yours-drive"><DriveCard s={drive} /></ul>}
              {/* Slack (main's Slack connector): the person's own Slack link; its sign-in comes back here (?slack=) */}
              {!q && <SlackAccount />}
              {/* with adding allowed only when there are some (Discover below adds them); without it, as before, with why
                  there are none */}
              {(d.personalAllowed ? shownMine.length > 0 : !q || shownMine.length > 0) && <section aria-labelledby={ids.connected}>
                <h3 id={ids.connected} tabIndex={-1} className={`mb-2 ${sectionTitleCls}`}>
                  {t('connectors.connected')}
                </h3>
                {!mine.length && driveListed ? null : !mine.length ? (
                  // phones: no frame around the empty state (it is the only thing under its heading)
                  <div className="md:rounded-xl md:border md:border-dashed md:border-line" data-testid="integrations-empty">
                    <EmptyState icon={<Cable size={26} />} title={t('integrations.personalOffTitle')}>
                      <p>{t('integrations.personalOff')}</p>
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
              {d.personalAllowed && (
                <>
                  {/* nothing connected yet: no empty box, Discover leads */}
                  {nothingYet && !q && <p className="text-sm text-muted" data-testid="integrations-empty">{t('integrations.empty')}</p>}
                  <ConnectorDiscover titleId={ids.discover} className={connections ? 'border-t border-line pt-6' : undefined} connected={mine} query={query}
                    onAdd={(c) => setDialog({ connector: c, toList: true })} onCustom={admin ? () => setDialog({ toList: true }) : undefined}
                    builtIns={[driveCard]} onAddBuiltIn={connectDrive} onOpenBuiltIn={() => setOpen({ kind: 'drive' })} onOpen={(c) => setOpen({ kind: 'mcp', c })} />
                </>
              )}
              <p className="text-xs text-faint">{t('integrations.privacy')}</p>
            </div>
          )
        }}
      </Loadable>
      {dialog && (
        <IntegrationDialog
          scope={dialog.existing?.scope ?? 'personal'}
          existing={dialog.existing}
          connector={dialog.connector}
          onClose={() => setDialog(null)}
          onSaved={(i, next) => {
            setDialog(null)
            actions.saved(i, next, !dialog.existing)
            // added from Discover (or from Add over a connector's page): the search is cleared (the new row may not
            // match it) and the keyboard goes to the list the new row is in, since the button that opened it is gone
            if (dialog.toList) { setOpen(null); setQuery(''); goToSection(ids.connected) }
          }}
        />
      )}
    </section>
  )
}
