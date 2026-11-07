// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom; like Slack AI's "share to channel"): a finished answer of
// my own AI chat goes to a room I am in as my message: my one-line note, then the answer (its Markdown kept) as a quote
// headed "<AI> 답변" (components/rooms/RoomMessages.tsx). The dialog (a bottom sheet on phones) lists my rooms as the
// "#" list does (components/chat/RoomRefMenu.tsx: the same filter and rows) under a search field; the note and 보내기
// stay at its foot while the list scrolls. Arrow keys in the search move the pick, Enter there takes it and goes on to
// the note, Enter in the note sends. An answer too long for one room message is said to be cut before it is sent (the
// server cuts it). When some people of the room cannot open what the answer used, the server first answers "confirm":
// how many, and which places (never who); 그래도 보내기 sends it with the same id and that count (more people than that
// by then: the server asks again, a new step of its own), 취소 goes back to the list. Sent: the dialog closes and a toast
// says where, with 열기. Never in a confidential chat (the server refuses it; components/chat/Messages.tsx hides the
// button).
import clsx from 'clsx'
import { Check, Folder, FolderLock, Hash, Lock, MessagesSquare, Plug, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ANSWER_NOTE_MAX, answerNote, answerShareCut, uuidv7, type AnswerSharePlace, type Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { errorText } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { matchRooms } from '../../lib/roomRefs'
import { aiName } from '../../lib/tabs'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { useRoomTitle } from '../rooms/RoomIcon'
import { Button, inputCls, Modal, Spinner, useMediaQuery } from '../ui'
import { ROOM_OPTION_CLS, RoomOptionLabel } from './RoomRefMenu'

/** the server's "confirm"; `seq`: one more each time it asks (each is a step of its own) */
interface Ask { room: Room; people: number; places: AnswerSharePlace[]; otherPlaces: boolean; seq: number }

export default function ShareToRoom({ chatId, messageId, answer, onClose }: { chatId: string; messageId: string; answer: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const title = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  /** one id per room and note: sending the same again (a lost answer, the confirm) gets the first message back */
  const sendId = useRef<{ key: string; id: string } | null>(null)
  // a phone: the keyboard does not come up over the list before anything is touched
  const touch = useMediaQuery('(pointer: coarse)')

  // the rooms are the sidebar's list; a phone that never opened it reads it here
  useEffect(() => { if (!loaded) void useRooms.getState().loadRooms() }, [loaded])
  const hits = useMemo(() => matchRooms(rooms, query, title, 50), [rooms, query, title])
  // a room the search no longer shows is not picked (nothing is sent to a room out of sight)
  const room = hits.find((r) => r.id === picked) ?? null
  const label = (r: Room) => (r.kind === 'dm' ? t('composer.roomDm', { name: title(r) }) : title(r))
  const cut = answerShareCut(note, answer)
  const optionId = (r: Room) => `${id}-room-${r.id}`

  // the picked room stays in sight as the arrow keys move it (the dialog's body is what scrolls)
  useEffect(() => {
    if (room) listRef.current?.querySelector<HTMLElement>(`[data-room-id="${room.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [room])

  const move = (step: 1 | -1) => {
    if (!hits.length) return
    const i = room ? hits.indexOf(room) : -1
    const next = i < 0 ? (step > 0 ? 0 : hits.length - 1) : (i + step + hits.length) % hits.length
    setPicked(hits[next]!.id)
  }

  /** `confirm`: the number of people I said yes to (the last confirm's) */
  const send = async (to: Room, confirm?: number) => {
    if (busy) return
    const n = answerNote(note)
    const key = `${to.id}\n${n}`
    if (sendId.current?.key !== key) sendId.current = { key, id: uuidv7() }
    setBusy(true)
    try {
      const r = await useRooms.getState().shareAnswer(chatId, messageId, { roomId: to.id, ...(n ? { note: n } : {}), ...(confirm ? { confirm } : {}), clientMessageId: sendId.current.id })
      if (r.status === 'confirm') {
        setAsk((a) => ({ room: to, people: r.people, places: r.places, otherPlaces: r.otherPlaces, seq: (a?.seq ?? 0) + 1 }))
        setBusy(false)
        return
      }
      onClose()
      toast({ level: 'success', text: t('shareRoom.sent', { room: label(to) }), action: { label: t('shareRoom.open'), run: () => navigateTo(`/rooms/${to.id}`) } })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }

  // each step is a dialog of its own (key): opening one puts the focus in it
  if (ask)
    return (
      <Modal
        key={`confirm-${ask.seq}`}
        open
        onClose={onClose}
        width={420}
        title={t('chat.shareToRoom')}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setAsk(null)} data-testid="share-room-back">
              {t('common.cancel')}
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void send(ask.room, ask.people)} data-autofocus data-testid="share-room-anyway">
              {t('shareRoom.sendAnyway')}
            </Button>
          </>
        }
      >
        <div data-testid="share-room-confirm">
          <div className="-mx-2 mb-3 flex items-center gap-2.5 px-2 text-sm" data-testid="share-room-to">
            <RoomOptionLabel room={ask.room} />
          </div>
          <p className="text-sm leading-6 break-keep text-ink" data-testid="share-room-people">
            {t('shareRoom.confirm', { n: ask.people })}
          </p>
          {(ask.places.length > 0 || ask.otherPlaces) && (
            <ul className="mt-3 space-y-1.5 text-sm text-muted" data-testid="share-room-places">
              {ask.places.map((p, i) => <PlaceRow key={i} place={p} />)}
              {ask.otherPlaces && <Place icon={<Lock size={14} />} text={t('shareRoom.placeOther')} />}
            </ul>
          )}
        </div>
      </Modal>
    )

  return (
    <Modal
      key="pick"
      open
      onClose={onClose}
      width={420}
      title={t('chat.shareToRoom')}
      footer={
        <>
          <label className="w-full">
            <span className="sr-only">{t('shareRoom.note')}</span>
            <input
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                if (room) void send(room)
              }}
              maxLength={ANSWER_NOTE_MAX}
              placeholder={t('shareRoom.note')}
              className={inputCls}
              data-testid="share-room-note"
            />
          </label>
          {cut && (
            <p role="note" className="w-full text-xs leading-5 break-keep text-muted" data-testid="share-room-cut">
              {t('shareRoom.cut', { history: t('sidebar.aiChats', { name: aiName(t) }) })}
            </p>
          )}
          <Button variant="primary" busy={busy} disabled={!room} onClick={() => room && void send(room)} data-testid="share-room-send">
            {t('shareRoom.send')}
          </Button>
        </>
      }
    >
      <div className="-mx-5 -mt-5 border-b border-line px-5 py-3 max-sm:-mx-4 max-sm:px-4">
        <label className="relative block">
          <span className="sr-only">{t('shareRoom.search')}</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(e.key === 'ArrowDown' ? 1 : -1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const to = room ?? hits[0]
                if (!to) return
                setPicked(to.id)
                noteRef.current?.focus()
              }
            }}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={room ? optionId(room) : undefined}
            aria-autocomplete="list"
            placeholder={t('shareRoom.search')}
            className={`${inputCls} pl-9`}
            data-autofocus={touch ? undefined : ''}
            data-testid="share-room-search"
          />
        </label>
      </div>
      {!loaded ? (
        <Spinner className="pt-4" label={t('common.loading')} />
      ) : !rooms.length ? (
        <p className="pt-4 text-sm text-muted">{t('rooms.listEmpty')}</p>
      ) : !hits.length ? (
        <p className="pt-4 text-sm text-muted" data-testid="share-room-none">{t('shareRoom.noMatch')}</p>
      ) : (
        <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={t('composer.roomMenu')} className="pt-3" data-testid="share-room-list">
          {hits.map((r) => {
            const on = r.id === room?.id
            return (
              <li
                key={r.id}
                id={optionId(r)}
                role="option"
                aria-selected={on}
                // the focus stays in the search field (the keyboard goes on from there)
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPicked(r.id)}
                className={clsx(ROOM_OPTION_CLS, 'cursor-pointer', on ? 'bg-accent-soft' : 'hover:bg-hover')}
                data-testid="share-room-option"
                data-room-id={r.id}
              >
                <RoomOptionLabel room={r} end={<Check size={16} strokeWidth={2.5} aria-hidden className={clsx('shrink-0 text-accent-text', !on && 'invisible')} />} />
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

/** One place the answer used that some people of the room cannot open, as the app names it. */
function PlaceRow({ place }: { place: AnswerSharePlace }) {
  const t = useT()
  switch (place.kind) {
    case 'folder':
      return <Place icon={<Folder size={14} />} text={place.path ? `${place.path.replace(/\/+$/, '')}/` : t('rooms.aiRootFolder')} />
    case 'mine':
      return <Place icon={<FolderLock size={14} />} text={t('shareRoom.placeMine')} />
    case 'service':
      return <Place icon={<Plug size={14} />} text={place.name} />
    case 'room':
      return <Place icon={<Hash size={14} />} text={t('shareRoom.placeRoom', { name: place.name || t('rooms.all') })} />
    case 'conversation':
      return <Place icon={<MessagesSquare size={14} />} text={t('shareRoom.placeConversation')} />
  }
}

function Place({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-2" data-testid="share-room-place">
      <span aria-hidden className="flex shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 truncate text-ink" title={text}>{text}</span>
    </li>
  )
}
