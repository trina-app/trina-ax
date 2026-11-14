// The small "Guest" tag beside a guest's name (docs/DECISIONS.md "Guests: only what they were invited to"), wherever a
// name shows: list rows, member lists, mentions, a message's author; and the "Includes 1 guest" line of a room's and a
// project's header. Who is a guest comes from the people directory (lib/guests.ts personIsGuest), and from a project's
// people list for someone whose directory does not have them (an owner or admin outside the guest's one place, QA S8).
import clsx from 'clsx'
import { useT } from '../i18n'
import { personIsGuest } from '../lib/guests'
import type { Person } from '@mycel/shared/api'
import { usePeople } from '../store/people'

/** The tag itself: a quiet outline, one size below the name, never cut. */
export function GuestTag({ className }: { className?: string }) {
  const t = useT()
  return (
    <span className={clsx('inline-flex shrink-0 items-center self-center rounded-full border border-line px-1.5 text-micro leading-4 font-medium text-muted', className)} data-testid="guest-tag">
      {t('role.guest')}
    </span>
  )
}

type Known = { byId: Record<string, Person>; guestIds: Record<string, true> }
const known = (s: Known, id: string) => personIsGuest(s.byId[id]) || !!s.guestIds[id]

/** Is this person (by id) a guest, as the directory (or a project's people list) says? */
export const useIsGuest = (userId: string | null | undefined): boolean => usePeople((s) => !!userId && known(s, userId))

/** How many of these people are guests. */
export function useGuestCount(ids: readonly string[] | null | undefined): number {
  return usePeople((s) => (ids ?? []).reduce((n, id) => n + (known(s, id) ? 1 : 0), 0))
}

/** The tag for a person by id: nothing for a team member. */
export function GuestTagFor({ userId, className }: { userId: string | null | undefined; className?: string }) {
  return useIsGuest(userId) ? <GuestTag className={className} /> : null
}

/** "Includes 1 guest" (nothing without one), for a header's member line. */
export function IncludesGuests({ ids, className, prefix = '' }: { ids: readonly string[] | null | undefined; className?: string; prefix?: string }) {
  const t = useT()
  const n = useGuestCount(ids)
  if (!n) return null
  return (
    <span className={className} data-testid="includes-guests">
      {prefix}
      {t('guest.includes', { n })}
    </span>
  )
}
