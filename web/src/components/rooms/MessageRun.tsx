// The look of a list of messages, shared by a room's timeline and thread (RoomMessages.tsx) and by the thread under a
// shared chat's AI answer (components/chat/ChatThreadPanel.tsx), so both read the same (Slack's): one author's messages
// close together are one run (lib/rooms.ts groupRuns) under one face, name and time, each message a row that lights up
// under the pointer with its hover bar (components/messages/MessageActions.tsx); a date line starts each day; on phones a run's time shows
// only when it differs from the run above it.
import clsx from 'clsx'
import { NATIVE_CALLOUT } from '../messages/MessageActions'
import type { ReactNode } from 'react'
import type { Locale, RoomMessage, UserRef } from '@mycel/shared/api'
import { formatDateTime, intlTag } from '../../lib/format'
import type { MessageRun, RunItem } from '../../lib/rooms'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf, useNameOf } from '../../store/people'
import { Avatar } from '../Avatar'
import { GuestTagFor } from '../GuestTag'
import { PersonButton } from '../PersonCard'
import { StatusEmoji } from '../StatusMessage'
import { AiFace } from './AiFace'

export const timeOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
const dayOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'full' }).format(new Date(iso))

/** A message's words: selectable with a mouse, never on a touch screen (a long press opens its menu there) */
export const WORDS = 'select-text pointer-coarse:select-none'

/** One message of a run: a rounded row that lights up under the pointer, with its menu open, or with the keyboard's
 * focus in it (`lit`: being edited in the box below; a message a link or a quote's jump goes to is not lit, only scrolled
 * to: owner 2026-11-21) */
export const messageRowClass = (lit: boolean) =>
  clsx('group relative -mx-2 rounded-lg px-2 py-0.5 transition select-none pointer-coarse:[-webkit-touch-callout:none]', NATIVE_CALLOUT, lit ? 'bg-accent-soft' : 'hover:bg-subtle has-[[role=menu]]:bg-subtle has-[[aria-expanded=true]]:bg-subtle has-[:focus-visible]:bg-subtle')

/** For each run: its time reads the same as the time shown above it on the same day (a date line starts a new day).
 * Phones show such a time once: the first run of that minute has it. An event line shows no time, so a run compares
 * with the nearest message run above it, never with an event line. */
export function sameTimeAsAbove<M extends RunItem>(runs: readonly MessageRun<M>[], time: (iso: string) => string): boolean[] {
  let shown: string | null = null
  return runs.map((run) => {
    if (run.newDay) shown = null
    const first = run.messages[0]!
    if (first.event) return false
    const t = time(first.createdAt)
    const same = shown === t
    shown = t
    return same
  })
}

/** The date line above a day's first run */
export function DayLine({ at }: { at: string }) {
  const locale = useLocale()
  return (
    <div role="separator" className="flex items-center gap-3 py-3 text-micro font-medium text-faint" data-testid="room-day">
      <span className="h-px flex-1 bg-line" aria-hidden />
      {dayOf(at, locale)}
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  )
}

/** A run: its face, then its name and the first message's time, then its messages (`children`). `repeat`: the time
 * reads as the one above (hidden on phones). */
export function RunShell({ face, name, at, repeat = false, children }: { face: ReactNode; name: ReactNode; at: string; repeat?: boolean; children: ReactNode }) {
  const locale = useLocale()
  return (
    <div className="flex gap-3 pt-2 max-md:pt-3" data-testid="room-run">
      {face}
      <div className="min-w-0 flex-1">
        {/* (a <div>: a person's name is a button with its card under it, components/PersonCard.tsx). A phone: the
            name takes taps from 44 px (index.css touch-hit-start, drawn over what follows), so the run's top gap
            is 12 px (it never reaches the message above) and the emoji and a quote's jump sit above it */}
        <div className="flex items-baseline gap-2" data-testid="room-run-head">
          {name}
          <time dateTime={at} title={formatDateTime(at, locale)} className={clsx('shrink-0 text-xs text-faint', repeat && 'max-md:hidden')} data-repeat={repeat ? '' : undefined}>
            {timeOf(at, locale)}
          </time>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A run's face: the AI's mark, a person's photo (it opens their card), or a grey circle for someone gone */
export function RunFace({ user, ai = false }: { user: UserRef | null; ai?: boolean }) {
  const face = useAvatarOf(ai ? null : user)
  if (ai) return <AiFace size={32} className="mt-0.5" />
  return face ? <PersonButton user={face} look="face" boxClassName="mt-0.5 shrink-0 self-start select-none" testId="room-run-face"><Avatar user={face} size={32} /></PersonButton> : <span aria-hidden className="mt-0.5 size-8 shrink-0 rounded-full bg-hover" />
}

/** A run's name: the AI's, a person's (it opens their card; their status emoji and the guest tag after it), or "unknown
 * person" for someone gone */
export function RunName({ user, ai = false, left }: { user: UserRef | null; ai?: boolean; left?: RoomMessage['authorLeft'] }) {
  const t = useT()
  const nameOf = useNameOf()
  if (ai || !user) return <span className="truncate text-sm font-medium text-ink">{ai ? t('rooms.aiName') : t('rooms.goneUser')}</span>
  return (
    <>
      <PersonButton user={user} look="name" className="text-sm font-medium text-ink" boxClassName="flex min-w-0" testId="room-run-name">{nameOf(user)}</PersonButton>
      <StatusEmoji userId={user.id} tap className="relative z-[2] -ml-1 self-center text-sm select-none" />
      {/* an account turned off or removed (S-110): "나감", or "게스트 · 나감" for a removed guest, in place of the guest tag */}
      {left ? <LeftTag guest={left === 'guest'} /> : <GuestTagFor userId={user.id} />}
    </>
  )
}

/** The quiet tag by the name of someone whose account is turned off or removed (RoomMessage.authorLeft); the guest
 * tag's look */
export function LeftTag({ guest }: { guest: boolean }) {
  const t = useT()
  return (
    <span className="inline-flex shrink-0 items-center self-center rounded-full border border-line px-1.5 text-micro leading-4 font-medium text-muted" data-testid="left-tag">
      {t(guest ? 'rooms.authorLeftGuest' : 'rooms.authorLeft')}
    </span>
  )
}
