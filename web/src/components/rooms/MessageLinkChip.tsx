// A message link in a person's words, as the conversation it points into (docs/DECISIONS.md "Message links and their
// previews"): a speech bubble and the place's name as this viewer names it ("#marketing", "Ben", "Thread in #marketing"),
// only when the server gave this viewer a preview of that message (RoomMessage.linkPreviews). Without one the address
// stays the plain link it always was (MessageText.tsx RoomLink): nothing says whether the message exists.
import { MessageSquareText } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo } from 'react'
import type { RoomLinkPreview } from '@mycel/shared/api'
import { linkHosts, placeLabel } from '../../lib/messageLinks'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { useRoomTitle } from './RoomIcon'

/** The previews of the message being drawn; a card's own text gets the same list (a link in it is a chip, never a card
 * inside a card). */
export const MessageLinkPreviews = createContext<readonly RoomLinkPreview[] | null>(null)
export const useMessageLinkPreviews = () => useContext(MessageLinkPreviews)

/** The hosts whose links are this team's: this page's and the team address. */
export function useLinkHosts(): ReadonlySet<string> {
  const address = useMe()?.team.address ?? null
  return useMemo(() => linkHosts(typeof location === 'undefined' ? null : location.host, address), [address])
}

/** A preview's place as words: "#name", a person, a group chat's name or people; a reply "Thread in …". */
export function usePlaceLabel(): (p: Pick<RoomLinkPreview, 'place' | 'sharedBy' | 'rootId'>) => string {
  const t = useT()
  const title = useRoomTitle()
  return useCallback((p) => {
    const label = placeLabel(p, { title: (place) => title(place), dm: t('rooms.link.dm'), group: t('rooms.link.group') })
    return p.rootId ? t('rooms.link.threadIn', { name: label }) : label
  }, [t, title])
}

/** What a chip shows (inside the link RoomLink draws). */
export function MessageLinkChipBody({ preview }: { preview: RoomLinkPreview }) {
  const label = usePlaceLabel()(preview)
  return (
    <>
      <MessageSquareText size={14} aria-hidden className="mr-1 inline-block shrink-0 align-[-2px]" />
      {label}
    </>
  )
}

/** The chip's own look: the accent text on the soft accent, rounded, no underline. */
export const CHIP = 'rounded-md bg-accent-soft px-1 py-px font-medium text-accent-text no-underline [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent'
