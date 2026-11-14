// "Add an app" / "Apps posting here" (docs/DECISIONS.md "Apps posting in rooms", plan
// docs/AGENTS/plan/20261114-0900-room-apps.md screens 1, 2, 5 and 7): one dialog (a bottom sheet on a phone: Modal) with
// its screens: the picker (four letter-tile rows), a kind's guide (the address, numbered steps in that service, the live
// status line), the list of the room's apps and one app's settings (status line, switches, Quiet, Address with "Get a
// new address", Remove). Without an internet address the picker's place says who can turn the relay on (owner: the
// connection settings; everyone else: ask the owner). Opened from the room's ⋯ (RoomMenu), the sender's "Manage"
// (AppSender) and the paused notice's "Open settings" (pages/Activity). Only the people who manage the room's apps see
// it (store/roomApps.ts mayManageApps); the server checks again.
// Nothing is made by picking: the app is added on the guide's first Copy (address, code or secret), so closing the guide
// before that leaves nothing behind. Trina's own words never say "webhook"; the services' screen labels are quoted
// (roomApps.vendorLabel.*, to be checked against the live tools in QA TC-1546).
import clsx from 'clsx'
import { AlertCircle, Check, ChevronLeft, ChevronRight, Circle, ExternalLink, PauseCircle, Plus } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ROOM_APP_SWITCHES, roomAppFormsScript, type Locale, type RoomApp, type RoomAppKind, type RoomAppList } from '@mycel/shared/api'
import { api, API, errorText } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { appStatus, NOTHING_YET_MS, waitsForEvent } from '../../../lib/roomApps'
import { useLocale, useT } from '../../../i18n'
import { useRooms } from '../../../store/rooms'
import { useRoomApps, type AppsStart } from '../../../store/roomApps'
import { isOwner, useMe } from '../../../store/session'
import { toast } from '../../../store/ui'
import { ListRow } from '../../list/List'
import { Button, confirmDialog, IconButton, inputCls, Modal, Skeleton, Switch } from '../../ui'
import { useRoomTitle } from '../RoomIcon'
import { AppTile } from './AppParts'

const KINDS: RoomAppKind[] = ['sentry', 'github', 'google_forms', 'other']
/** the user guide's page about apps in rooms (docs/site/use/room-apps.md) */
export const ROOM_APPS_GUIDE = 'https://ax.trina.app/docs/use/room-apps/'
/** how often an open guide or settings page reads the app again while it waits for its first message (or a refusal) */
const POLL_MS = 4000

/** A service's own screen label, quoted the way the language quotes ("Webhook URL", 「Webhook URL」). */
function quote(locale: Locale, s: string): string {
  return locale === 'ja' || locale === 'zh' ? `「${s}」` : `“${s}”`
}
function useVendor() {
  const t = useT()
  const locale = useLocale()
  return (k: string) => quote(locale, t(`roomApps.vendorLabel.${k}` as never))
}

/** The address cut in its middle for the field ("https://acme.trina.app/in/tax_in_Ab…9xQ"): the whole one is copied. */
export function middleCut(s: string, head = 34, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** Copy what `make` gives, in the same click: the text may come from the server (the first Copy adds the app), and
 * Safari only lets a page write the clipboard in the click itself (a ClipboardItem with a promise). Throws with the
 * text when no copy was possible, so the screen can show it to copy by hand. */
async function copyFrom(make: Promise<string>): Promise<string> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': make.then((s) => new Blob([s], { type: 'text/plain' })) })])
      return await make
    }
  } catch {
    // fall through: the text is written the plain way once it is here
  }
  const s = await make
  await navigator.clipboard.writeText(s)
  return s
}

type View = { view: 'pick' } | { view: 'list' } | { view: 'settings'; appId: string } | { view: 'guide'; kind: RoomAppKind; appId?: string }

