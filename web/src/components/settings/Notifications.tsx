import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Bell } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { InboxNotification, Locale, NotificationPreferences } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { listTime } from '../../lib/format'
import { firstRunText } from '../../lib/teamGoal'
import { useLocale, useT } from '../../i18n'
import { accessChanged, notificationsChanged, reloadAsked } from '../../store/live'
import { Button, ErrorNote, Skeleton, Switch } from '../ui'
import { changeRoomSound, useRoomSoundOn } from '../../store/roomSound'
import { PushNotifications } from './PushNotifications'
import { DesktopNotifications } from './DesktopNotifications'
import { isDesktop } from '../../lib/desktop'
import { deletionNoticeText } from './AccountDeletion'
import { PrefRow, PrefSection } from './PrefRows'
import { RoomNotifySettings } from './RoomNotifySettings'
import { isRoomRow, roomNoticeLink, RoomNoticeRow } from './RoomNoticeRow'
import { useRooms } from '../../store/rooms'
import { HandoverNoticeExtras, handoverNoticeNode } from '../handover/HandoverNotice'
import { isolate } from '../handover/isolate'

/** 작업·연결 알림: the server's switches for what is not a conversation (the rooms' are in RoomNotifySettings) */
const workKeys = ['scheduleSuccess', 'scheduleFailure', 'connectionReconnect', 'skillSuggestions'] as const

/** A conversation notice from a server that does not say where and why (RoomNoticeRow does), or one whose message I may
 * no longer read: who wrote it when the server still names them, no text. */
const roomText = (item: InboxNotification, t: ReturnType<typeof useT>) => {
  const from = item.room?.from
  if (item.code === 'room.mention') return from ? t('notifications.event.room.mentionNamed', { name: from }) : t('notifications.event.room.mention')
  return from ? t('notifications.event.room.dmNamed', { name: from }) : t('notifications.event.room.dm')
}

/** What an admin did to the team's AI (or to a member's own connection): the page knows these actions; one it does not
 * (a newer server) is a generic line rather than a missing text. */
const CREDENTIAL_ACTIONS = ['added', 'replaced', 'removed', 'disabled', 'reassigned', 'zero_limit', 'shared_on', 'engine', 'personal_disabled', 'personal_removed', 'personal_login_stopped'] as const
export const credentialChangeText = (c: NonNullable<InboxNotification['credentialChange']>, t: ReturnType<typeof useT>) =>
  (CREDENTIAL_ACTIONS as readonly string[]).includes(c.action)
    ? t(`notifications.credentialChange.${c.action as typeof CREDENTIAL_ACTIONS[number]}`, { who: c.who, subject: c.subject })
    : t('notifications.event.credential.change')

/** A suggestion to review opens in the review tab, an own result in "my suggestions" (the Skills screen checks access). */
/** A skill notice's link: a suggestion to review (a member's batch of skill folders: Skills › 검토 at that person,
 * docs/DECISIONS.md "MC"), or the result of one of mine. */
export const skillsLink = (item: Pick<InboxNotification, 'code' | 'sourceId' | 'contribution'>) =>
  `/skills?${item.code === 'skill.suggested' ? (item.contribution ? 'batch' : 'review') : 'mine'}=${encodeURIComponent(item.sourceId)}`

/** Settings › MCP: a request opens as ?request=, a connection template (its notice, or a scheduled run that needed it)
 * opens its Connect as ?template=. */
export const integrationsLink = (item: Pick<InboxNotification, 'sourceId' | 'template' | 'needsKey'>) => {
  const template = item.template?.id ?? item.needsKey?.templateId
  return template ? `/settings/connectors?template=${encodeURIComponent(template)}` : `/settings/connectors?request=${encodeURIComponent(item.sourceId)}`
}

export type DevEnvEndReason = 'timeout' | 'oom' | 'stopped' | 'idle' | 'disk' | 'setting' | 'expired' | 'lost'
export const END_REASONS: ReadonlySet<string> = new Set<DevEnvEndReason>(['timeout', 'oom', 'stopped', 'idle', 'disk', 'setting', 'expired', 'lost'])

/** The text of a dev environment notice: with the job or the project while the person can still read that project. */
const devEnvText = (item: InboxNotification, t: ReturnType<typeof useT>) => {
  const d = item.devEnv
  // srt runner: a job with no exit code says why it ended (a reason the page does not know is the old text)
  if (d?.job && d.job.exitCode === null && d.job.reason && END_REASONS.has(d.job.reason)) return t('notifications.event.dev_env.jobReason', { name: d.job.name, why: t(`devEnv.end.${d.job.reason as DevEnvEndReason}`) })
  if (d?.job) return d.job.exitCode === null ? t('notifications.event.dev_env.jobNoCode', { name: d.job.name }) : t('notifications.event.dev_env.jobEnded', { name: d.job.name, code: d.job.exitCode })
  if (d?.stopCode === 'disk') return t('notifications.event.dev_env.boxDisk', { project: d.projectName })
  if (d?.stopCode === 'busy_max') return t('notifications.event.dev_env.boxBusy', { project: d.projectName })
  return t(`notifications.event.${item.code as 'dev_env.job' | 'dev_env.box'}`)
}

