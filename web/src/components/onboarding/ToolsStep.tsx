// 팀이 쓸 도구, the welcome steps' step between 팀 파일 and 팀원 초대 (docs/decisions/20261120-team-vs-personal-onboarding.md,
// which supersedes docs/DECISIONS.md "Onboarding's Tools step: Drive, Notion and the full list"): a team setting like
// the other steps. One list, two kinds of rows:
//  - a team connection, for a tool the team connects once (Notion, a team-scope connection everyone may use; Slack,
//    its own page in Admin): [팀으로 연결], "팀 전체가 이 연결을 같이 써요". The sign-in is the team account's, at the
//    service, in the window reserved during the click; never the owner's own connection.
//  - a tool each person connects with their own account (Google Drive where this server has it, Gmail where it can be
//    connected): a [팀 추천] switch (TeamSettings.recommendedTools, shared/src/api/team-tools.ts). Recommended tools come
//    first in everyone's Settings › Connectors; nothing is gated, anyone may still connect anything. Saved at once; a
//    failure puts it back and says why on its row.
// Then one quiet "다른 도구 보기" line: Settings › Connectors, the full list (a tool's page there has the same 팀 추천
// switch for an owner or admin). Settings is a dialog over this step (App.tsx useSettingsOverlay), so its close comes
// back here, which reads everything again; it opens with the step's way back in its history state (SetupReturn.tsx).
// Never blocking: once something is done (a team connection connected, a tool recommended; Slack's row only opens its page) the primary is the next
// step; until then only "나중에 하기". A phone walks past the step (pages/Welcome.tsx), as before.
import { Check, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, SLACK, type Integration } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { APP_CONNECTORS, appConnectorLogo, connectorLogo, CONNECTORS, CONNECTORS_HOME, servesAt, SLACK_ADMIN_PATH, SLACK_APP, slackLogo, type Connector } from '../../lib/connectors'
import { lineKey, type BuiltInId } from '../../lib/googleApps'
import { connectorsPlace } from '../../pages/settingsTabs'
import { setupReturnState } from '../../lib/welcome'
import { useRealPath } from '../../lib/realPath'
import { useRecommendedTools } from '../../lib/teamTools'
import { integrationsChanged } from '../../store/live'
import { useLocale, useT } from '../../i18n'
import { Button, Switch, WaitLine } from '../ui'
import { SIGN_IN_WAIT_MINUTES } from '../../lib/signInWait'
import { LogoTile } from '../integrations/ConnectorsView'
import { reserveSignInWindow, useSignIn } from '../integrations/IntegrationRow'

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'
/** the listed services the step connects for the team (Notion; the full list is one click away) */
export const WELCOME_SERVICES = ['notion'] as const
/** the tools the step offers to recommend, where this server can connect them */
const RECOMMEND: BuiltInId[] = ['google-drive', 'gmail']
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
  // back from Settings (a dialog over this step): read everything again
  const real = useRealPath()
  const was = useRef(real)
  useEffect(() => {
    if (was.current !== real && real === '/welcome') { void rec.reload(); avail.reload(); team.reload() }
    was.current = real
  }, [real]) // eslint-disable-line react-hooks/exhaustive-deps
  const recommendRows = RECOMMEND.filter((id) => avail.ids.includes(id)).map((id) => {
    const a = APP_CONNECTORS.find((x) => x.id === id)!
    return { id, name: a.name, logo: appConnectorLogo(a), line: t(lineKey(id)) }
  })
  const next = done || !!rec.tools?.length || team.anyOn
  return (
    <div className="space-y-5" data-testid="welcome-tools">
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink">{t('welcome.tools.title')}</h2>
        <p className="text-sm text-balance text-muted">{t('welcome.tools.desc', { where: connectorsPlace(t) })}</p>
      </div>
      <div className="space-y-4">
        <ul className="divide-y divide-line border-y border-line" data-testid="welcome-tools-cards">
          <TeamRows team={team} />
          {rec.tools !== undefined && recommendRows.map((r) => {
            const error = rec.error?.id === r.id ? rec.error.text : null
            return (
              <li key={r.id} className={rowCls} data-testid="welcome-tools-service" data-id={r.id} data-kind="recommend" data-state={rec.on(r.id) ? 'recommended' : 'off'}>
                <LogoTile src={r.logo} className={logoCls} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium text-ink">{r.name}</p>
                  <p className={`text-sm break-words ${error ? 'text-warn' : 'text-muted'}`} role={error ? 'alert' : undefined} data-testid="welcome-tools-service-line">{error ?? t('welcome.tools.ownLine', { line: r.line })}</p>
                </div>
                <Switch checked={rec.on(r.id)} disabled={rec.saving !== null} onChange={(v) => void rec.set(r.id, v)} label={t('welcome.tools.recommend')} testId="welcome-tools-recommend" />
              </li>
            )
          })}
        </ul>
        <OtherTools />
      </div>
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
 * again a little later and when the window comes back), Gmail where it can be connected. A failed read: no row. */
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

