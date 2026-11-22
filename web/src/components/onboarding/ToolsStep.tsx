// 팀이 쓸 도구, the welcome steps' step between 팀 파일 and 팀원 초대 (docs/decisions/20261120-team-vs-personal-onboarding.md,
// with docs/decisions/20261121-onboarding-google-team-or-own.md for the Google rows and the switch's name): a team
// setting like the other steps. One list, in this order: Notion, Higgsfield, Google Drive, Gmail.
//  - a team connection, for a listed service the team connects once (Notion, Higgsfield: a team-scope connection
//    everyone may use): [팀으로 연결], "팀 전체가 이 연결을 같이 써요 · <what it does>". The sign-in is the team account's, at the service,
//    in the window reserved during the click; never the owner's own connection. Slack is not a row since 2026-11-22
//    (owner: its connection is too complicated for the first steps): it is in "다른 도구 보기" (Settings › Connectors,
//    its card for an owner or admin) and Admin › Connected apps; a Slack connected there still counts as a working tool.
//  - a Google tool (Google Drive where this server has it, Gmail where it can be connected; Calendar, Docs and Sheets
//    stay in "다른 도구 보기" and Admin, to keep the step lean): both ways, on one row (owner, 11-21: "a Google account is added as a team account AND as a
//    personal account"). [팀으로 연결] on its right opens the very dialog Admin › Connected apps uses
//    (DriveShares.tsx DriveShareDialog for Drive, GoogleAppTeam.tsx GoogleAppTeamDialog for a Google app: one shared
//    Google account, then who may use it), where this server can do that (Drive set up; the app set up and the server
//    sends its team account); once connected the row says which account and who uses it, with 연결됨 like Notion.
//  - under the line of every row a small switch "각자 연결하도록 권하기" (TeamSettings.recommendedTools,
//    shared/src/api/team-tools.ts): those tools come first in everyone's Settings › Connectors; nothing is gated, anyone
//    may still connect anything. Saved at once; a failure puts it back and says why on its row.
// Then one quiet "다른 도구 보기" line: Settings › Connectors, the full list (a tool's page there has the same "각자 연결하도록 권하기"
// switch for an owner or admin). Settings is a dialog over this step (App.tsx useSettingsOverlay), so its close comes
// back here, which reads everything again; it opens with the step's way back in its history state (SetupReturn.tsx).
// Never blocking: once something is done (a team connection connected, Slack connected, a team Google account
// connected, a tool asked for) the primary is the next step; until then only "나중에 하기". A phone walks past the step (pages/Welcome.tsx), as before.
import { Check, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, SLACK, type DriveShare, type GoogleAppAdminStatus, type Integration } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { APP_CONNECTORS, appConnectorLogo, connectorLogo, CONNECTORS, CONNECTORS_HOME, servesAt, type Connector } from '../../lib/connectors'
import { lineKey, type BuiltInId } from '../../lib/googleApps'
import { setupReturnState } from '../../lib/welcome'
import { useRealPath } from '../../lib/realPath'
import { useRecommendedTools } from '../../lib/teamTools'
import { integrationsChanged } from '../../store/live'
import { useLocale, useT } from '../../i18n'
import { Button, Switch, WaitLine } from '../ui'
import { SIGN_IN_WAIT_MINUTES } from '../../lib/signInWait'
import { LogoTile } from '../integrations/ConnectorsView'
import { reserveSignInWindow, useSignIn } from '../integrations/IntegrationRow'
import { DriveShareDialog } from '../integrations/DriveShares'
import { GoogleAppTeamDialog } from '../integrations/GoogleAppTeam'
import { isEmptyAccess } from '../../lib/integrations'
import { useAdminGroups, useAdminUsers } from '../../store/adminPeople'

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'
/** the listed services the step connects for the team, in their order (Notion, Higgsfield; the full list is one click
 * away) */
export const WELCOME_SERVICES = ['notion', 'higgsfield'] as const
/** the Google tools the step offers (for the team, or each person's own), where this server can connect them */
const RECOMMEND: BuiltInId[] = ['google-drive', 'gmail']
type GoogleRowId = BuiltInId
const rowCls = 'flex items-center gap-3 py-3'
const logoCls = 'size-10 rounded-xl p-2'
const WAITING = new Set(['starting', 'pending', 'exchanging'])
const isOn = (i: Integration | undefined) => !!i && i.status === 'connected' && (i.auth !== 'oauth' || i.hasSecret)

