// 도구 연결, the welcome steps' step between 팀 파일 and 팀원 초대 (docs/DECISIONS.md "W6 — Onboarding v6"): one screen,
// never blocking, on every team (a phone skips it: pages/Welcome.tsx). Two things only:
//  - Google Drive, where this server has it (`configured`: its own Google client, or the hosting service's sign-in once
//    it answered; while it has not, the row is not shown and the step stays the same). One [연결] is the owner's own
//    Google sign-in and, while members may not connect theirs, the team's switch too: both named in the row's line, and
//    the switch turns on only at the confirmed account ("맞아요"), never at the press; a cancel changes nothing. A flow
//    under way comes back after a reload (this tab's session storage keeps its id).
//  - one quiet "다른 도구 연결하기" line: today's add-a-connection dialog for a team connection (kind, name,
//    address, sign-in, who may use it), with its own errors; a saved one is one line under it.
// Once something is connected the primary is the next step; until then only "나중에 하기". After the setup the way back
// is Settings › Connected apps (the Drive card has the same two effects for an owner or admin).
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { API, type DriveConnection, type Integration } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { APP_CONNECTORS } from '../../lib/connectors'
import { aiName } from '../../lib/tabs'
import { mobileApp, openExternal } from '../../lib/mobile'
import { useT } from '../../i18n'
import { Button } from '../ui'
import { useDriveConnection } from '../settings/DriveConnection'
import { DriveLogo } from '../integrations/DriveConnector'
import { IntegrationDialog } from '../integrations/IntegrationDialog'
import { useSignIn } from '../integrations/IntegrationRow'

const DRIVE = APP_CONNECTORS[0]
/** the Drive sign-in under way in this tab (its flow id), so a reload shows the same row again */
const FLOW_KEY = 'mycel.welcome.driveFlow'
const keep = (id: string | null) => {
  try { if (id) sessionStorage.setItem(FLOW_KEY, id); else sessionStorage.removeItem(FLOW_KEY) } catch { /* this page only */ }
}
const kept = () => { try { return sessionStorage.getItem(FLOW_KEY) } catch { return null } }

/** Where the way back is after the setup, by the menus' own names ("설정 › 연결한 서비스") */
const connectorsPlace = (t: ReturnType<typeof useT>) => `${t('settings.title')} › ${t('integrations.title')}`

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

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
  const [driveOn, setDriveOn] = useState(false)
  const [added, setAdded] = useState<Integration[]>([])
  const connected = driveOn || added.length > 0 || done
  return (
    <div className="space-y-5" data-testid="welcome-tools">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-ink">{t('welcome.tools.title')}</h2>
        <p className="text-sm text-balance text-muted">{t('welcome.tools.desc', { ai: aiName(t), where: connectorsPlace(t) })}</p>
      </div>
      <div className="space-y-4">
        <DriveRow onConnected={setDriveOn} />
        <OtherTools added={added} onAdded={(i) => setAdded((x) => [...x.filter((y) => y.id !== i.id), i])} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {connected ? (
          <Button variant="primary" className="max-sm:w-full" disabled={busy} onClick={onDone} data-testid="welcome-tools-next">{nextLabel}</Button>
        ) : <span />}
        {/* once something is connected, the next step is the one way on (the 팀 파일 rule) */}
        {!connected && (
          <Button variant="ghost" onClick={onSkip} disabled={busy} data-testid="welcome-later">{t('welcome.later')}</Button>
        )}
      </div>
    </div>
  )
}

/** The Drive row: hidden until the server says it has Drive (and on a failed read); then [연결] → Google's window →
 * "{account} 계정이 맞나요? [맞아요] [다른 계정]" → "연결됨 · {account}". */