export function AppsDialog({ roomId, start }: { roomId: string; start: AppsStart }) {
  const t = useT()
  const locale = useLocale()
  const list = useRoomApps((s) => s.lists[roomId])
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const roomTitle = useRoomTitle()
  const [error, setError] = useState<string | null>(null)
  const [stack, setStack] = useState<View[]>(start.view === 'auto' ? [] : [start])
  const close = () => useRoomApps.getState().close()
  const reload = useCallback(() => useRoomApps.getState().load(roomId).then(() => setError(null), (e) => setError(errorText(e, locale, t('error.network')))), [roomId, locale, t])
  useEffect(() => { void reload() }, [reload])
  // "auto": the list when the room has apps, else the picker
  const view: View | null = stack.at(-1) ?? (list ? (list.items.length ? { view: 'list' } : { view: 'pick' }) : null)
  const go = (v: View) => setStack((s) => [...(s.length || !view ? s : [view]), v])
  const back = stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : view?.view !== 'list' && view?.view !== 'pick' && list?.items.length ? () => setStack([{ view: 'list' }]) : null
  const name = room ? roomTitle(room) : ''
  const app = view && 'appId' in view && view.appId ? list?.items.find((a) => a.id === view.appId) ?? null : null
  const title = !view ? t('roomApps.listTitle')
    : view.view === 'pick' ? t('roomApps.pickTitle')
    : view.view === 'list' ? t('roomApps.listTitle')
    : view.view === 'guide' ? t('roomApps.guideTitle', { app: app?.name ?? t(`roomApps.kind.${view.kind}`) })
    : app?.name ?? ''
  // a new app needs the internet address; the list and settings of existing ones say it is gone
  const blocked = !!list && !list.available && (view?.view === 'pick' || (view?.view === 'guide' && !view.appId))
  return (
    <Modal
      open
      onClose={close}
      width={480}
      title={
        <span className="flex min-w-0 items-center gap-1">
          {back && (
            <IconButton label={t('roomApps.back')} onClick={back} className="touch-hit -ml-2 shrink-0" data-testid="apps-back">
              <ChevronLeft size={18} aria-hidden />
            </IconButton>
          )}
          <span className="truncate" data-testid="apps-title">{title}</span>
        </span>
      }
    >
      <div data-testid="apps-dialog" data-view={blocked ? 'no-address' : view?.view}>
        {error && !list ? <p className="text-sm text-danger" role="alert">{error}</p>
          : !list || !view ? <Skeleton lines={4} />
          : blocked ? <NoAddress />
          : view.view === 'pick' ? <Picker list={list} roomName={name} onPick={(kind) => go({ view: 'guide', kind })} />
          : view.view === 'list' ? <AppList list={list} onOpen={(id) => go({ view: 'settings', appId: id })} onAdd={() => go({ view: 'pick' })} />
          : view.view === 'guide' ? <Guide roomId={roomId} kind={view.kind} app={app} onAdded={(a) => setStack((s) => [...s.slice(0, -1), { view: 'guide', kind: a.kind, appId: a.id }])} onDone={close} />
          : app ? <Settings roomId={roomId} roomName={name} app={app} available={list.available} onAgain={() => go({ view: 'guide', kind: app.kind, appId: app.id })} onRemoved={() => setStack([{ view: list.items.length > 1 ? 'list' : 'pick' }])} />
          : <p className="text-sm text-muted">{t('rooms.notFound')}</p>}
      </div>
    </Modal>
  )
}

// ---------------- 7. no internet address ----------------
function NoAddress() {
  const t = useT()
  const me = useMe()
  const owner = isOwner(me)
  const close = () => useRoomApps.getState().close()
  return (
    <div className="space-y-3 text-sm" data-testid="apps-no-address">
      <p className="text-ink">{t('roomApps.noAddressLead')}</p>
      <p className="text-muted" data-testid="apps-no-address-who">{t(owner ? 'roomApps.noAddressOwner' : 'roomApps.noAddressOthers')}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {owner && (
          <Link to="/admin/system/connection" onClick={close} className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:opacity-90 max-md:h-11" data-testid="apps-open-connection">
            {t('roomApps.openConnection')}
          </Link>
        )}
        <a href={ROOM_APPS_GUIDE} target="_blank" rel="noopener noreferrer" className="touch-hit inline-flex items-center gap-1 text-accent-text hover:underline" data-testid="apps-how-it-works">
          {t('roomApps.howItWorks')}
          <ExternalLink size={12} aria-hidden />
        </a>
      </div>
    </div>
  )
}

