// What an app's message looks like wherever it shows (docs/DECISIONS.md "Apps posting in rooms"): its mark in place of a
// face (AppTile), its name with the one "App" tag (SenderTag: the timeline, the thread, search). The card itself is
// components/rooms/AppCard.tsx (plain text, its one checked link).
import clsx from 'clsx'
import { Blocks, ClipboardList } from 'lucide-react'
import type { RoomAppKind, RoomAppRef } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import { Badge } from '../../ui'

/** The services' own marks, one colour, served from this server (web/public/icons/room-apps; sources and terms in
 * docs/THIRD-PARTY-NOTICES.md), drawn in the text colour through a CSS mask so they read in light and dark (black or
 * white is what GitHub's and Sentry's guidelines allow). Google Forms has none: Google asks for permission before its
 * product icons are used, so it gets a plain form icon, as Other gets a plain app icon. */
export const APP_LOGOS: Partial<Record<RoomAppKind, string>> = { sentry: '/icons/room-apps/sentry.svg', github: '/icons/room-apps/github.svg' }

/** The sizes an app's mark comes in: beside a dialog's title, in a list row, as a sender's face (a person's picture). */
export const APP_TILE_SIZES = { title: 24, row: 28, face: 32 } as const
export type AppTileSize = keyof typeof APP_TILE_SIZES

/** An app's mark: a rounded square (people are round, apps square) with the service's mark, or a plain icon for Google
 * Forms and Other apps. Decorative: the name is always written beside it. One component for the picker, the list, the
 * settings' title, the timeline and search. */
export function AppTile({ kind, size = 'face', className }: { kind: RoomAppKind; size?: AppTileSize; className?: string }) {
  const px = APP_TILE_SIZES[size]
  const mark = Math.round(px * 0.56)
  const logo = APP_LOGOS[kind]
  const Icon = kind === 'google_forms' ? ClipboardList : Blocks
  const mask = logo ? `url(${logo}) center / contain no-repeat` : undefined
  return (
    <span
      aria-hidden
      style={{ width: px, height: px, borderRadius: Math.round(px * 0.28) }}
      className={clsx('flex shrink-0 items-center justify-center bg-hover text-ink select-none', className)}
      data-testid="app-tile"
      data-kind={kind}
    >
      {logo
        ? <span className="block bg-current" style={{ width: mark, height: mark, mask, WebkitMask: mask }} data-testid="app-logo" />
        : <Icon size={mark} strokeWidth={1.75} />}
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
      {example && <Badge className="px-1 py-0 leading-4"><span data-testid="app-example-tag">{t('roomApps.exampleTag')}</span></Badge>}
    </span>
  )
}

/** An app's name as a sender shows it: "Sentry", or "Sentry (removed)" once it was taken out of the room. */
export function useAppName(): (app: Pick<RoomAppRef, 'id' | 'name'>) => string {
  const t = useT()
  return (app) => (app.id ? app.name : t('roomApps.removedApp', { app: app.name }))
}
