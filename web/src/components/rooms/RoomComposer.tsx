// The message box of a room: text that grows with what is typed (Enter sends, Shift+Enter makes a new line, nothing
// happens while a Korean or Japanese word is still being composed; on touch screens Enter makes a new line and the
// button sends, like the AI chat's box), files (the clip, paste, or a drop anywhere on the room's column or the thread
// around the box: components/FileDropZone.tsx; each is uploaded at once with POST /api/rooms/:id/files and sent by id;
// a picture shows as itself at once, a 64 px square, while it uploads), and "@"
// for the room's members: a picked name (or "@트리나") stands out in the
// box at once and is sent as a mention (useMentionMenu, components/TokenTextarea.tsx). "@전체" notifies everyone in the
// room (not in a DM; in the everyone room only for owners and admins); in a room of MENTION_ALL_CONFIRM people or more the
// send asks first, in one line inside the box ("N명에게 알림이 가요. 보낼까요?"). In a thread (threadRootId) it
// writes a reply, with one quiet choice under the box: "대화방에도 보내기" (the reply goes to the room's timeline too).
// Voice input as in the AI chat's box (lib/useVoiceInput.ts, components/VoiceBar.tsx), under the same team switch: the
// mic right before send (the clip stays on the left), Space held in the box on a computer, a finger held on the mic; the words go into the box as
// text (never a voice message, never sent by themselves). A room names no chat: while every chat is confidential and
// voice input goes to an outside service, the mic says so instead (lib/voice.ts voiceBlockedInRoom).
// The round send button is the screen's one primary action. Phones: a flat bar under a hairline, no frame.
// Two boxes can write the same place at once (a thread on the room page and beside one of its files in the viewer): the
// one that stays takes the other's draft when it goes, and a refused send comes back into one of them.
import clsx from 'clsx'
import { ArrowUp, FileText, Loader2, Paperclip, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ROOM_FILES_MAX, ROOM_MESSAGE_MAX, SMALL_UPLOAD_MAX, type RoomFile, type UserRef } from '@mycel/shared/api'
import { api, API, errorText, roomFileUrl } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { pastedFiles } from '../../lib/paste'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { micState, voiceBlockedInRoom } from '../../lib/voice'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { placeKey, roomDraftMentions, roomDrafts as drafts, useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { TokenTextarea } from '../TokenTextarea'
import { Button, IconButton } from '../ui'
import { Tooltip } from '../Tooltip'
import { isLocalImage, PictureTile } from '../ChipThumb'
import { ImageGroup } from '../ImageViewer'
import { localItem, roomItem } from '../../lib/imageViewer'
import { VoiceBar, VoiceLive, VoiceMic, VoiceProgress } from '../VoiceBar'
import { useEveryone, useMentionMenu } from './useMentionMenu'
import { useTextSize } from '../../lib/textSize'
import { usePanelExpanded } from '../../lib/sidePanel'
import { useFileDrop } from '../chat/ComposerFiles'
import { useDropTarget } from '../FileDropZone'

interface Upload {
  key: number
  file: File
  status: 'uploading' | 'done' | 'failed'
  roomFile?: RoomFile
  error?: string
  abort: AbortController
}

let uploadKey = 0

/** It shows as a picture (a square, not a file chip): one from this computer, or a photo of a send the server gave back (its room thumbnail). */
const picture = (u: Upload) => isLocalImage(u.file) || (u.roomFile?.kind === 'image' && !!u.roomFile.thumb)

/** From this many members (me included) a message with "@전체" asks before it goes. */
export const MENTION_ALL_CONFIRM = 10

/** the boxes on screen for each place (placeKey), each with how it reads the place's draft again */
const boxesOf = new Map<string, Set<() => void>>()

export function RoomComposer({ roomId, threadRootId = null, members, meId, onSent, empty = false, autoFocus = false }: { roomId: string; threadRootId?: string | null; members: UserRef[]; meId: string | null; onSent: () => void; empty?: boolean; autoFocus?: boolean }) {
  const t = useT()
  const locale = useLocale()
  // the room's box and each thread's box keep their own draft
  const key = placeKey(roomId, threadRootId)
  const [text, setTextState] = useState(() => drafts.get(key) ?? '')
  const [alsoInRoom, setAlsoInRoom] = useState(false)
  const [files, setFiles] = useState<Upload[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const setText = (s: string) => {
    setTextState(s)
    if (s) drafts.set(key, s)
    else drafts.delete(key)
  }
  // "@전체": everyone else in the room, where it is offered (useEveryone)
  const everyone = useEveryone(roomId, members, meId)
  const others = members.filter((m) => m.id !== meId).length
  const me = useMe()
  // "@트리나" in the "@" list only while the server still takes it (Me.server.roomAiMentions; off by default: the
  // side chat, ✦ in the room's header, asks the AI beside the room)
  const aiMentions = !!me?.server?.roomAiMentions
  const mention = useMentionMenu({ text, setText, input, members, meId, ai: aiMentions, initial: roomDraftMentions.get(key), everyone })
  const [asking, setAsking] = useState(false)
  // voice input off (Admin > Team settings): no mic for members, a hint to the setting for admins
  const mic = micState(me)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const latest = useRef(text)
  latest.current = text
  const root = useRef<HTMLDivElement>(null)
  const voice = useVoiceInput({
    input,
    root,
    room: true,
    text,
    // (through the token box's own change: the mentions' ranges follow what the words replace)
    replace: mention.inputProps.onTextChange,
    append: (said) => {
      const cur = latest.current
      setText(cur.trim() ? `${cur.trimEnd()} ${said}` : said)
    },
    blocked: voiceBlockedInRoom(me),
    enabled: mic === 'on',
    menuOpen: mention.open,
    onError: setVoiceError,
    afterFocus: mention.inputProps.onSelect,
  })
  // the draft keeps its mentions too
  useEffect(() => {
    if (mention.picked.length) roomDraftMentions.set(key, mention.picked)
    else roomDraftMentions.delete(key)
  }, [key, mention.picked])
  // another box of this place (the same thread beside a file in the viewer) goes: what it left is this box's draft now
  const mentionNow = useRef(mention)
  mentionNow.current = mention
  useEffect(() => {
    const reread = () => {
      const d = drafts.get(key) ?? ''
      if (d !== latest.current) mentionNow.current.restore(d, roomDraftMentions.get(key) ?? [])
    }
    const set = boxesOf.get(key) ?? new Set<() => void>()
    boxesOf.set(key, set)
    set.add(reread)
    return () => {
      set.delete(reread)
      if (!set.size) boxesOf.delete(key)
      for (const f of set) f()
    }
  }, [key])
  // a send the server refused (the AI still answering my last question, …) comes back here, not as a failed bubble
  // (into one box: the first to take it)
  const back = useRooms((s) => s.returned[key])
  useEffect(() => {
    if (!back || useRooms.getState().returned[key] !== back) return
    useRooms.getState().takeReturned(key)
    mention.putBack(back.body, back.mentions, !!back.mentionsAll)
    if (back.alsoInRoom) setAlsoInRoom(true)
    if (back.files.length) setFiles((list) => [...back.files.map((f) => ({ key: ++uploadKey, file: { name: f.name, size: f.size } as File, status: 'done' as const, roomFile: f, abort: new AbortController() })), ...list])
    input.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back])

  // the box grows with its text (an empty box with its placeholder: a transcription job's long label), and is measured
  // again when the person's text size changes. Behind a big side panel (lib/sidePanel.ts) it is not drawn and measures
  // 0: it keeps its height, and is measured again when the room shows
  const textSize = useTextSize()
  const behindPanel = usePanelExpanded()
  const placeholder = voice.transcribing ? voice.transcribingText : threadRootId ? t('rooms.threadPlaceholder') : empty ? t(aiMentions ? 'rooms.placeholderEmpty' : 'rooms.placeholderEmptySide') : t('rooms.placeholder')
  useLayoutEffect(() => {
    const ta = input.current
    if (!ta) return
    const was = ta.style.height
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight ? Math.min(ta.scrollHeight, 200) + 'px' : was
  }, [text, textSize, placeholder, voice.recording, behindPanel])
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

  // files dropped on the column around the box (the room's, the thread's: FileDropZone) come here, with its checks: a box
  // with no room left for one more refuses the whole drop. Outside every column the box takes drops on itself.
  const inZone = useDropTarget({ files: addFiles, refusal: () => (files.length >= ROOM_FILES_MAX ? t('rooms.tooMany', { n: ROOM_FILES_MAX }) : null) })
  const { drag, dropProps } = useFileDrop({ files: inZone ? undefined : addFiles })

  const removeFile = (u: Upload) => {
    u.abort.abort()
    setFiles((list) => list.filter((x) => x.key !== u.key))
  }

  const body = text.trim()
  const ready = files.filter((f) => f.status === 'done')
  const canSend = (body.length > 0 || ready.length > 0) && files.every((f) => f.status === 'done') && text.length <= ROOM_MESSAGE_MAX && !voice.busy

  const all = mention.mentionsAll()
  // the question shows while the message still has "@전체" (taken out, there is nothing to ask, and a later one asks anew)
  const ask = asking && all
  useEffect(() => {
    if (!all) setAsking(false)
  }, [all])
  const submit = (sure = false) => {
    if (!canSend) return
    if (all && members.length >= MENTION_ALL_CONFIRM && !sure) {
      setAsking(true)
      return
    }
    setAsking(false)
    useRooms.getState().send(roomId, { body, mentions: mention.mentions(), ...(all ? { mentionsAll: true } : {}), files: ready.map((f) => f.roomFile!), threadRootId, alsoInRoom: !!threadRootId && alsoInRoom })
    setText('')
    setFiles([])
    mention.reset()
    setAlsoInRoom(false)
    setVoiceError(null)
    onSent()
    input.current?.focus()
  }

  return (
    <div ref={root} className="shrink-0 pb-[max(0.75rem,var(--safe-bottom))] max-sm:border-t max-sm:border-line max-sm:pt-1 sm:px-4" data-bottom-bar>
      <VoiceLive voice={voice} />
      <div
        className={clsx('mx-auto max-w-[780px] transition sm:rounded-2xl sm:border sm:bg-surface', drag ? 'sm:border-accent sm:ring-2 sm:ring-accent/30' : 'sm:border-field-border sm:focus-within:border-faint')}
        {...dropProps}
        data-testid="room-composer"
      >
        {!voice.recording && mention.list}
        {/* the question about "@전체" (hidden while recording, like the "@" list) */}
        {ask && !voice.recording && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-2.5 max-md:px-4" data-testid="room-mention-all-confirm">
            <p role="status" className="min-w-0 flex-1 text-sm text-ink">
              {t('rooms.mentionAllConfirm', { n: others })}
            </p>
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setAsking(false); input.current?.focus() }} data-testid="room-mention-all-cancel">
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => submit(true)} disabled={!canSend} data-testid="room-mention-all-send">
                {t('chat.send')}
              </Button>
            </div>
          </div>
        )}
        {files.length > 0 && (
          // centred on the row: a file's compact chip beside a picture's 64 px square keeps its own height; the box's
          // pictures are one pane of the image viewer (← →)
          <ImageGroup>
          <ul className="flex flex-wrap items-center gap-2 px-3 pt-2" aria-label={t('composer.attachments')}>
            {files.map((f) =>
              picture(f) ? (
                // a picture as itself, at once: from this computer, or a photo of a send the server gave back (its room
                // thumbnail); its words for screen readers, a failure's reason beside it
                <li key={f.key} className="flex max-w-full items-center gap-2 pt-1.5 pr-1.5 text-xs" data-testid="room-file-chip" data-status={f.status}>
                  <PictureTile
                    name={f.file.name}
                    file={isLocalImage(f.file) ? f.file : undefined}
                    src={isLocalImage(f.file) ? undefined : roomFileUrl(roomId, f.roomFile!.id, { thumb: '1' })}
                    busy={f.status === 'uploading'}
                    failed={f.status === 'failed'}
                    removeLabel={t('rooms.removeFile', { name: f.file.name })}
                    onRemove={() => removeFile(f)}
                    // its own bytes in the image viewer, or the room's copy the server gave back
                    item={isLocalImage(f.file) ? localItem(String(f.key), f.file, f.file.name) : roomItem(roomId, f.roomFile!)}
                  />
                  <span role="status" className={f.status === 'failed' ? 'max-w-[160px] truncate text-danger' : 'sr-only'} title={f.error}>
                    {f.status === 'uploading' ? t('rooms.uploading', { name: f.file.name }) : f.status === 'failed' ? f.error : formatSize(f.file.size, locale)}
                  </span>
                </li>
              ) : (
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
              ),
            )}
          </ul>
          </ImageGroup>
        )}
        {voice.recording ? (
          // as tall as the box's row (one slot and the row's padding), ✕ and ✓ where the clip and send were: nothing moves
          <VoiceBar voice={voice} className="box-content min-h-composer-line px-1.5 py-1.5 max-md:px-3" />
        ) : (
          <>
            <VoiceProgress voice={voice} text={text} className="px-3 pt-2 max-md:px-4" />
            {/* bottom-aligned; each control centred in a slot as tall as one text line's box (index.css
                --spacing-composer-line): one line, one centre; more lines, the buttons stay on the last */}
            <div className="flex items-end gap-1 px-1.5 py-1.5 max-md:px-3">
              <div className="flex h-composer-line shrink-0 items-center">
                <IconButton tip label={t('composer.attach')} onClick={() => picker.current?.click()} className="touch-hit" data-testid="room-attach">
                  <Paperclip size={18} />
                </IconButton>
              </div>
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
                placeholder={placeholder}
                // not disabled: the focus stays in the box while the words are on their way
                readOnly={voice.busy}
                aria-busy={voice.transcribing || undefined}
                maxLength={ROOM_MESSAGE_MAX}
                {...mention.inputProps}
                onPaste={(e) => {
                  const pasted = pastedFiles(e.clipboardData)
                  if (pasted.length) {
                    e.preventDefault()
                    addFiles(pasted)
                  }
                }}
                onKeyDown={(e) => {
                  if (mention.onKeyDown(e)) return
                  if (voice.onKeyDown(e)) return
                  // the question about "@전체": Esc puts it away, Enter answers it as 보내기
                  if (ask && e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault()
                    e.stopPropagation()
                    setAsking(false)
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    // touch screens: Enter makes a new line (the button sends)
                    if (window.matchMedia?.('(pointer: coarse)').matches) return
                    e.preventDefault()
                    submit(ask)
                  }
                }}
                containerClassName="min-w-0 flex-1"
                className="max-h-[200px] resize-none px-1.5 py-2 text-reading leading-reading text-ink outline-none placeholder:text-faint"
                data-testid="room-input"
              />
              {/* the mic right before send, as in ChatGPT's box */}
              <div className="flex h-composer-line shrink-0 items-center gap-1">
                <VoiceMic voice={voice} mic={mic} tip />
                <Tooltip label={t('chat.send')}>
                  <button
                    type="button"
                    onClick={() => submit(ask)}
                    disabled={!canSend}
                    aria-label={t('chat.send')}
                    className={clsx('touch-hit flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
                    data-testid="room-send"
                  >
                    <ArrowUp size={18} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </div>
          </>
        )}
      </div>
      {voiceError && (
        <p role="alert" className="mx-auto max-w-[780px] px-1 pt-1.5 text-xs text-danger max-sm:px-4" data-testid="room-voice-error">
          {voiceError}
        </p>
      )}
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
