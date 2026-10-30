import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { InboxNotification, NotificationPreferences } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { accessChanged, notificationsChanged, reloadAsked } from '../../store/live'
import { Button, ErrorNote, Skeleton } from '../ui'
import { PushNotifications } from './PushNotifications'

const preferenceKeys = ['scheduleSuccess', 'scheduleFailure', 'connectionReconnect', 'skillSuggestions'] as const

/** A suggestion to review opens in the review tab, an own result in "my suggestions" (the Skills screen checks access). */
export const skillsLink = (item: Pick<InboxNotification, 'code' | 'sourceId'>) => `/skills?${item.code === 'skill.suggested' ? 'review' : 'mine'}=${encodeURIComponent(item.sourceId)}`

export function Notifications() {
  const t = useT(), locale = useLocale()
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
  return <section className="space-y-5" data-testid="notifications">
    <div><h2 className="text-base font-semibold">{t('notifications.title')}</h2><p className="mt-1 text-sm text-muted">{t('notifications.description')}</p></div>
    {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
    {!items && !error && <Skeleton lines={3} />}
    {preferences && <fieldset disabled={busy} className="space-y-3 rounded-xl border border-line p-4"><legend className="px-1 text-sm font-medium">{t('notifications.preferences')}</legend>
      {preferenceKeys.map(key => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences[key]} onChange={e => void update(key, e.target.checked)} data-testid={`notification-pref-${key}`} />{t(`notifications.${key}`)}</label>)}
      <p className="text-xs text-muted">{t('notifications.preferenceHint')}</p>
    </fieldset>}
    <PushNotifications />
    {items && <div>
      <h3 className="mb-3 text-sm font-semibold">{t('notifications.unread', { count: unread })}</h3>
      {!items.length && <p className="text-sm text-muted">{t('notifications.empty')}</p>}
      <ul className="divide-y divide-line">{items.map(item => <li key={item.id} className="flex items-start gap-3 py-3" data-testid="notification-item">
        <div className="min-w-0 flex-1"><p className={`text-sm ${item.readAt ? 'text-muted' : 'font-medium'}`}>{t(item.code === 'schedule.failure' && item.review ? 'notifications.event.schedule.review' : item.code === 'schedule.failure' && item.outcome === 'problems' ? 'notifications.event.schedule.problems' : `notifications.event.${item.code}`)}</p><p className="mt-1 text-xs text-faint">{formatDateTime(item.createdAt, locale)}</p>
          {item.link === 'chat' && item.chatId && <Link className="text-sm text-accent-text hover:underline" to={`/c/${encodeURIComponent(item.chatId)}`} onClick={() => void read(item)}>{t('schedules.lastRun')}</Link>}
          {item.review && <Link className="text-sm text-accent-text hover:underline" to="/settings/schedules" onClick={() => void read(item)} data-testid="notification-review-link">{t('settings.schedules')}</Link>}
          {item.link === 'connections' && <Link className="text-sm text-accent-text hover:underline" to="/settings/drive" onClick={() => void read(item)}>{t('drive.title')}</Link>}
          {item.link === 'skills' && <Link className="text-sm text-accent-text hover:underline" to={skillsLink(item)} onClick={() => void read(item)}>{t('skills.title')}</Link>}
        </div>
        {!item.readAt && <Button size="sm" onClick={() => void read(item)}>{t('notifications.markRead')}</Button>}
      </li>)}</ul>
      {cursor && <Button onClick={() => void load(cursor)}>{t('common.loadMore')}</Button>}
    </div>}
  </section>
}