export function ToolsStep({ busy, done, nextLabel, onDone, onSkip }: {
  busy: boolean
  /** the step was done before (coming back by ← 이전 or the setup row): the next step is the primary */
  done: boolean
  /** "다음: 팀원 초대" */
  nextLabel: string
  onDone: () => void
  onSkip: () => void
}) {
  const t = useT()
  const rec = useRecommendedTools()
  const avail = useRecommendable()
  const team = useTeamConnections()
  const google = useGoogleTeam()
  const [dialog, setDialog] = useState<GoogleRowId | null>(null)
  // back from Settings (a dialog over this step): read everything again
  const real = useRealPath()
  const was = useRef(real)
  useEffect(() => {
    if (was.current !== real && real === '/welcome') { void rec.reload(); avail.reload(); team.reload(); google.reload() }
    was.current = real
  }, [real]) // eslint-disable-line react-hooks/exhaustive-deps
  const recommendRows = RECOMMEND.filter((id) => avail.ids.includes(id)).map((id) => {
    const a = APP_CONNECTORS.find((x) => x.id === id)!
    return { id, name: a.name, logo: appConnectorLogo(a), line: t(lineKey(id)) }
  })
  const next = done || !!rec.tools?.length || team.anyOn || google.anyOn
  return (
    <div className="space-y-5" data-testid="welcome-tools">
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink">{t('welcome.tools.title')}</h2>
        <p className="text-sm text-balance text-muted">{t('welcome.tools.desc')}</p>
      </div>
      <div className="space-y-4">
        <ul className="divide-y divide-line border-y border-line" data-testid="welcome-tools-cards">
          <TeamRows team={team} rec={rec} />
          {rec.tools !== undefined && recommendRows.map((r) => {
            const error = rec.error?.id === r.id ? rec.error.text : null
            const g = google.of(r.id)
            const teamState = !g ? 'none' : g.account ? (g.ok ? 'connected' : 'needs-sign-in') : 'available'
            const line = error ?? (!g ? t('welcome.tools.ownLine', { line: r.line })
              : g.account ? t('welcome.tools.googleTeamOn', { account: g.account, who: g.who })
                : t('welcome.tools.googleLine'))
            return (
              <li key={r.id} className={rowCls} data-testid="welcome-tools-service" data-id={r.id} data-kind="google" data-team={teamState} data-state={rec.on(r.id) ? 'recommended' : 'off'}>
                <LogoTile src={r.logo} className={logoCls} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium text-ink">{r.name}</p>
                  <p className={`text-sm break-words ${error || teamState === 'needs-sign-in' ? 'text-warn' : 'text-muted'}`} role={error ? 'alert' : undefined} data-testid="welcome-tools-service-line">{line}</p>
                  <AskSwitch rec={rec} id={r.id} />
                </div>
                {g && (teamState === 'connected' ? connectedMark(t) : (
                  <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setDialog(r.id)}
                    aria-label={`${t(g.account ? 'welcome.tools.reconnect' : 'welcome.tools.teamConnect')}: ${r.name}`} data-testid="welcome-tools-team-connect">
                    {t(g.account ? 'welcome.tools.reconnect' : 'welcome.tools.teamConnect')}
                  </Button>
                ))}
              </li>
            )
          })}
        </ul>
        <OtherTools />
      </div>
      {dialog && <GoogleTeamDialog app={dialog} google={google} onClose={() => { setDialog(null); google.reload() }} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {next ? (
          <Button variant="primary" className="max-sm:w-full" disabled={busy || rec.saving !== null} onClick={onDone} data-testid="welcome-tools-next">{nextLabel}</Button>
        ) : <span />}
        {/* once something is done, the next step is the one way on (the 팀 파일 rule) */}
        {!next && (
          <Button variant="ghost" onClick={onSkip} disabled={busy} data-testid="welcome-later">{t('welcome.later')}</Button>
        )}
      </div>
    </div>
  )
}

/** The tools of RECOMMEND this server can connect: Google Drive where it has it (a hosted team's first minutes: read
 * again a little later and when the window comes back), a Google app where it can be connected. A failed read: no row. */
function useRecommendable() {
  const [ids, setIds] = useState<string[]>([])
  const [driveWaits, setDriveWaits] = useState(false)
  const reload = useCallback(() => {
    void Promise.all([
      api.call(API.myDriveConnection).then((d) => { setDriveWaits(!d.configured); return d.configured ? ['google-drive'] : [] }, () => []),
      api.call(API.myGoogleApps).then((r) => r.apps.filter((a) => a.available).map((a) => a.id as string), () => []),
    ]).then(([d, g]) => setIds([...d, ...g]))
  }, [])
  useEffect(reload, [reload])
  useEffect(() => {
    if (!driveWaits) return
    const timer = window.setInterval(reload, 15_000)
    window.addEventListener('focus', reload)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', reload) }
  }, [driveWaits, reload])
  return { ids, reload }
}

/** The team's connections (GET /api/admin/integrations) and whether its Slack is connected (GET /api/admin/slack): what
 * the team rows show, and whether one works (`anyOn`: a team connection connected, or Slack connected in Admin › Connected
 * apps, which has no row here but is a working team tool all the same). */
