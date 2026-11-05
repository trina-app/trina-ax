// The message box of a room: text that grows with what is typed (Enter sends, Shift+Enter makes a new line, nothing
// happens while a Korean or Japanese word is still being composed; on touch screens Enter makes a new line and the
// button sends, like the AI chat's box), files (the clip, paste or drop; each is uploaded at once with POST
// /api/rooms/:id/files and sent by id), the message it answers (a chip with a way out), and "@" for the room's members.
// The round send button is the screen's one primary action. Phones: a flat bar under a hairline, no frame.
import clsx from 'clsx'
import { ArrowUp, CornerUpLeft, FileText, Loader2, Paperclip, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ROOM_FILES_MAX, ROOM_MESSAGE_MAX, SMALL_UPLOAD_MAX, type RoomFile, type RoomQuote, type UserRef } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { roomDrafts as drafts, useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { IconButton } from '../ui'
import { useMentionMenu } from './useMentionMenu'

interface Upload {
  key: number
  file: File
  status: 'uploading' | 'done' | 'failed'
  roomFile?: RoomFile
  error?: string
  abort: AbortController
}

let uploadKey = 0

export function RoomComposer({ roomId, members, meId, reply, onCancelReply, onSent, gone }: { roomId: string; members: UserRef[]; meId: string | null; reply: RoomQuote | null; onCancelReply: () => void; onSent: () => void; gone: string }) {
  const t = useT()
  const locale = useLocale()
  const [text, setTextState] = useState(() => drafts.get(roomId) ?? '')
  const [files, setFiles] = useState<Upload[]>([])
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const setText = (s: string) => {
    setTextState(s)
    if (s) drafts.set(roomId, s)
    else drafts.delete(roomId)
  }
  const mention = useMentionMenu({ text, setText, input, members, meId })

  useLayoutEffect(() => {
    const ta = input.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [text])
  // answering a message: the box is where the person types next
  useEffect(() => {
    if (reply) input.current?.focus()
  }, [reply])
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
    useRooms.getState().send(roomId, { body, mentions: mention.mentions(), replyTo: reply, files: ready.map((f) => f.roomFile!) })
    setText('')
    setFiles([])
    mention.reset()
    onCancelReply()
    onSent()
    input.current?.focus()
  }

  return (
    <div className="shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:border-t max-sm:border-line max-sm:pt-1 sm:px-4">
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
        {reply && (
          <div className="flex items-center gap-2 pt-2 pr-1.5 pl-3 text-xs" data-testid="reply-chip">
            <CornerUpLeft size={13} className="shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-muted">
              <span className="font-medium text-ink">{t('rooms.replyTo', { name: reply.author?.name ?? gone })}</span>
              {reply.excerpt && <span> · {reply.excerpt}</span>}
            </span>
            <IconButton label={t('rooms.cancelReply')} onClick={onCancelReply} className="p-1">
              <X size={14} />
            </IconButton>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-2" aria-label={t('composer.attachments')}>
            {files.map((f) => (
              <li key={f.key} className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1 pr-1 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : 'border-line bg-subtle')} data-testid="room-file-chip" data-status={f.status}>
                {f.status === 'uploading' ? <Loader2 size={14} className="animate-spin text-faint" aria-hidden /> : <FileText size={14} className="text-muted" aria-hidden />}
                <span className="max-w-[180px] truncate font-medium">{f.file.name}</span>
                <span role="status" className={f.status === 'failed' ? 'max-w-[160px] truncate text-danger' : 'text-faint'} title={f.error}>
                  {f.status === 'uploading' ? <span className="sr-only">{t('rooms.uploading', { name: f.file.name })}</span> : f.status === 'failed' ? f.error : formatSize(f.file.size, locale)}
                </span>
                <IconButton label={t('rooms.removeFile', { name: f.file.name })} onClick={() => removeFile(f)} className="p-1">
                  <X size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1 px-1.5 py-1.5">
          <IconButton label={t('composer.attach')} onClick={() => picker.current?.click()} className="mb-0.5" data-testid="room-attach">
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
          <textarea
            ref={input}
            rows={1}
            value={text}
            aria-label={t('composer.label')}
            placeholder={t('rooms.placeholder')}
            maxLength={ROOM_MESSAGE_MAX}
            {...mention.inputProps}
            onChange={(e) => {
              setText(e.target.value)
              mention.track()
            }}
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
            className="block max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-6 text-ink outline-none placeholder:text-faint"
            data-testid="room-input"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label={t('chat.send')}
            title={t('chat.send')}
            className={clsx('mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
            data-testid="room-send"
          >
            <ArrowUp size={18} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
