// 도구 연결, the welcome steps' step between 팀 파일 and 팀원 초대 (docs/DECISIONS.md "W6 — Onboarding v6"): one screen,
// never blocking, on every team (a phone skips it: pages/Welcome.tsx). The same cards as Connectors' Discover (logo,
// name, one line; QA TC-136):
//  - Google Drive. Where this server has it (`configured`: its own Google client, or the hosting service's sign-in once
//    it answered), one [연결] is the owner's own Google sign-in and, while members may not connect theirs, the team's
//    switch too: both named in the card's line, and the switch turns on only at the confirmed account ("맞아요"), never
//    at the press; a cancel changes nothing. A flow under way comes back after a reload (this tab's session storage
//    keeps its id). Where it does not, the card says so ("아직 설정 안 됨") instead of being left out (TC sheet TC-145).
//  - The first listed services (Notion, Linear, Atlassian, Canva, Figma: lib/connectors.ts). One [연결] makes the
//    owner's own connection to it (its address and sign-in from the list: nothing to type) and opens its sign-in in the
//    window reserved during the click; the card shows how the sign-in goes, and "연결됨" once done (ListedTools).
//  - Last, one quiet "다른 도구 연결하기" line: the add-a-connection dialog for a team connection (kind, name, address,
//    sign-in, who may use it), with its own errors; a saved one is one line under it.
// Once something is connected the primary is the next step; until then only "나중에 하기". After the setup the way back
// is Connectors in the sidebar (the Drive card has the same two effects for an owner or admin).
import { Check, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, type DriveConnection, type Integration } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { APP_CONNECTORS, connectorLogo, CONNECTORS, type Connector } from '../../lib/connectors'
import { builtInLogo } from '../../lib/googleApps'
import { canonicalService, splitByScope } from '../../lib/integrations'
import { aiName } from '../../lib/tabs'
import { mobileApp, openExternal } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { Button } from '../ui'
import { useDriveConnection } from '../settings/DriveConnection'
import { LogoTile } from '../integrations/ConnectorsView'
import { IntegrationDialog } from '../integrations/IntegrationDialog'
import { reserveSignInWindow, useSignIn } from '../integrations/IntegrationRow'

const DRIVE = APP_CONNECTORS[0]
/** the Drive sign-in under way in this tab (its flow id), so a reload shows the same row again */
const FLOW_KEY = 'mycel.welcome.driveFlow'
const keep = (id: string | null) => {
  try { if (id) sessionStorage.setItem(FLOW_KEY, id); else sessionStorage.removeItem(FLOW_KEY) } catch { /* this page only */ }
}
const kept = () => { try { return sessionStorage.getItem(FLOW_KEY) } catch { return null } }

/** Where the way back is after the setup, by the sidebar's own name ("커넥터") */
const connectorsPlace = (t: ReturnType<typeof useT>) => t('integrations.title')

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'
/** the listed services the step offers (Discover's first ones after the built-ins) */
export const WELCOME_SERVICES = 5
/** one card of the step, as Discover's (pages/Connectors.tsx DiscoverCard): logo, name, one line, one thing on the right */
const cardCls = 'flex items-start gap-3 py-3'
const logoCls = 'size-10 rounded-xl p-2'

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
  const [listedOn, setListedOn] = useState(false)
  const [added, setAdded] = useState<Integration[]>([])
  const connected = driveOn || listedOn || added.length > 0 || done
  return (
    <div className="space-y-5" data-testid="welcome-tools">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-ink">{t('welcome.tools.title')}</h2>
        <p className="text-sm text-balance text-muted">{t('welcome.tools.desc', { ai: aiName(t), where: connectorsPlace(t) })}</p>
      </div>
      <div className="space-y-4">
        <ul className="divide-y divide-line border-y border-line" data-testid="welcome-tools-cards">
          <DriveRow onConnected={setDriveOn} />
          <ListedTools onConnected={setListedOn} />
        </ul>
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
  if (!c) return null
  // this server has no Google Drive yet: the card says so (set up in Admin › 커넥터), never a hidden row
  if (!c.configured) return (
    <li className={cardCls} data-testid="welcome-tools-drive" data-state="not-set-up">
      <LogoTile src={builtInLogo('google-drive')} className={logoCls} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-ink">{DRIVE.name}</p>
        <p className="text-sm text-muted" data-testid="welcome-tools-drive-line">{t('drive.setUpFirst')}</p>
      </div>
      <span className="max-w-28 shrink-0 pt-0.5 text-right text-xs text-faint" data-testid="welcome-tools-drive-off">{t('gapps.off.notSetUp')}</span>
    </li>
  )
  const flow = d.inProgress ? d.flow : null
  const start = () => { setNote(null); s.start() }
  const cancel = () => { keep(null); setNote('not'); void d.cancel() }
  const account = c.account?.email ?? c.account?.name ?? ''
  return (
    <li className={cardCls} data-testid="welcome-tools-drive" data-state={linked ? 'connected' : flow ? `flow-${flow.state}` : 'disconnected'}>
      <LogoTile src={builtInLogo('google-drive')} className={logoCls} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-ink">{DRIVE.name}</p>
        {linked ? (
          <p className="text-sm break-words text-muted" data-testid="welcome-tools-drive-connected">{t('welcome.tools.connected', { name: account || t('drive.status.connected') })}</p>
        ) : flow?.state === 'ready' ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="welcome-tools-drive-confirm">
            <span role="status" className="min-w-0 break-words text-ink">{t('welcome.tools.confirm', { account: [flow.account?.email, flow.account?.name].find(Boolean) ?? '' })}</span>
            <Button size="sm" variant="primary" busy={d.busy} onClick={() => void d.complete()} data-testid="welcome-tools-drive-yes">{t('welcome.tools.yes')}</Button>
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
            <p className="text-sm text-muted" data-testid="welcome-tools-drive-line">{t('welcome.tools.driveLine', { ai: aiName(t) })}</p>
            {note && <p className="text-label text-warn" role="alert" data-testid="welcome-tools-drive-note">{note === 'unavailable' ? t('welcome.tools.driveUnavailable', { where: connectorsPlace(t) }) : t('welcome.tools.driveNotConnected')}</p>}
          </>
        )}
      </div>
      {!linked && !flow && (
        <Button size="sm" variant="secondary" className="shrink-0" busy={d.busy} onClick={start} data-testid="welcome-tools-drive-connect">{t('aiApps.connect')}</Button>
      )}
    </li>
  )
}

