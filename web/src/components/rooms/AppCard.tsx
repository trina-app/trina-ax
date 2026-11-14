// A message an app posted in a room (docs/DECISIONS.md "Apps posting in rooms"): its card as plain text. Its fields come
// from outside services (an error's title, a form answer, any text sent to the room's address), so nothing in them is
// read as Markdown or HTML and no address in them becomes a link; the card's one link (https, checked by the server)
// is the only one, shown by its host. One component for the timeline and the thread; phase 2 builds the full card
// (sender tag, status line on a phone) on top of it.
import type { RoomMessage } from '@mycel/shared/api'

export function AppCardText({ m, className }: { m: Pick<RoomMessage, 'appCard' | 'body'>; className?: string }) {
  const c = m.appCard
  if (!c) return null
  return (
    <div className={className} data-testid="room-app-card">
      {c.kind && <p className="text-xs text-faint">{c.kind}</p>}
      <p className="font-medium">{c.title}</p>
      {c.details.map((d, i) => <p key={i} className="text-faint">{d}</p>)}
      {(c.status || c.link) && (
        <p className="text-xs text-faint">
          {c.status}
          {c.status && c.link ? ' · ' : ''}
          {c.link && (
            <a href={c.link.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="underline hover:text-ink" data-testid="room-app-link">
              {c.link.host} ↗
            </a>
          )}
        </p>
      )}
    </div>
  )
}