function useTeamConnections() {
  const [items, setItems] = useState<Integration[] | null>(null)
  const [slack, setSlack] = useState(false)
  const reload = useCallback(() => {
    api.call(API.listTeamIntegrations).then((r) => setItems(r.items), () => setItems((x) => x ?? []))
    api.call(SLACK.slackAdmin).then((s) => setSlack(s.state === 'connected'), () => setSlack(false))
  }, [])
  useEffect(reload, [reload])
  useEffect(() => integrationsChanged.on(reload), [reload])
  return { items, setItems, reload, anyOn: !!items?.some(isOn) || slack }
}

/** The team rows: each listed service of WELCOME_SERVICES, in that order, as one team connection everyone may use, made
 * from the list (its address and sign-in: nothing to type) and signed in at once. */
function TeamRows({ team, rec }: { team: ReturnType<typeof useTeamConnections>; rec: ReturnType<typeof useRecommendedTools> }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const signIn = useSignIn(() => team.reload())
  if (!team.items) return null
  const services: Connector[] = WELCOME_SERVICES.flatMap((id) => CONNECTORS.filter((c) => c.id === id))
  const theirs = (c: Connector) => team.items!.find((i) => servesAt(c, i.url))
  const connect = async (c: Connector) => {
    // the window first, during the click (one opened after the server answers is blocked as a popup)
    const w = reserveSignInWindow()
    setErrors((e) => ({ ...e, [c.id]: '' }))
    const there = theirs(c)
    if (there) { void signIn.start(there.id, w); return }
    setBusy(c.id)
    try {
      const i = await api.call(API.createTeamIntegration, { body: { kind: 'mcp', name: c.name, url: c.url, auth: 'oauth', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } })
      team.setItems((m) => [...(m ?? []).filter((x) => x.id !== i.id), i])
      if (i.status === 'needs_auth') void signIn.start(i.id, w)
      else w?.close()
    } catch (e) {
      w?.close()
      setErrors((x) => ({ ...x, [c.id]: errorText(e, locale, t('error.network')) }))
    } finally { setBusy(null) }
  }
  const connected = connectedMark(t)
  return (
    <>
      {services.map((c) => {
        const i = theirs(c)
        const flow = i && signIn.state?.id === i.id ? signIn.state : null
        const waiting = !!flow && WAITING.has(flow.state)
        const on = isOn(i) && !flow
        const line = waiting ? (flow.away ? t('integrations.signIn.notFinished') : t('welcome.tools.signingIn', { name: c.name }))
          : flow ? flow.reason || t('welcome.tools.signInFailed', { name: c.name })
            : errors[c.id] || (rec.error?.id === c.id ? rec.error.text : '') || `${t('welcome.tools.teamLine')} · ${t(`integrations.catalog.${c.id}`)}`
        return (
          <li key={c.id} className={rowCls} data-testid="welcome-tools-service" data-id={c.id} data-kind="team" data-state={on ? 'connected' : waiting ? 'signing-in' : i ? 'needs-sign-in' : 'available'}>
            <LogoTile src={connectorLogo(c)} className={logoCls} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-ink">{c.name}</p>
              {waiting ? <WaitLine className="text-sm text-muted" text={line} hint={t('connect.wait.limit', { n: SIGN_IN_WAIT_MINUTES })} testId="welcome-tools-service-line" />
                : <p className={`text-sm break-words ${flow || errors[c.id] || rec.error?.id === c.id ? 'text-warn' : 'text-muted'}`} data-testid="welcome-tools-service-line">{line}</p>}
              {waiting && flow.url && <a href={flow.url} target="_blank" rel="noopener noreferrer" className={`${quietLink} text-sm`}>{t('integrations.signIn.open')}</a>}
              {/* each person may connect their own too (a listed service): the same switch as the Google rows */}
              {rec.tools !== undefined && <AskSwitch rec={rec} id={c.id} />}
            </div>
            {on ? connected : waiting ? (
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="secondary" onClick={() => void connect(c)} data-testid="welcome-tools-team-retry">{t('common.retry')}</Button>
                <Button size="sm" variant="ghost" onClick={signIn.cancel} data-testid="welcome-tools-team-cancel">{t('common.cancel')}</Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" className="shrink-0" busy={busy === c.id} disabled={!!busy}
                onClick={() => void connect(c)} aria-label={`${t('welcome.tools.teamConnect')}: ${c.name}`} data-testid="welcome-tools-team-connect">
                {flow ? t('common.retry') : t('welcome.tools.teamConnect')}
              </Button>
            )}
          </li>
        )
      })}
    </>
  )
}

