// One row of the AI's history and its hover quick view. Moved out of Sidebar.tsx unchanged (navigation redesign,
// docs/AGENTS/plan/20261112-1839-nav-rail.md, phase P0b) so every list of AI chats draws the same row: the sidebar's
// history (nav/HistoryList.tsx) today, the rail's Trina panel later.
import clsx from 'clsx'
import { Pin } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { needsMe } from '../../lib/sessionMarkers'
import { sharedRights } from '../../lib/sharedChat'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { useRooms } from '../../store/rooms'
import { useChatMenuItems } from '../chat/chatMenuItems'
import { SharedIcon } from '../chat/SharedChat'
import { SessionMarker, useChatMarker } from '../chat/ChatState'
import { MenuButton } from '../rooms/MenuButton'
import { useRowMenu } from '../rooms/RoomMenu'
import { useRoomTitle } from '../rooms/RoomIcon'

/** A row of the AI's history. Its "···" is the rooms' row menu (rooms/MenuButton.tsx): on hover or keyboard focus on a
 * computer and always on a phone; a right-click on the row opens it too, and on a touch screen a long press (a sheet on
 * a phone, the chat's title on top; the finger lifting opens no chat, and starts no text selection). Every row has it:
 * "상단에 고정" / "고정 해제" is anyone's who sees the chat. A pinned row has a pin before its title. */
export function ChatItem({ chat, onNavigate, peek, onMove }: { chat: Chat; onNavigate: () => void; peek: ChatPeek; onMove: (c: Chat) => void }) {
  const t = useT()
  const more = useRef<HTMLButtonElement>(null)
  // a shared chat: the people icon before its title (what its menu holds: components/chat/chatMenuItems.tsx)
  const rights = sharedRights(chat, useMeStrict().user.id)
  // "?" your turn, a grey ring while it runs, a dot for a new answer; nothing on an idle row. A row that needs me ("?" or
  // the dot: what "답 필요" and the one count hold) reads in ink, the others stay muted
  const { marker, reason } = useChatMarker(chat)
  const ref = useRef<HTMLLIElement>(null)
  const menu = useRowMenu()
  const title = chat.title || t('chat.untitled')
  // a room's side chat (✦ Trina): the room it was asked beside, small after the title ("# design"); a room I left: none
  const sideRoom = useRooms((s) => (chat.sideRoomId ? s.rooms.find((r) => r.id === chat.sideRoomId) ?? null : null))
  const roomTitle = useRoomTitle()
  const items = useChatMenuItems(chat, { testId: 'chat-row', more, onMove })

  return (
    <li
      ref={ref}
      className="group relative"
      {...menu.row}
      onMouseEnter={(e) => peek.soon(chat, e.currentTarget, 400)}
      onMouseLeave={peek.hide}
      data-marker={marker?.kind}
      data-pinned={chat.pinnedAt ? '' : undefined}
    >
      <NavLink
        to={`/c/${chat.id}`}
        onClick={(e) => {
          menu.guard(e)
          if (e.defaultPrevented) return
          peek.hide()
          onNavigate()
        }}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && peek.soon(chat, ref.current!, 600)}
        onBlur={peek.hide}
        onKeyDown={(e) => e.key === 'Escape' && peek.hide()}
        className={({ isActive }) =>
          clsx('flex h-9 items-center gap-2 rounded-lg pr-9 pl-3 text-sm hover:bg-hover max-md:h-11 max-md:pr-11 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] group-has-[[aria-expanded=true]]:bg-hover', marker && 'max-md:pr-17', isActive ? 'bg-hover font-medium text-ink' : needsMe(marker) ? 'font-medium text-ink' : 'text-muted')
        }
      >
        {chat.pinnedAt && <Pin size={12} role="img" aria-label={t('chat.pinned')} className="shrink-0 text-faint" data-testid="chat-pin-icon" />}
        {rights.shared && <SharedIcon className="text-faint" />}
        <span className="truncate">{title}</span>
        {sideRoom && <span className="shrink-0 truncate text-xs font-normal text-faint max-w-[40%]" data-testid="chat-row-room">{sideRoom.kind === 'dm' ? roomTitle(sideRoom) : `# ${roomTitle(sideRoom)}`}</span>}
        {marker && (
          // one marker at the right end (session markers): its reason is part of the link's name. On a computer it sits in
          // the "···" spot, its right edge in line with the rooms' pills above, and gives way to "···" on hover and focus;
          // on a phone "···" always shows and it sits left of it
          <span className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center group-has-[[aria-expanded=true]]:opacity-0 max-md:right-11 md:group-focus-within:opacity-0 md:group-hover:opacity-0" data-testid="chat-marker">
            <SessionMarker marker={marker} label={reason} />
          </span>
        )}
      </NavLink>
      {/* 28 px (WCAG 2.2 target size: it sits on the row's link), 44 px on a phone */}
      <MenuButton
        label={t('chat.menu')}
        items={items}
        className="absolute inset-y-0 right-1 flex items-center max-md:right-0"
        buttonClassName="hover:bg-surface max-md:size-11 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
        openSignal={menu.openSignal}
        openRequest={menu.openRequest}
        sheetTitle={title}
        buttonRef={more}
        testId="chat-row-menu"
      />
    </li>
  )
}

