// The web ask (lib/push-ask.ts): one quiet line with a hairline, no box. On a computer at the top of the main column, on
// a phone browser above the tab bar (Layout.tsx mounts it in both places; each shows at its own width). Not inside a room
// or an AI chat on a phone (their message box needs the bottom), and not on Settings › Notifications, whose row is the
// same switch. It first shows on the page after the one where it became ready, so it never moves the page in front of
// the person. A failed [알림 켜기] says why in the line, with the way to Settings › Notifications; the words sit in one
// live region that is always there, so a screen reader hears the reason when it replaces the question. The buttons stay
// focusable while it works (aria-busy, not disabled), and when the line goes away under the keyboard's focus, the focus
// moves to the page (#main) instead of being lost.
import clsx from 'clsx'
import { Bell, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useLocale, useT } from '../i18n'
import { notificationPermission } from '../lib/push'
import { noteWebPushAskPath, prepareWebPushAsk, turnOnWebPush, useWebPushAsk, webPushAskLater } from '../lib/push-ask'
import { useRealPath } from '../lib/realPath'
import { hidesTabs } from '../lib/tabs'
import { isAdmin, useMe } from '../store/session'
import { toast } from '../store/ui'
import { pushFailureText } from './settings/PushNotifications'
import { Button } from './ui'

/** The line held the focus and is going: give it to the page, not to nowhere. */
function focusPage(line: HTMLElement | null, hadFocus: boolean) {
  if (typeof document === 'undefined') return
  const now = document.activeElement
  // only when the focus is still the line's (or fell to the body with it): never take it from where the person moved it
  if (hadFocus && (!now || now === document.body || !now.isConnected || !!line?.contains(now))) document.getElementById('main')?.focus({ preventScroll: true })
}

export function WebPushAsk({ at }: { at: 'top' | 'bottom' }) {
  const t = useT(), locale = useLocale()
  const me = useMe()
  const path = useRealPath()
  const { show, revealed, busy, failure } = useWebPushAsk()
  const line = useRef<HTMLDivElement>(null)
  const key = me && !me.user.mustChangePassword ? `${me.user.id}:${me.session.id}` : null
  // one of the two places prepares and follows the pages (the store keeps one answer per session)
  useEffect(() => { if (at === 'top') void prepareWebPushAsk(key) }, [at, key])
  useEffect(() => { if (at === 'top') noteWebPushAskPath(path) }, [at, path, show])
  // the browser may have been answered elsewhere (Settings, another tab); not while this line's own turn-on runs (the
  // answer comes before the subscription), and a reason stays until [나중에]
  if (!show || !revealed || (!busy && !failure && notificationPermission() !== 'default')) return null
  if (path.startsWith('/settings/notifications') || (at === 'bottom' && hidesTabs(path))) return null
  const holdsFocus = () => !!line.current?.contains(document.activeElement)
  const turnOn = async () => {
    const hadFocus = holdsFocus()
    const done = await turnOnWebPush()
    if (done === 'on') toast({ level: 'success', text: t('push.askOn') })
    if (done === 'on' || done === 'blocked') focusPage(line.current, hadFocus)
  }
  const later = () => {
    const hadFocus = holdsFocus()
    focusPage(line.current, hadFocus)
    webPushAskLater()
  }
  const reason = failure && pushFailureText(failure, t, locale, { admin: isAdmin(me) })
  return (
    <div
      ref={line}
      role="region"
      aria-label={t('push.title')}
      className={clsx('flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-canvas px-4 py-1.5 text-sm', at === 'top' ? 'border-b border-line max-md:hidden' : 'border-t border-line md:hidden in-[.keyboard-open]:hidden')}
      data-testid={`web-push-ask-${at}`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Bell size={16} className={clsx('mt-0.5 shrink-0', reason ? 'text-danger' : 'text-muted')} aria-hidden />
        <span className={clsx('min-w-0', reason ? 'text-ink' : 'text-muted')} role="status" data-testid="web-push-ask-text" data-reason={failure?.kind}>
          {reason ? <>{reason}{' '}<Link to="/settings/notifications" className="whitespace-nowrap text-accent-text underline">{t('settings.title')} › {t('notifications.title')}</Link></> : t('push.askWeb')}
        </span>
      </span>
      {/* right after the words, as one sentence: "새 메시지 알림을 받으려면 [알림 켜기] · [나중에]" */}
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" aria-busy={busy || undefined} onClick={() => { if (!busy) void turnOn() }} data-testid="web-push-on">
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t('push.turnOn')}
        </Button>
        <span aria-hidden className="text-faint">·</span>
        <Button size="sm" variant="ghost" onClick={later} data-testid="web-push-later">{t('push.later')}</Button>
      </span>
    </div>
  )
}