// ---------------- 1. the picker ----------------
function Picker({ list, roomName, onPick }: { list: RoomAppList; roomName: string; onPick: (k: RoomAppKind) => void }) {
  const t = useT()
  const left = list.max - list.items.length
  const full = left <= 0
  return (
    <div className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-picker">
      <p className="px-5 pt-4 pb-2 text-sm text-muted max-sm:px-4">{t('roomApps.pickLead', { room: roomName })}</p>
      <ul className="px-2 pb-2 max-sm:px-1">
        {KINDS.map((k) => (
          <ListRow key={k} onClick={() => onPick(k)} disabled={full} lead={<AppTile kind={k} name={t(`roomApps.kind.${k}`)} size={28} />} strong name={t(`roomApps.kind.${k}`)} meta={t(`roomApps.hint.${k}`)} end={<ChevronRight size={16} className="shrink-0 self-center text-faint" aria-hidden />} testId={`apps-pick-${k}`} />
        ))}
      </ul>
      {(full || left <= 2) && <p className="border-t border-line px-5 py-3 text-xs text-muted max-sm:px-4" data-testid="apps-left">{full ? t('roomApps.pickFull', { max: list.max }) : t('roomApps.pickLeft', { left })}</p>}
    </div>
  )
}

// ---------------- 5. the list ----------------
function AppList({ list, onOpen, onAdd }: { list: RoomAppList; onOpen: (id: string) => void; onAdd: () => void }) {
  const t = useT()
  const left = list.max - list.items.length
  return (
    <div className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-list">
      {!list.available && <NoAddressLine className="mx-5 mt-4 max-sm:mx-4" />}
      <ul className="px-2 py-2 max-sm:px-1">
        {list.items.map((a) => (
          <ListRow
            key={a.id}
            onClick={() => onOpen(a.id)}
            lead={<AppTile kind={a.kind} name={a.name} size={28} />}
            strong
            name={a.name}
            meta={a.leaverKnows ? <span className="text-warn">{t('roomApps.leaverKnows')}</span> : a.pausedUntil ? `${t('roomApps.paused')} · ${t('roomApps.startsTomorrow')}` : a.createdBy ? t('roomApps.setUpBy', { name: a.createdBy.name }) : t('roomApps.setUpByGone')}
            tag={a.pausedUntil ? <span className="inline-flex items-center gap-1 text-warn"><PauseCircle size={12} aria-hidden />{t('roomApps.paused')}</span> : t('roomApps.today', { count: a.today })}
            end={<ChevronRight size={16} className="shrink-0 self-center text-faint" aria-hidden />}
            testId="apps-list-row"
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 max-sm:px-4">
        <Button size="sm" onClick={onAdd} disabled={left <= 0 || !list.available} data-testid="apps-add">
          <Plus size={14} aria-hidden />
          {t('roomApps.add')}
        </Button>
        {left <= 2 && <span className="text-xs text-muted" data-testid="apps-left">{left <= 0 ? t('roomApps.pickFull', { max: list.max }) : t('roomApps.pickLeft', { left })}</span>}
      </div>
    </div>
  )
}

function NoAddressLine({ className }: { className?: string }) {
  const t = useT()
  return (
    <p className={clsx('flex items-start gap-2 border-l-2 border-warn py-1 pl-3 text-sm text-ink', className)} role="status" data-testid="apps-status-no-address">
      {t('roomApps.statusNoAddress')}
    </p>
  )
}

// ---------------- the status line (guide and settings) ----------------
/** The one status line: connected / last message, a refusal with its reason, paused, or waiting. */
function StatusLine({ app, kind, place, onAgain, onResume }: { app: RoomApp | null; kind: RoomAppKind; place: 'guide' | 'settings'; onAgain?: () => void; onResume?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const s = app ? appStatus(app) : { kind: 'none' as const }
  const time = (iso: string) => formatDateTime(iso, locale)
  const [icon, text, tone] = s.kind === 'refused' ? [<AlertCircle key="i" size={15} aria-hidden />, t('roomApps.statusRefused', { time: time(s.at), reason: t(`roomApps.reason.${s.reason}`) }), 'text-danger']
    : s.kind === 'paused' ? [<PauseCircle key="i" size={15} aria-hidden />, t('roomApps.statusPaused', { cap: 500 }), 'text-warn']
    : s.kind === 'ok' ? [<Check key="i" size={15} aria-hidden />, place === 'guide' ? t('roomApps.connected', { time: time(s.first) }) : t('roomApps.statusOk', { when: time(s.last) }), 'text-ok']
    : [<Circle key="i" size={13} aria-hidden />, place === 'settings' ? t('roomApps.statusNone') : kind === 'sentry' ? t('roomApps.waitSentry') : kind === 'google_forms' ? t('roomApps.waitForms') : t('roomApps.waiting'), 'text-muted']
  return (
    <div className="flex items-start gap-2 text-sm" role="status" aria-live="polite" data-testid="apps-status" data-state={s.kind}>
      <span className={clsx('mt-0.5 shrink-0', tone)}>{icon}</span>
      <span className="min-w-0 flex-1 text-ink">
        {text}
        {s.kind === 'refused' && s.reason === 'signature' && onAgain && (
          <> <button type="button" onClick={onAgain} className="touch-hit font-medium text-accent-text hover:underline" data-testid="apps-set-up-again">{t('roomApps.setUpAgain')}</button></>
        )}
      </span>
      {s.kind === 'paused' && app?.canResume && onResume && <Button size="sm" onClick={onResume} data-testid="apps-resume">{t('roomApps.resumeNow')}</Button>}
    </div>
  )
}

/** While a screen is open on an app that has not shown a message yet (or whose last try was refused), its state is read
 * again now and then, and at once when a message from it reaches the room: the status line follows live. */
function useLive(roomId: string, app: RoomApp | null) {
  const s = app ? appStatus(app).kind : null
  const watching = !!app && (s === 'none' || s === 'refused')
  const appId = app?.id ?? null
  const arrived = useRooms((st) => (appId && st.timeline?.roomId === roomId ? st.timeline.messages.some((m) => m.app?.id === appId && !m.app.example) : false))
  useEffect(() => {
    if (!watching) return
    const id = setInterval(() => { void useRoomApps.getState().load(roomId).catch(() => {}) }, POLL_MS)
    return () => clearInterval(id)
  }, [watching, roomId])
  useEffect(() => { if (arrived && watching) void useRoomApps.getState().load(roomId).catch(() => {}) }, [arrived, watching, roomId])
}

// ---------------- 2. the guide ----------------
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm text-ink" data-testid="apps-step">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold text-muted">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">{children}</div>
    </li>
  )
}

function Fold({ summary, children, testId }: { summary: string; children: ReactNode; testId: string }) {
  return (
    <details className="group rounded-lg border border-line" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-ink md:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden className="shrink-0 text-faint transition group-open:rotate-90" />
        {summary}
      </summary>
      <div className="space-y-2 px-3 pb-3 text-sm text-ink">{children}</div>
    </details>
  )
}

function Guide({ roomId, kind, app, onAdded, onDone }: { roomId: string; kind: RoomAppKind; app: RoomApp | null; onAdded: (a: RoomApp) => void; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const v = useVendor()
  const [address, setAddress] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'address' | 'secret' | null>(null)
  const [manual, setManual] = useState<string | null>(null)
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  useLive(roomId, app)
  // an app set up before (Set up again, a guide reopened): its address (and a secret Trina made) to copy again
  useEffect(() => {
    if (!app || address) return
    api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } }).then((a) => { setAddress(a.address); if (a.secret) setSecret(a.secret) }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id])
  /** the address, adding the app on the first Copy */
  const ensure = async (): Promise<{ app: RoomApp; address: string }> => {
    if (app && address) return { app, address }
    if (app) {
      const a = await api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } })
      setAddress(a.address)
      return { app, address: a.address }
    }
    const r = await api.call(API.createRoomApp, { params: { id: roomId }, body: { kind } })
    setAddress(r.address)
    useRoomApps.getState().put(r.app)
    onAdded(r.app)
    return r
  }
  const flash = (w: 'address' | 'secret') => { setCopied(w); setTimeout(() => setCopied((c) => (c === w ? null : c)), 1500) }
  const copyAddress = async () => {
    setBusy(true)
    setManual(null)
    const made = ensure().then((r) => (kind === 'google_forms' ? roomAppFormsScript(r.address, r.app.events.email !== false) : r.address))
    try {
      await copyFrom(made)
      flash('address')
    } catch (e) {
      // the app may be there with its address: show it to copy by hand
      const text = await made.catch(() => null)
      if (text) setManual(text)
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  const copySecret = async () => {
    setBusy(true)
    const made = (async () => {
      const r = await ensure()
      if (secret) return secret
      const s = await api.call(API.setRoomAppSecret, { params: { id: roomId, appId: r.app.id }, body: { generate: true } })
      useRoomApps.getState().put(s.app)
      setSecret(s.secret ?? null)
      return s.secret ?? ''
    })()
    try {
      await copyFrom(made)
      flash('secret')
    } catch (e) {
      const text = await made.catch(() => null)
      if (text) setManual(text)
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  const copyLabel = kind === 'google_forms' ? t('roomApps.copyCode') : t('roomApps.copyAddress')
  const s = app ? appStatus(app).kind : 'none'
  // GitHub and Other can send a test at once: after two minutes without one, a short checklist
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (waitsForEvent(kind) || !app || s !== 'none') return
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [kind, app, s])
  const nothingYet = !waitsForEvent(kind) && !!app && s === 'none' && now - Date.parse(app.createdAt) >= NOTHING_YET_MS
  const example = async () => {
    if (!app) return
    try {
      await api.call(API.exampleRoomApp, { params: { id: roomId, appId: app.id } })
      toast({ level: 'success', text: t('roomApps.exampleSent') })
    } catch (e) { fail(e) }
  }
  const curl = useMemo(() => `curl -X POST -H 'Content-Type: application/json' -d '{"text":"Hi"}' ${address ?? '<address>'}`, [address])
  return (
    <div className="space-y-4" data-testid="apps-guide" data-kind={kind}>
      {/* the address: read-only, cut in its middle, the whole one copied */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted" id="apps-address-label">{t('roomApps.addressLabel')}</p>
        <div className="flex gap-2 max-sm:flex-col">
          <div aria-labelledby="apps-address-label" title={address ?? undefined} className={clsx(inputCls, 'flex min-w-0 flex-1 items-center truncate font-mono text-code-sm select-all', !address && 'font-sans text-faint')} data-testid="apps-address">
            {address ? middleCut(address) : t('roomApps.addressPlaceholder')}
          </div>
          <Button variant="primary" onClick={() => void copyAddress()} busy={busy && copied === null} className="shrink-0 max-sm:w-full" data-testid="apps-copy-address">
            {copied === 'address' ? <><Check size={14} aria-hidden />{t('roomApps.copied')}</> : copyLabel}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('roomApps.addressPrivate')}</p>
        {manual && (
          <div className="space-y-1">
            <p className="text-xs text-danger" role="alert">{t('roomApps.copyFailed')}</p>
            <textarea readOnly value={manual} rows={3} onFocus={(e) => e.currentTarget.select()} className={clsx(inputCls, 'h-auto font-mono text-code-sm')} data-testid="apps-manual-copy" />
          </div>
        )}
      </div>

      <ol className="space-y-3" data-testid="apps-steps">
        {kind === 'sentry' && <>
          <Step n={1}>
            <p>{t('roomApps.sentry1', { path: v('sentryPath'), create: v('sentryCreate') })}</p>
            <p className="text-xs text-muted">{t('roomApps.sentryRole')}</p>
          </Step>
          <Step n={2}><p>{t('roomApps.sentry2', { url: v('sentryUrl') })}</p></Step>
          <Step n={3}><p>{t('roomApps.sentry3', { perms: v('sentryPerms'), issueEvent: v('sentryIssueEvent'), read: v('sentryRead'), hooks: v('sentryHooks'), issue: v('sentryIssue') })}</p></Step>
        </>}
        {kind === 'github' && <>
          <Step n={1}>
            <p>{t('roomApps.github1', { path: v('githubPath') })}</p>
            <p className="text-xs text-muted">{t('roomApps.githubRole')}</p>
          </Step>
          <Step n={2}><p>{t('roomApps.github2', { url: v('githubUrl'), json: v('githubJson') })}</p></Step>
          <Step n={3}><p>{t('roomApps.github3', { all: v('githubAll'), add: v('githubAdd') })}</p></Step>
        </>}
        {kind === 'google_forms' && <>
          <Step n={1}><p>{t('roomApps.forms1', { path: v('formsPath') })}</p></Step>
          <Step n={2}><p>{t('roomApps.forms2')}</p></Step>
          <Step n={3}><p>{t('roomApps.forms3', { unverified: v('formsUnverified'), advanced: v('formsAdvanced') })}</p></Step>
          <Step n={4}>
            <p>{t('roomApps.forms4')}</p>
            <p className="text-xs text-muted" data-testid="apps-forms-email">{t('roomApps.formsEmail')}</p>
          </Step>
        </>}
        {kind === 'other' && <>
          <Step n={1}><p>{t('roomApps.other1', { term: v('otherTerm') })}</p></Step>
          <Step n={2}><p>{t('roomApps.other2')}</p></Step>
          <Step n={3}>
            <p>{t('roomApps.other3')}</p>
            <p className="text-xs text-muted">{t('roomApps.otherExample')} <code className="font-mono text-code-sm text-ink">{'{"text": "Backup finished"}'}</code></p>
          </Step>
        </>}
      </ol>

      {/* optional: signatures (owner decision 9), Sentry's alert rules */}
      {(kind === 'github' || kind === 'sentry') && (
        <Fold summary={t('roomApps.safer')} testId="apps-safer">
          {kind === 'github' ? <p>{t('roomApps.saferGithub', { secret: v('githubSecret') })}</p> : <p>{t('roomApps.saferSentry', { secret: v('sentrySecret') })}</p>}
          {app?.signed && !secret ? (
            <SignedLine roomId={roomId} app={app} />
          ) : kind === 'github' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void copySecret()} disabled={busy} data-testid="apps-copy-secret">
                {copied === 'secret' ? <><Check size={14} aria-hidden />{t('roomApps.copied')}</> : t('roomApps.copySecret')}
              </Button>
              {app?.signed && <SignedLine roomId={roomId} app={app} />}
            </div>
          ) : (
            <SentrySecret roomId={roomId} app={app} ensure={ensure} />
          )}
        </Fold>
      )}
      {kind === 'sentry' && (
        <Fold summary={t('roomApps.sentryAlert')} testId="apps-sentry-alert">
          <p>{t('roomApps.sentryAlertBody', { alerts: v('sentryAlerts'), action: v('sentryAlertAction') })}</p>
        </Fold>
      )}

      <div className="border-t border-line pt-3">
        <StatusLine app={app} kind={kind} place="guide" />
        {nothingYet && (
          <Fold summary={t('roomApps.nothingYet')} testId="apps-nothing-yet">
            <ul className="list-disc space-y-1 pl-5">
              {kind === 'github' ? <>
                <li>{t('roomApps.checkJson', { json: v('githubJson') })}</li>
                <li>{t('roomApps.checkSecret')}</li>
                <li>{t('roomApps.checkDeliveries', { deliveries: v('githubDeliveries') })}</li>
              </> : <>
                <li>{t('roomApps.checkAddress')}</li>
                <li>{t('roomApps.checkText')}</li>
                {/* a terminal is a computer's */}
                <li className="max-md:hidden">{t('roomApps.checkCurl')} <code className="mt-1 block font-mono text-code-sm break-all text-ink" data-testid="apps-curl">{curl}</code></li>
              </>}
            </ul>
          </Fold>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {app && <Button variant="ghost" onClick={() => void example()} data-testid="apps-example">{t('roomApps.showExample')}</Button>}
        <Button variant="primary" onClick={onDone} data-testid="apps-done">{t('roomApps.done')}</Button>
      </div>
    </div>
  )
}

/** A secret is set: only signed messages are shown; "Turn off" takes it away (unsigned ones are shown again, their
 * names marked "(unverified)"). */
function SignedLine({ roomId, app }: { roomId: string; app: RoomApp }) {
  const t = useT()
  const locale = useLocale()
  const off = async () => {
    try {
      const r = await api.call(API.setRoomAppSecret, { params: { id: roomId, appId: app.id }, body: { secret: null } })
      useRoomApps.getState().put(r.app)
    } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="apps-signed">
      <Check size={14} className="text-ok" aria-hidden />
      <span>{t('roomApps.saferOn')}</span>
      <button type="button" onClick={() => void off()} className="touch-hit font-medium text-accent-text hover:underline" data-testid="apps-secret-off">{t('roomApps.saferOff')}</button>
    </p>
  )
}

/** Sentry's Client Secret, pasted and saved. Saving before the address was copied adds the app first. */
function SentrySecret({ roomId, app, ensure }: { roomId: string; app: RoomApp | null; ensure: () => Promise<{ app: RoomApp }> }) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const a = app ?? (await ensure()).app
      const r = await api.call(API.setRoomAppSecret, { params: { id: roomId, appId: a.id }, body: { secret: value.trim() } })
      useRoomApps.getState().put(r.app)
      setValue('')
    } catch (e) { setErr(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  return (
    <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">{t('roomApps.secretPlaceholder')}</label>
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('roomApps.secretPlaceholder')} autoComplete="off" spellCheck={false} className={clsx(inputCls, 'min-w-0 flex-1 font-mono text-code-sm')} aria-invalid={!!err} data-testid="apps-sentry-secret" />
        <Button type="submit" disabled={!value.trim() || busy} busy={busy} data-testid="apps-sentry-secret-save">{t('roomApps.save')}</Button>
      </div>
      {err && <p className="text-xs text-danger" role="alert" data-testid="apps-secret-error">{err}</p>}
    </form>
  )
}

// ---------------- 5. one app's settings ----------------
function Settings({ roomId, roomName, app, available, onAgain, onRemoved }: { roomId: string; roomName: string; app: RoomApp; available: boolean; onAgain: () => void; onRemoved: () => void }) {
  const t = useT()
  const locale = useLocale()
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  useLive(roomId, app)
  const [error, setError] = useState(false)
  const set = async (body: { events?: Record<string, boolean>; quiet?: boolean }) => {
    setError(false)
    try { await useRoomApps.getState().update(roomId, app.id, body) } catch { setError(true) }
  }
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const made = (fresh ? Promise.resolve(fresh) : api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } }).then((a) => a.address))
      .then((a) => (app.kind === 'google_forms' ? roomAppFormsScript(a, app.events.email !== false) : a))
    try {
      await copyFrom(made)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) { fail(e) }
  }
  const rotate = async () => {
    const ok = await confirmDialog({ title: t('roomApps.newAddressTitle'), body: app.kind === 'google_forms' ? t('roomApps.newAddressBodyForms') : t('roomApps.newAddressBody', { app: app.name }), confirm: t('roomApps.newAddressConfirm') })
    if (!ok) return
    try {
      const r = await api.call(API.rotateRoomApp, { params: { id: roomId, appId: app.id } })
      useRoomApps.getState().put(r.app)
      setFresh(r.address)
    } catch (e) { fail(e) }
  }
  const remove = async () => {
    const ok = await confirmDialog({ title: t('roomApps.removeTitle', { app: app.name, room: roomName }), body: t('roomApps.removeBody', { app: app.name }), confirm: t('roomApps.removeConfirm'), danger: true })
    if (!ok) return
    try {
      await api.call(API.deleteRoomApp, { params: { id: roomId, appId: app.id } })
      useRoomApps.getState().drop(roomId, app.id)
      onRemoved()
    } catch (e) { fail(e) }
  }
  const resume = async () => {
    try {
      const a = await api.call(API.resumeRoomApp, { params: { id: roomId, appId: app.id } })
      useRoomApps.getState().put(a)
      toast({ level: 'success', text: t('roomApps.resumed', { app: app.name }) })
    } catch (e) { fail(e) }
  }
  const quietId = useId()
  return (
    <div className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-settings" data-kind={app.kind}>
      <div className="space-y-2 px-5 pt-4 pb-3 max-sm:px-4">
        {!available && <NoAddressLine />}
        <StatusLine app={app} kind={app.kind} place="settings" onAgain={onAgain} onResume={() => void resume()} />
        {/* someone who was shown the address can no longer manage the app (left the room or the team, no longer an
            admin): one line with the way out (the server's room_app_viewers; it never changes the address by itself) */}
        {app.leaverKnows && !fresh && (
          <p className="flex flex-wrap items-center gap-x-1.5 border-l-2 border-warn py-0.5 pl-3 text-sm text-ink" role="status" data-testid="apps-leaver-knows">
            <span>{t('roomApps.leaverKnows')}</span>
            <span aria-hidden className="text-faint">·</span>
            <button type="button" onClick={() => void rotate()} disabled={!available} className="touch-hit font-medium text-accent-text hover:underline disabled:opacity-40" data-testid="apps-leaver-new-address">{t('roomApps.newAddress')}</button>
          </p>
        )}
        {error && <p className="text-xs text-danger" role="alert" data-testid="apps-save-failed">{t('roomApps.saveFailed')}</p>}
      </div>
      <section className="border-t border-line px-5 py-2 max-sm:px-4" aria-labelledby={`${quietId}-show`}>
        <h3 id={`${quietId}-show`} className="py-2 text-xs font-medium text-muted">{t('roomApps.showHere')}</h3>
        <ul>
          {ROOM_APP_SWITCHES[app.kind].map((sw) => (
            <SwitchRow key={sw.key} id={`${quietId}-${sw.key}`} label={t(`roomApps.switch.${app.kind}.${sw.key}` as never)} checked={app.events[sw.key] ?? sw.on} onChange={(v) => void set({ events: { [sw.key]: v } })} testId={`apps-switch-${sw.key}`} />
          ))}
        </ul>
      </section>
      <section className="border-t border-line px-5 py-2 max-sm:px-4">
        <ul>
          <SwitchRow id={`${quietId}-quiet`} label={t('roomApps.quiet')} hint={t('roomApps.quietHint')} checked={app.quiet} onChange={(v) => void set({ quiet: v })} testId="apps-quiet" />
        </ul>
      </section>
      <section className="space-y-2 border-t border-line px-5 py-3 max-sm:px-4" data-testid="apps-address-row">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="mr-auto text-sm text-ink">{t('roomApps.address')}</span>
          <Button size="sm" onClick={() => void copy()} disabled={!available} data-testid="apps-settings-copy">
            {copied ? <><Check size={14} aria-hidden />{t('roomApps.copied')}</> : app.kind === 'google_forms' ? t('roomApps.copyCode') : t('roomApps.copyAddress')}
          </Button>
          <button type="button" onClick={() => void rotate()} disabled={!available} className="touch-hit text-sm font-medium text-accent-text hover:underline disabled:opacity-40" data-testid="apps-new-address">{t('roomApps.newAddress')}</button>
        </div>
        {fresh && <p className="text-xs text-muted" role="status" data-testid="apps-new-address-done">{t('roomApps.newAddressDone', { app: app.name })}</p>}
      </section>
      <div className="border-t border-line px-5 py-3 max-sm:px-4">
        <button type="button" onClick={() => void remove()} className="touch-hit text-sm font-medium text-danger hover:underline" data-testid="apps-remove">{t('roomApps.remove')}</button>
      </div>
    </div>
  )
}

/** A switch row: the words on the left, the switch on the right; 44 px tall on a phone. */
function SwitchRow({ id, label, hint, checked, onChange, testId }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <li className="flex min-h-11 items-center gap-3 py-1 md:min-h-9">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm text-ink">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </label>
      <Switch id={id} external checked={checked} onChange={onChange} label={label} testId={testId} />
    </li>
  )
}