type T = ReturnType<typeof useT>

/** The words of a notice of the app's own. A scheduled run names its task while the task is there (the person's own
 * words, in <bdi>); without it, "a scheduled task" as before. */
export function noticeText(item: InboxNotification, t: T, locale: Locale): ReactNode {
  if (item.handover) return handoverNoticeNode(locale, item.handover)
  if (item.code === 'credential.change' && item.credentialChange) return credentialChangeText(item.credentialChange, t)
  if (item.code === 'room.dm' || item.code === 'room.mention') return roomText(item, t)
  if (item.code === 'dev_env.job' || item.code === 'dev_env.box') return devEnvText(item, t)
  if (item.code === 'onboarding.ai_request' && item.requester) return t('notifications.event.onboarding.ai_requestNamed', { name: item.requester.name })
  if (item.code === 'skills.merge_waiting' && item.merges) return t('notifications.event.skills.merge_waitingN', { n: item.merges.n })
  if (item.code === 'skill.suggested' && item.contribution) return item.contribution.name ? t('notifications.event.skill.contributed', { name: item.contribution.name, n: item.contribution.n }) : t('notifications.event.skill.contributedGone', { n: item.contribution.n })
  if (item.code === 'team.joined') return item.joined ? t('teamLink.joinedNotice', { name: item.joined.name }) : t('teamLink.joinedNoticeGone')
  if (item.code === 'onboarding.first_run') return firstRunText(t, locale, item)
  if (item.code === 'account.deletion_request') return deletionNoticeText(t, item)
  if (item.code === 'integration.request' && item.request) return t('notifications.event.integration.requestNamed', { name: item.request.name, host: item.request.host })
  if (item.code === 'drive.share_reconnect' && item.driveShare) return t('notifications.event.drive.share_reconnectNamed', { name: item.driveShare.name })
  if (item.template) return t(item.code === 'integration.template_reconnect' ? 'notifications.event.integration.template_reconnectNamed' : 'notifications.event.integration.templateNamed', { name: item.template.name })
  const title = item.schedule?.title
  if (item.code === 'schedule.failure' && item.needsKey) return title
    ? isolate(locale, 'notifications.event.schedule.needsKeyNamed', { title, name: item.needsKey.name }, ['title', 'name'])
    : t('notifications.event.schedule.needsKey', { name: item.needsKey.name })
  if (item.code === 'schedule.failure' && item.review) return t('notifications.event.schedule.review')
  if (item.code === 'schedule.success' || item.code === 'schedule.failure') {
    const kind = item.code === 'schedule.success' ? 'success' : item.outcome === 'problems' ? 'problems' : 'failure'
    return title ? isolate(locale, `notifications.event.schedule.${kind}Named`, { title }, ['title']) : t(`notifications.event.schedule.${kind}`)
  }
  return t(`notifications.event.${item.code}`)
}

/** Where a notice of the app's own opens, with its link's test id: the result chat of a scheduled run, the page of the
 * rest. Null: nowhere (a source I may no longer read, a notice that only tells), and its row is no link. */
export function noticeLink(item: InboxNotification): { to: string; testId: string } | null {
  if (item.link === 'chat' && item.chatId) return { to: `/c/${encodeURIComponent(item.chatId)}`, testId: 'notification-chat-link' }
  if (item.link === 'room' && item.room) return { to: roomNoticeLink(item.room), testId: 'notification-room-link' }
  if (item.link === 'project' && item.devEnv) return { to: `/projects/${encodeURIComponent(item.devEnv.projectId)}`, testId: 'notification-project-link' }
  if (item.review) return { to: '/scheduled', testId: 'notification-review-link' }
  if (item.link === 'connections') return { to: '/settings/connectors?drive=1', testId: 'notification-connections-link' }
  if (item.link === 'integrations') return { to: integrationsLink(item), testId: item.template || item.needsKey ? 'notification-template-link' : 'notification-request-link' }
  if (item.link === 'admin_connectors') return { to: '/admin/connectors?drive=1', testId: 'notification-drive-share-link' }
  if (item.link === 'admin_credentials') return { to: '/admin/providers', testId: item.code === 'credential.change' ? 'notification-credential-link' : 'notification-ai-request-link' }
  if (item.code === 'team.joined') return { to: '/admin/members', testId: 'notification-joined-link' }
  if (item.link === 'admin_members') return { to: `/admin/members?member=${encodeURIComponent(item.sourceId)}`, testId: 'notification-deletion-link' }
  if (item.link === 'skills') return { to: skillsLink(item), testId: 'notification-skills-link' }
  return null
}

