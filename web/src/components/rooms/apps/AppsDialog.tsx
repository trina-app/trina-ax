// "Add an app" / "Apps posting here" (docs/DECISIONS.md "Apps posting in rooms", plan
// docs/AGENTS/plan/20261114-0900-room-apps.md screens 1, 2, 5 and 7): one dialog (a bottom sheet on a phone: Modal) with
// its screens: the picker (four rows with the services' marks), a kind's guide (Other's name, the address or Forms' code,
// numbered steps in that service, the live status line, a preview of its messages), the list of the room's apps and one
// app's settings (who set it up and "How to connect", status, one block of warnings with one action each, the name, the
// switches when there is more than one, "Post quietly", Other's "How to send", Address with "Get a new address",
// Remove). Without an internet address the picker's place says who can turn the connection on (owner: the connection
// settings; everyone else: ask the owner). Opened from the room's ⋯ (RoomMenu), the sender's "Manage" (AppSender) and
// the notices' "Open settings" (pages/Activity). Only the people who manage the room's apps see it
// (store/roomApps.ts mayManageApps); the server checks again.
// Nothing is made by picking: the app is added on the guide's first Copy (address, code or secret), so closing the guide
// before that leaves nothing behind. The address is in the page only after the person copied it in the guide; settings
// copy it without showing it. The address is the "Webhook URL" (Slack's word, owner 2026-11-14); the services' screen
// labels are quoted (roomApps.vendorLabel.*, checked against the live tools in QA TC-1546 and TC-1634).
// Presets (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md, P1): Notion, Typeform, Tally, Jotform,
// Stripe, Shopify and Zendesk are Other apps with a preset; the screens show them as their service (lib/roomApps.ts
// serviceOf): the picker's groups with "Needs: …", their guides (PresetSteps), switches, signing and warnings.
import clsx from 'clsx'
import { AlertCircle, Check, ChevronLeft, ChevronRight, ExternalLink, Info, PauseCircle, Plus } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { limitResetText } from '@mycel/shared'
import { ROOM_APP_NAME_MAX, roomAppFormsScript, type RoomApp, type RoomAppCard, type RoomAppList } from '@mycel/shared/api'
import { api, API, errorText } from '../../../lib/api'
import { dateBucket, formatNumber, formatShortDateTime, intlTag } from '../../../lib/format'
import { appStatus, FORM_SERVICES, isPreset, kindOf, MORE_SERVICES, needsOf, notSetUp, NOTHING_YET, NOTHING_YET_MS, PICKER_GROUPS, serviceOf, signingOf, switchesOf, type AppService } from '../../../lib/roomApps'
import { useLocale, useT } from '../../../i18n'
import { useRooms } from '../../../store/rooms'
import { useRoomApps, type AppsStart } from '../../../store/roomApps'
import { isOwner, useMe } from '../../../store/session'
import { toast } from '../../../store/ui'
import { ListRow } from '../../list/List'
import { Button, confirmDialog, IconButton, inputCls, Modal, Skeleton, Switch, TextAction } from '../../ui'
import { AppCardText } from '../AppCard'
import { useRoomTitle } from '../RoomIcon'
import { AppTile, SenderTag } from './AppParts'
import { CopyButton, copyFrom, Fold, Step, useFlash, useVendor } from './GuideParts'
import { DontSeeYourApp, PresetSteps } from './PresetSteps'

/** the user guide's page about apps in rooms (docs/site/use/room-apps.md) */
export const ROOM_APPS_GUIDE = 'https://ax.trina.app/docs/use/room-apps/'
/** how often an open guide or settings page reads the app again while it waits for its first message (or a refusal) */
const POLL_MS = 4000
/** An app's service: a kind, or the preset of an Other app (lib/roomApps.ts serviceOf). */
const svc = (a: RoomApp): AppService => serviceOf(a)

/** "today 10:58", "yesterday 18:02", else a short date and time. */
function useWhen() {
  const t = useT()
  const locale = useLocale()
  return (iso: string) => {
    const b = dateBucket(iso)
    const time = new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
    return b === 'today' ? t('roomApps.todayAt', { time }) : b === 'yesterday' ? t('roomApps.yesterdayAt', { time }) : formatShortDateTime(iso, locale)
  }
}

