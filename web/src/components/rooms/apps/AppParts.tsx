// What an app's message looks like wherever it shows (docs/DECISIONS.md "Apps posting in rooms"): its mark in place of a
// face (AppTile), its name with the one "App" tag (SenderTag: the timeline, the thread, search). The card itself is
// components/rooms/AppCard.tsx (plain text, its one checked link).
import clsx from 'clsx'
import { Blocks, ClipboardList } from 'lucide-react'
import type { RoomAppRef } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import type { AppService } from '../../../lib/roomApps'
import { Badge } from '../../ui'

/** The services' own marks, one colour, served from this server (web/public/icons/room-apps; sources and terms in
 * docs/THIRD-PARTY-NOTICES.md), drawn through a CSS mask in the text colour so they read in light and dark (black or
 * white is what their guidelines allow). Stripe's guidelines name its colours (blurple on light, white on dark), so its
 * mark is drawn in those. Google Forms has none: Google asks for permission before its product icons are used, so it
 * gets a plain form icon, as Other gets a plain app icon. Shopify (written permission first), Tally and Jotform (no
 * mark we may copy) and Typeform (its only one-colour file is the wordmark, unreadable at this size) get their initials
 * on the same tile. */
export const APP_LOGOS: Partial<Record<AppService, string>> = {
  sentry: '/icons/room-apps/sentry.svg',
  github: '/icons/room-apps/github.svg',
  notion: '/icons/room-apps/notion.svg',
  zendesk: '/icons/room-apps/zendesk.svg',
  stripe: '/icons/room-apps/stripe.svg',
}
/** A mark drawn in its brand's colours instead of the text colour (light, dark). */
const LOGO_TINT: Partial<Record<AppService, string>> = { stripe: 'text-[#635BFF] dark:text-white' }
/** The services shown by their initial: no mark we may use. */
export const APP_INITIALS: Partial<Record<AppService, string>> = { shopify: 'S', typeform: 'Tf', tally: 'T', jotform: 'J' }

/** The sizes an app's mark comes in: beside a dialog's title, in a list row, as a sender's face (a person's picture). */
export const APP_TILE_SIZES = { title: 24, row: 28, face: 32 } as const
export type AppTileSize = keyof typeof APP_TILE_SIZES

/** An app's mark: a rounded square (people are round, apps square) with the service's mark, its initial, or a plain icon
 * for Google Forms and Other apps. Decorative: the name is always written beside it. One component for the picker, the
 * list, the settings' title, the timeline and search. */
export function AppTile({ service, size = 'face', className }: { service: AppService; size?: AppTileSize; className?: string }) {
  const px = APP_TILE_SIZES[size]
  const mark = Math.round(px * 0.56)
  const logo = APP_LOGOS[service]
  const initial = APP_INITIALS[service]
  const Icon = service === 'google_forms' ? ClipboardList : Blocks
  const mask = logo ? `url(${logo}) center / contain no-repeat` : undefined
  return (
    <span
      aria-hidden
      style={{ width: px, height: px, borderRadius: Math.round(px * 0.28) }}
      className={clsx('flex shrink-0 items-center justify-center bg-hover text-ink select-none', className)}
      data-testid="app-tile"
      data-kind={service}
    >
      {logo
        ? <span className={clsx('block bg-current', LOGO_TINT[service])} style={{ width: mark, height: mark, mask, WebkitMask: mask }} data-testid="app-logo" />
        : initial
          ? <span className="font-semibold leading-none" style={{ fontSize: Math.round(px * (initial.length > 1 ? 0.4 : 0.5)) }} data-testid="app-initial">{initial}</span>
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
