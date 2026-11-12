// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom; like Slack AI's "share to channel"): a finished answer of
// my own AI chat goes to a room I am in as my message: my one-line note, then the answer (its Markdown kept) as a quote
// headed "<AI> 답변" (components/rooms/RoomMessages.tsx). The dialog (a bottom sheet on phones) lists my rooms as the
// "#" list does (components/chat/RoomRefMenu.tsx: the same filter and rows) under a search field; the note and 보내기
// stay at its foot while the list scrolls. Arrow keys in the search move the pick, Enter there takes it and goes on to
// the note, Enter in the note sends. An answer too long for one room message is said to be cut before it is sent (the
// server cuts it). When something applies, the server first answers "confirm", and the next step asks two things apart:
// the files the answer links to (a row each: everyone can open it, how many cannot, or nobody else can; a file I cannot
// open is never named, only counted; a 첨부 switch, on by default, sends a copy with the message and says how many more
// people will see it), and one line when the answer carries content from material some members cannot see (the places I
// may look myself; "not all known" for an answer off the chat's branch). Never who. The primary button (첨부해서 보내기
// when a switch is on, else 보내기) is the focused default; it sends with the same id and the confirmKey (things changed
// meanwhile: the server asks again, said so on top). 취소, ✕ and Esc go back to the list with the room and the note kept.
// Sent: the dialog closes and a toast says where (and how many files went), with 열기. Never in a confidential chat (the
// server refuses it; components/chat/Messages.tsx hides the button).
// The confirm step is its own part (ShareConfirm, with useConfirmStep for its state): a room's side chat sends with one
// click and shows only this step when the server asks (components/rooms/SendHere.tsx), its target above the rows.
import clsx from 'clsx'
import { AlertCircle, Check, FileText, Info, Lock, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ANSWER_NOTE_MAX, answerNote, answerShareCut, ROOM_FILES_MAX, uuidv7, type AnswerShareFile, type AnswerSharePlace, type AnswerShareProvenance, type Room, type ShareAnswerToRoomResult } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { errorText } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { matchRooms } from '../../lib/roomRefs'
import { aiName } from '../../lib/tabs'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { useRoomTitle } from '../rooms/RoomIcon'
import { Button, inputCls, Modal, Spinner, Switch, useMediaQuery } from '../ui'
import { ROOM_OPTION_CLS, RoomOptionLabel } from './RoomRefMenu'

/** the server's "confirm"; `seq`: one more each time it asks (each is a step of its own); `again`: it asked again after
 * my yes because something changed meanwhile (not when only my choice of files changed its line) */
export interface ConfirmAsk { files: AnswerShareFile[]; provenance: AnswerShareProvenance | null; confirmKey: string; seq: number; again: boolean }
interface Ask extends ConfirmAsk { room: Room }
type Confirm = Extract<ShareAnswerToRoomResult, { status: 'confirm' }>

/** The switches a new "confirm" starts with: the files that may go, on, the first ROOM_FILES_MAX; asked again, my own
 * choice stays for the files that are still there. */
function startAttach(files: readonly AnswerShareFile[], before?: { files: readonly AnswerShareFile[]; on: ReadonlySet<string> }): Set<string> {
  const may = files.filter((f) => f.attach === 'yes' && f.path).map((f) => f.path!)
  const known = new Set(before?.files.filter((f) => f.attach === 'yes' && f.path).map((f) => f.path!) ?? [])
  return new Set(may.filter((p) => (known.has(p) ? before!.on.has(p) : true)).slice(0, ROOM_FILES_MAX))
}

/** The confirm step's state: the server's last "confirm" and my 첨부 switches. `asked(r, yes)`: the server asked (again,
 * after my yes when `yes`); `close()`: the step goes. */
export function useConfirmStep<T extends ConfirmAsk = ConfirmAsk>() {
  const [ask, setAsk] = useState<T | null>(null)
  const [attach, setAttach] = useState<Set<string>>(new Set())
  const asked = (r: Confirm, yes: boolean, extra: Omit<T, keyof ConfirmAsk>) => {
    setAttach(startAttach(r.files, yes && ask ? { files: ask.files, on: attach } : undefined))
    // asked again: said so when something changed meanwhile; a line that changed with my own choice of files is only
    // shown as it now reads
    setAsk((a) => ({ ...extra, files: r.files, provenance: r.provenance, confirmKey: r.confirmKey, seq: (a?.seq ?? 0) + 1, again: yes && r.reason !== 'choice' }) as T)
  }
  return { ask, attach, setAttach, asked, close: () => setAsk(null) }
}

