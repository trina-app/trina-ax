// Settings › Notifications › 대화 (docs/DECISIONS.md "대화방 알림 설정"): what in the team's conversations alerts me. My
// default for rooms without a level of their own (알림 받을 메시지), replies in threads I follow, quiet hours (방해 금지 시간,
// in the team's time zone) and the rooms I turned off, with each one's level to change back. Each room's own level is
// on its bell (components/rooms/RoomNotifyMenu.tsx). The rule is the server's and the sound's (shared room-alerts.ts).
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NotificationPreferences, QuietHours, RoomNotifyDefault, RoomNotifyLevel } from '@mycel/shared/api'
import { QUIET_HOURS_DEFAULT } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { inputCls, Switch } from '../ui'
import { RoomIcon, useRoomTitle } from '../rooms/RoomIcon'
import { roomNotify } from '../rooms/RoomNotifyMenu'
import { PrefRow, PrefSection } from './PrefRows'

const LEVELS: readonly RoomNotifyDefault[] = ['direct', 'all', 'none']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function RoomNotifySettings({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (patch: Partial<NotificationPreferences>) => void }) {
  const t = useT()
  // an older server knows one switch for rooms
  if (!prefs.roomLevel) {
    if (typeof prefs.roomMessages !== 'boolean') return null
    return (
      <PrefSection title={t('notifications.section.rooms')} testId="notifications-rooms">
        <PrefRow id="np-room-messages" title={t('notifications.roomMessages')}
          control={<Switch id="np-room-messages" external checked={prefs.roomMessages} onChange={(v) => onChange({ roomMessages: v })} label={t('notifications.roomMessages')} testId="notification-pref-roomMessages" />} />
      </PrefSection>
    )
  }
  return (
    <PrefSection title={t('notifications.section.rooms')} testId="notifications-rooms">
      <div className="py-3.5" data-testid="notification-room-level">
        <p id="np-room-level" className="text-sm font-medium text-ink">{t('notifications.roomLevel')}</p>
        <p id="np-room-level-desc" className="mt-0.5 text-sm text-muted">{t('notifications.roomLevelDesc')}</p>
        <div role="radiogroup" aria-labelledby="np-room-level" aria-describedby="np-room-level-desc" className="mt-2 flex flex-col">
          {LEVELS.map((l) => (
            <label key={l} className="flex min-h-8 items-center gap-2.5 text-sm max-md:min-h-10">
              <input type="radio" name="np-room-level" value={l} checked={prefs.roomLevel === l} onChange={() => onChange({ roomLevel: l })} className="size-4 shrink-0" data-testid={`notification-room-level-${l}`} />
              {t(`notifications.roomLevel.${l}`)}
            </label>
          ))}
        </div>
      </div>
      <PrefRow id="np-thread-replies" title={t('notifications.roomThreadReplies')} desc={t('notifications.roomThreadRepliesDesc')}
        control={<Switch id="np-thread-replies" external describedBy="np-thread-replies-desc" checked={prefs.roomThreadReplies !== false} onChange={(v) => onChange({ roomThreadReplies: v })} label={t('notifications.roomThreadReplies')} testId="notification-thread-replies" />} />
      <QuietHoursRow quiet={prefs.quietHours ?? QUIET_HOURS_DEFAULT} onChange={(quietHours) => onChange({ quietHours })} />
      <MutedRooms />
    </PrefSection>
  )
}

/** On/off, then from–to (across midnight when the end comes first) and all of the weekend; saved as soon as a time is
 * whole and the two differ. */
