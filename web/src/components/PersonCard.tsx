// A person's card (docs/decisions/20261116-person-card.md): a click on someone's photo or name opens a small card with
// their photo, name, title and status, and one button, "Message", which opens the 1:1 chat with them (the one there is,
// or a new one: store/rooms.ts openDm) with the message box ready. One piece for every place a person shows: a
// message's photo and name (rooms/RoomMessages.tsx, a thread too), an @mention in a message (Markdown.tsx
// PersonMarkdown) and a row of a room's member list (rooms/MembersDialog.tsx).
// - The card is the shared menu (rooms/MenuButton.tsx `body`): a popover by the photo or name on a computer (Esc, a
//   click outside or a scroll closes it; the keyboard goes back to where it was), a bottom sheet on a phone.
// - Only what the people directory gives (GET /api/people: name, title, status, photo, the Guest tag): never an
//   e-mail, a role or a group.
// - Who has a card: the people the directory lists for this viewer. The server lets the viewer message exactly those
//   (rooms/service.ts openDm: an active person the viewer may reach; a guest and the people of their places only, both
//   ways), so the button is never one that fails. Anyone else (an account that is gone, the AI, an app) has no card:
//   `PersonButton` draws its children as they were.
// - Yourself: no Message; "Edit profile" (Settings › Profile) in its place.
import clsx from 'clsx'
import { useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Person } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { personIsGuest } from '../lib/guests'
import { useLocale, useT } from '../i18n'
import { usePeople } from '../store/people'
import { focusRoomBox, hasRoomBox } from '../store/roomEdit'
import { placeKey, useRooms } from '../store/rooms'
import { useMe } from '../store/session'
import { useStatusOf } from '../store/statusMessages'
import { toast } from '../store/ui'
import { GuestTag } from './GuestTag'
import { PresenceFace, PresenceText } from './Presence'
import { MenuButton } from './rooms/MenuButton'
import { useStatusWords } from './StatusMessage'
import { Button } from './ui'

/** Where the person shows: a photo, a name over a message, a name in a sentence (an @mention), or a list's row (the
 * whole row opens the card: the row's <li> must be `relative`). */
export type PersonLook = 'face' | 'name' | 'mention' | 'row'

/** a touch held this long opened the message's menu (MenuButton useLongPress): the finger lifting is no click */
const LONG_PRESS_MS = 500

const LOOK: Record<PersonLook, string> = {
  face: 'flex cursor-pointer rounded-full transition hover:opacity-80 aria-expanded:opacity-80',
  name: 'block max-w-full cursor-pointer truncate rounded-sm text-left hover:underline aria-expanded:underline',
  mention: 'cursor-pointer text-left hover:underline aria-expanded:underline',
  row: "block max-w-full cursor-pointer truncate text-left after:absolute after:inset-0 after:rounded-lg after:content-['']",
}

/** The message box of `place`, once it is on screen (the room's page opens first). Not on a touch screen: the keyboard
 * would cover the chat that just opened. */
function focusBoxWhenThere(place: string) {
  if (typeof window === 'undefined' || window.matchMedia?.('(pointer: coarse)').matches) return
  let tries = 0
  const tick = () => {
    if (hasRoomBox(place)) return focusRoomBox(place)
    if (++tries < 180) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/**
 * Someone's photo or name as a button that opens their card. `className`: the look of the words or the photo (on the
 * button; on a plain <span> for someone with no card). `boxClassName`: the button's box in its row. `onGo`: before
 * the card leaves this screen (a dialog it was opened from closes).
 */
export function PersonButton({ user, look, className, boxClassName, onGo, children, testId = 'person-button' }: { user: { id: string; name: string } | null | undefined; look: PersonLook; className?: string; boxClassName?: string; onGo?: () => void; children: ReactNode; testId?: string }) {
  const t = useT()
  const person = usePeople((s) => (user ? s.byId[user.id] : undefined))
  // the last touch on it: when it went down, and whether it was held long enough to open the message's menu
  const press = useRef({ down: 0, long: false })
  if (!person) return className || boxClassName ? <span className={clsx(className, boxClassName)}>{children}</span> : <>{children}</>
  const button = (
    <MenuButton
      label={t('person.open', { name: person.name })}
      // (the name is written on it or beside it: no tooltip)
      tip=""
      bare
      inline={look === 'mention'}
      icon={children}
      className={clsx(look === 'row' ? 'static' : look === 'mention' && 'inline', boxClassName)}
      buttonClassName={clsx(LOOK[look], className)}
      startAligned
      closeOnScroll
      items={[]}
      testId={testId}
      body={(close) => <PersonCard person={person} close={close} onGo={onGo} />}
    />
  )
  if (look !== 'mention') return button
  // inside a message: a long press opens the message's menu, and the finger lifting then opens no card
  return (
    <span
      onPointerDownCapture={(e: PointerEvent) => { press.current = { down: e.pointerType === 'touch' ? Date.now() : 0, long: false } }}
      onPointerUpCapture={() => { const p = press.current; press.current = { down: 0, long: p.down > 0 && Date.now() - p.down >= LONG_PRESS_MS } }}
      onPointerCancelCapture={() => { press.current = { down: 0, long: false } }}
      onClickCapture={(e: MouseEvent) => {
        const long = press.current.long
        press.current.long = false
        if (!long || e.detail === 0) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {button}
    </span>
  )
}

/** The card itself, inside the menu: who it is, then the one thing to do. */
function PersonCard({ person, close, onGo }: { person: Person; close: () => void; onGo?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const me = useMe()
  const self = me?.user.id === person.id
  const status = useStatusOf(person.id)
  const words = useStatusWords()
  const message = async () => {
    close()
    try {
      const room = await useRooms.getState().openDm(person.id)
      onGo?.()
      navigate(`/rooms/${room.id}`)
      focusBoxWhenThere(placeKey(room.id))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const profile = () => {
    close()
    onGo?.()
    navigate('/settings/profile')
  }
  return (
    <div className="flex flex-col gap-3 p-2 md:w-72 max-md:px-3 max-md:pt-2 max-md:pb-1" data-testid="person-card" data-person={person.id}>
      <div className="flex items-center gap-3 [--presence-bg:var(--c-surface)]">
        <PresenceFace user={person} size={56} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1.5 text-base">
            <span className="line-clamp-2 min-w-0 font-semibold break-words text-ink" data-testid="person-card-name">{person.name}</span>
            {personIsGuest(person) && <GuestTag />}
            {self && <span className="shrink-0 text-meta text-faint">{t('rooms.you')}</span>}
            <PresenceText userId={person.id} offline />
          </p>
          {person.title && <p className="line-clamp-2 text-sm break-words text-muted" data-testid="person-card-title">{person.title}</p>}
          {status && <p className="truncate text-sm text-muted" data-testid="person-card-status">{status.text ? `${status.emoji} ${words(status)}` : words(status) === status.emoji ? status.emoji : `${status.emoji} ${words(status)}`}</p>}
        </div>
      </div>
      {self ? (
        <Button role="menuitem" className="w-full" onClick={profile} data-testid="person-card-profile">
          {t('person.editProfile')}
        </Button>
      ) : (
        <Button role="menuitem" variant="primary" className="w-full" onClick={() => void message()} data-testid="person-card-message">
          {t('person.message')}
        </Button>
      )}
    </div>
  )
}
