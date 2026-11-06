import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { InboxNotification, NotificationPreferences } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { firstRunText } from '../../lib/teamGoal'
import { useLocale, useT } from '../../i18n'
import { accessChanged, notificationsChanged, reloadAsked } from '../../store/live'
import { Button, ErrorNote, Skeleton } from '../ui'
import { mobilePushApp } from '../../lib/mobile-push'
import { PushNotifications } from './PushNotifications'
import { deletionNoticeText } from './AccountDeletion'

const preferenceKeys = ['scheduleSuccess', 'scheduleFailure', 'connectionReconnect', 'skillSuggestions', 'roomMessages'] as const

/** A DM message or an @mention in a team chat room: who wrote it when the server still names them (never the text). */
const roomText = (item: InboxNotification, t: ReturnType<typeof useT>) => {
  const from = item.room?.from
  if (item.code === 'room.mention') return from ? t('notifications.event.room.mentionNamed', { name: from }) : t('notifications.event.room.mention')
  return from ? t('notifications.event.room.dmNamed', { name: from }) : t('notifications.event.room.dm')
}

/** A suggestion to review opens in the review tab, an own result in "my suggestions" (the Skills screen checks access). */
export const skillsLink = (item: Pick<InboxNotification, 'code' | 'sourceId'>) => `/skills?${item.code === 'skill.suggested' ? 'review' : 'mine'}=${encodeURIComponent(item.sourceId)}`

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