/** A notice of the app's own, read like a conversation row (RoomNoticeRow): a quiet bell where a conversation row has
 * the writer's photo, so the text of every row starts at one edge; the words; the time on the right, as the 대화 list
 * shows it. With a place to open, the whole row is that link and opening it reads the notice (while unread, a dot where
 * a conversation row has its count). With none, the row is still, no hover, and keeps its 읽음 표시. A job's log and the
 * handover's buttons sit under the link, not in it (the log is there to be selected). */
function NoticeRow({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT(), locale = useLocale()
  const unread = !item.readAt
  const link = noticeLink(item)
  const d = item.devEnv
  // the project a link used to name, when the words do not (a stopped box's do)
  const project = item.link === 'project' && d?.projectName && !(item.code === 'dev_env.box' && (d.stopCode === 'disk' || d.stopCode === 'busy_max')) ? d.projectName : null
  // under the words: the handover's lines and buttons, a job's log (never inside a link)
  const below = item.handover || d?.job?.tail ? <>
    {item.handover && <HandoverNoticeExtras item={item} onRead={onRead} onChanged={onChanged} />}
    {d?.job?.tail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-faint" data-testid="notification-job-tail">{d.job.tail}</pre>}
  </> : null
  const row = (inside: ReactNode) => <>
    <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-hover text-muted"><Bell size={16} /></span>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <div className={clsx('min-w-0 flex-1 text-sm', unread ? 'font-medium text-ink' : 'text-muted')} data-testid="notification-text">{noticeText(item, t, locale)}</div>
        {/* the time where a conversation row has it; under it, while unread, the dot (a link reads the notice) or 읽음 표시 */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <time dateTime={item.createdAt} className="text-xs text-faint">{listTime(item.createdAt, locale, t('sidebar.yesterday'))}</time>
          {unread && (link
            ? <span className="size-2 rounded-full bg-accent" data-testid="notification-unread"><span className="sr-only">{t('notifications.unreadMark')}</span></span>
            : <Button size="sm" onClick={onRead}>{t('notifications.markRead')}</Button>)}
        </div>
      </div>
      {project && <p className="mt-0.5 truncate text-xs text-muted" data-testid="notification-project"><bdi>{project}</bdi></p>}
      {d?.job?.exitCode === null && d.job.note && <p className="mt-1 text-xs text-muted" data-testid="notification-job-note">{d.job.note}</p>}
      {inside}
    </div>
  </>
  if (!link) return <li className="flex items-start gap-3 py-3" data-testid="notification-item" data-unread={unread ? '' : undefined}>{row(below)}</li>
  return <li data-testid="notification-item">
    <Link to={link.to} onClick={onRead} className="-mx-2 flex min-w-0 items-start gap-3 rounded-lg px-2 py-3 hover:bg-hover" data-testid={link.testId} data-unread={unread ? '' : undefined}>{row(null)}</Link>
    {below && <div className="-mt-2 min-w-0 pb-3 pl-12">{below}</div>}
  </li>
}

export function Notifications() {
  const t = useT(), locale = useLocale()
  const sound = useRoomSoundOn()
  const [items, setItems] = useState<InboxNotification[] | null>(null)
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), sequence = useRef(0), writing = useRef(false)
  /** changes made while one is saving: sent together right after it (nothing waits for the server on screen) */
  const queued = useRef<Partial<NotificationPreferences> | null>(null)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])
  /** how many rows are on screen: a read again keeps the pages already loaded ("더 보기"), up to the API's 100 */
  const shown = useRef(0)
  const load = useCallback(async (after?: string) => {
    const generation = life.current, seq = ++sequence.current
    try {
      const [inbox, prefs] = await Promise.all([
        api.call(API.listNotifications, { query: { limit: after ? 30 : Math.min(100, Math.max(30, shown.current)), cursor: after } }),
        api.call(API.getNotificationPreferences),
      ])
      if (generation !== life.current || seq !== sequence.current) return
      setItems(previous => {
        const next = after && previous ? [...new Map([...previous, ...inbox.items].map(item => [item.id, item])).values()] : inbox.items
        shown.current = next.length
        return next
      })
      // while my changes are being saved, the switches show them, not a read from before the last one landed
      if (!writing.current) setPreferences(prefs)
      setCursor(inbox.nextCursor); setUnread(inbox.unreadCount); setError(null)
    } catch (e) { if (generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    // useT returns a fresh function; its translations change only with locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const off = notificationsChanged.on(() => void load()), reload = reloadAsked.on(() => void load())
    const access = accessChanged.on(() => { setItems(null); void load() })
    // a conversation row grows while its run goes on (another reply in the thread) without a new notice: read the rows
    // again once the rooms have been quiet for a second, and at least every 5 seconds while they keep changing
    let timer: ReturnType<typeof setTimeout> | undefined, since = 0
    const rooms = useRooms.subscribe((s, before) => {
      if (s.rooms === before.rooms) return
      const now = Date.now()
      if (!since) since = now
      clearTimeout(timer)
      timer = setTimeout(() => { since = 0; void load() }, now - since >= 5000 ? 0 : 1000)
    })
    return () => { off(); reload(); access(); rooms(); clearTimeout(timer) }
  }, [load])
  // shown at once; saved in order, one request at a time (a change made meanwhile goes with the next one)
  const update = async (patch: Partial<NotificationPreferences>) => {
    const generation = life.current
    setPreferences(current => current ? { ...current, ...patch } : current)
    sequence.current++
    if (writing.current) { queued.current = { ...queued.current, ...patch }; return }
    const before = preferences
    writing.current = true
    try {
      for (let body: Partial<NotificationPreferences> | null = patch; body; body = queued.current, queued.current = null) {
        await api.call(API.updateNotificationPreferences, { body })
      }
    } catch (e) {
      queued.current = null; writing.current = false
      if (generation === life.current) { setPreferences(before); setError(errorText(e, locale, t('error.network'))) }
      return
    }
    writing.current = false
    if (generation === life.current) await load()
  }
  const read = async (item: InboxNotification) => {
    if (item.readAt) return
    const generation = life.current
    try { await api.call(API.markNotificationRead, { params: { id: item.id } }); if (generation === life.current) await load() }
    catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
  }
  // The inbox first (on a phone this page is 알림함, the 나 tab's top row), then the settings as plain sections: 대화,
  // 작업·연결 알림, 이 기기 (docs/DECISIONS.md "대화방 알림 설정"). No frames; the title is in the bar above on a phone
  // (SettingsDialog.tsx), so here it is for screen readers only.
  return <section className="flex flex-col gap-5" data-testid="notifications">
    <div><h2 className="text-base font-semibold max-md:sr-only">{t('notifications.title')}</h2><p className="mt-1 text-sm text-muted max-md:mt-0">{t('notifications.description')}</p></div>
    {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
    {!items && !error && <Skeleton lines={3} />}
    {/* the inbox comes first: it is what the sidebar's "Inbox" opens; the preferences follow below it */}
    {items && <div data-testid="notifications-inbox">
      <h3 className="mb-3 text-base font-semibold">{t('inbox.title')} <span className="font-normal text-muted">· {t('notifications.unread', { count: unread })}</span></h3>
      {!items.length && <p className="text-sm text-muted">{t('notifications.empty')}</p>}
      <ul className="divide-y divide-line">{items.map(item => isRoomRow(item)
        ? <li key={item.id} data-testid="notification-item"><RoomNoticeRow item={item} onOpen={() => void read(item)} /></li>
        : <NoticeRow key={item.id} item={item} onRead={() => void read(item)} onChanged={() => void load()} />)}</ul>
      {cursor && <Button onClick={() => void load(cursor)}>{t('common.loadMore')}</Button>}
    </div>}
    {preferences && <RoomNotifySettings prefs={preferences} onChange={(patch) => void update(patch)} />}
    {preferences && <PrefSection title={t('notifications.section.work')} desc={t('notifications.preferenceHint')} testId="notifications-work">
      {/* a server from before a preference existed leaves it out: no row for it */}
      {workKeys.filter(key => typeof preferences[key] === 'boolean').map(key => <PrefRow key={key} id={`np-${key}`} title={t(`notifications.${key}`)} desc={t(`notifications.${key}Desc`)}
        control={<Switch id={`np-${key}`} external describedBy={`np-${key}-desc`} checked={preferences[key]} onChange={v => void update({ [key]: v })} label={t(`notifications.${key}`)} testId={`notification-pref-${key}`} />} />)}
    </PrefSection>}
    {/* this device's: the chime (store/roomSound.ts, kept in this browser, never waits for the server and shows even when
        the server's choices could not be read) and push to this device (the desktop app: its own computer notifications) */}
    <PrefSection title={t('notifications.section.device')} testId="notifications-device">
      <PrefRow id="np-sound" title={t('notifications.sound')} desc={t('notifications.soundDesc')}
        control={<Switch id="np-sound" external describedBy="np-sound-desc" checked={sound} onChange={changeRoomSound} label={t('notifications.sound')} testId="notification-sound" />} />
      {isDesktop() ? <DesktopNotifications /> : <PushNotifications />}
    </PrefSection>
  </section>
}
