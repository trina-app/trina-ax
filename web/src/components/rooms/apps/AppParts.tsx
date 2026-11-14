// What an app's message looks like wherever it shows (docs/DECISIONS.md "Apps posting in rooms"): its letter tile in
// place of a face (letters, not vendor logos: owner decision 7), its name with the one "App" tag (SenderTag: the
// timeline, the thread, search, the rooms list), and its card. A card is plain text only: no Markdown, no HTML and no
// links found in its words, ever; its one link is the card's own checked https link (RoomAppCard.link), shown as
// "Open in Sentry ↗" (a button on a computer, a link on the status line on a phone). Names in it are the vendor's text,
// never a link to anyone's profile ("Resolved by Jun (unverified)" when the request was not signed: the server writes it).
// A quiet app's message (and the paused / turned-back-on lines) is one short line in the style of an event line.
import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import type { RoomAppCard, RoomAppKind, RoomAppRef } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import { Badge } from '../../ui'

/** The tile's letter: the vendor's first letter, an "Other" app's own name's (a dot when it has none). */
export function appLetter(kind: RoomAppKind, name: string): string {
  if (kind === 'sentry') return 'S'
  if (kind === 'github') return 'G'
  if (kind === 'google_forms') return 'F'
  const c = [...name.trim()][0]
  return c && /[\p{L}\p{N}]/u.test(c) ? c.toLocaleUpperCase() : '·'
}

/** An app's mark: a rounded square with its letter, the size of a person's picture where it stands (people are round,
 * apps square). Decorative: the name is always written beside it. */
export function AppTile({ kind, name, size = 32, className }: { kind: RoomAppKind; name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), fontSize: Math.round(size * 0.46) }}
      className={clsx('flex shrink-0 items-center justify-center bg-hover leading-none font-semibold text-ink select-none', className)}
      data-testid="app-tile"
      data-kind={kind}
    >
      {appLetter(kind, name)}
    </span>
  )
}

/** The tag beside an app's name: "App" (and "Example" on "Show an example"'s card). One component for every place a
 * sender is named. */
export function SenderTag({ example = false, className }: { example?: boolean; className?: string }) {
  const t = useT()
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 self-center', className)}>
      <Badge className="px-1 py-0 leading-4" >
        <span data-testid="app-tag">{t('roomApps.tag')}</span>
      </Badge>
      {example && <Badge tone="accent" className="px-1 py-0 leading-4"><span data-testid="app-example-tag">{t('roomApps.exampleTag')}</span></Badge>}
    </span>
  )
}

/** An app's name as a sender shows it: "Sentry", or "Sentry (removed)" once it was taken out of the room. */
export function useAppName(): (app: Pick<RoomAppRef, 'id' | 'name'>) => string {
  const t = useT()
  return (app) => (app.id ? app.name : t('roomApps.removedApp', { app: app.name }))
}

/** "Open in Sentry" / "Open link" (Other) for a card's link. */
function linkLabel(t: ReturnType<typeof useT>, kind: RoomAppKind, name: string): string {
  return kind === 'other' ? t('roomApps.openLink') : t('roomApps.openIn', { app: name })
}

/** One app card: its kind line, title, up to three detail lines, the status line and the one link. `reply`: a reply in
 * its thread, as short lines (the title and the first detail). Every field is text, never parsed for links. */
export function AppCardView({ app, card }: { app: Pick<RoomAppRef, 'kind' | 'name'>; card: RoomAppCard }) {
  const t = useT()
  const label = linkLabel(t, app.kind, app.name)
  const link = card.link
  return (
    <div className="mt-0.5 mb-0.5 max-w-[640px] min-w-0 border-l-2 border-line-strong py-0.5 pl-3 text-sm break-words select-text pointer-coarse:select-none" data-testid="app-card">
      {card.kind && <p className="text-xs text-muted" data-testid="app-card-kind">{card.kind}</p>}
      <p className="font-medium text-ink" data-testid="app-card-title">{card.title}</p>
      {card.details.map((d, i) => <p key={i} className="text-muted" data-testid="app-card-detail">{d}</p>)}
      {(card.status || link) && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {card.status && <p className="min-w-0 text-xs text-muted" data-testid="app-card-status">{card.status}</p>}
          {link && (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={link.host}
              // a computer: a small button at the line's end; a phone: a link on the status line (44 px tall to tap)
              className="touch-hit inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text hover:underline md:ml-auto md:rounded-md md:border md:border-field-border md:bg-surface md:px-2 md:py-1 md:text-ink md:hover:bg-hover md:hover:no-underline"
              data-testid="app-card-link"
            >
              {label}
              <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
      )}
    </div>
  )
}

/** A quiet app's message, the paused line and "turned back on" line: one short line, an event line's size, with the
 * card's link at its end. A thread opens from it like any message. */
export function AppQuietLine({ app, card }: { app: Pick<RoomAppRef, 'kind' | 'name'>; card: RoomAppCard }) {
  const t = useT()
  const text = [card.kind, card.title].filter(Boolean).join(': ')
  return (
    <p className="min-w-0 text-xs break-words text-muted select-text pointer-coarse:select-none" data-testid="app-quiet-line">
      <span>{text}</span>
      {card.link && (
        <>
          {' · '}
          <a href={card.link.url} target="_blank" rel="noopener noreferrer nofollow" title={card.link.host} className="touch-hit inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline" data-testid="app-card-link">
            {linkLabel(t, app.kind, app.name)}
            <ExternalLink size={11} aria-hidden />
          </a>
        </>
      )}
    </p>
  )
}

/** A reply from the app in its thread: short lines (the title, the first detail), with the status line when it has one. */
export function AppReplyLines({ card }: { card: RoomAppCard }) {
  return (
    <div className="min-w-0 text-sm break-words select-text pointer-coarse:select-none" data-testid="app-reply">
      <p className="text-ink">{card.title}</p>
      {card.details[0] && <p className="text-muted">{card.details[0]}</p>}
    </div>
  )
}