function QuietHoursRow({ quiet, onChange }: { quiet: QuietHours; onChange: (q: QuietHours) => void }) {
  const t = useT()
  const tz = useMeStrict().server.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const [start, setStart] = useState(quiet.start), [end, setEnd] = useState(quiet.end)
  useEffect(() => { setStart(quiet.start); setEnd(quiet.end) }, [quiet.start, quiet.end])
  const same = start === end
  const time = (which: 'start' | 'end', v: string) => {
    if (which === 'start') setStart(v)
    else setEnd(v)
    const next = { ...quiet, start: which === 'start' ? v : start, end: which === 'end' ? v : end }
    if (HHMM.test(next.start) && HHMM.test(next.end) && next.start !== next.end) onChange(next)
  }
  return (
    <PrefRow id="np-quiet" title={t('notifications.quiet')} desc={t('notifications.quietDesc', { tz })} testId="notification-quiet-row" attrs={{ 'data-on': quiet.on ? 'true' : 'false' }}
      control={<Switch id="np-quiet" external describedBy="np-quiet-desc" checked={quiet.on} onChange={(on) => onChange({ ...quiet, on })} label={t('notifications.quiet')} testId="notification-quiet" />}
      below={quiet.on && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <span className="inline-flex items-center gap-2">
            <input type="time" required aria-label={t('notifications.quietFrom')} className={clsx(inputCls, 'w-32 tabular-nums')} value={start} onChange={(e) => time('start', e.target.value)} aria-invalid={same || undefined} data-testid="notification-quiet-start" />
            <span aria-hidden className="text-muted">–</span>
            <input type="time" required aria-label={t('notifications.quietTo')} className={clsx(inputCls, 'w-32 tabular-nums')} value={end} onChange={(e) => time('end', e.target.value)} aria-invalid={same || undefined} data-testid="notification-quiet-end" />
          </span>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={quiet.weekends} onChange={(e) => onChange({ ...quiet, weekends: e.target.checked })} data-testid="notification-quiet-weekends" />
            {t('notifications.quietWeekends')}
          </label>
          {same && <p role="alert" className="basis-full text-sm text-danger">{t('notifications.quietBad')}</p>}
        </div>
      )} />
  )
}

/** The rooms I turned off (끄기), each with its level to change back. A room changed here stays in the list until the
 * page is left, so nothing jumps under the pointer. */
function MutedRooms() {
  const t = useT(), locale = useLocale()
  const rooms = useRooms((s) => s.rooms)
  const title = useRoomTitle()
  useEffect(() => { if (!useRooms.getState().loaded) void useRooms.getState().loadRooms() }, [])
  const touched = useRef(new Set<string>())
  const [, bump] = useState(0)
  const off = useMemo(() => rooms.filter((r) => roomNotify(r).own === 'off'), [rooms])
  const shown = rooms.filter((r) => roomNotify(r).own === 'off' || touched.current.has(r.id))
  if (!shown.length) return null
  const set = async (roomId: string, level: RoomNotifyLevel | null) => {
    touched.current.add(roomId)
    bump((n) => n + 1)
    try { await useRooms.getState().setNotifyLevel(roomId, level) }
    catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  return (
    <div className="py-3.5" data-testid="notification-muted-rooms">
      <p className="text-sm font-medium text-ink">{t('notifications.mutedRooms', { count: off.length })}</p>
      <p className="mt-0.5 text-sm text-muted">{t('notifications.mutedRoomsDesc')}</p>
      <ul className="mt-2 divide-y divide-line">
        {shown.map((r) => {
          const n = roomNotify(r), id = `np-room-${r.id}`
          return (
            <li key={r.id} className="flex items-center gap-3 py-2" data-testid="notification-muted-room">
              <RoomIcon room={r} size={24} />
              <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">{title(r)}</label>
              <select id={id} className={clsx(inputCls, 'w-auto max-w-[11rem] shrink-0')} value={n.own ?? 'default'} onChange={(e) => void set(r.id, e.target.value === 'default' ? null : (e.target.value as RoomNotifyLevel))} data-testid="notification-muted-room-level">
                <option value="default">{t('rooms.notify.default')} · {t(`rooms.notify.${n.byDefault}`)}</option>
                <option value="all">{t('rooms.notify.all')}</option>
                <option value="mentions">{t('rooms.notify.mentions')}</option>
                <option value="off">{t('rooms.notify.off')}</option>
              </select>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
