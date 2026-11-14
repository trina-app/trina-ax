// What an app's message looks like wherever it shows (docs/DECISIONS.md "Apps posting in rooms"): its letter tile in
// place of a face (letters, not vendor logos: owner decision 7), its name with the one "App" tag (SenderTag: the
// timeline, the thread, search). The card itself is components/rooms/AppCard.tsx (plain text, its one checked link).
import clsx from 'clsx'
import type { RoomAppKind, RoomAppRef } from '@mycel/shared/api'
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
