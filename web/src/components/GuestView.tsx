// A guest's own view (docs/DECISIONS.md "Guests: only what they were invited to"): the lines only a guest reads.
// - GuestNoAi: in place of the AI's box (Home, a project's box, a chat, a room's ✦ side chat) while no AI answers them
//   (GET /api/me/ai-access: their AI is off, the default): "AI isn't on for you. Ask the person who invited you." No box
//   that would only fail, no button (turning it on is the inviter's or an admin's).
// - GuestProjectNote: once, on their project's page: "Members of this project can see your chats here." Closed with ×,
//   shown on the first visit with AI on only (remembered in this browser as soon as it shows: it says nothing new the
//   second time; with AI off they have no chats there, and the no-AI line is the one thing above the list).
// The rail, the tab bar, the routes and Settings leave out what is not theirs (useGuestHidden, NotForGuests below).
import { Info, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useT } from '../i18n'
import { isGuestMe, meGuest } from '../lib/guests'
import { readProjectList, useProjects } from '../store/projects'
import { useRooms } from '../store/rooms'
import { useAiAccess } from '../store/aiAccess'
import { useMe } from '../store/session'
import { IconButton } from './ui'

/** A guest whose AI is off (known once ai-access has answered): nothing answers them and there is nothing they can
 * connect themselves. */
export function useGuestNoAi(): boolean {
  const guest = isGuestMe(useMe())
  const me = useMe()
  const { loaded, usable, action } = useAiAccess()
  useEffect(() => { if (guest) void useAiAccess.getState().load() }, [guest])
  // their AI choice as the server says it (Me.guest.ai): off at once, before ai-access answers
  if (guest && meGuest(me)?.ai === 'none') return true
  // "their own sign-in" not made yet (connect_own): the box stays, with the line that offers the sign-in
  return guest && loaded && !usable && action !== 'connect_own'
}

export function GuestNoAi({ className }: { className?: string }) {
  const t = useT()
  return (
    <p role="status" className={['flex items-start gap-2 rounded-xl border border-line bg-subtle px-3 py-2.5 text-sm leading-6 break-keep text-ink', className].filter(Boolean).join(' ')} data-testid="guest-no-ai">
      <Info size={16} className="mt-1 shrink-0 text-muted" aria-hidden />
      {t('guest.noAi')}
    </p>
  )
}

const NOTE_KEY = 'mycel.guestProjectNote'
const seen = (projectId: string): boolean => {
  try { return (localStorage.getItem(NOTE_KEY) ?? '').split(',').includes(projectId) } catch { return false }
}
const markSeen = (projectId: string) => {
  try { localStorage.setItem(NOTE_KEY, [...new Set([...(localStorage.getItem(NOTE_KEY) ?? '').split(',').filter(Boolean), projectId])].slice(-20).join(',')) } catch { /* storage blocked: it shows again next time */ }
}

export function GuestProjectNote({ projectId }: { projectId: string }) {
  const t = useT()
  const guest = isGuestMe(useMe())
  // with AI off they have no chats here: the no-AI line alone (the note waits for a visit with AI on)
  const noAi = useGuestNoAi()
  const [open, setOpen] = useState(() => !seen(projectId))
  const show = guest && open && !noAi
  // once: seen as soon as it shows (it stays until the page is left or × closes it)
  useEffect(() => { if (show) markSeen(projectId) }, [show, projectId])
  if (!show) return null
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-subtle py-2 pr-1 pl-3 text-sm leading-6 break-keep text-ink" data-testid="guest-project-note">
      <Info size={16} className="mt-1 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 py-0.5">{t('guest.projectNote')}</span>
      <IconButton label={t('common.close')} onClick={() => setOpen(false)} className="touch-hit shrink-0" data-testid="guest-project-note-close">
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  )
}

const NONE = new Set<string>()
/**
 * The rail's places and phone tabs a guest does not get: 파일 (the team's files are not theirs; their project's files are
 * on its page), 프로젝트 when they have none (a guest in a room: Me.guest.place, else an empty projects list), and 트리나
 * (Ask Trina and its history) while their AI is off: they land on their one place instead (useGuestLanding).
 */
export function useGuestHidden(): ReadonlySet<string> {
  const me = useMe()
  const guest = isGuestMe(me)
  const noAi = useGuestNoAi()
  const listed = useProjects((s) => s.listed)
  // a guest's projects list is read once, so a guest in a room loses the 프로젝트 place at once
  useEffect(() => { if (guest && !meGuest(me)?.place) void readProjectList({ minAgeMs: 60_000 }).catch(() => {}) }, [guest]) // eslint-disable-line react-hooks/exhaustive-deps
  const place = meGuest(me)?.place
  const noProjects = place ? place.kind === 'room' : listed !== null && listed.size === 0
  return useMemo(() => (guest ? new Set(['files', ...(noProjects ? ['projects'] : []), ...(noAi ? ['ai'] : [])]) : NONE), [guest, noProjects, noAi])
}

/**
 * A guest's one place as an address: their room or their project (Me.guest.place; until the server names it, the one
 * project they see, else their group chat, else the chats list). null while it is still being read.
 */
export function useGuestPlacePath(): string | null {
  const me = useMe()
  const place = meGuest(me)?.place
  const listed = useProjects((s) => s.listed)
  const roomsLoaded = useRooms((s) => s.loaded)
  const groupRoom = useRooms((s) => s.rooms.find((r) => r.kind === 'group')?.id)
  useEffect(() => { if (!place) void readProjectList({ minAgeMs: 60_000 }).catch(() => {}) }, [place])
  if (place?.id) return place.kind === 'room' ? `/rooms/${place.id}` : `/projects/${place.id}`
  if (listed === null) return null
  if (listed.size === 1) return `/projects/${[...listed][0]}`
  if (!roomsLoaded) return null
  return groupRoom ? `/rooms/${groupRoom}` : '/rooms'
}

/** Home for a guest whose AI is off: there is nothing to ask, so their one place opens instead. */
export function GuestLanding() {
  const to = useGuestPlacePath()
  return to ? <Navigate to={to} replace /> : <div className="h-full" data-testid="guest-landing" />
}

/** A page that is not a guest's (the team's files, skills, scheduled tasks, Admin, the welcome steps, connecting apps):
 * a guest who opens its address lands on Home instead. */
export function NotForGuests({ children }: { children: ReactNode }) {
  return isGuestMe(useMe()) ? <Navigate to="/" replace /> : <>{children}</>
}