const WAITING = new Set(['starting', 'pending', 'exchanging'])

/** The first listed services as cards. One [연결]: the owner's own connection to it, made with the list's address and
 * sign-in (POST /api/integrations: nothing to type, nobody else's), then its sign-in at the service in the window
 * reserved during the click. One already there (from Connectors, an earlier visit) shows where it stands; its [연결]
 * signs in again. `onConnected`: any of them connected. */
function ListedTools({ onConnected }: { onConnected: (on: boolean) => void }) {
  const t = useT()
  const locale = useLocale()
  const [mine, setMine] = useState<Integration[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    try { setMine(splitByScope((await api.call(API.listIntegrations)).items).mine) } catch { setMine((m) => m ?? []) }
  }, [])
  useEffect(() => { void load() }, [load])
  const signIn = useSignIn(() => { void load() })
  const services: Connector[] = CONNECTORS.slice(0, WELCOME_SERVICES)
  const own = (c: Connector) => mine?.find((i) => canonicalService(i.url) === canonicalService(c.url))
  const isOn = (i: Integration | undefined) => !!i && i.status === 'connected' && (i.auth !== 'oauth' || i.hasSecret)
  const anyOn = services.some((c) => isOn(own(c)))
  useEffect(() => { onConnected(anyOn) }, [anyOn]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!mine) return null
  const connect = async (c: Connector) => {
    // the window first, during the click (one opened after the server answers is blocked as a popup)
    const w = reserveSignInWindow()
    setErrors((e) => ({ ...e, [c.id]: '' }))
    const there = own(c)
    if (there) { void signIn.start(there.id, w); return }
    setBusy(c.id)
    try {
      const i = await api.call(API.createIntegration, { body: { kind: 'mcp', name: c.name, url: c.url, auth: 'oauth', writePolicy: 'ask' } })
      setMine((m) => [...(m ?? []).filter((x) => x.id !== i.id), i])
      if (i.status === 'needs_auth') void signIn.start(i.id, w)
      else w?.close()
    } catch (e) {
      w?.close()
      setErrors((x) => ({ ...x, [c.id]: errorText(e, locale, t('error.network')) }))
    } finally { setBusy(null) }
  }
  return (
    <>
      {services.map((c) => {
        const i = own(c)
        const flow = i && signIn.state?.id === i.id ? signIn.state : null
        const waiting = !!flow && WAITING.has(flow.state)
        const on = isOn(i) && !flow
        const line = waiting ? (flow.away ? t('integrations.signIn.notFinished') : t('welcome.tools.signingIn', { name: c.name }))
          : flow ? flow.reason || t('welcome.tools.signInFailed', { name: c.name })
            : errors[c.id] || t(`integrations.catalog.${c.id}`)
        return (
          <li key={c.id} className={cardCls} data-testid="welcome-tools-service" data-id={c.id} data-state={on ? 'connected' : waiting ? 'signing-in' : i ? 'needs-sign-in' : 'available'}>
            <LogoTile src={connectorLogo(c)} className={logoCls} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-ink">{c.name}</p>
              <p className={`text-sm break-words ${(flow && !waiting) || errors[c.id] ? 'text-warn' : 'text-muted'}`} role={waiting ? 'status' : undefined} data-testid="welcome-tools-service-line">{line}</p>
              {waiting && flow.url && <a href={flow.url} target="_blank" rel="noopener noreferrer" className={`${quietLink} text-sm`}>{t('integrations.signIn.open')}</a>}
            </div>
            {on ? (
              <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted" data-testid="welcome-tools-service-on">
                <Check size={14} className="text-ok" aria-hidden /> {t('drive.status.connected')}
              </span>
            ) : waiting ? (
              <div className="flex shrink-0 gap-1">
                {flow.away && <Button size="sm" variant="secondary" onClick={() => void connect(c)} data-testid="welcome-tools-service-retry">{t('common.retry')}</Button>}
                <Button size="sm" variant="ghost" onClick={signIn.cancel} data-testid="welcome-tools-service-cancel">{t('common.cancel')}</Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" className="shrink-0" busy={busy === c.id} disabled={!!busy || waiting}
                onClick={() => void connect(c)} aria-label={`${t('aiApps.connect')}: ${c.name}`} data-testid="welcome-tools-service-connect">
                {flow ? t('common.retry') : t('aiApps.connect')}
              </Button>
            )}
          </li>
        )
      })}
    </>
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