/** `roomId`: the room picked at the start (a room's side chat shares to its room); the person may still pick another */
export default function ShareToRoom({ chatId, messageId, answer, onClose, roomId }: { chatId: string; messageId: string; answer: string; onClose: () => void; roomId?: string }) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const title = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(roomId ?? null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const confirm = useConfirmStep<Ask>()
  const { ask, attach } = confirm
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

  /** `yes`: the last confirm's key and the files I chose to attach */
  const send = async (to: Room, yes?: { confirmKey: string; attach: string[] }) => {
    if (busy) return
    const n = answerNote(note)
    const key = `${to.id}\n${n}`
    if (sendId.current?.key !== key) sendId.current = { key, id: uuidv7() }
    setBusy(true)
    try {
      const r = await useRooms.getState().shareAnswer(chatId, messageId, { roomId: to.id, ...(n ? { note: n } : {}), ...(yes ?? {}), clientMessageId: sendId.current.id })
      if (r.status === 'confirm') {
        confirm.asked(r, !!yes, { room: to })
        setBusy(false)
        return
      }
      onClose()
      const files = r.message.files.length
      toast({ level: 'success', text: files ? t('shareRoom.sentFiles', { room: label(to), n: files }) : t('shareRoom.sent', { room: label(to) }), action: { label: t('shareRoom.open'), run: () => navigateTo(`/rooms/${to.id}`) } })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }

  // the confirm step: 취소, ✕ and Esc all go back to the list, with the room and the note as they were
  if (ask) {
    const n = answerNote(note)
    return (
      <ShareConfirm
        title={t('chat.shareToRoom')}
        target={<div className="flex items-center gap-2.5"><RoomOptionLabel room={ask.room} /></div>}
        note={n}
        ask={ask}
        others={Math.max(0, ask.room.memberCount - 1)}
        attach={attach}
        onAttach={confirm.setAttach}
        busy={busy}
        onSend={(yes) => void send(ask.room, yes)}
        onCancel={confirm.close}
      />
    )
  }

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

/** The confirm step, a dialog of its own for each "confirm" (key: opening one puts the focus in it, the primary button):
 * where it goes (`target`), my note, "asked again" when it is, a row per linked file with its 첨부 switch, the provenance
 * line. The primary button (첨부해서 보내기 when a switch is on, else 보내기) sends with the key and the files on;
 * 취소, ✕ and Esc are `onCancel`. `others`: the people of the room but me (a row's "nobody else can open it"). `returnTo`:
 * where the focus goes when it closes (default: where it was). */
export function ShareConfirm({ title, target, note, ask, others, attach, onAttach, busy, onSend, onCancel, returnTo }: {
  title: string; target: ReactNode; note?: string; ask: ConfirmAsk; others: number; attach: ReadonlySet<string>
  onAttach: (f: (cur: Set<string>) => Set<string>) => void; busy: boolean; onSend: (yes: { confirmKey: string; attach: string[] }) => void; onCancel: () => void; returnTo?: HTMLElement | null
}) {
  const t = useT()
  const id = useId()
  const shown = ask.files.filter((f) => !f.missing && f.path)
  const hidden = ask.files.length - shown.length
  return (
    <Modal
      key={`confirm-${ask.seq}`}
      open
      onClose={onCancel}
      width={460}
      title={title}
      returnTo={returnTo}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel} data-testid="share-room-back">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => onSend({ confirmKey: ask.confirmKey, attach: [...attach] })} data-autofocus data-testid="share-room-confirm-send">
            {attach.size ? t('shareRoom.sendAttached') : t('shareRoom.send')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="share-room-confirm">
        <div>
          <div className="-mx-2 px-2 text-sm" data-testid="share-room-to">
            {target}
          </div>
          {note && (
            <p className="mt-1.5 text-sm leading-6 break-words text-muted" data-testid="share-room-confirm-note">
              “{note}”
            </p>
          )}
        </div>
        {ask.again && (
          <p role="status" className="flex items-start gap-2 text-sm leading-6 break-keep text-warn" data-testid="share-room-again">
            <AlertCircle size={16} className="mt-1 shrink-0" aria-hidden />
            {t('shareRoom.askedAgain')}
          </p>
        )}
        {ask.files.length > 0 && (
          <section aria-labelledby={`${id}-files`}>
            <h3 id={`${id}-files`} className="mb-1 text-xs font-medium text-muted">{t('shareRoom.filesHead')}</h3>
            <ul className="divide-y divide-line" data-testid="share-room-files">
              {shown.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  others={others}
                  on={attach.has(f.path!)}
                  full={attach.size >= ROOM_FILES_MAX}
                  onChange={(v) => onAttach((cur) => { const next = new Set(cur); if (v) next.add(f.path!); else next.delete(f.path!); return next })}
                />
              ))}
              {hidden > 0 && (
                <li className="flex items-center gap-3 py-2.5 text-sm text-muted" data-testid="share-room-hidden">
                  <Lock size={16} className="shrink-0 text-faint" aria-hidden />
                  {t('shareRoom.hidden', { n: hidden })}
                </li>
              )}
            </ul>
          </section>
        )}
        {ask.provenance && <Provenance p={ask.provenance} />}
      </div>
    </Modal>
  )
}

