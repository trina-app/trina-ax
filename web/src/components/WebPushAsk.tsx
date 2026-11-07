// The web ask (lib/push-ask.ts): one quiet line with a hairline, no box. On a computer at the top of the main column, on
// a phone browser above the tab bar (Layout.tsx mounts it in both places; each shows at its own width). Not inside a room
// or an AI chat on a phone (their message box needs the bottom), and not on Settings › Notifications, whose row is the
// same switch. A failed [알림 켜기] says why in the line, with the way to Settings › Notifications.
import clsx from 'clsx'
import { Bell } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useLocale, useT } from '../i18n'
import { notificationPermission } from '../lib/push'
import { prepareWebPushAsk, turnOnWebPush, useWebPushAsk, webPushAskLater } from '../lib/push-ask'
import { useRealPath } from '../lib/realPath'
import { hidesTabs } from '../lib/tabs'
import { isAdmin, useMe } from '../store/session'
import { toast } from '../store/ui'
import { pushFailureText } from './settings/PushNotifications'
import { Button } from './ui'

export function WebPushAsk({ at }: { at: 'top' | 'bottom' }) {
  const t = useT(), locale = useLocale()
  const me = useMe()
  const path = useRealPath()
  const { show, busy, failure } = useWebPushAsk()
  const key = me && !me.user.mustChangePassword ? `${me.user.id}:${me.session.id}` : null
  // one of the two places prepares (the store keeps one answer per session)
  useEffect(() => { if (at === 'top') void prepareWebPushAsk(key) }, [at, key])
  // the browser may have been answered meanwhile (Settings, another tab); a reason stays until [나중에]
  if (!show || (!failure && notificationPermission() !== 'default')) return null
  if (path.startsWith('/settings/notifications') || (at === 'bottom' && hidesTabs(path))) return null
  const turnOn = async () => {
    if (await turnOnWebPush() === 'on') toast({ level: 'success', text: t('push.askOn') })
  }
  const reason = failure && pushFailureText(failure, t, locale, { admin: isAdmin(me) })
  return (
    <div
      role="region"
      aria-label={t('push.title')}
      className={clsx('flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-canvas px-4 py-1.5 text-sm', at === 'top' ? 'border-b border-line max-md:hidden' : 'border-t border-line md:hidden')}
      data-testid={`web-push-ask-${at}`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Bell size={16} className={clsx('mt-0.5 shrink-0', reason ? 'text-danger' : 'text-muted')} aria-hidden />
        <span className={clsx('min-w-0', reason ? 'text-ink' : 'text-muted')} role={reason ? 'alert' : undefined} data-testid="web-push-ask-text">
          {reason ? <>{reason}{' '}<Link to="/settings/notifications" className="whitespace-nowrap text-accent-text underline">{t('settings.title')} › {t('notifications.title')}</Link></> : t('push.askWeb')}
        </span>
      </span>
      {/* right after the words, as one sentence: "새 메시지 알림을 받으려면 [알림 켜기] · [나중에]" */}
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" busy={busy} onClick={() => void turnOn()} data-testid="web-push-on">{t('push.turnOn')}</Button>
        <span aria-hidden className="text-faint">·</span>
        <Button size="sm" variant="ghost" onClick={() => webPushAskLater()} data-testid="web-push-later">{t('push.later')}</Button>
      </span>
    </div>
  )
}
