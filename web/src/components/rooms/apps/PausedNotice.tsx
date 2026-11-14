// The "app paused" notice in Activity (notifications 'room_app.paused', docs/DECISIONS.md "Apps posting in rooms";
// plan screen 6): "Sign-up form paused in #sales · It reached 500 messages today. 37 more were skipped and won't
// appear. It starts again tomorrow." with [Resume now] (once a day, while it is still paused and I manage it) and
// [Open settings] (the room with the app's settings open: /rooms/<room>?apps=<app>). "Tomorrow" is the team's midnight;
// when that is not midnight where the reader is, the time is said instead. When the team's cap paused it (QA TC-2067):
// "Your team's apps reached 5,000 messages today. All apps are paused until Nov 16, 00:00." in the team's time zone,
// and no Resume now (it could not help before the team's midnight).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { InboxNotification, Locale } from '@mycel/shared/api'
import { api, API, errorText } from '../../../lib/api'
import { limitResetText } from '@mycel/shared'
import { formatNumber, intlTag } from '../../../lib/format'
import { useLocale, useT } from '../../../i18n'
import { toast } from '../../../store/ui'
import { Button } from '../../ui'

type Paused = NonNullable<InboxNotification['roomApp']>
type T = ReturnType<typeof useT>

/** The time the pause ends, when that is not midnight in the reader's time zone (else null: "tomorrow" says it). */
export function startsAtTime(until: string | null, locale: Locale, timeZone?: string): string | null {
  if (!until) return null
  const d = new Date(until)
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(d)
  if (parts === '00:00') return null
  return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short', timeZone }).format(d)
}

export function pausedNoticeText(p: Paused, t: T, locale: Locale): string {
  const title = p.roomName ? t('roomApps.pausedTitle', { app: p.name, room: p.roomKind === 'team' ? `#${p.roomName}` : p.roomName }) : t('roomApps.pausedTitleNoRoom', { app: p.name })
  const cap = formatNumber(p.cap, locale)
  const skipped = formatNumber(p.skipped, locale)
  if (p.team) return `${title}. ${p.pausedUntil ? t('roomApps.pausedBodyTeam', { cap, time: limitResetText(new Date(p.pausedUntil), locale, p.timeZone) }) : t('roomApps.pausedBodyTeamEnded', { cap })}`
  const at = startsAtTime(p.pausedUntil, locale)
  // Google Forms counts responses, and the ones it skipped are still in the form
  const forms = p.kind === 'google_forms'
  const body = forms
    ? (at ? t('roomApps.pausedBodyFormsAt', { cap, skipped, time: at }) : t('roomApps.pausedBodyForms', { cap, skipped }))
    : at ? t('roomApps.pausedBodyAt', { cap, skipped, time: at }) : t('roomApps.pausedBody', { cap, skipped })
  return `${title}. ${body}`
}

/** Where the row opens: the app's settings in its room, while I am in it. */
export const pausedNoticeLink = (p: Paused | undefined) => (p?.roomId ? `/rooms/${encodeURIComponent(p.roomId)}?apps=${encodeURIComponent(p.appId)}` : null)

/** Under the row: Resume now (when it can be) and Open settings. */
export function PausedNoticeExtras({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const p = item.roomApp
  const [busy, setBusy] = useState(false)
  if (!p?.roomId) return null
  const resume = async () => {
    setBusy(true)
    try {
      await api.call(API.resumeRoomApp, { params: { id: p.roomId!, appId: p.appId } })
      toast({ level: 'success', text: t('roomApps.resumed', { app: p.name }) })
      onRead()
      onChanged()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  const settings = pausedNoticeLink(p)!
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="notification-room-app">
      {p.canResume && !p.team && p.pausedUntil && <Button size="sm" variant="primary" busy={busy} onClick={() => void resume()} data-testid="notification-room-app-resume">{t('roomApps.resumeNow')}</Button>}
      <Link to={settings} onClick={onRead} className="inline-flex h-8 items-center rounded-lg border border-field-border bg-surface px-3 text-sm font-medium text-ink hover:bg-hover max-md:h-11" data-testid="notification-room-app-settings">{t('roomApps.openSettings')}</Link>
    </div>
  )
}

// The "someone who left knows the address" notice (notifications 'room_app.leaver'): "Someone who left knows the address
// of Sentry · Get a new address", the link opening the app's settings in its room (where "Get a new address" is).
type Leaver = NonNullable<InboxNotification['roomAppLeaver']>
export const leaverNoticeText = (l: Leaver, t: T) => t('roomApps.leaverNotice', { app: l.name })
export const leaverNoticeLink = (l: Leaver | undefined) => (l?.roomId ? `/rooms/${encodeURIComponent(l.roomId)}?apps=${encodeURIComponent(l.appId)}` : null)
export function LeaverNoticeExtras({ item, onRead }: { item: InboxNotification; onRead: () => void }) {
  const t = useT()
  const to = leaverNoticeLink(item.roomAppLeaver)
  if (!to) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="notification-room-app-leaver">
      <Link to={to} onClick={onRead} className="inline-flex h-8 items-center rounded-lg border border-field-border bg-surface px-3 text-sm font-medium text-ink hover:bg-hover max-md:h-11" data-testid="notification-room-app-new-address">{t('roomApps.newAddress')}</Link>
    </div>
  )
}
