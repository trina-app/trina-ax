// The one card frame for what the AI did for the person (docs/decisions/20261116-ai-share-card-and-stop.md): a share, a
// stop, a post to a room. A headline in the past tense, rows (a file with its place in words, people with their faces),
// plain lines under them, and at most one button at its end. The confirmation card of the same action (AskCard.tsx) has
// the same box (radius, padding, where the buttons sit), so answering it reads as the card turning into its result where
// it is. Everything shown comes from the server's record, never from the AI's words.
import clsx from 'clsx'
import type { ReactNode } from 'react'

/** the box both the confirmation card and the result card use */
export const actionCardBox = 'my-3 rounded-2xl border px-4 py-3'

export function ActionCard({ title, children, footer, label, testId = 'action-card', state, kind }: {
  /** the headline: what was done, in the past tense */
  title: ReactNode
  children?: ReactNode
  /** the card's one button (and an error beside it) */
  footer?: ReactNode
  /** the card's name for a screen reader (the headline's words) */
  label: string
  testId?: string
  state?: string
  kind?: string
}) {
  return (
    <div className={clsx(actionCardBox, 'border-line')} role="group" aria-label={label} data-testid={testId} data-state={state} data-kind={kind}>
      <p className="text-sm font-medium break-keep [overflow-wrap:anywhere]" data-testid="action-card-title">{title}</p>
      {children}
      {footer ? <div className="mt-3 flex flex-wrap items-center justify-end gap-2" data-testid="action-card-footer">{footer}</div> : null}
    </div>
  )
}

/** The card's rows (ListRow inside: its own padding lines up with the card's text) */
export function ActionRows({ children, testId }: { children: ReactNode; testId?: string }) {
  return <ul className="-mx-3 mt-1.5" data-testid={testId}>{children}</ul>
}

/** A plain line under the rows: who was told, who can still open it, why it could not be done */
export function ActionNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="mt-1.5 text-sm break-keep text-muted [overflow-wrap:anywhere]" data-testid={testId}>{children}</p>
}
