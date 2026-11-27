// Connect a Slack channel (docs/SLACK.md "Channel relay", plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md
// "Recommended UX (lean)" and "States"): one panel, the same in Add an app › Slack (inside the apps dialog) and behind
// the header chip (SlackRelayDialog). What the conversation's status says (GET /api/rooms/:id/slack) decides what it
// shows, one thing at a time:
//   linked        the channel, its state in words, who connected it and when; for an admin of an official app added
//                 before the relay asked for it, one quiet line "Add to Slack again …"; Disconnect (its owners and admins;
//                 a member reads it only)
//   blocked       why not here, in one line (an admin of a team without Slack gets the way to Admin › Slack)
//   not linked    only "Sign in with Slack" (a window of its own; this panel waits and carries on by itself), or, where
//                 that is not set up, how to link by mentioning the app in Slack
//   pick          the channels both I and the app are in (a taken one greyed, a private one with a lock, a shared one
//                 said), how to bring a missing one, the one sentence of who will see what, and Connect
// Nothing else to set. Slack's own words (channel, /invite) are kept.
import clsx from 'clsx'
import { Hash, Lock } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SLACK, type SlackRelayChannel, type SlackRelayLink, type SlackRelayStatus } from '@mycel/shared/api'
import { useLocale, useT } from '../../../i18n'
import { api, API, ApiError, errorText } from '../../../lib/api'
import { SLACK_ADMIN_PATH } from '../../../lib/connectors'
import { destructive } from '../../../lib/destructive'
import { openSignInWindow, reserveSignInWindow, signInPlace } from '../../../lib/driveSignIn'
import { dateBucket, formatShortDateTime, intlTag } from '../../../lib/format'
import { useWaitLimit } from '../../../lib/signInWait'
import { useRoomApps } from '../../../store/roomApps'
import { isAdmin, useMe } from '../../../store/session'
import { useSlackRelay } from '../../../store/slackRelay'
import { BrowserWait } from '../../integrations/BrowserWait'
import { Button, ErrorNote, Modal, Skeleton } from '../../ui'
import { SlackMark } from '../SlackMessage'

/** how often the panel reads the status again while a sign-in window is open */
const SIGN_IN_POLL_MS = 3000

type T = ReturnType<typeof useT>

/** A refused connect (or channel list) in plain words, by the server's reason; else its message. */
export function relayErrorText(e: unknown, t: T, locale: Parameters<typeof errorText>[1], bot: string | null): string {
  const reason = e instanceof ApiError ? e.body.params?.reason : undefined
  switch (reason) {
    case 'slack_off': return t('slackRelay.err.slackOff')
    case 'room_kind': return t('slackRelay.blocked.roomKind')
    case 'guests': return t('slackRelay.blocked.guests')
    case 'slack_not_linked': return t('slackRelay.err.notLinked')
    case 'not_in_channel': return t('slackRelay.err.notInChannel')
    case 'bot_not_in_channel': return bot ? t('slackRelay.err.botNotInChannel', { bot }) : t('slackRelay.err.botNotInChannelNoBot')
    case 'linked': return t('slackRelay.err.linked')
    case 'slack_unreachable': return t('slackRelay.err.slackDown')
    case 'broker_unreachable': return t('slackRelay.err.brokerDown')
    default: return errorText(e, locale, t('error.network'))
  }
}

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

/** A link's state in words (the status, the header chip's tooltip). */
export function relayStateText(t: T, link: Pick<SlackRelayLink, 'state'>, bot: string | null): string {
  if (link.state === 'archived') return t('slackRelay.state.archived')
  if (link.state === 'bot_removed') return bot ? t('slackRelay.state.botRemoved', { bot }) : t('slackRelay.state.botRemovedNoBot')
  return t('slackRelay.state.active')
}