/** The address cut in its middle for the field ("https://acme.trina.app/in/tax_in_Ab…9xQ"): the whole one is copied. */
export function middleCut(s: string, head = 34, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** After Regenerate, until a message arrives on the new Webhook URL (QA TC-2086): "Waiting for GitHub to use the new
 * Webhook URL." and where to paste it, by the service's plain name (not the name the app was given). */
function useMovedText() {
  const t = useT()
  return (a: RoomApp, part: 'wait' | 'paste') => {
    const s = svc(a)
    const k = part === 'wait' ? 'movedWait' : 'movedPaste'
    return s === 'other' ? t(`roomApps.${k}Other`) : s === 'google_forms' ? t(`roomApps.${k}Forms`) : t(`roomApps.${k}`, { app: t(`roomApps.kind.${s}`) })
  }
}

/** "Paused: it reached 500 messages today …" or, when the team's cap holds it, "Paused: your team's apps reached 5,000
 * messages today. All apps are paused until Nov 16, 00:00." (the team's midnight, in the team's time zone). */
function usePausedText() {
  const t = useT()
  const locale = useLocale()
  return (s: Extract<ReturnType<typeof appStatus>, { kind: 'paused' }>, forms: boolean) => s.by === 'team'
    ? t('roomApps.statusPausedTeam', { cap: formatNumber(s.cap, locale), time: limitResetText(new Date(s.until), locale, s.timeZone) })
    : t(forms ? 'roomApps.statusPausedForms' : 'roomApps.statusPaused', { cap: formatNumber(s.cap, locale) })
}

/** `step` (a guide): the switch whose optional step "Show the step" scrolls to (that step, not the first optional one) */
type View = { view: 'pick' } | { view: 'list' } | { view: 'settings'; appId: string } | { view: 'guide'; service: AppService; appId?: string; step?: string }

/** The picker as it was left (a guide and Back must not lose it; QA TC-2386): "Show more services" open, and how far the
 * dialog's body was scrolled. */
type PickerPlace = { more: boolean | null; scroll: number }
/** The dialog body that scrolls (Modal's), from an element inside it. */
const scrollerOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('.overflow-y-auto') ?? null

export function AppsDialog({ roomId, start }: { roomId: string; start: AppsStart }) {
  const t = useT()
  const locale = useLocale()
  const list = useRoomApps((s) => s.lists[roomId])
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const roomTitle = useRoomTitle()
  const [error, setError] = useState<string | null>(null)
  const [stack, setStack] = useState<View[]>(start.view === 'auto' ? [] : [start])
  const pickerPlace = useRef<PickerPlace>({ more: null, scroll: 0 })
  const close = () => useRoomApps.getState().close()
  const reload = useCallback(() => useRoomApps.getState().load(roomId).then(() => setError(null), (e) => setError(errorText(e, locale, t('error.network')))), [roomId, locale, t])
  useEffect(() => { void reload() }, [reload])
  // "auto": the list when the room has apps, else the picker
  const view: View | null = stack.at(-1) ?? (list ? (list.items.length ? { view: 'list' } : { view: 'pick' }) : null)
  const go = (v: View) => setStack((s) => [...(s.length || !view ? s : [view]), v])
  const back = stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : view?.view !== 'list' && view?.view !== 'pick' && list?.items.length ? () => setStack([{ view: 'list' }]) : null
  const name = room ? roomTitle(room) : ''
  // another screen starts at its top (the body is one scrolling box for all of them); the picker puts itself back
  const body = useRef<HTMLDivElement>(null)
  const screen = view ? `${stack.length}:${view.view}` : ''
  useLayoutEffect(() => {
    if (view?.view === 'pick') return
    const box = scrollerOf(body.current)
    if (box) box.scrollTop = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])
  const app = view && 'appId' in view && view.appId ? list?.items.find((a) => a.id === view.appId) ?? null : null
  const kindLabel = (s: AppService) => t(`roomApps.kind.${s}`)
  const title: ReactNode = !view ? t('roomApps.listTitle')
    : view.view === 'pick' ? t('roomApps.pickTitle')
    : view.view === 'list' ? t('roomApps.listTitle')
    : view.view === 'guide' ? (app ? t('roomApps.guideTitle', { app: app.name }) : view.service === 'other' ? t('roomApps.guideTitleOther') : t('roomApps.guideTitle', { app: kindLabel(view.service) }))
    : app?.name ?? ''
  // a new app needs the internet address; the list and settings of existing ones say it is gone
  const blocked = !!list && !list.available && (view?.view === 'pick' || (view?.view === 'guide' && !view.appId))
  return (
    <Modal
      open
      onClose={close}
      width={480}
      title={
        <span className="flex min-w-0 items-center gap-2">
          {back && (
            <IconButton label={t('roomApps.back')} onClick={back} className="touch-hit -mr-1 -ml-2 shrink-0" data-testid="apps-back">
              <ChevronLeft size={18} aria-hidden />
            </IconButton>
          )}
          {/* one app's settings: its mark, the name it was given and, small, which kind it is */}
          {view?.view === 'settings' && app && <AppTile service={svc(app)} size="title" />}
          <span className="truncate" data-testid="apps-title">{title}</span>
          {view?.view === 'settings' && app && app.name !== kindLabel(svc(app)) && (
            <span className="shrink-0 text-xs font-normal text-muted" data-testid="apps-title-kind">{kindLabel(svc(app))}</span>
          )}
        </span>
      }
    >
      <div ref={body} data-testid="apps-dialog" data-view={blocked ? 'no-address' : view?.view}>
        {error && !list ? <p className="text-sm text-danger" role="alert">{error}</p>
          : !list || !view ? <Skeleton lines={4} />
          : blocked ? <NoAddress />
          : view.view === 'pick' ? <Picker list={list} roomName={name} place={pickerPlace.current} onPick={(service) => go({ view: 'guide', service })} />
          : view.view === 'list' ? <AppList list={list} onOpen={(id) => go({ view: 'settings', appId: id })} onAdd={() => { pickerPlace.current = { more: null, scroll: 0 }; go({ view: 'pick' }) }} />
          : view.view === 'guide' ? <Guide roomId={roomId} service={view.service} app={app} step={view.step} onAdded={(a) => setStack((s) => [...s.slice(0, -1), { view: 'guide', service: view.service, appId: a.id }])} onDone={close} />
          : app ? <Settings roomId={roomId} roomName={name} app={app} available={list.available} onGuide={(step) => go({ view: 'guide', service: svc(app), appId: app.id, ...(step ? { step } : {}) })} onRemoved={() => setStack([{ view: list.items.length > 1 ? 'list' : 'pick' }])} />
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
      {!owner && <p className="text-muted" data-testid="apps-no-address-who">{t('roomApps.noAddressOthers')}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {owner && (
          <Link to="/admin/system/connection" onClick={close} className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:opacity-90 max-md:h-11" data-testid="apps-open-connection">
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
/** A group's heading in the picker's one list (no tabs, no search). */
function GroupHeading({ id, children }: { id: string; children: ReactNode }) {
  return <h3 id={id} className="px-3 pt-3 pb-1 text-xs font-medium tracking-wide text-muted uppercase max-sm:px-3" data-testid="apps-pick-group">{children}</h3>
}

function Picker({ list, roomName, place, onPick }: { list: RoomAppList; roomName: string; place: PickerPlace; onPick: (s: AppService) => void }) {
  const t = useT()
  const gid = useId()
  const left = list.max - list.items.length
  const full = left <= 0
  // "Show more services": open from the start when the room has one of them already; as it was left after a guide
  const [more, setMoreState] = useState(() => place.more ?? list.items.some((a) => MORE_SERVICES.includes(svc(a))))
  const setMore = (v: boolean) => { place.more = v; setMoreState(v) }
  // back from a guide: the list where it was (the dialog's body is the one scrolling), and where it is now kept
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = scrollerOf(ref.current)
    if (!box) return
    if (place.scroll) box.scrollTop = place.scroll
    const keep = () => { place.scroll = box.scrollTop }
    box.addEventListener('scroll', keep, { passive: true })
    return () => box.removeEventListener('scroll', keep)
  }, [place])
  // the second line: what the service posts, then what it needs ("Needs: …") so nobody finds out after setup
  const row = (s: AppService) => {
    const needs = needsOf(s)
    return (
      <ListRow
        key={s}
        onClick={() => onPick(s)}
        disabled={full}
        lead={<AppTile service={s} size="row" />}
        strong
        name={t(`roomApps.kind.${s}`)}
        // the Needs line wraps (the row's second line is cut at one line); on a phone too
        meta={needs ? <>{t(`roomApps.hint.${s}`)}<span className="block whitespace-normal" data-testid={`apps-pick-needs-${s}`}>{t(`roomApps.needs.${needs}`)}</span></> : t(`roomApps.hint.${s}`)}
        end={<ChevronRight size={16} className="shrink-0 self-center text-faint" aria-hidden />}
        testId={`apps-pick-${s}`}
      />
    )
  }
  return (
    <div ref={ref} className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-picker">
      <p className="px-5 pt-4 pb-1 text-sm text-muted max-sm:px-4">{t('roomApps.pickLead', { room: roomName })}</p>
      <div className="px-2 pb-1 max-sm:px-1">
        {PICKER_GROUPS.map((g) => (
          <Fragment key={g.key}>
            <GroupHeading id={`${gid}-${g.key}`}>{t(`roomApps.group.${g.key}`)}</GroupHeading>
            <ul aria-labelledby={`${gid}-${g.key}`}>{g.items.map(row)}</ul>
          </Fragment>
        ))}
        {/* the regional services, folded: the same list for everyone */}
        {more ? (
          <>
            <GroupHeading id={`${gid}-more`}>{t('roomApps.group.more')}</GroupHeading>
            <ul aria-labelledby={`${gid}-more`} data-testid="apps-more-list">{MORE_SERVICES.map(row)}</ul>
          </>
        ) : (
          <button type="button" onClick={() => setMore(true)} aria-expanded={false} className="flex min-h-11 w-full items-center gap-1 rounded-lg px-3 text-left text-sm font-medium text-accent-text hover:bg-hover md:min-h-9" data-testid="apps-show-more">
            {t('roomApps.showMore')}
            <ChevronRight size={14} aria-hidden className="shrink-0" />
          </button>
        )}
      </div>
      {/* a divider, then the catch-all, last (owner decision 5) */}
      <div className="border-t border-line px-2 pb-2 max-sm:px-1">
        <GroupHeading id={`${gid}-other`}>{t('roomApps.group.other')}</GroupHeading>
        <ul aria-labelledby={`${gid}-other`}>{row('other')}</ul>
      </div>
      {(full || left <= 2) && <p className="border-t border-line px-5 py-3 text-xs text-muted max-sm:px-4" data-testid="apps-left">{full ? t('roomApps.pickFull', { max: list.max }) : t('roomApps.pickLeft', { left })}</p>}
    </div>
  )
}

// ---------------- 5. the list ----------------
function AppList({ list, onOpen, onAdd }: { list: RoomAppList; onOpen: (id: string) => void; onAdd: () => void }) {
  const t = useT()
  const locale = useLocale()
  const moved = useMovedText()
  const left = list.max - list.items.length
  return (
    <div className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-list">
      {!list.available && <Warnings className="mx-5 mt-4 max-sm:mx-4" items={[{ key: 'no-address', text: t('roomApps.statusNoAddress') }]} />}
      <h3 className="px-5 pt-4 pb-1 text-xs font-medium text-muted max-sm:px-4">{t('roomApps.listSection')}</h3>
      <ul className="px-2 pb-2 max-sm:px-1">
        {list.items.map((a) => {
          const kind = t(`roomApps.kind.${svc(a)}`)
          const by = a.createdBy ? t('roomApps.setUpBy', { name: a.createdBy.name }) : t('roomApps.setUpByGone')
          const st = appStatus(a)
          return (
            <ListRow
              key={a.id}
              onClick={() => onOpen(a.id)}
              lead={<AppTile service={svc(a)} size="row" />}
              strong
              name={a.name}
              meta={a.leaverKnows ? <span className="text-warn">{t('roomApps.leaverKnows')}</span>
                : st.kind === 'paused' ? (st.by === 'team' ? t('roomApps.listPausedTeam', { time: limitResetText(new Date(st.until), locale, st.timeZone) }) : `${t('roomApps.paused')} · ${t('roomApps.startsTomorrow')}`)
                : st.kind === 'moved' ? <span data-testid="apps-list-moved">{moved(a, 'wait')}</span>
                : a.name !== kind ? `${kind} · ${by}` : by}
              tag={a.pausedUntil ? <span className="inline-flex items-center gap-1 text-warn"><PauseCircle size={12} aria-hidden />{t('roomApps.paused')}</span> : t('roomApps.today', { count: a.today })}
              end={<ChevronRight size={16} className="shrink-0 self-center text-faint" aria-hidden />}
              testId="apps-list-row"
            />
          )
        })}
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

/** One block of what needs someone, each line with at most one action (settings, the list without an address). */
type Warning = { key: string; text: string; action?: { label: string; onClick: () => void; disabled?: boolean; testId: string } }
function Warnings({ items, className }: { items: Warning[]; className?: string }) {
  if (!items.length) return null
  return (
    <ul className={clsx('space-y-1.5 border-l-2 border-warn py-0.5 pl-3 text-sm text-ink', className)} role="status" data-testid="apps-warnings">
      {items.map((w) => (
        <li key={w.key} className="flex flex-wrap items-center gap-x-2" data-testid={`apps-warning-${w.key}`}>
          <span className="min-w-0">{w.text}</span>
          {w.action && <TextAction onClick={w.action.onClick} disabled={w.action.disabled} data-testid={w.action.testId}>{w.action.label}</TextAction>}
        </li>
      ))}
    </ul>
  )
}

// ---------------- the status line (guide and settings) ----------------
/** A dot that breathes while an app waits for its first message (still under reduced motion). */
function WaitingDot() {
  return (
    <span aria-hidden className="relative mt-1.5 flex size-2 shrink-0">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  )
}

/** Why the last try was not shown. A preset whose secret was saved but didn't match names the service and where its
 * secret is ("Stripe sent a message … Copy it again from Reveal secret."); else the reason. */
function useRefusedText() {
  const t = useT()
  const when = useWhen()
  return (s: AppService, r: { at: string; reason: NonNullable<RoomApp['lastRefusal']>['reason'] }) =>
    r.reason === 'signature' && isPreset(s) && signingOf(s) !== 'none'
      ? t(`roomApps.refusedSecret.${s as 'stripe'}`, { time: when(r.at) })
      : t('roomApps.statusRefused', { time: when(r.at), reason: t(`roomApps.reason.${r.reason}`) })
}

/** The one status line: last message, a refusal with its reason (the guide; settings list it with the warnings), paused,
 * or waiting for the first message (one way for every kind); a guide before its first Copy says what Copy does
 * (`beforeCopy`: the Webhook URL, or Forms' code). */
function StatusLine({ app, place, beforeCopy = 'address', onAgain, onResume }: { app: RoomApp | null; place: 'guide' | 'settings'; beforeCopy?: 'address' | 'code'; onAgain?: () => void; onResume?: () => void }) {
  const t = useT()
  const when = useWhen()
  const raw = app ? appStatus(app) : { kind: 'none' as const }
  // settings put a refusal among the warnings; the line then says what it would without it (the last message shown,
  // waiting for the new Webhook URL, or waiting)
  const s = place === 'settings' && raw.kind === 'refused' && app ? appStatus({ ...app, lastRefusal: null }) : raw
  const forms = !!app && FORM_SERVICES.includes(svc(app))
  const refused = useRefusedText()
  const moved = useMovedText()
  const paused = usePausedText()
  const [icon, text, tone] = s.kind === 'refused' ? [<AlertCircle key="i" size={15} aria-hidden />, refused(app ? svc(app) : 'other', s), 'text-danger']
    : s.kind === 'paused' ? [<PauseCircle key="i" size={15} aria-hidden />, paused(s, forms), 'text-warn']
    : s.kind === 'moved' && app ? [<WaitingDot key="i" />, `${moved(app, 'wait')} ${moved(app, 'paste')}`, '']
    : s.kind === 'ok' ? [<Check key="i" size={15} aria-hidden />, place === 'guide' ? t('roomApps.connected', { time: when(s.first) }) : t('roomApps.statusOk', { when: when(s.last) }), 'text-ok']
    // a guide before its first Copy: nothing is added yet, so nothing is waited for (no breathing dot)
    : !app ? [<Info key="i" size={15} aria-hidden />, t(beforeCopy === 'code' ? 'roomApps.beforeCopyCode' : 'roomApps.beforeCopy'), 'text-muted']
    : [<WaitingDot key="i" />, t('roomApps.waiting'), '']
  return (
    <div className="flex items-start gap-2 text-sm" role="status" aria-live="polite" data-testid="apps-status" data-state={!app && s.kind === 'none' ? 'before' : s.kind}>
      <span className={clsx('mt-0.5 flex shrink-0', tone)}>{icon}</span>
      <span className="min-w-0 flex-1 text-ink">
        {text}
        {s.kind === 'refused' && s.reason === 'signature' && onAgain && (
          <> <TextAction onClick={onAgain} className="align-middle" data-testid="apps-set-up-again">{t('roomApps.checkSecretAction')}</TextAction></>
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
  const watching = !!app && (s === 'none' || s === 'refused' || s === 'moved')
  const appId = app?.id ?? null
  const arrived = useRooms((st) => (appId && st.timeline?.roomId === roomId ? st.timeline.messages.some((m) => m.app?.id === appId && !m.app.example) : false))
  useEffect(() => {
    if (!watching) return
    const id = setInterval(() => { void useRoomApps.getState().load(roomId).catch(() => {}) }, POLL_MS)
    return () => clearInterval(id)
  }, [watching, roomId])
  useEffect(() => { if (arrived && watching) void useRoomApps.getState().load(roomId).catch(() => {}) }, [arrived, watching, roomId])
}

// ---------------- the name (Other's guide, every app's settings) ----------------
/** The app's name as the room shows it over its messages. Saved when the field is left or Enter is pressed (the
 * server refuses a person's name or one that looks like it, and says why). */
function NameField({ value, onChange, onCommit, error, testId }: { value: string; onChange: (v: string) => void; onCommit?: () => void; error: string | null; testId: string }) {
  const t = useT()
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-muted">{t('roomApps.nameLabel')}</label>
      <input
        id={id}
        value={value}
        maxLength={ROOM_APP_NAME_MAX}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.()}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCommit?.() } }}
        placeholder={t('roomApps.namePlaceholder')}
        autoComplete="off"
        className={inputCls}
        aria-invalid={!!error}
        data-testid={testId}
      />
      {error && <p className="text-xs text-danger" role="alert" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  )
}

/** Save a new name for an app: on screen at once, the old one back when the server refuses it. */
function useRename(roomId: string, app: RoomApp | null) {
  const locale = useLocale()
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const save = async (name: string) => {
    const n = name.trim()
    if (!app || !n || n === app.name) { setError(null); return }
    try {
      await useRoomApps.getState().update(roomId, app.id, { name: n })
      setError(null)
    } catch (e) { setError(errorText(e, locale, t('error.network'))) }
  }
  return { error, setError, save }
}

// ---------------- Other: how to send ----------------
/** What an Other app sends (server rooms/apps/parse.ts other()): a JSON example with the fields Trina reads, Copy for it,
 * and on a computer a test command with this room's address, filled only in what is copied (never on screen here). */
function HowToSend({ getAddress, className }: { getAddress: () => Promise<string>; className?: string }) {
  const t = useT()
  const locale = useLocale()
  const [copied, flash] = useFlash()
  const example = useMemo(() => JSON.stringify({ text: t('roomApps.sendExText'), title: t('roomApps.sendExTitle'), url: 'https://example.com/report', thread: 'nightly-backup' }, null, 2), [t])
  const copyExample = async () => {
    try { await copyFrom(Promise.resolve(example)); flash('example') } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  const copyCommand = async () => {
    const body = JSON.stringify({ text: t('roomApps.sendExCurl') }).replace(/'/g, `'\\''`)
    try {
      await copyFrom(getAddress().then((a) => `curl -X POST -H 'Content-Type: application/json' -d '${body}' ${a}`))
      flash('command')
    } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  return (
    <div className={clsx('space-y-2 text-sm text-ink', className)} data-testid="apps-how-to-send">
      <p>{t('roomApps.sendLead')}</p>
      <pre className="overflow-x-auto rounded-lg border border-line bg-hover/50 px-3 py-2 font-mono text-code-sm text-ink" data-testid="apps-send-example">{example}</pre>
      <ul className="list-disc space-y-1 pl-5 text-muted">
        <li>{t('roomApps.sendFields')}</li>
        <li>{t('roomApps.sendAlso')}</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton label={t('roomApps.copyExample')} copied={copied === 'example'} onClick={() => void copyExample()} testId="apps-copy-example" />
        {/* a terminal is a computer's */}
        <CopyButton label={t('roomApps.copyCommand')} copied={copied === 'command'} onClick={() => void copyCommand()} className="max-md:hidden" testId="apps-copy-command" />
      </div>
    </div>
  )
}

// ---------------- a preview of the app's messages (no message is posted) ----------------
function ExamplePreview({ service, name }: { service: AppService; name: string }) {
  const t = useT()
  // Other's card is its text (a title and a line); the services' have a kind line and a status line too
  const head = service !== 'other'
  const card: RoomAppCard = {
    ...(head ? { kind: t(`roomApps.preview.${service}.kind` as never) } : {}),
    title: t(`roomApps.preview.${service}.title` as never),
    details: [t(`roomApps.preview.${service}.detail` as never)],
    ...(head ? { status: t(`roomApps.preview.${service}.status` as never) } : {}),
  }
  const ref = { id: null, name, kind: kindOf(service), ...(isPreset(service) ? { preset: service } : {}) }
  return (
    <div className="space-y-2 rounded-lg border border-line p-3" data-testid="apps-preview">
      <p className="text-xs text-muted">{t('roomApps.previewLead')}</p>
      <div className="flex gap-2.5">
        <AppTile service={service} size="face" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-1.5 text-sm"><span className="truncate font-medium text-ink">{name}</span><SenderTag /></p>
          <AppCardText m={{ app: ref, appCard: card, body: '' }} />
        </div>
      </div>
    </div>
  )
}

// ---------------- 2. the guide ----------------
function Guide({ roomId, service, app, step, onAdded, onDone }: { roomId: string; service: AppService; app: RoomApp | null; step?: string; onAdded: (a: RoomApp) => void; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const v = useVendor()
  const [address, setAddress] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, flash] = useFlash()
  // copied in this guide: Copy turns to an outline "✓ Copied", Done becomes the next step
  const [used, setUsed] = useState(false)
  // the browser refused the clipboard: what to copy by hand, where it was asked for (the Webhook URL in its own field, in
  // full; Forms' code and a secret in a box under their Copy)
  const [manual, setManual] = useState<{ what: 'address' | 'code' | 'secret'; text: string } | null>(null)
  const manualRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => { if (manual) { manualRef.current?.focus(); manualRef.current?.select() } }, [manual])
  const [preview, setPreview] = useState(false)
  const kind = kindOf(service)
  const preset = isPreset(service) ? service : null
  const [name, setName] = useState(app && service === 'other' ? app.name : '')
  const rename = useRename(roomId, app)
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  useLive(roomId, app)
  // an app set up before (How to connect, Check the secret): its address (and a secret Trina made) to copy again
  useEffect(() => {
    if (!app || address) return
    api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } }).then((a) => { setAddress(a.address); if (a.secret) setSecret(a.secret) }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id])
  // "Not set up in Jira › Show the step": the step that sets up that switch's event in view, at the top (Jira's comments
  // flow is step 6, not the first optional one; QA TC-2416, TC-2421)
  const stepsRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!step) return
    const id = requestAnimationFrame(() => {
      const list = stepsRef.current
      const el = Array.from(list?.querySelectorAll<HTMLElement>('[data-step-for]') ?? []).find((x) => (x.dataset.stepFor ?? '').split(' ').includes(step))
        ?? list?.querySelector<HTMLElement>('[data-testid="apps-step-optional"]')
      el?.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(id)
  }, [step])
  /** the address, adding the app on the first Copy (with the name typed for an Other app; a preset's own) */
  const ensure = async (): Promise<{ app: RoomApp; address: string }> => {
    if (app && address) return { app, address }
    if (app) {
      const a = await api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } })
      setAddress(a.address)
      return { app, address: a.address }
    }
    const typed = service === 'other' ? name.trim() : ''
    // a preset is an Other app with its preset (fixed at create); the server names it
    const body = { kind, ...(preset ? { preset } : {}), ...(typed ? { name: typed } : {}) }
    const r = await api.call(API.createRoomApp, { params: { id: roomId }, body })
    setAddress(r.address)
    useRoomApps.getState().put(r.app)
    onAdded(r.app)
    return r
  }
  const copyAddress = async () => {
    setBusy(true)
    setManual(null)
    const made = ensure().then((r) => (kind === 'google_forms' ? roomAppFormsScript(r.address, r.app.events.email !== false) : r.address))
    try {
      await copyFrom(made)
      flash('address')
      setUsed(true)
    } catch (e) {
      // the app may be there with its address: show it to copy by hand
      const text = await made.catch(() => null)
      if (text) setManual({ what: kind === 'google_forms' ? 'code' : 'address', text })
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
    setManual(null)
    try {
      await copyFrom(made)
      flash('secret')
    } catch (e) {
      const text = await made.catch(() => null)
      if (text) setManual({ what: 'secret', text })
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  const forms = kind === 'google_forms'
  const signing = signingOf(service)
  const needs = needsOf(service)
  const s = app ? appStatus(app).kind : 'none'
  // after two minutes without a first message, a short checklist of that service's likely mistakes (every service)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!app || s !== 'none') return
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [app, s])
  const nothingYet = !!app && s === 'none' && now - Date.parse(app.createdAt) >= NOTHING_YET_MS
  const curl = useMemo(() => `curl -X POST -H 'Content-Type: application/json' -d '{"text":"Hi"}' ${address ?? '<address>'}`, [address])
  return (
    <div className="space-y-4" data-testid="apps-guide" data-kind={service}>
      {/* what it needs, before anything is set up (the picker's row said it too) */}
      {needs && (
        <p className="flex items-start gap-1.5 text-sm text-ink" data-testid="apps-needs">
          <Info size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <span>{t(`roomApps.needs.${needs}`)}</span>
        </p>
      )}
      {/* Other: the name it posts under, first (the others carry their service's name) */}
      {service === 'other' && (
        <NameField value={name} onChange={(x) => { setName(x); rename.setError(null) }} onCommit={app ? () => void rename.save(name) : undefined} error={rename.error} testId="apps-guide-name" />
      )}
      {/* the address: read-only, cut in its middle, the whole one copied; Forms: only the code to paste. When the browser
          refused the clipboard, the whole Webhook URL in a real read-only field instead, selected (QA TC-2388): the
          cut one would copy a URL that cannot work. Only here, after Copy: settings never show it */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted" id="apps-address-label">{forms ? t('roomApps.codeLabel') : t('roomApps.addressLabel')}</p>
        <div className="flex gap-2 max-sm:flex-col">
          {!forms && (manual?.what === 'address' ? (
            <input ref={manualRef} readOnly value={manual.text} aria-labelledby="apps-address-label" onFocus={(e) => e.currentTarget.select()} spellCheck={false} className={clsx(inputCls, 'min-w-0 flex-1 font-mono text-code-sm')} data-testid="apps-address-full" />
          ) : (
            <div aria-labelledby="apps-address-label" title={address ?? undefined} className={clsx(inputCls, 'flex min-w-0 flex-1 items-center truncate font-mono text-code-sm', !address && 'font-sans text-faint!')} data-testid="apps-address">
              {address ? middleCut(address) : t('roomApps.addressPlaceholder')}
            </div>
          ))}
          <CopyButton label={forms ? t('roomApps.copyCode') : t('roomApps.copyAddress')} copied={copied === 'address' || used} primary busy={busy && copied === null} onClick={() => void copyAddress()} className="max-sm:w-full" testId="apps-copy-address" />
        </div>
        {manual && manual.what !== 'secret' && <p className="text-xs text-danger" role="alert" data-testid="apps-copy-failed">{t(manual.what === 'address' ? 'roomApps.copyFailedAddress' : 'roomApps.copyFailed')}</p>}
        {manual?.what === 'code' && <textarea ref={manualRef} readOnly value={manual.text} rows={3} onFocus={(e) => e.currentTarget.select()} className={clsx(inputCls, 'h-auto font-mono text-code-sm')} data-testid="apps-manual-copy" />}
        {/* before the first Copy there is no URL yet: nothing to keep private, nothing to wait for (the status says so) */}
        {address && <p className="text-xs text-muted" data-testid="apps-address-private">{t(forms ? 'roomApps.addressPrivateForms' : 'roomApps.addressPrivate')}</p>}
        {service === 'other' && <p className="text-xs text-ink" data-testid="apps-other-where">{t('roomApps.otherWhere')}</p>}
      </div>

      <ol ref={stepsRef} className="space-y-3" data-testid="apps-steps">
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
        {forms && <>
          <Step n={1}><p>{t('roomApps.forms1', { path: v('formsPath') })}</p></Step>
          <Step n={2}><p>{t('roomApps.forms2')}</p></Step>
          <Step n={3}>
            <p>{t('roomApps.forms3', { run: v('formsRun'), unverified: v('formsUnverified'), advanced: v('formsAdvanced') })}</p>
            <p className="text-xs text-muted" data-testid="apps-forms-safe">{t('roomApps.formsSafe')}</p>
          </Step>
          <Step n={4}>
            <p>{t('roomApps.forms4')}</p>
            <p className="text-xs text-muted" data-testid="apps-forms-email">{t('roomApps.formsEmail')}</p>
          </Step>
        </>}
        {preset && <PresetSteps preset={preset} app={app} />}
        {service === 'other' && <>
          <Step n={1}><p>{t('roomApps.other1', { term: v('otherTerm') })}</p></Step>
          <Step n={2}><p>{t('roomApps.other2')}</p></Step>
          <Step n={3}>
            <p>{t('roomApps.other3')}</p>
            <HowToSend getAddress={() => ensure().then((r) => r.address)} />
          </Step>
        </>}
      </ol>
      {service === 'other' && <DontSeeYourApp />}

      {/* optional: signatures (owner decision 4), where the service can sign; Sentry's alert rules */}
      {signing !== 'none' && (
        <Fold summary={t('roomApps.safer')} testId="apps-safer">
          <p data-testid="apps-safer-how">{service === 'github' ? t('roomApps.saferGithub', { secret: v('githubSecret') })
            : service === 'sentry' ? t('roomApps.saferSentry', { secret: v('sentrySecret') })
            : service === 'typeform' ? t('roomApps.saferPreset.typeform', { edit: v('typeformEdit'), secret: v('typeformSecret') })
            : service === 'tally' ? t('roomApps.saferPreset.tally', { secret: v('tallySecret') })
            : service === 'stripe' ? t('roomApps.saferPreset.stripe', { reveal: v('stripeReveal') })
            : service === 'shopify' ? t('roomApps.saferPreset.shopify', { signed: v('shopifySigned') })
            : service === 'toss_payments' ? t('roomApps.saferPreset.toss_payments', { key: v('tossSecurityKey') })
            : service === 'channel_talk' ? t('roomApps.saferPreset.channel_talk', { token: v('channelToken') })
            : service === 'portone' ? t('roomApps.saferPreset.portone', { secret: v('portoneSecret') })
            : t('roomApps.saferPreset.zendesk', { reveal: v('zendeskReveal') })}</p>
          {app?.signed && !secret ? (
            <SignedLine roomId={roomId} app={app} />
          ) : signing === 'trina_makes' ? (
            <div className="space-y-2">
              <CopyButton label={t('roomApps.copySecret')} copied={copied === 'secret'} disabled={busy} onClick={() => void copySecret()} testId="apps-copy-secret" />
              {manual?.what === 'secret' && <>
                <p className="text-xs text-danger" role="alert" data-testid="apps-copy-failed">{t('roomApps.copyFailed')}</p>
                <textarea ref={manualRef} readOnly value={manual.text} rows={2} onFocus={(e) => e.currentTarget.select()} className={clsx(inputCls, 'h-auto font-mono text-code-sm')} data-testid="apps-manual-copy" />
              </>}
              {/* copying it turns nothing off: signing starts with the first message signed with it (the server) */}
              {(app?.signed || app?.signingPending) && <SignedLine roomId={roomId} app={app} />}
            </div>
          ) : (
            <PasteSecret roomId={roomId} app={app} ensure={ensure} placeholder={service === 'sentry' ? t('roomApps.secretPlaceholder') : t(`roomApps.secretName.${service as 'stripe'}`)} />
          )}
          {!app?.signed && !app?.signingPending && <p className="text-xs text-muted" data-testid="apps-unsigned">{t('roomApps.unsigned')}</p>}
        </Fold>
      )}
      {kind === 'sentry' && (
        <Fold summary={t('roomApps.sentryAlert')} testId="apps-sentry-alert">
          <p>{t('roomApps.sentryAlertBody', { alerts: v('sentryAlerts'), action: v('sentryAlertAction') })}</p>
        </Fold>
      )}

      <div className="border-t border-line pt-3">
        <StatusLine app={app} place="guide" beforeCopy={forms ? 'code' : 'address'} />
        {nothingYet && (
          <Fold summary={t('roomApps.nothingYet')} testId="apps-nothing-yet" className="mt-2">
            <ul className="list-disc space-y-1 pl-5">
              {kind === 'github' ? <>
                <li>{t('roomApps.checkJson', { json: v('githubJson') })}</li>
                <li>{t('roomApps.checkSecret')}</li>
                <li>{t('roomApps.checkDeliveries', { deliveries: v('githubDeliveries') })}</li>
              </> : service === 'other' ? <>
                <li>{t('roomApps.checkAddress')}</li>
                <li>{t('roomApps.checkText')}</li>
              </> : <>
                {/* the services that post only when something happens there: was it pasted whole, what to check there,
                    and how to make something happen */}
                <li>{t(forms ? 'roomApps.checkCode' : 'roomApps.checkAddress')}</li>
                {(NOTHING_YET[service] ?? []).map((vars, i) => (
                  <li key={i}>{t(`roomApps.nothingYetCheck.${service}.${i + 1}` as never, Object.fromEntries(Object.entries(vars ?? {}).map(([k, label]) => [k, v(label)])))}</li>
                ))}
              </>}
            </ul>
            {/* a terminal is a computer's, and for developers: folded once more */}
            {service === 'other' && (
              <details className="max-md:hidden" data-testid="apps-for-developers">
                <summary className="cursor-pointer text-xs font-medium text-muted">{t('roomApps.forDevelopers')}</summary>
                <p className="mt-1 text-xs text-muted">{t('roomApps.checkCurl')}</p>
                <code className="mt-1 block font-mono text-code-sm break-all text-ink" data-testid="apps-curl">{curl}</code>
              </details>
            )}
          </Fold>
        )}
      </div>
      {preview && <ExamplePreview service={service} name={app?.name ?? (service === 'other' && name.trim() ? name.trim() : t(`roomApps.kind.${service}`))} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => setPreview((p) => !p)} aria-expanded={preview} data-testid="apps-example">{preview ? t('roomApps.hideExample') : t('roomApps.showExample')}</Button>
        <Button variant={used ? 'primary' : 'secondary'} onClick={onDone} data-testid="apps-done">{t('roomApps.done')}</Button>
      </div>
    </div>
  )
}

/** A secret is set: only signed messages are shown (Channel Talk's token: only messages that carry it); "Turn off" takes
 * it away (unsigned ones are shown again). A secret Trina made that the service has not used yet (signingPending): it
 * says signing starts with the first signed message and that until then messages without it still show. */
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
    <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="apps-signed" data-state={app.signingPending ? 'pending' : 'on'}>
      {app.signingPending ? <span className="-mt-1.5 flex shrink-0"><WaitingDot /></span> : <Check size={14} className="shrink-0 text-ok" aria-hidden />}
      <span className="min-w-0 flex-1">{app.signingPending ? t('roomApps.saferPending', { app: t(`roomApps.kind.${svc(app)}`) }) : t(svc(app) === 'channel_talk' ? 'roomApps.saferOnToken' : 'roomApps.saferOn')}</span>
      <TextAction onClick={() => void off()} data-testid="apps-secret-off">{t('roomApps.saferOff')}</TextAction>
    </p>
  )
}

/** The service's own secret (Sentry's Client Secret, Stripe's signing secret, Shopify's key, Zendesk's secret), pasted
 * and saved; the server checks its shape for the service and says why it refuses one. Saving before the address was
 * copied adds the app first. */
function PasteSecret({ roomId, app, ensure, placeholder }: { roomId: string; app: RoomApp | null; ensure: () => Promise<{ app: RoomApp }>; placeholder: string }) {
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
        <label htmlFor={id} className="sr-only">{placeholder}</label>
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className={clsx(inputCls, 'min-w-0 flex-1 font-mono text-code-sm')} aria-invalid={!!err} data-testid="apps-sentry-secret" />
        <Button type="submit" disabled={!value.trim() || busy} busy={busy} data-testid="apps-sentry-secret-save">{t('roomApps.save')}</Button>
      </div>
      {err && <p className="text-xs text-danger" role="alert" data-testid="apps-secret-error">{err}</p>}
    </form>
  )
}

// ---------------- 5. one app's settings ----------------
function Settings({ roomId, roomName, app, available, onGuide, onRemoved }: { roomId: string; roomName: string; app: RoomApp; available: boolean; onGuide: (step?: string) => void; onRemoved: () => void }) {
  const t = useT()
  const locale = useLocale()
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  useLive(roomId, app)
  const service = svc(app)
  const [error, setError] = useState(false)
  const set = async (body: { events?: Record<string, boolean>; quiet?: boolean }) => {
    setError(false)
    try { await useRoomApps.getState().update(roomId, app.id, body) } catch { setError(true) }
  }
  const [name, setName] = useState(app.name)
  useEffect(() => { setName(app.name) }, [app.name])
  const rename = useRename(roomId, app)
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, flash] = useFlash()
  /** the address (a new one just made, else the server's); never put on the screen here */
  const address = () => (fresh ? Promise.resolve(fresh) : api.call(API.getRoomAppAddress, { params: { id: roomId, appId: app.id } }).then((a) => a.address))
  const copy = async () => {
    const made = address().then((a) => (app.kind === 'google_forms' ? roomAppFormsScript(a, app.events.email !== false) : a))
    try {
      await copyFrom(made)
      flash('address')
    } catch (e) {
      // the browser refused the clipboard: settings never show the URL; its guide does, in full, after Copy there
      if (await made.then(() => true, () => false)) toast({ level: 'error', text: t('roomApps.copyFailedSettings') })
      else fail(e)
    }
  }
  const rotate = async () => {
    // what the service does with the old URL, where it does something (plan "States")
    const body = service === 'google_forms' ? t('roomApps.newAddressBodyForms')
      : service === 'typeform' || service === 'shopify' || service === 'notion' ? t(`roomApps.newAddressBodyPreset.${service}`)
      : service === 'other' ? t('roomApps.newAddressBodyOther')
      : t('roomApps.newAddressBody', { app: t(`roomApps.kind.${service}`) })
    const ok = await confirmDialog({ title: t('roomApps.newAddressTitle'), body, confirm: t('roomApps.newAddressConfirm') })
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
  const status = appStatus(app)
  const switches = switchesOf(service)
  // optional events set up in the service that never arrived: "Not set up in Shopify"
  const missing = notSetUp(service, app)
  const refusedText = useRefusedText()
  // what needs someone, one block, one action each
  const leaver = !!app.leaverKnows && !fresh
  const warnings: Warning[] = [
    ...(!available ? [{ key: 'no-address', text: t('roomApps.statusNoAddress') }] : []),
    ...(status.kind === 'refused' ? [{
      key: 'refused', text: refusedText(service, status),
      ...(status.reason === 'signature' ? { action: { label: t('roomApps.checkSecretAction'), onClick: () => onGuide(), testId: 'apps-set-up-again' } } : {}),
    }] : []),
    ...(leaver ? [{ key: 'leaver', text: t('roomApps.leaverKnows'), action: { label: t('roomApps.newAddress'), onClick: () => void rotate(), disabled: !available, testId: 'apps-leaver-new-address' } }] : []),
    ...(signingOf(service) !== 'none' && !app.signed && !app.signingPending ? [{ key: 'unsigned', text: t('roomApps.unsigned'), action: { label: t('roomApps.makeSafer'), onClick: () => onGuide(), testId: 'apps-make-safer' } }] : []),
    // a secret Trina made, not used by the service yet: unsigned messages still show until the first signed one
    ...(app.signingPending ? [{ key: 'signing-pending', text: t('roomApps.saferPending', { app: t(`roomApps.kind.${service}`) }), action: { label: t('roomApps.howToConnect'), onClick: () => onGuide(), testId: 'apps-pending-how' } }] : []),
  ]
  return (
    <div className="-mx-5 -my-5 max-sm:-mx-4" data-testid="apps-settings" data-kind={service}>
      <div className="space-y-3 px-5 pt-4 pb-3 max-sm:px-4">
        {/* who set it up, and the way back to its steps */}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted" data-testid="apps-set-up-by">
          <span>{app.createdBy ? t('roomApps.setUpBy', { name: app.createdBy.name }) : t('roomApps.setUpByGone')}</span>
          <span aria-hidden className="text-faint">·</span>
          <TextAction onClick={() => onGuide()} data-testid="apps-how-to-connect">{t('roomApps.howToConnect')}</TextAction>
        </p>
        <StatusLine app={app} place="settings" onResume={() => void resume()} />
        {status.kind === 'none' && service === 'other' &&<p className="-mt-1 pl-4 text-xs text-muted" data-testid="apps-waiting-hint">{t('roomApps.waitingOther')}</p>}
        <Warnings items={warnings} />
        {error && <p className="text-xs text-danger" role="alert" data-testid="apps-save-failed">{t('roomApps.saveFailed')}</p>}
      </div>
      <section className="border-t border-line px-5 py-3 max-sm:px-4">
        <NameField value={name} onChange={(x) => { setName(x); rename.setError(null) }} onCommit={() => void rename.save(name)} error={rename.error} testId="apps-name" />
      </section>
      {/* the switches, when there is a choice (Other has one kind of message) */}
      {switches.length > 1 && (
        <section className="border-t border-line px-5 py-2 max-sm:px-4" aria-labelledby={`${quietId}-show`}>
          <h3 id={`${quietId}-show`} className="py-2 text-xs font-medium text-muted">{t('roomApps.showHere')}</h3>
          <ul>
            {switches.map((sw) => (
              <SwitchRow
                key={sw.key} id={`${quietId}-${sw.key}`} label={t(`roomApps.switch.${service}.${sw.key}` as never)} checked={app.events[sw.key] ?? sw.on}
                onChange={(v) => void set({ events: { [sw.key]: v } })} testId={`apps-switch-${sw.key}`}
                note={missing.has(sw.key) ? { text: t('roomApps.notSetUp', { app: t(`roomApps.kind.${service}`) }), action: t('roomApps.notSetUpShow'), onClick: () => onGuide(sw.key) } : undefined}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="border-t border-line px-5 py-2 max-sm:px-4">
        <ul>
          <SwitchRow id={`${quietId}-quiet`} label={t('roomApps.quiet')} hint={t('roomApps.quietHint')} checked={app.quiet} onChange={(v) => void set({ quiet: v })} testId="apps-quiet" />
        </ul>
      </section>
      {service === 'other' && (
        <section className="border-t border-line px-5 py-3 max-sm:px-4" aria-labelledby={`${quietId}-send`}>
          <h3 id={`${quietId}-send`} className="pb-2 text-xs font-medium text-muted">{t('roomApps.howToSend')}</h3>
          <HowToSend getAddress={address} />
        </section>
      )}
      <section className="space-y-2 border-t border-line px-5 py-3 max-sm:px-4" data-testid="apps-address-row">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="mr-auto text-sm text-ink">{app.kind === 'google_forms' ? t('roomApps.codeLabel') : t('roomApps.address')}</span>
          <CopyButton label={app.kind === 'google_forms' ? t('roomApps.copyCode') : t('roomApps.copyAddress')} copied={copied === 'address'} disabled={!available} onClick={() => void copy()} testId="apps-settings-copy" />
          {/* while the warning above offers it, not twice */}
          {!leaver && <TextAction onClick={() => void rotate()} disabled={!available} className="px-1 text-sm" data-testid="apps-new-address">{t('roomApps.newAddress')}</TextAction>}
        </div>
        {fresh && <p className="text-xs text-muted" role="status" data-testid="apps-new-address-done">{service === 'other' ? t('roomApps.newAddressDoneOther') : service === 'google_forms' ? t('roomApps.newAddressDoneForms') : t('roomApps.newAddressDone', { app: t(`roomApps.kind.${service}`) })}</p>}
      </section>
      <div className="border-t border-line px-5 py-3 max-sm:px-4">
        <TextAction tone="danger" onClick={() => void remove()} className="text-sm" data-testid="apps-remove">{t('roomApps.remove')}</TextAction>
      </div>
    </div>
  )
}

/** A switch row: the words on the left, the switch on the right; 44 px tall on a phone. `note`: an optional event that
 * never arrived says so under its words, with the way back to its step ("Not set up in Shopify · Show the step"). */
function SwitchRow({ id, label, hint, note, checked, onChange, testId }: { id: string; label: string; hint?: string; note?: { text: string; action: string; onClick: () => void }; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <li className="flex min-h-11 items-center gap-3 py-0.5 md:min-h-9">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="flex min-h-6 cursor-pointer flex-col justify-center text-sm text-ink max-md:min-h-11">
          {label}
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </label>
        {note && (
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted" data-testid={`${testId}-not-set-up`}>
            <span>{note.text}</span>
            <span aria-hidden className="text-faint">·</span>
            <TextAction onClick={note.onClick} data-testid={`${testId}-show-step`}>{note.action}</TextAction>
          </p>
        )}
      </div>
      <Switch id={id} external checked={checked} onChange={onChange} label={label} testId={testId} />
    </li>
  )
}
