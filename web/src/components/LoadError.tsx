// A list or a section that could not be read (docs/DECISIONS.md "How we show errors"):
// - The connection (lib/api.ts isConnectionError): a calm notice on the neutral surface, "지금 연결이 안 돼요" and under
//   it "다시 연결하는 중…" with a small spinner, and [다시 시도]. It reads again by itself (lib/autoRetry.ts) and goes away
//   when a read works, so the data shows without a click. While the app's connection banner shows (Layout.tsx), or the
//   message box says its message was not sent for the connection (useSaysConnection), only a quiet spinner: one place
//   says it.
// - Anything else (the server answered with an error): the red ErrorNote as before, the server's words or `text`.
//   `soft`: a part that is extra on its page (Home's 「팀에 준비된 것」) gets the calm notice with "불러오지 못했어요"
//   instead, and does not read by itself.
// Red stays for real problems the person must act on and for destructive confirmations; a passing network blip is not one.
import clsx from 'clsx'
import { CircleAlert, Loader2, WifiOff } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import { errorText, isConnectionError } from '../lib/api'
import { useAutoRetry } from '../lib/autoRetry'
import { useLocale, useT } from '../i18n'
import { useUi } from '../store/ui'
import { Button, ErrorNote } from './ui'

/** How many lines on screen say the connection is down besides the banner (the message box's "not sent"). */
const useSaid = create<{ n: number }>(() => ({ n: 0 }))

/** A line that says the connection is down (the message box's "not sent"), while `on`: the notices of places that could
 * not be read step down to a quiet spinner, so the cause is said once. */
export function useSaysConnection(on: boolean) {
  useEffect(() => {
    if (!on) return
    useSaid.setState((s) => ({ n: s.n + 1 }))
    return () => useSaid.setState((s) => ({ n: s.n - 1 }))
  }, [on])
}

/** The calm notice: an icon, one plain sentence, a quiet second line, one secondary button. Neutral surface, never red. */
export function CalmNotice({ icon, title, detail, action, className, testId, state, what }: {
  icon: ReactNode
  title: ReactNode
  /** the quiet line under it ("다시 연결하는 중…") */
  detail?: ReactNode
  /** one secondary button ("다시 시도") */
  action?: ReactNode
  className?: string
  testId?: string
  state?: string
  what?: string
}) {
  return (
    <div role="status" className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm text-ink', className)} data-testid={testId} data-state={state} data-what={what}>
      {/* at least ~12rem for the words: in a narrow place (the sidebar, a phone) the button wraps below instead */}
      <span className="flex min-w-0 flex-[1_1_12rem] items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-muted" aria-hidden>{icon}</span>
        <span className="min-w-0">
          <span className="block text-balance">{title}</span>
          {detail && <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">{detail}</span>}
        </span>
      </span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  )
}

export interface LoadErrorProps {
  /** what failed (the thrown error, not its text) */
  error: unknown
  /** reads the place again; a place keeps its error until the answer, so the notice stays while it reads */
  onRetry: () => unknown
  /** the words for an error that is not the connection (default: the server's, errorText) */
  text?: ReactNode
  /** a part that is extra on its page: any failure is calm */
  soft?: boolean
  /** the place, for its tests (data-what) and for keeping the backoff when the notice is drawn again */
  what?: string
  className?: string
}

export function LoadError({ error, onRetry, text, soft, what, className }: LoadErrorProps) {
  const t = useT()
  const locale = useLocale()
  const connection = isConnectionError(error)
  const banner = useUi((s) => s.conn === 'reconnecting' || s.conn === 'offline')
  const saidElsewhere = useSaid((s) => s.n > 0)
  const { tryNow } = useAutoRetry(connection, onRetry, what)
  if (connection && (banner || saidElsewhere)) {
    // the banner on top (or the message box's line) says it; this place waits for the connection, quietly
    return (
      <div className={clsx('flex justify-center py-3', className)} data-testid="load-error" data-what={what} data-state="waiting">
        <Loader2 size={16} className="animate-spin text-faint" aria-hidden />
      </div>
    )
  }
  if (connection) {
    return (
      <CalmNotice
        className={className}
        testId="load-error"
        what={what}
        state="connection"
        icon={<WifiOff size={16} />}
        title={t('conn.now')}
        detail={<><Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />{t('conn.retrying')}</>}
        action={<Button size="sm" variant="secondary" onClick={tryNow} data-testid="load-error-retry">{t('common.retry')}</Button>}
      />
    )
  }
  if (soft) {
    return (
      <CalmNotice
        className={className}
        testId="load-error"
        what={what}
        state="failed"
        icon={<CircleAlert size={16} />}
        title={t('conn.loadFailed')}
        action={<Button size="sm" variant="secondary" onClick={() => void onRetry()} data-testid="load-error-retry">{t('common.retry')}</Button>}
      />
    )
  }
  return <ErrorNote onRetry={() => void onRetry()}>{text ?? errorText(error, locale, t('error.network'))}</ErrorNote>
}