/** The hover quick view of a recent chat, like Claude's: after resting on it (or reaching it with the keyboard), a
 * card beside the sidebar with the start of the last answer or its first file, the title and when. Only where there is
 * a mouse; decorative (aria-hidden: the link already says the title), never in the way (no pointer events), and gone on
 * leave, Esc, a click or a scroll. One read of the last two messages per chat version, kept for the session. */
export type ChatPeek = ReturnType<typeof useChatPeek>
/** The peek's first line: the row marker's reason (session markers), as the chat is now (it may have changed since the
 * pointer came). Nothing on an idle chat. */
function PeekReason({ chatId, fallback }: { chatId: string; fallback: Chat }) {
  const chat = useChats((s) => s.chats.find((c) => c.id === chatId)) ?? fallback
  const { marker, reason } = useChatMarker(chat)
  if (!marker) return null
  return (
    <p className={clsx('mb-2 line-clamp-2 text-xs font-medium', marker.kind === 'ask' ? 'text-warn' : marker.kind === 'new' ? 'text-accent-text' : 'text-faint')} data-testid="chat-peek-reason">
      {reason}
    </p>
  )
}
const peeks = new Map<string, Promise<{ text: string; file: string | null }>>()
function peekOf(c: Chat) {
  const key = `${c.id}:${c.updatedAt}`
  let p = peeks.get(key)
  if (!p) {
    p = api.call(API.listMessages, { params: { id: c.id }, query: { limit: 2 } }).then(
      (page) => {
        const items = [...page.items].reverse()
        const answer = items.find((m) => m.role === 'assistant')
        const text = (answer?.content ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)
        const file = items.flatMap((m) => m.attachments).find(Boolean)?.name ?? null
        return { text, file }
      },
      () => ({ text: '', file: null }),
    )
    peeks.set(key, p)
  }
  return p
}
const canHover = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine) and (min-width: 768px)').matches

export function useChatPeek() {
  const t = useT()
  const locale = useLocale()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shown, setShown] = useState<{ chat: Chat; top: number; left: number } | null>(null)
  const [data, setData] = useState<{ id: string; text: string; file: string | null } | null>(null)
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setShown(null)
  }, [])
  const soon = useCallback((chat: Chat, row: HTMLElement, ms: number) => {
    if (!canHover()) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = row.getBoundingClientRect()
      const side = row.closest('nav')?.getBoundingClientRect()
      setShown({ chat, top: Math.max(8, Math.min(r.top - 8, innerHeight - 200)), left: (side?.right ?? r.right) + 8 })
      void peekOf(chat).then((d) => setData({ id: chat.id, ...d }))
    }, ms)
  }, [])
  useEffect(() => {
    if (!shown) return
    const k = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', k)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('blur', hide)
    }
  }, [shown, hide])
  useEffect(() => hide, [hide])
  const d = shown && data?.id === shown.chat.id ? data : null
  const card = shown
    ? createPortal(
        <div aria-hidden className="pointer-events-none fixed z-40 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg" style={{ top: shown.top, left: shown.left }} data-testid="chat-peek">
          <PeekReason chatId={shown.chat.id} fallback={shown.chat} />
          <div className="mb-2 min-h-12 rounded-lg bg-subtle p-2.5 text-xs text-muted" data-testid="chat-peek-preview">
            {!d ? (
              <span className="block h-3 w-2/3 animate-pulse rounded bg-hover" />
            ) : d.file ? (
              <span className="inline-flex max-w-full items-center rounded-md border border-line bg-surface px-2 py-0.5 text-micro text-ink">
                <span className="truncate">{d.file}</span>
              </span>
            ) : (
              <span className="line-clamp-3">{d.text || t('sidebar.peek.empty')}</span>
            )}
          </div>
          <p className="truncate text-sm font-medium text-ink">{shown.chat.title || t('chat.untitled')}</p>
          <p className="text-xs text-faint">{formatRelative(shown.chat.updatedAt, locale)}</p>
        </div>,
        document.body,
      )
    : null
  return { soon, hide, card }
}