/** The panel. `onChanged`: a channel was connected or disconnected (the apps dialog reads its list again). */
export function SlackRelayPanel({ roomId, onChanged }: { roomId: string; onChanged?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const status = useSlackRelay((s) => s.status[roomId])
  const [error, setError] = useState<string | null>(null)
  const words = useRef({ t, locale })
  words.current = { t, locale }
  const reload = useRef(() => {})
  reload.current = () => {
    useSlackRelay.getState().load(roomId).then(() => setError(null), (e) => setError(errorText(e, words.current.locale, words.current.t('error.network'))))
  }
  // fresh each time it opens, and again when the window is used again (a sign-in finished in another window, the app
  // invited in Slack)
  useEffect(() => {
    reload.current()
    const again = () => { if (document.visibilityState !== 'hidden') reload.current() }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again) }
  }, [roomId])
  if (status === undefined) return error ? <ErrorNote onRetry={() => reload.current()}>{error}</ErrorNote> : <Skeleton lines={3} />
  // an older server (no relay): the same as Slack not being there
  const s: SlackRelayStatus = status ?? { link: null, blocked: 'not_added', meLinked: false, signIn: false, botName: null, needsReAdd: false }
  return (
    <div className="space-y-3 text-sm" data-testid="slack-relay" data-state={s.link ? 'linked' : s.blocked ? `blocked-${s.blocked}` : s.meLinked ? 'pick' : 'sign-in'}>
      {error && <ErrorNote onRetry={() => reload.current()}>{error}</ErrorNote>}
      {s.link ? <Linked roomId={roomId} status={s} link={s.link} onChanged={onChanged} />
        : s.blocked ? <Blocked why={s.blocked} />
        : !s.meLinked ? <SignIn roomId={roomId} status={s} />
        : <Pick roomId={roomId} status={s} onChanged={onChanged} />}
    </div>
  )
}

function Blocked({ why }: { why: NonNullable<SlackRelayStatus['blocked']> }) {
  const t = useT()
  const me = useMe()
  const admin = isAdmin(me)
  const close = () => { useSlackRelay.getState().close(); useRoomApps.getState().close() }
  if (why === 'not_added') {
    return (
      <div className="space-y-3" data-testid="slack-relay-blocked">
        <p className="text-ink">{t(admin ? 'slackRelay.blocked.notAddedAdmin' : 'slackRelay.blocked.notAdded')}</p>
        {admin && (
          <Link to={SLACK_ADMIN_PATH} onClick={close} className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:opacity-90 max-md:h-11" data-testid="slack-relay-open-admin">
            {t('slackRelay.openAdmin')}
          </Link>
        )}
      </div>
    )
  }
  const key = why === 'room_kind' ? 'slackRelay.blocked.roomKind' : why === 'guests' ? 'slackRelay.blocked.guests' : 'slackRelay.blocked.notManager'
  return <p className="text-ink" data-testid="slack-relay-blocked">{t(key)}</p>
}

function SignIn({ roomId, status }: { roomId: string; status: SlackRelayStatus }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [since, setSince] = useState<number | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  // a browser that refused the window: the sign-in page as a link
  const [link, setLink] = useState<string | null>(null)
  const waiting = since !== null
  // while the window is open: the status again every few seconds; linked, the panel goes on to the channels by itself
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => { void useSlackRelay.getState().load(roomId).catch(() => {}) }, SIGN_IN_POLL_MS)
    return () => clearInterval(id)
  }, [waiting, roomId])
  useWaitLimit(waiting, since, () => { setSince(null); setTimedOut(true); void api.call(SLACK.cancelSlackSignIn).catch(() => {}) })
  if (!status.signIn) {
    return <p className="text-ink" data-testid="slack-relay-mention">{status.botName ? t('slackRelay.mentionLead', { bot: status.botName }) : t('slackRelay.mentionLeadNoBot')}</p>
  }
  const start = async () => {
    const place = signInPlace()
    // during the click: a browser's window opened after the server answers is blocked as a popup
    const reserved = reserveSignInWindow(place)
    setBusy(true); setError(null); setTimedOut(false); setLink(null)
    try {
      const { authorizationUrl } = await api.call(SLACK.startSlackSignIn, { body: {} })
      setSince(Date.now())
      // the phone app hands the address to its own browser
      if (place === 'phone') window.location.assign(authorizationUrl)
      else openSignInWindow(place, reserved, authorizationUrl)
      if (place === 'browser' && (!reserved || reserved.closed)) setLink(authorizationUrl)
    } catch (e) {
      reserved?.close()
      setError(errorText(e, locale, t('error.network')))
    } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3" data-testid="slack-relay-sign-in">
      <p className="text-ink">{t('slackRelay.signInLead')}</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {waiting ? (
        <BrowserWait text={t('slack.wait.signIn')} busy={busy} onRetry={() => void start()} link={link ? { href: link, label: t('slackRelay.openSignIn') } : null} testId="slack-relay-waiting" />
      ) : (
        <Button variant="primary" busy={busy} disabled={busy} onClick={() => void start()} className="max-md:h-11" data-testid="slack-relay-sign-in-button">
          <SlackMark size={14} />
          {t('slackRelay.signIn')}
        </Button>
      )}
      {timedOut && <p role="status" className="text-warn" data-testid="slack-relay-sign-in-timeout">{t('connect.wait.timedOut')}</p>}
    </div>
  )
}

