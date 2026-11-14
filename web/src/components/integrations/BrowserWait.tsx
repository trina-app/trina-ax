// The line a connect flow shows while it waits for a sign-in in a browser window (Google, a service's sign-in page,
// Add to Slack, Sign in with Slack): what it waits for, and always Try again and Cancel (QA TC-1417: the window was
// closed before it finished and the page kept waiting with no way out). Try again starts the sign-in over (a new
// window; the server replaces the old flow), Cancel leaves it. A wait that lasts too long ends by itself
// (lib/signInWait.ts), and the line says so under a spinner (QA TC-2132: no sign it was working, no idea how long).
// `link`: the sign-in page as a link, where the browser refused the window opened for it.
import clsx from 'clsx'
import type { MouseEvent } from 'react'
import { useT } from '../../i18n'
import { SIGN_IN_WAIT_MINUTES } from '../../lib/signInWait'
import { Button, WaitLine } from '../ui'

export function BrowserWait({ text, onRetry, onCancel, busy, link, testId, retryTestId, cancelTestId, framed, className }: {
  text: string
  onRetry: () => void
  onCancel: () => void
  busy?: boolean
  link?: { href: string; label: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void } | null
  testId?: string
  retryTestId?: string
  cancelTestId?: string
  /** in a box of its own (a page's steps), not a row's line */
  framed?: boolean
  className?: string
}) {
  const t = useT()
  return (
    <div className={clsx('flex flex-wrap items-center gap-2 text-sm', framed && 'rounded-xl border border-line px-3 py-2', className)} data-testid={testId} data-waiting="">
      <WaitLine className="flex-[1_1_12rem] text-muted" text={text} hint={t('connect.wait.limit', { n: SIGN_IN_WAIT_MINUTES })} testId={testId ? `${testId}-line` : undefined} />
      {link && (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center" onClick={link.onClick} data-testid={testId ? `${testId}-link` : undefined}>
          {link.label}
        </a>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Button size="sm" variant="secondary" className="max-md:h-11" disabled={busy} onClick={onRetry} data-testid={retryTestId ?? (testId ? `${testId}-retry` : undefined)}>{t('common.retry')}</Button>
        <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={onCancel} data-testid={cancelTestId ?? (testId ? `${testId}-cancel` : undefined)}>{t('common.cancel')}</Button>
      </span>
    </div>
  )
}