/** "각자 연결하도록 권하기": the tool comes first in everyone's Settings › Connectors (TeamSettings.recommendedTools),
 * each connecting their own; saved at once. */
function AskSwitch({ rec, id }: { rec: ReturnType<typeof useRecommendedTools>; id: string }) {
  const t = useT()
  return (
    <div className="pt-0.5 text-muted">
      <Switch checked={rec.on(id)} disabled={rec.saving !== null} onChange={(v) => void rec.set(id, v)} label={t('welcome.tools.recommend')} testId="welcome-tools-recommend" />
    </div>
  )
}

/** 연결됨 on the right of a team row. */
function connectedMark(t: ReturnType<typeof useT>) {
  return (
    <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted" data-testid="welcome-tools-team-on">
      <Check size={14} className="text-ok" aria-hidden /> {t('drive.status.connected')}
    </span>
  )
}

/** The team's shared Google accounts, as Admin › Connected apps reads them (owners and admins): Google Drive's shares
 * (GET /api/admin/google-drive, then its shares once it is set up) and each Google app's team account
 * (GET /api/admin/google-apps). `of(id)`: null where the team way cannot be offered here (not set up, an older server,
 * a failed read); else the account shown (the first share that works, else the first) and who uses it. */
function useGoogleTeam() {
  const t = useT()
  const [shares, setShares] = useState<DriveShare[] | null>(null)
  const [apps, setApps] = useState<GoogleAppAdminStatus[]>([])
  const reload = useCallback(() => {
    api.call(API.driveAdminStatus).then((d) => d.configured ? api.call(API.listDriveShares).then((r) => setShares(r.items)) : setShares(null))
      .catch(() => setShares(null))
    api.call(API.googleAppsAdminStatus).then((r) => setApps(r.apps), () => setApps([]))
  }, [])
  useEffect(reload, [reload])
  const share = shares?.find((x) => x.status === 'connected') ?? shares?.[0] ?? null
  const app = (id: string) => apps.find((a) => a.id === id)
  const who = (x: { access: DriveShare['access']; usedBy: number }) => (isEmptyAccess(x.access) ? t('driveShare.nobody') : t('driveShare.usedBy', { count: x.usedBy }))
  const email = (a: DriveShare['account']) => a.email ?? a.name ?? ''
  const of = (id: GoogleRowId) => {
    if (id === 'google-drive') return shares === null ? null : { account: share ? email(share.account) : null, ok: share?.status === 'connected', who: share ? who(share) : '' }
    const a = app(id)
    if (!a?.configured || a.team === undefined) return null
    return { account: a.team ? email(a.team.account) : null, ok: a.team?.status === 'connected', who: a.team ? who(a.team) : '' }
  }
  const setApp = (st: GoogleAppAdminStatus) => setApps((xs) => xs.map((a) => (a.id === st.id ? st : a)))
  return { of, share, app, setApp, reload, anyOn: share?.status === 'connected' || apps.some((a) => a.team?.status === 'connected') }
}

/** The dialog Admin › Connected apps opens for a shared Google account: Drive's share (sign in, folders, who), or a Google
 * app's team account (Gmail, Calendar, Docs, Sheets: sign in, who); a new sign-in for one that needs it. */
function GoogleTeamDialog({ app, google, onClose }: { app: GoogleRowId; google: ReturnType<typeof useGoogleTeam>; onClose: () => void }) {
  const groups = useAdminGroups()
  const users = useAdminUsers()
  // what there was when the dialog opened, kept while it is open (as Admin does): a sign-in made here sets the app's
  // team account at once (onStatus), and the dialog must still treat it as new, so its Cancel or ✕ removes it again
  const [share] = useState(() => google.share)
  const [isNew] = useState(() => !google.app(app)?.team)
  if (app === 'google-drive') {
    return <DriveShareDialog share={share ?? undefined} reconnect={!!share} groups={groups.data ?? []} users={users.data ?? []} onClose={onClose} onSaved={onClose} />
  }
  const st = google.app(app)
  if (!st) return null
  return <GoogleAppTeamDialog app={st.id} team={st.team ?? null} step="connect" isNew={isNew} onStatus={google.setApp} onClose={onClose} />
}

/** "다른 도구 보기": Settings › Connectors, the full list (Settings is a dialog over the step; its close comes back). */
function OtherTools() {
  const t = useT()
  const navigate = useNavigate()
  return (
    <p className="text-sm" data-testid="welcome-tools-mcp">
      <button type="button" className={`${quietLink} inline-flex items-center gap-1.5`} onClick={() => navigate(CONNECTORS_HOME, { state: setupReturnState('tools') })} data-testid="welcome-tools-mcp-add">
        <Plus size={14} className="shrink-0 text-faint" aria-hidden /> {t('welcome.tools.mcp')}
      </button>
    </p>
  )
}

export default ToolsStep