function DriveRow({ onConnected }: { onConnected: (on: boolean) => void }) {
  const t = useT()
  const s = useDriveConnection((c) => { keep(null); onConnected(c.status === 'connected') })
  const { d } = s
  const c: DriveConnection | null = s.connection
  const [note, setNote] = useState<'not' | 'unavailable' | null>(null)
  const linked = c?.status === 'connected'
  // members may not connect theirs yet: this press turns that on too (named in the line), at the confirm. The confirm
  // always asks for it (the owner walks these steps): the server ignores it while the switch is on, and a switch another
  // admin turned off meanwhile is turned on as the line said
  const turnOn = c?.personalAllowed === false
  useEffect(() => { onConnected(linked) }, [linked]) // eslint-disable-line react-hooks/exhaustive-deps
  // a sign-in this tab started before a reload: shown again where it stands
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || !c?.configured || linked) return
    resumed.current = true
    const id = kept()
    if (id) void d.resume(id)
  }, [c?.configured, linked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d.flow?.flowId) keep(d.flow.flowId) }, [d.flow?.flowId])
  // a sign-in that failed or was refused: back to [연결] with why (the hosting service down, or not connected); a poll
  // that failed once while the flow goes on is no failure
  useEffect(() => {
    if (!d.error || d.inProgress) return
    keep(null)
    setNote(d.reason?.includes('broker_unavailable') ? 'unavailable' : 'not')
  }, [d.error, d.reason, d.inProgress])
  if (!c?.configured) return null
  const flow = d.inProgress ? d.flow : null
  const start = () => { setNote(null); s.start() }
  const cancel = () => { keep(null); setNote('not'); void d.cancel() }
  const account = c.account?.email ?? c.account?.name ?? ''
  return (
    <div className="flex items-start gap-3" data-testid="welcome-tools-drive" data-state={linked ? 'connected' : flow ? `flow-${flow.state}` : 'disconnected'}>
      <DriveLogo className="size-9 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-ink">{DRIVE.name}</p>
        {linked ? (
          <p className="text-sm break-words text-muted" data-testid="welcome-tools-drive-connected">{t('welcome.tools.connected', { name: account || t('drive.status.connected') })}</p>
        ) : flow?.state === 'ready' ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="welcome-tools-drive-confirm">
            <span role="status" className="min-w-0 break-words text-ink">{t('welcome.tools.confirm', { account: [flow.account?.email, flow.account?.name].find(Boolean) ?? '' })}</span>
            <Button size="sm" variant="primary" busy={d.busy} onClick={() => void d.complete({ membersOn: true })} data-testid="welcome-tools-drive-yes">{t('welcome.tools.yes')}</Button>
            <Button size="sm" variant="ghost" disabled={d.busy} onClick={() => { keep(null); setNote(null); void d.cancel() }} data-testid="welcome-tools-drive-other">{t('welcome.tools.other')}</Button>
          </div>
        ) : flow ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" role="status" data-testid="welcome-tools-drive-waiting">
            <span className="text-muted">{d.popupBlocked ? t('welcome.tools.popupBlocked') : t('drive.waitingShort')}</span>
            {d.authorizationUrl && (
              <a href={d.authorizationUrl} target="_blank" rel="noopener noreferrer" className={quietLink}
                onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>
                {t('drive.openGoogle')}
              </a>
            )}
            <Button size="sm" variant="ghost" disabled={d.busy} onClick={cancel} data-testid="welcome-tools-drive-cancel">{t('common.cancel')}</Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted" data-testid="welcome-tools-drive-line">{t(turnOn ? 'welcome.tools.driveLineOn' : 'welcome.tools.driveLine', { ai: aiName(t) })}</p>
            {note && <p className="text-label text-warn" role="alert" data-testid="welcome-tools-drive-note">{note === 'unavailable' ? t('welcome.tools.driveUnavailable', { where: connectorsPlace(t) }) : t('welcome.tools.driveNotConnected')}</p>}
          </>
        )}
      </div>
      {!linked && !flow && (
        <Button size="sm" variant="secondary" className="shrink-0" busy={d.busy} onClick={start} data-testid="welcome-tools-drive-connect">{t('aiApps.connect')}</Button>
      )}
    </div>
  )
}

/** "다른 도구 연결하기 (MCP)": today's add-a-connection dialog for a team connection; each one saved here is one line
 * under it ("연결됨 · {name}", "· 확인이 필요해요" when its check failed), its sign-in at the service right after the save
 * when it asks for one. */
function OtherTools({ added, onAdded }: { added: Integration[]; onAdded: (i: Integration) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const signIn = useSignIn((id) => {
    // signed in: the connection as the server keeps it now
    void api.call(API.listTeamIntegrations).then((r) => { const i = r.items.find((x) => x.id === id); if (i) onAdded(i) }, () => {})
  })
  const flow = signIn.state
  return (
    <div className="space-y-1.5" data-testid="welcome-tools-mcp">
      <p className="text-sm">
        <button type="button" className={`${quietLink} inline-flex items-center gap-1.5`} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="welcome-tools-mcp-add">
          <Plus size={14} className="shrink-0 text-faint" aria-hidden /> {t('welcome.tools.mcp')}
        </button>
      </p>
      {added.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="welcome-tools-mcp-list">
          {added.map((i) => {
            const mine = flow?.id === i.id ? flow : null
            const waiting = !!mine && ['starting', 'pending', 'exchanging'].includes(mine.state)
            return (
              <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted" data-testid="welcome-tools-mcp-item" data-status={i.status}>
                <span className="min-w-0 break-words">
                  {waiting ? t('welcome.tools.signingIn', { name: i.name })
                    : mine ? t('welcome.tools.signInFailed', { name: i.name })
                      : i.status === 'error' || i.status === 'needs_auth' ? t('welcome.tools.mcpCheck', { name: i.name })
                        : t('welcome.tools.connected', { name: i.name })}
                </span>
                {waiting && mine?.url && <a href={mine.url} target="_blank" rel="noopener noreferrer" className={quietLink}>{t('integrations.signIn.open')}</a>}
                {waiting && <Button size="sm" variant="ghost" onClick={signIn.cancel}>{t('common.cancel')}</Button>}
                {mine && !waiting && <Button size="sm" variant="ghost" onClick={() => void signIn.start(i.id)}>{t('common.retry')}</Button>}
              </li>
            )
          })}
        </ul>
      )}
      {open && (
        <IntegrationDialog
          scope="team"
          onClose={() => setOpen(false)}
          onSaved={(i, next) => {
            setOpen(false)
            onAdded(i)
            // the sign-in at the service next, in the window reserved during the click
            if (next && i.status === 'needs_auth') void signIn.start(i.id, next.window)
            else next?.window?.close()
          }}
        />
      )}
    </div>
  )
}

export default ToolsStep