/** The team's connections (GET /api/admin/integrations) and its Slack (GET /api/admin/slack, null: not on this server
 * or not readable): what the team rows show, and whether one works (`anyOn`: any team connection connected). Slack's
 * row is the way to its own page; a Slack added before does not count as this step done. */
function useTeamConnections() {
  const [items, setItems] = useState<Integration[] | null>(null)
  const [slack, setSlack] = useState<boolean | null>(null)
  const reload = useCallback(() => {
    api.call(API.listTeamIntegrations).then((r) => setItems(r.items), () => setItems((x) => x ?? []))
    api.call(SLACK.slackAdmin).then((s) => setSlack(!!s.tokens || s.lastError === 'removed'), () => setSlack(null))
  }, [])
  useEffect(reload, [reload])
  useEffect(() => integrationsChanged.on(reload), [reload])
  return { items, setItems, slack, reload, anyOn: !!items?.some(isOn) }
}

/** The team rows: each listed service of WELCOME_SERVICES as one team connection everyone may use, made from the list
 * (its address and sign-in: nothing to type) and signed in at once; then Slack, its own page in Admin › Connectors. */
function TeamRows({ team }: { team: ReturnType<typeof useTeamConnections> }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const signIn = useSignIn(() => team.reload())
  if (!team.items) return null
  const services: Connector[] = CONNECTORS.filter((c) => (WELCOME_SERVICES as readonly string[]).includes(c.id))
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
  const connected = (
    <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted" data-testid="welcome-tools-team-on">
      <Check size={14} className="text-ok" aria-hidden /> {t('drive.status.connected')}
    </span>
  )
  return (
    <>
      {services.map((c) => {
        const i = theirs(c)
        const flow = i && signIn.state?.id === i.id ? signIn.state : null
        const waiting = !!flow && WAITING.has(flow.state)
        const on = isOn(i) && !flow
        const line = waiting ? (flow.away ? t('integrations.signIn.notFinished') : t('welcome.tools.signingIn', { name: c.name }))
          : flow ? flow.reason || t('welcome.tools.signInFailed', { name: c.name })
            : errors[c.id] || t('welcome.tools.teamLine')
        return (
          <li key={c.id} className={rowCls} data-testid="welcome-tools-service" data-id={c.id} data-kind="team" data-state={on ? 'connected' : waiting ? 'signing-in' : i ? 'needs-sign-in' : 'available'}>
            <LogoTile src={connectorLogo(c)} className={logoCls} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-ink">{c.name}</p>
              {waiting ? <WaitLine className="text-sm text-muted" text={line} hint={t('connect.wait.limit', { n: SIGN_IN_WAIT_MINUTES })} testId="welcome-tools-service-line" />
                : <p className={`text-sm break-words ${flow || errors[c.id] ? 'text-warn' : 'text-muted'}`} data-testid="welcome-tools-service-line">{line}</p>}
              {waiting && flow.url && <a href={flow.url} target="_blank" rel="noopener noreferrer" className={`${quietLink} text-sm`}>{t('integrations.signIn.open')}</a>}
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
      {team.slack !== null && (
        <li className={rowCls} data-testid="welcome-tools-service" data-id={SLACK_APP.id} data-kind="team" data-state={team.slack ? 'connected' : 'available'}>
          <LogoTile src={slackLogo} className={logoCls} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-ink">{SLACK_APP.name}</p>
            <p className="text-sm break-words text-muted" data-testid="welcome-tools-service-line">{t('welcome.tools.slackLine')}</p>
          </div>
          {team.slack ? connected : (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => navigate(SLACK_ADMIN_PATH, { state: setupReturnState('tools') })}
              aria-label={`${t('welcome.tools.teamConnect')}: ${SLACK_APP.name}`} data-testid="welcome-tools-team-connect">{t('welcome.tools.teamConnect')}</Button>
          )}
        </li>
      )}
    </>
  )
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