function Pick({ roomId, status, onChanged }: { roomId: string; status: SlackRelayStatus; onChanged?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const gid = useId()
  const [items, setItems] = useState<SlackRelayChannel[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const words = useRef({ t, locale, bot: status.botName })
  words.current = { t, locale, bot: status.botName }
  useEffect(() => {
    let live = true
    setLoadError(null)
    api.call(API.slackRelayChannels, { params: { id: roomId } }).then(
      (r) => { if (live) setItems(r.items) },
      (e) => {
        if (!live) return
        setLoadError(relayErrorText(e, words.current.t, words.current.locale, words.current.bot))
        // signed out of Slack or Slack taken away meanwhile: the status says what to show instead
        if (e instanceof ApiError && (e.body.params?.reason === 'slack_not_linked' || e.body.params?.reason === 'slack_off')) void useSlackRelay.getState().load(roomId).catch(() => {})
      },
    )
    return () => { live = false }
  }, [roomId, tries])
  const chosen = items?.find((c) => c.id === picked) ?? null
  const connect = async () => {
    if (!chosen) return
    setBusy(true); setError(null)
    try {
      const s = await api.call(API.connectSlackRelay, { params: { id: roomId }, body: { channelId: chosen.id } })
      useSlackRelay.getState().put(roomId, s)
      onChanged?.()
    } catch (e) {
      setError(relayErrorText(e, t, locale, status.botName))
      if (e instanceof ApiError && (e.body.params?.reason === 'slack_not_linked' || e.body.params?.reason === 'slack_off' || e.body.params?.reason === 'guests' || e.body.params?.reason === 'room_kind')) void useSlackRelay.getState().load(roomId).catch(() => {})
    } finally { setBusy(false) }
  }
  const invite = status.botName ? t('slackRelay.inviteHint', { bot: status.botName }) : t('slackRelay.inviteHintNoBot')
  return (
    <div className="space-y-3" data-testid="slack-relay-pick">
      {loadError ? <ErrorNote onRetry={() => setTries((n) => n + 1)}>{loadError}</ErrorNote>
        : !items ? <Skeleton lines={3} />
        : items.length === 0 ? <p className="text-ink" data-testid="slack-relay-none">{t('slackRelay.none')}</p>
        : (
          <div role="radiogroup" aria-label={t('slackRelay.pickLabel')} className="-mx-2 max-h-72 overflow-y-auto" data-testid="slack-relay-channels">
            {items.map((c) => (
              <label
                key={c.id}
                className={clsx('flex min-h-11 items-center gap-2.5 rounded-lg px-2 md:min-h-9', c.taken ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-hover', picked === c.id && 'bg-hover')}
                data-testid="slack-relay-channel" data-taken={c.taken ? '' : undefined}
              >
                <input type="radio" name={`${gid}-channel`} value={c.id} checked={picked === c.id} disabled={c.taken || busy} onChange={() => { setPicked(c.id); setError(null) }} className="size-4 shrink-0 accent-[var(--c-accent)]" data-testid={`slack-relay-channel-${c.id}`} />
                {c.private ? <Lock size={14} className="shrink-0 text-muted" aria-label={t('slackRelay.privateLabel')} /> : <Hash size={14} className="shrink-0 text-muted" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{c.name}</span>
                  {(c.taken || c.extShared) && (
                    <span className="block truncate text-xs text-muted">{c.taken ? t('slackRelay.taken') : t('slackRelay.extShared')}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      <p className="text-xs text-muted" data-testid="slack-relay-invite">{invite}</p>
      {/* who will see what: the one sentence before Connect (owner decision 3) */}
      <p className="border-t border-line pt-3 text-ink" data-testid="slack-relay-who">
        {t('slackRelay.who')}{chosen?.extShared ? ` ${t('slackRelay.whoShared')}` : ''}
      </p>
      {error && <p role="alert" className="text-danger" data-testid="slack-relay-error">{error}</p>}
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} disabled={!chosen || busy} onClick={() => void connect()} className="max-md:h-11 max-sm:w-full" data-testid="slack-relay-connect">
          {t('slackRelay.connect')}
        </Button>
      </div>
    </div>
  )
}

function Linked({ roomId, status, link, onChanged }: { roomId: string; status: SlackRelayStatus; link: SlackRelayLink; onChanged?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const when = useWhen()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // a member reads it; its owners and admins in it may disconnect it (also once Slack left the team, or a guest got in)
  const mayDisconnect = status.blocked !== 'not_manager'
  // asked first (lib/destructive.ts); no toast: the panel shows the channels to connect again, and the line says it
  const disconnect = () => destructive({
    confirm: { title: t('slackRelay.disconnectTitle', { channel: link.channelName }), body: t('slackRelay.disconnectBody'), confirm: t('slackRelay.disconnect') },
    run: async () => {
      setBusy(true); setError(null)
      try {
        await api.call(API.disconnectSlackRelay, { params: { id: roomId } })
        useRoomApps.getState().drop(roomId, link.appId)
        await useSlackRelay.getState().load(roomId).catch(() => {})
        onChanged?.()
        return true
      } catch (e) { setError(errorText(e, locale, t('error.network'))); return false } finally { setBusy(false) }
    },
    done: () => null,
  })
  return (
    <div className="space-y-3" data-testid="slack-relay-linked" data-link-state={link.state}>
      <div className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-hover" aria-hidden><SlackMark size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1 font-medium text-ink">
            {link.private ? <Lock size={13} className="shrink-0 text-muted" aria-label={t('slackRelay.privateLabel')} /> : <Hash size={13} className="shrink-0 text-muted" aria-hidden />}
            <span className="truncate" data-testid="slack-relay-channel-name">{link.channelName}</span>
          </p>
          <p className={clsx('mt-0.5', link.state === 'active' ? 'text-muted' : link.state === 'bot_removed' ? 'text-warn' : 'text-faint')} data-testid="slack-relay-state">
            {relayStateText(t, link, status.botName)}
          </p>
          {link.extShared && <p className="mt-0.5 text-muted" data-testid="slack-relay-shared">{t('slackRelay.sharedLine')}</p>}
          <p className="mt-0.5 text-xs text-faint" data-testid="slack-relay-by">
            {link.createdBy ? t('slackRelay.by', { name: link.createdBy.name, when: when(link.createdAt) }) : t('slackRelay.byGone', { when: when(link.createdAt) })}
          </p>
          {status.needsReAdd && (
            <Link to={SLACK_ADMIN_PATH} onClick={() => { useSlackRelay.getState().close(); useRoomApps.getState().close() }} className="mt-1 inline-block text-xs text-accent-text hover:underline" data-testid="slack-relay-readd">
              {t('slackRelay.reAdd')}
            </Link>
          )}
        </div>
      </div>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {mayDisconnect && (
        <div className="flex justify-end">
          <Button variant="danger" size="sm" busy={busy} disabled={busy} onClick={() => void disconnect()} className="max-md:h-11" data-testid="slack-relay-disconnect">
            {t('slackRelay.disconnect')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The panel in a dialog of its own: the header chip's (members read it; its managers disconnect from it). */
export function SlackRelayDialog({ roomId }: { roomId: string }) {
  const t = useT()
  const link = useSlackRelay((s) => s.status[roomId]?.link ?? null)
  return (
    <Modal open onClose={() => useSlackRelay.getState().close()} width={440} title={t(link ? 'slackRelay.titleLinked' : 'slackRelay.title')}>
      <SlackRelayPanel roomId={roomId} />
    </Modal>
  )
}