export function Notifications() {
  const t = useT(), locale = useLocale()
  const app = mobilePushApp()
  const [items, setItems] = useState<InboxNotification[] | null>(null)
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [unread, setUnread] = useState(0), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), sequence = useRef(0), writing = useRef(false)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])
  const load = useCallback(async (after?: string) => {
    const generation = life.current, seq = ++sequence.current
    try {
      const [inbox, prefs] = await Promise.all([
        api.call(API.listNotifications, { query: { limit: 30, cursor: after } }),
        api.call(API.getNotificationPreferences),
      ])
      if (generation !== life.current || seq !== sequence.current) return
      setItems(previous => after && previous ? [...new Map([...previous, ...inbox.items].map(item => [item.id, item])).values()] : inbox.items)
      setPreferences(prefs); setCursor(inbox.nextCursor); setUnread(inbox.unreadCount); setError(null)
    } catch (e) { if (generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    // useT returns a fresh function; its translations change only with locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const off = notificationsChanged.on(() => void load()), reload = reloadAsked.on(() => void load())
    const access = accessChanged.on(() => { setItems(null); void load() })
    return () => { off(); reload(); access() }
  }, [load])
  const update = async (key: keyof NotificationPreferences, value: boolean) => {
    if (writing.current) return
    const generation = life.current
    const before = preferences
    setPreferences(current => current ? { ...current, [key]: value } : current)
    writing.current = true; sequence.current++; setBusy(true)
    try {
      await api.call(API.updateNotificationPreferences, { body: { [key]: value } })
      if (generation === life.current) await load()
    } catch (e) { if (generation === life.current) { setPreferences(before); setError(errorText(e, locale, t('error.network'))) } }
    finally { writing.current = false; if (generation === life.current) setBusy(false) }
  }
  const read = async (item: InboxNotification) => {
    if (item.readAt) return
    const generation = life.current
    try { await api.call(API.markNotificationRead, { params: { id: item.id } }); if (generation === life.current) await load() }
    catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
  }
  // Phones: in the phone app, whether alerts reach this phone comes right after the title (it is what matters there); a
  // phone's browser has the inbox first (its push lines only say what it cannot do). No frames inside the Settings
  // card, and hints as large as the text they explain. The title itself is in the bar above on a phone
  // (SettingsDialog.tsx), so here it is for screen readers only.
  return <section className="flex flex-col gap-5" data-testid="notifications">
    <div className="max-md:order-first"><h2 className="text-base font-semibold max-md:sr-only">{t('notifications.title')}</h2><p className="mt-1 text-sm text-muted max-md:mt-0">{t('notifications.description')}</p></div>
    {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
    {!items && !error && <Skeleton lines={3} />}
    {/* the inbox comes first: it is what the sidebar's "Inbox" opens; the preferences follow below it */}
    {items && <div data-testid="notifications-inbox">
      <h3 className="mb-3 text-sm font-semibold">{t('inbox.title')} <span className="font-normal text-muted">· {t('notifications.unread', { count: unread })}</span></h3>
      {!items.length && <p className="text-sm text-muted">{t('notifications.empty')}</p>}
      <ul className="divide-y divide-line">{items.map(item => <li key={item.id} className="flex items-start gap-3 py-3" data-testid="notification-item">
        <div className="min-w-0 flex-1"><p className={`text-sm ${item.readAt ? 'text-muted' : 'font-medium'}`}>{item.code === 'room.dm' || item.code === 'room.mention' ? roomText(item, t) : item.code === 'dev_env.job' || item.code === 'dev_env.box' ? devEnvText(item, t) : item.code === 'onboarding.ai_request' && item.requester ? t('notifications.event.onboarding.ai_requestNamed', { name: item.requester.name }) : item.code === 'team.joined' ? (item.joined ? t('teamLink.joinedNotice', { name: item.joined.name }) : t('teamLink.joinedNoticeGone')) : item.code === 'onboarding.first_run' ? firstRunText(t, locale, item) : item.code === 'account.deletion_request' ? deletionNoticeText(t, item) : item.code === 'integration.request' && item.request ? t('notifications.event.integration.requestNamed', { name: item.request.name, host: item.request.host }) : item.code === 'drive.share_reconnect' && item.driveShare ? t('notifications.event.drive.share_reconnectNamed', { name: item.driveShare.name }) : item.template ? t(item.code === 'integration.template_reconnect' ? 'notifications.event.integration.template_reconnectNamed' : 'notifications.event.integration.templateNamed', { name: item.template.name }) : item.code === 'schedule.failure' && item.needsKey ? t('notifications.event.schedule.needsKey', { name: item.needsKey.name }) : t(item.code === 'schedule.failure' && item.review ? 'notifications.event.schedule.review' : item.code === 'schedule.failure' && item.outcome === 'problems' ? 'notifications.event.schedule.problems' : `notifications.event.${item.code}`)}</p><p className="mt-1 text-xs text-faint">{formatDateTime(item.createdAt, locale)}</p>
          {item.devEnv?.job?.exitCode === null && item.devEnv.job.note && <p className="mt-1 text-xs text-muted" data-testid="notification-job-note">{item.devEnv.job.note}</p>}
          {item.devEnv?.job?.tail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-faint" data-testid="notification-job-tail">{item.devEnv.job.tail}</pre>}
          {item.link === 'chat' && item.chatId && <Link className="text-sm text-accent-text hover:underline" to={`/c/${encodeURIComponent(item.chatId)}`} onClick={() => void read(item)}>{t(item.code === 'dev_env.job' ? 'notifications.openChat' : 'scheduled.openResult')}</Link>}
          {item.link === 'room' && item.room && <Link className="text-sm text-accent-text hover:underline" to={`/rooms/${encodeURIComponent(item.room.id)}`} onClick={() => void read(item)} data-testid="notification-room-link">{t('notifications.openRoom')}</Link>}
          {item.link === 'project' && item.devEnv && <Link className="text-sm text-accent-text hover:underline" to={`/projects/${encodeURIComponent(item.devEnv.projectId)}`} onClick={() => void read(item)}>{item.devEnv.projectName}</Link>}
          {item.review && <Link className="text-sm text-accent-text hover:underline" to="/scheduled" onClick={() => void read(item)} data-testid="notification-review-link">{t('settings.schedules')}</Link>}
          {item.link === 'connections' && <Link className="text-sm text-accent-text hover:underline" to="/settings/connectors?drive=1" onClick={() => void read(item)}>{t('drive.title')}</Link>}
          {item.link === 'integrations' && <Link className="text-sm text-accent-text hover:underline" to={integrationsLink(item)} onClick={() => void read(item)} data-testid={item.template || item.needsKey ? 'notification-template-link' : 'notification-request-link'}>{item.template || item.needsKey ? t('integrations.template.connectOwn') : t('integrations.title')}</Link>}
          {item.link === 'admin_connectors' && <Link className="text-sm text-accent-text hover:underline" to="/admin/connectors?drive=1" onClick={() => void read(item)} data-testid="notification-drive-share-link">{t('drive.title')}</Link>}
          {item.link === 'admin_credentials' && <Link className="text-sm text-accent-text hover:underline" to="/admin/providers" onClick={() => void read(item)} data-testid="notification-ai-request-link">{t('aiAccess.connectTeam')}</Link>}
          {item.code === 'team.joined' && <Link className="text-sm text-accent-text hover:underline" to="/admin/members" onClick={() => void read(item)} data-testid="notification-joined-link">{t('admin.members')}</Link>}
          {item.link === 'admin_members' && <Link className="text-sm text-accent-text hover:underline" to={`/admin/members?member=${encodeURIComponent(item.sourceId)}`} onClick={() => void read(item)} data-testid="notification-deletion-link">{t('admin.members')}</Link>}
          {item.link === 'skills' && <Link className="text-sm text-accent-text hover:underline" to={skillsLink(item)} onClick={() => void read(item)}>{t('skills.title')}</Link>}
        </div>
        {!item.readAt && <Button size="sm" onClick={() => void read(item)}>{t('notifications.markRead')}</Button>}
      </li>)}</ul>
      {cursor && <Button onClick={() => void load(cursor)}>{t('common.loadMore')}</Button>}
    </div>}
    {preferences && <fieldset disabled={busy} className="space-y-3 md:rounded-xl md:border md:border-line md:p-4"><legend className="text-sm font-medium md:px-1 max-md:mb-3">{t('notifications.preferences')}</legend>
      {/* a server from before a preference existed leaves it out: no box for it */}
      {preferenceKeys.filter(key => typeof preferences[key] === 'boolean').map(key => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences[key]} onChange={e => void update(key, e.target.checked)} data-testid={`notification-pref-${key}`} />{t(`notifications.${key}`)}</label>)}
      <p className="text-xs text-muted max-md:text-sm">{t('notifications.preferenceHint')}</p>
    </fieldset>}
    <div className={app ? 'max-md:-order-1' : undefined}><PushNotifications /></div>
  </section>
}