/** One linked file: its name, who can open it, and the 첨부 switch when it may go with the message. */
function FileRow({ file, others, on, full, onChange }: { file: AnswerShareFile; others: number; on: boolean; full: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  const id = useId()
  const status = file.unable === 0 ? t('shareRoom.fileAll') : file.unable >= others ? t('shareRoom.fileNoOne') : t('shareRoom.fileSome', { n: file.unable })
  const caption = file.attach === 'yes' ? (on ? t('shareRoom.attachWiden', { n: file.unable }) : t('shareRoom.linkOnly')) : file.attach === 'too_big' ? t('shareRoom.tooBig') : file.unable > 0 ? t('shareRoom.linkOnly') : null
  return (
    <li className="flex items-center gap-3 py-2.5" data-testid="share-room-file" data-path={file.path}>
      <FileText size={16} className="mt-0.5 shrink-0 self-start text-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <p id={`${id}-name`} className="truncate text-sm font-medium text-ink" title={file.path}>{file.name}</p>
        {/* who can open it, then what the switch does: each wraps as one piece on a phone, never mid-phrase */}
        <p id={`${id}-about`} className="text-xs leading-5 break-keep text-muted" data-testid="share-room-file-status">
          <span className="inline-block">
            {file.unable === 0 && <Check size={12} strokeWidth={2.5} className="mr-1 inline-block align-[-0.1em] text-ok" aria-hidden />}
            {status}
          </span>
          {caption && (
            <>
              {' · '}
              <span className="inline-block" data-testid="share-room-file-caption">{caption}</span>
            </>
          )}
        </p>
      </div>
      {file.attach === 'yes' && (
        <div className="shrink-0">
          <Switch checked={on} onChange={onChange} disabled={!on && full} label={t('shareRoom.attach')} describedBy={`${id}-name ${id}-about`} testId="share-room-attach" />
        </div>
      )}
    </li>
  )
}

/** The one line about where the content came from, with the places I may look myself. */
function Provenance({ p }: { p: AnswerShareProvenance }) {
  const t = useT()
  const places = p.places.map((x) => placeName(t, x))
  const text = p.unknown ? t('shareRoom.unknown') : places.length ? t('shareRoom.provenance', { n: p.people, places: places.join(', ') }) : t('shareRoom.provenanceNoPlace', { n: p.people })
  return (
    <p className="flex items-start gap-2 text-sm leading-6 break-keep text-ink" data-testid="share-room-provenance">
      <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
      <span>{text}</span>
    </p>
  )
}

/** A place the answer used that some people of the room cannot see, as the app names it (also the share of a whole
 * chat: components/chat/ShareChat.tsx). */
export function placeName(t: ReturnType<typeof useT>, place: AnswerSharePlace): string {
  switch (place.kind) {
    case 'folder':
      return place.path ? `${place.path.replace(/\/+$/, '')}/` : t('rooms.aiRootFolder')
    case 'mine':
      return t('shareRoom.placeMine')
    case 'service':
      return place.name
    case 'room':
      return t('shareRoom.placeRoom', { name: place.name || t('rooms.all') })
    case 'conversation':
      return t('shareRoom.placeConversation')
  }
}
