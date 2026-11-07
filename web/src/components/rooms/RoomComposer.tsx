// The message box of a room: text that grows with what is typed (Enter sends, Shift+Enter makes a new line, nothing
// happens while a Korean or Japanese word is still being composed; on touch screens Enter makes a new line and the
// button sends, like the AI chat's box), files (the clip, paste or drop; each is uploaded at once with POST
// /api/rooms/:id/files and sent by id), and "@" for the room's members: a picked name (or "@트리나") stands out in the
// box at once and is sent as a mention (useMentionMenu, components/TokenTextarea.tsx). In a thread (threadRootId) it
// writes a reply, with one quiet choice under the box: "대화방에도 보내기" (the reply goes to the room's timeline too).
// The round send button is the screen's one primary action. Phones: a flat bar under a hairline, no frame.
import clsx from 'clsx'
import { ArrowUp, FileText, Loader2, Paperclip, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ROOM_FILES_MAX, ROOM_MESSAGE_MAX, SMALL_UPLOAD_MAX, type RoomFile, type UserRef } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { placeKey, roomDraftMentions, roomDrafts as drafts, useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { TokenTextarea } from '../TokenTextarea'
import { IconButton } from '../ui'
import { Tooltip } from '../Tooltip'
import { useMentionMenu } from './useMentionMenu'
import { useTextSize } from '../../lib/textSize'

interface Upload {
  key: number
  file: File
  status: 'uploading' | 'done' | 'failed'
  roomFile?: RoomFile
  error?: string
  abort: AbortController
}

let uploadKey = 0

export function RoomComposer({ roomId, threadRootId = null, members, meId, onSent, empty = false, autoFocus = false }: { roomId: string; threadRootId?: string | null; members: UserRef[]; meId: string | null; onSent: () => void; empty?: boolean; autoFocus?: boolean }) {
  const t = useT()
  const locale = useLocale()
  // the room's box and each thread's box keep their own draft
  const key = placeKey(roomId, threadRootId)
  const [text, setTextState] = useState(() => drafts.get(key) ?? '')
  const [alsoInRoom, setAlsoInRoom] = useState(false)
  const [files, setFiles] = useState<Upload[]>([])
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const setText = (s: string) => {
    setTextState(s)
    if (s) drafts.set(key, s)
    else drafts.delete(key)
  }
  const mention = useMentionMenu({ text, setText, input, members, meId, ai: true, initial: roomDraftMentions.get(key) })
  // the draft keeps its mentions too
  useEffect(() => {
    if (mention.picked.length) roomDraftMentions.set(key, mention.picked)
    else roomDraftMentions.delete(key)
  }, [key, mention.picked])
  // a send the server refused (the AI still answering my last question, …) comes back here, not as a failed bubble
  const back = useRooms((s) => s.returned[key])
  useEffect(() => {
    if (!back) return
    useRooms.getState().takeReturned(key)
    mention.putBack(back.body, back.mentions)
    if (back.alsoInRoom) setAlsoInRoom(true)
    if (back.files.length) setFiles((list) => [...back.files.map((f) => ({ key: ++uploadKey, file: { name: f.name, size: f.size } as File, status: 'done' as const, roomFile: f, abort: new AbortController() })), ...list])
    input.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back])

  // the box grows with its text, and is measured again when the person's text size changes
  const textSize = useTextSize()
  useLayoutEffect(() => {
    const ta = input.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [text, textSize])
  // a thread just opened (from "reply in thread"): the box is where the person types next
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true })
  }, [autoFocus])
  // leaving the room stops uploads still on their way (they would never be sent)
  const current = useRef(files)
  current.current = files
  useEffect(() => () => current.current.forEach((f) => f.status === 'uploading' && f.abort.abort()), [])

  const upload = async (u: Upload) => {
    try {
      const f = await api.call(API.uploadRoomFile, { params: { id: roomId }, body: { fields: { size: String(u.file.size) }, file: u.file, filename: u.file.name }, signal: u.abort.signal })
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'done', roomFile: f } : x)))
    } catch (e) {
      if (u.abort.signal.aborted) return
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'failed', error: errorText(e, locale, t('error.network')) } : x)))
    }
  }

  const addFiles = (picked: File[]) => {
    const room = ROOM_FILES_MAX - files.length
    if (picked.length > room) toast({ level: 'warn', text: t('rooms.tooMany', { n: ROOM_FILES_MAX }) })
    const added: Upload[] = []
    for (const file of picked.slice(0, Math.max(0, room))) {
      if (file.size > SMALL_UPLOAD_MAX) {
        toast({ level: 'warn', text: t('rooms.tooBig', { name: file.name, max: formatSize(SMALL_UPLOAD_MAX, locale) }) })
        continue
      }
      added.push({ key: ++uploadKey, file, status: 'uploading', abort: new AbortController() })
    }
    if (!added.length) return
    setFiles((list) => [...list, ...added])
    for (const u of added) void upload(u)
  }

  const removeFile = (u: Upload) => {
    u.abort.abort()
    setFiles((list) => list.filter((x) => x.key !== u.key))
  }

  const body = text.trim()
  const ready = files.filter((f) => f.status === 'done')
  const canSend = (body.length > 0 || ready.length > 0) && files.every((f) => f.status === 'done') && text.length <= ROOM_MESSAGE_MAX

  const submit = () => {
    if (!canSend) return
    useRooms.getState().send(roomId, { body, mentions: mention.mentions(), files: ready.map((f) => f.roomFile!), threadRootId, alsoInRoom: !!threadRootId && alsoInRoom })
    setText('')
    setFiles([])
    mention.reset()
    setAlsoInRoom(false)
    onSent()
    input.current?.focus()
  }

  return (
    <div className="shrink-0 pb-[max(0.75rem,var(--safe-bottom))] max-sm:border-t max-sm:border-line max-sm:pt-1 sm:px-4" data-bottom-bar>
      <div
        className={clsx('mx-auto max-w-[780px] transition sm:rounded-2xl sm:border sm:bg-surface', drag ? 'sm:border-accent sm:ring-2 sm:ring-accent/30' : 'sm:border-field-border sm:focus-within:border-faint')}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setDrag(false)
          addFiles(Array.from(e.dataTransfer.files))
        }}
        data-testid="room-composer"
      >
        {mention.list}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-2" aria-label={t('composer.attachments')}>
            {files.map((f) => (
              <li key={f.key} className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1 pr-1 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : 'border-line bg-subtle')} data-testid="room-file-chip" data-status={f.status}>
                {f.status === 'uploading' ? <Loader2 size={14} className="animate-spin text-faint" aria-hidden /> : <FileText size={14} className="text-muted" aria-hidden />}
                <span className="max-w-[180px] truncate font-medium">{f.file.name}</span>
                <span role="status" className={f.status === 'failed' ? 'max-w-[160px] truncate text-danger' : 'text-faint'} title={f.error}>
                  {f.status === 'uploading' ? <span className="sr-only">{t('rooms.uploading', { name: f.file.name })}</span> : f.status === 'failed' ? f.error : formatSize(f.file.size, locale)}
                </span>
                <IconButton tip label={t('rooms.removeFile', { name: f.file.name })} onClick={() => removeFile(f)} className="p-1">
                  <X size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1 px-1.5 py-1.5 max-md:px-3">
          <IconButton tip label={t('composer.attach')} onClick={() => picker.current?.click()} className="touch-hit mb-0.5" data-testid="room-attach">
            <Paperclip size={18} />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <TokenTextarea
            ref={input}
            rows={1}
            value={text}
            aria-label={t('composer.label')}
            placeholder={threadRootId ? t('rooms.threadPlaceholder') : empty ? t('rooms.placeholderEmpty') : t('rooms.placeholder')}
            maxLength={ROOM_MESSAGE_MAX}
            {...mention.inputProps}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files)
              if (pasted.length) {
                e.preventDefault()
                addFiles(pasted)
              }
            }}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                // touch screens: Enter makes a new line (the button sends)
                if (window.matchMedia?.('(pointer: coarse)').matches) return
                e.preventDefault()
                submit()
              }
            }}
            containerClassName="min-w-0 flex-1"
            className="max-h-[200px] resize-none px-1.5 py-2 text-reading leading-reading text-ink outline-none placeholder:text-faint"
            data-testid="room-input"
          />
          <Tooltip label={t('chat.send')}>
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={t('chat.send')}
              className={clsx('touch-hit mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
              data-testid="room-send"
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      {/* a thread's reply may go to the room too: one quiet choice under the box (off again after each send) */}
      {threadRootId && (
        <label className="mx-auto flex max-w-[780px] cursor-pointer items-center gap-2 px-1 pt-1.5 text-xs text-muted select-none max-sm:px-4 max-sm:pt-0.5 max-sm:pb-1" data-testid="room-also-in-room">
          <input type="checkbox" checked={alsoInRoom} onChange={(e) => setAlsoInRoom(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          {t('rooms.alsoToRoom')}
        </label>
      )}
    </div>
  )
}
