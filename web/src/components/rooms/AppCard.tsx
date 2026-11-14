// A message an app posted in a room (docs/DECISIONS.md "Apps posting in rooms"): its card as plain text. Its fields come
// from outside services (an error's title, a form answer, any text sent to the room's address), so nothing in them is
// read as Markdown or HTML and no address in them becomes a link; the card's one link (https, checked by the server)
// is the only one: "Open in Sentry ↗" ("Open link ↗" for Other), a small button at the status line's end on a
// computer, a link on the status line on a phone, its host as its tooltip. One component for the timeline, the thread
// and every other place a card shows. `variant`: 'card' (the whole card), 'reply' (a reply in its thread: short lines,
// the title and the first detail), 'quiet' (a Quiet app's message and the paused / turned-back-on lines: one short line
// in the style of an event line). Names in it are the vendor's text, never a link to anyone's profile ("Resolved by Jun
// (unverified)" when the request was not signed: the server writes it).
import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import type { RoomAppKind, RoomMessage } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { appPlainText } from '../../lib/roomApps'

export type AppCardVariant = 'card' | 'reply' | 'quiet'

function CardLink({ kind, name, link, small = false }: { kind: RoomAppKind; name: string; link: { url: string; host: string }; small?: boolean }) {
  const t = useT()
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      title={link.host}
      className={small
        ? 'touch-hit inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline'
        // a phone: a link on the status line; a computer: a small button at the line's end
        : 'touch-hit inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text hover:underline md:ml-auto md:rounded-md md:border md:border-field-border md:bg-surface md:px-2 md:py-1 md:text-ink md:hover:bg-hover md:hover:no-underline'}
      data-testid="room-app-link"
    >
      {kind === 'other' ? t('roomApps.openLink') : t('roomApps.openIn', { app: name })}
      <ExternalLink size={small ? 11 : 12} aria-hidden />
    </a>
  )
}

export function AppCardText({ m, variant = 'card', className }: { m: Pick<RoomMessage, 'app' | 'appCard' | 'body'>; variant?: AppCardVariant; className?: string }) {
  const c = m.appCard
  const app = m.app
  // no card this build reads: its plain words
  if (!c || !app) return <p className={clsx('break-words whitespace-pre-wrap text-ink', className)} data-testid="room-app-card">{appPlainText(m)}</p>
  if (variant === 'quiet') {
    return (
      <p className={clsx('min-w-0 text-xs break-words text-muted', className)} data-testid="app-quiet-line">
        <span>{[c.kind, c.title].filter(Boolean).join(': ')}</span>
        {c.link && <>{' · '}<CardLink kind={app.kind} name={app.name} link={c.link} small /></>}
      </p>
    )
  }
  if (variant === 'reply') {
    return (
      <div className={clsx('min-w-0 text-sm break-words', className)} data-testid="app-reply">
        <p className="text-ink">{c.title}</p>
        {c.details[0] && <p className="text-muted">{c.details[0]}</p>}
      </div>
    )
  }
  return (
    <div className={clsx('mt-0.5 mb-0.5 max-w-[640px] min-w-0 border-l-2 border-line-strong py-0.5 pl-3 text-sm break-words', className)} data-testid="room-app-card">
      {c.kind && <p className="text-xs text-muted" data-testid="app-card-kind">{c.kind}</p>}
      <p className="font-medium text-ink" data-testid="app-card-title">{c.title}</p>
      {c.details.map((d, i) => <p key={i} className="text-muted" data-testid="app-card-detail">{d}</p>)}
      {(c.status || c.link) && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {c.status && <p className="min-w-0 text-xs text-muted" data-testid="app-card-status">{c.status}</p>}
          {c.link && <CardLink kind={app.kind} name={app.name} link={c.link} />}
        </div>
      )}
    </div>
  )
}
