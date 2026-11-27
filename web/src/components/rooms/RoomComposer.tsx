// The message box of a room: text that grows with what is typed (Enter sends, Shift+Enter makes a new line, nothing
// happens while a Korean or Japanese word is still being composed; on touch screens Enter makes a new line and the
// button sends, like the AI chat's box), files (the clip, paste, or a drop anywhere on the room's column or the thread
// around the box: components/FileDropZone.tsx; each is uploaded at once and sent by id: a small one with POST /api/rooms/:id/files, a larger one, up to 1 GB, in
// 8 MB pieces through an upload session that goes on after a lost connection (lib/upload.ts), what happens to it on the chip
// (waiting for its turn, being checked, its percent, finishing: components/UploadLabel.tsx);
// a picture shows as itself at once, a 64 px square, while it uploads), and "@"
// for the room's members: a picked name stands out in the
// box at once and is sent as a mention (useMentionMenu, components/TokenTextarea.tsx). "@전체" notifies everyone in the
// room (not in a DM; in the everyone room only for owners and admins); in a room of MENTION_ALL_CONFIRM people or more the
// send asks first, in one line inside the box ("N명에게 알림이 가요. 보낼까요?"), with one quiet tick "더 이상 묻지 않기" (Don't
// ask again: prefs.mentionAllAsk, one choice for every room and device; Settings › Notifications turns it back on). In a thread (threadRootId) it
// writes a reply, with one quiet choice under the box: "대화방에도 보내기" (the reply goes to the room's timeline too).
// Voice input as in the AI chat's box (lib/useVoiceInput.ts, components/VoiceBar.tsx), under the same team switch: the
// mic right before send (the clip stays on the left), Space held in the box on a computer, a finger held on the mic; the words go into the box as
// text (never a voice message, never sent by themselves). A room names no chat: while every chat is confidential and
// voice input goes to an outside service, the mic says so instead (lib/voice.ts voiceBlockedInRoom).
// The round send button is the screen's one primary action. Computers: the text on top and one row under it inside the
// frame, the clip on the left and the mic and send on the right (chat/ComposerToolbar.tsx, as every message box). Phones: the same frame (QA TC-1550), but one line inside it with only the clip and send; the clip is the
// attach sheet every message box has there (components/chat/AttachSheet.tsx: 사진 보관함, 사진 찍기, 파일, 팀 파일). A team
// file is copied as my upload in the room (POST /api/rooms/:id/team-file, the copy "대화방에 보내기" makes) and sent by
// id like any upload; a line under the files says how many more people it reaches (members who cannot open the team
// file). With the keyboard up the box keeps its text field and send in sight: its files in one sideways row, the "@"
// list and the text field each a part of what is in sight (useMentionMenu; at most 30 % for the text).
// While the person writes, the others in the room (in a thread: those who see it) are told "typing" (lib/roomTyping.ts,
// at most every 3 s; "stopped" on send, an emptied box, blur, leaving), and one quiet line over the box names who else
// is writing here (RoomTypingLine, docs/DECISIONS.md "입력 중 표시").
// Editing my own message on a phone happens here (store/roomEdit.ts; RoomMessages.tsx marks the message): the box says
// "Editing message" and holds the message's whole text with its mentions, the caret at its end; ✕ and ✓ take the send
// button's place, and the clip, the mic, the files, "Also send to the room" and the "@전체" question step aside. ✓ saves
// (not while the text is empty or unchanged), ✕ or Esc cancels; either way the reply that was being written comes back.
// Return makes a new line on a touch screen, Enter saves with a keyboard, as sending does.
// Two boxes can write the same place at once (a thread on the room page and beside one of its files in the viewer): the
// one that stays takes the other's draft when it goes, and a refused send comes back into one of them.
import { composerInset } from '../chat/composerBox'
import clsx from 'clsx'
import { Check, FileText, FolderOpen, Loader2, Pencil, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ROOM_FILE_MAX, ROOM_FILES_MAX, ROOM_MESSAGE_MAX, SMALL_UPLOAD_MAX, type FileEntry, type UserRef } from '@mycel/shared/api'
import { api, API, errorText, roomFileUrl } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { formatSize } from '../../lib/format'
import { NO_UPLOADS, nextUploadKey, roomTarget as targetOf, setPlaceUploads, teamCopies, useRoomUploads, type RoomUpload } from '../../store/roomUploads'
import { useSlackLink } from '../../store/slackRelay'
import { cancelUpload, SINGLE_REQUEST_MAX, unreadableFile, uploadFile, uploadPercent } from '../../lib/upload'
import { UploadLabel } from '../UploadLabel'
import { pastedFiles } from '../../lib/paste'
import { pastedTextFile, pasteOverLimit } from '../../lib/longPaste'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { micState, voiceBlockedInRoom } from '../../lib/voice'
import { currentLocale, translate, useLocale, useT } from '../../i18n'
import { myUploadMax } from '../../lib/guests'
import { isAdmin, useMe, useSession } from '../../store/session'
import { findMessage, keepRoomDraft, onRoomDraftElsewhere, placeKey, restoreRoomDraft, roomDraftMentions, roomDrafts as drafts, useRooms } from '../../store/rooms'
import { failedEdits, hasRoomBox, registerRoomBox, useRoomEdit } from '../../store/roomEdit'
import { usePeople } from '../../store/people'
import { useEndAfterRecording } from '../../lib/autoGrow'
import { allMentionNames, lineBreaks, MENTION_ALL_CONFIRM, type PickedMention } from '../../lib/rooms'
import { toast } from '../../store/ui'
import { Button, useMediaQuery } from '../ui'
import { Tooltip } from '../Tooltip'
import { ChipRemove, chipText, FAILED_REASON, isHeicName, isLocalImage, PictureTile } from '../ChipThumb'
import { ImageGroup } from '../ImageViewer'
import { localItem, roomItem } from '../../lib/imageViewer'
import { MENTION_ALL_WORDS, pickedInMessage, useEveryone, useMentionMenu } from './useMentionMenu'
import { useFileDrop } from '../chat/ComposerFiles'
import { withoutFolders } from '../../lib/fileDrop'
import { useDropTarget } from '../FileDropZone'
import { storagePlansUrl } from '../StoragePlansLink'
import { isStorageFull, RefusalLinks, storageFullText } from './storageRefusal'
import { AttachMenu } from '../composer/AttachMenu'
import { ComposerField } from '../composer/ComposerField'
import { ComposerShell } from '../composer/ComposerShell'
import { ComposerNotices } from '../composer/ComposerNotices'
import { enterSends, composing } from '../composer/keys'
import { sendTyping, TypingSender } from '../../lib/roomTyping'
import { RoomTypingLine } from './RoomTypingLine'
import { MessageLinkChoice, useLinkChoice } from './MessageLinkChoice'

type Upload = RoomUpload

/** It shows as a picture (a square, not a file chip): one from this computer, or a photo of a send the server gave back (its room thumbnail). */
// an iPhone photo (HEIC) is a picture square from the start: the room's thumbnail once it is sent (a picture icon until then)
const picture = (u: Upload) => isLocalImage(u.file) || isHeicName(u.file.name) || (u.roomFile?.kind === 'image' && !!u.roomFile.thumb)


/** the boxes on screen for each place (placeKey), each with how it reads the place's draft again */
const boxesOf = new Map<string, Set<() => void>>()
// another tab of mine changed a place's draft (sent it, typed in it): the boxes of that place here show it too
onRoomDraftElsewhere((key) => {
  for (const f of boxesOf.get(key) ?? []) f()
})

/** `above`: one quiet line over the box (a DM's status line, components/StatusMessage.tsx) */
export function RoomComposer({ roomId, threadRootId = null, members, meId, onSent, autoFocus = false, above }: { roomId: string; threadRootId?: string | null; members: UserRef[]; meId: string | null; onSent: () => void; autoFocus?: boolean; above?: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  // the room's box and each thread's box keep their own draft
  const key = placeKey(roomId, threadRootId)
  // (the draft this device kept for the place when this page has none: the app was closed, or the page loaded again)
  const [text, setTextState] = useState(() => {
    restoreRoomDraft(key)
    return drafts.get(key) ?? ''
  })
  const [alsoInRoom, setAlsoInRoom] = useState(false)
  // the place's files live above the box (store/roomUploads.ts): one that is still going up when the person opens
  // another room or page goes on, and is here when they come back. Nothing is sent before they press send here
  const files = useRoomUploads((s) => s.byPlace[key] ?? NO_UPLOADS)
  const setFiles = useCallback((next: Upload[] | ((list: Upload[]) => Upload[])) => setPlaceUploads(key, next), [key])
  const input = useRef<HTMLTextAreaElement>(null)
  // below 768px: one line, and a message is edited here
  const phone = useMediaQuery('(max-width: 767.98px)')
  // editing a message here (a phone): the reply being written waits in `held` and stays the place's draft
  const editingNow = useRef(false)
  const setText = (s: string) => {
    setTextState(s)
    if (editingNow.current) return
    if (s) drafts.set(key, s)
    else drafts.delete(key)
    keepRoomDraft(key)
  }
  // "typing" for the others while the person changes the text in the box (not a draft put back or another tab's);
  // "stopped" when the box empties (a send too), on blur, and when the room or thread closes
  const typing = useMemo(() => new TypingSender((on) => sendTyping(roomId, threadRootId, on)), [roomId, threadRootId])
  useEffect(() => () => typing.stop(), [typing])
  const typedBefore = useRef(text)
  useEffect(() => {
    if (text === typedBefore.current) return
    typedBefore.current = text
    // an edit tells nobody "typing"
    if (editingNow.current) return
    if (!text.trim()) typing.stop()
    else if (typeof document !== 'undefined' && document.activeElement === input.current) typing.input(text)
  }, [text, typing])
  // a reply typed here (store/rooms.ts roomDrafts, kept on this device too): while there is one, the page does not
  // reload by itself (after an update, or once the connection is back: lib/reload-guard.ts), as the chat's box does
  useEffect(() => (text.trim() ? markBusy('draft') : undefined), [text])
  // "@전체": everyone else in the room, where it is offered (useEveryone)
  const everyone = useEveryone(roomId, members, meId)
  const others = members.filter((m) => m.id !== meId).length
  const me = useMe()
  // a project's chat room: a file sent here goes into the project's Chat attachments folder, so it needs write there
  // (Room.project.attach, for everyone, guests too; docs/decisions/20261120-project-is-room.md D1). Someone who may
  // only read the project, or only not that folder, sends text only (the server refuses with 403
  // shared_upload_read_only). A member who cannot open the project now has no Room.project: text only too.
  const roomNow = useRooms((s) => s.rooms.find((r) => r.id === roomId))
  const attach = roomNow?.project?.room ? (roomNow.project.attach ?? (roomNow.project.canSave ? 'ok' : 'read_only')) : roomNow?.projectRoom ? 'read_only' : 'ok'
  const noFiles = attach === 'ok' ? null : t(attach === 'folder' ? 'rooms.project.noAttachFolder' : 'rooms.project.noAttach')
  // the owner or an admin (never a guest): a full disk's refusal links what takes the space
  const staff = isAdmin(me)
  // the largest file I may send here: 1 GB, or for a guest what the team allows guests (Me.team.uploadMaxBytes;
  // the server checks it again)
  const fileMax = myUploadMax(me, ROOM_FILE_MAX)
  // my message being edited in this box (a phone: RoomMessages.tsx puts it in store/roomEdit.ts when this place has a box)
  const editId = useRoomEdit((s) => s.editing[key] ?? null)
  const editMsg = useRooms((s) => (editId ? findMessage(s, roomId, editId) ?? null : null))
  const editing = phone && !!editMsg && !editMsg.deletedAt
  // an edit keeps "@전체" or takes it out, never adds one: it notifies nobody (the server refuses it)
  const mention = useMentionMenu({ text, setText, input, members, meId, initial: roomDraftMentions.get(key), everyone: editing ? (editMsg!.mentionsAll ? { count: others } : null) : everyone })
  const [asking, setAsking] = useState(false)
  // "Don't ask again" ticked on the question (saved with the send); the person said so before: no question at all
  const [noAsk, setNoAsk] = useState(false)
  const askAll = me?.user.prefs?.mentionAllAsk !== 'off'
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
      const next = cur.trim() ? `${cur.trimEnd()} ${said}` : said
      // a live recording's next words may come before the box renders again
      latest.current = next
      setText(next)
    },
    blocked: voiceBlockedInRoom(me),
    enabled: mic === 'on',
    menuOpen: mention.open,
    onError: setVoiceError,
    afterFocus: mention.inputProps.onSelect,
  })
  // another room or thread in the same box: a recording for the last one goes (its words stay with that room's draft)
  const abandonVoice = voice.abandon
  useEffect(() => () => abandonVoice(), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  // the draft keeps its mentions too
  useEffect(() => {
    if (editingNow.current) return
    if (mention.picked.length) roomDraftMentions.set(key, mention.picked)
    else roomDraftMentions.delete(key)
    keepRoomDraft(key)
  }, [key, mention.picked])
  // another box of this place (the same thread beside a file in the viewer) goes: what it left is this box's draft now
  const mentionNow = useRef(mention)
  mentionNow.current = mention
  useEffect(() => {
    const reread = () => {
      const d = drafts.get(key) ?? ''
      // while an edit is open the draft waits; it comes back as the other box left it
      if (editingNow.current) return void (held.current = { text: d, picked: roomDraftMentions.get(key) ?? [] })
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
  // an edit that just closed puts the reply back on the next render: a returned send waits for it (then goes before it)
  const [backAgain, setBackAgain] = useState(0)
  useEffect(() => {
    if (editing || !back || useRooms.getState().returned[key] !== back) return
    if (justHeld.current) return void setTimeout(() => setBackAgain((n) => n + 1))
    useRooms.getState().takeReturned(key)
    mention.putBack(back.body, back.mentions, !!back.mentionsAll)
    if (back.alsoInRoom) setAlsoInRoom(true)
    if (back.files.length) setFiles((list) => [...back.files.map((f) => ({ key: nextUploadKey(), file: { name: f.name, size: f.size } as File, status: 'done' as const, roomFile: f, abort: new AbortController(), ...(teamCopies.has(f.id) ? { teamPath: teamCopies.get(f.id)!.path, unable: teamCopies.get(f.id)!.unable } : {}) })), ...list])
    input.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back, editing, backAgain])

  // this place has a box on screen: a phone's edit comes here (the last box to go ends it)
  useEffect(() => registerRoomBox(key, () => input.current?.focus({ preventScroll: true })), [key])
  // an edit this box cannot take (a computer's width now, the message gone) ends
  useEffect(() => {
    if (editId && !editing) useRoomEdit.getState().end(key)
  }, [editId, editing, key])
  /** the reply being written while an edit is open, with its mentions */
  const held = useRef<{ text: string; picked: PickedMention[] } | null>(null)
  /** the reply an edit that just closed put back (another message's edit opening in the same commit keeps it waiting) */
  const justHeld = useRef<{ text: string; picked: PickedMention[] } | null>(null)
  // an edit opens: the reply waits, the box takes the message's text (or the words of an edit that failed) with the
  // people it mentions, the caret at the end; it closes: the reply comes back
  useLayoutEffect(() => {
    if (!editing || !editMsg) return
    held.current = justHeld.current ?? { text: latest.current, picked: mentionNow.current.picked }
    justHeld.current = null
    editingNow.current = true
    typing.stop()
    const kept = failedEdits.get(editMsg.id) ?? null
    failedEdits.delete(editMsg.id)
    const body0 = lineBreaks(editMsg.body)
    const start = kept?.text ?? body0
    const byId = usePeople.getState().byId
    // a mention is the name as it was typed: the person's name now and as the member list has it
    const people = editMsg.mentions.flatMap((id) => [...new Set([byId[id]?.name ?? '', members.find((x) => x.id === id)?.name ?? ''])].map((name) => ({ id, name })))
    const keptPeople = kept ? members.filter((x) => kept.mentions.includes(x.id)) : []
    mentionNow.current.restore(start, pickedInMessage(start, [...people, ...keptPeople, ...allMentionNames(editMsg, MENTION_ALL_WORDS)]))
    // after the menu that opened it gives its focus back
    const caret = setTimeout(() => {
      const ta = input.current
      if (!ta) return
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(ta.value.length, ta.value.length)
      ta.scrollTop = ta.scrollHeight
    })
    return () => {
      clearTimeout(caret)
      editingNow.current = false
      const h = held.current
      held.current = null
      justHeld.current = h
      queueMicrotask(() => void (justHeld.current = null))
      // the reply coming back is no "typing"
      typedBefore.current = h?.text ?? ''
      mentionNow.current.restore(h?.text ?? '', h?.picked ?? [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editMsg?.id])

  // (the field grows with its text and its placeholder: composer/ComposerField.tsx)
  // a conversation linked to a Slack channel (docs/SLACK.md "Channel relay"): nobody is surprised that it goes there too
  const slack = useSlackLink(roomId)
  const relayed = slack?.state === 'active'
  const placeholder = voice.transcribing ? voice.transcribingText
    : threadRootId ? (relayed ? t('slackRelay.threadPlaceholder') : t('rooms.threadPlaceholder'))
    : relayed ? t('slackRelay.placeholder', { channel: slack.channelName }) : t('rooms.placeholder')
  // back after a recording: the newest words in sight, as they were while recording
  useEndAfterRecording(input, voice.recording, voice.busy, text)
  // a thread just opened (from "reply in thread"): the box is where the person types next
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true })
  }, [autoFocus])
  const roomTarget = (file: File) => targetOf(roomId, file)
  /** a failed file's words: a full disk's by the role I have now (an upload can outlive a role change and this box) */
  const failedText = (f: Upload) => (f.stopped ? t('rooms.uploadStopped') : f.full ? storageFullText(staff, locale) : f.error)
  /** a failed file's words, in the language of this moment (the box may be gone by now: another room). A full disk
   * is only marked (its words follow the role at render: failedText); the rest as the server words it */
  const failure = (e: unknown): Pick<Upload, 'error' | 'plans' | 'full'> => {
    const locale = currentLocale()
    if (isStorageFull(e)) return { error: undefined, plans: storagePlansUrl(e), full: true }
    // a file the browser could not read is not a lost connection (TC-4483)
    if (unreadableFile(e)) return { error: translate(locale, 'composer.unreadable') }
    return { error: errorText(e, locale, translate(locale, 'error.network')), plans: storagePlansUrl(e) }
  }
  /** A large file from this computer (one that goes in pieces) says what happens to it: waiting for its turn, being
   * checked, its percent, finishing (components/UploadLabel.tsx, as on the Files page). A small one is up in a moment:
   * it only spins, with its percent once there is one (a slow connection). */
  const says = (f: Upload) => !f.teamPath && (f.file.size > SINGLE_REQUEST_MAX || uploadPercent(f.progress) !== null)
  const upload = async (u: Upload) => {
    try {
      // a small file in one request, a larger one (up to 1 GB) in 8 MB pieces that go on after a lost connection
      // (lib/upload.ts): no single request is large, so it passes a proxy in front of the team server too
      const r = await uploadFile(u.file, roomTarget(u.file), { client: api, signal: u.abort.signal, onProgress: (progress) => setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, progress } : x))) })
      if (r.kind !== 'room') throw new Error('unexpected upload result')
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'done', roomFile: r.file, progress: undefined } : x)))
    } catch (e) {
      // taken out while its pieces went up: what the server holds of it is dropped (lib/upload.ts cancelUpload; nothing
      // to do for a small file). Leaving the room does not stop it (store/roomUploads.ts)
      if (u.abort.signal.aborted) { void cancelUpload(u.file, roomTarget(u.file), api); return }
      // the box may be gone by now (another room): the reason in the language of this moment
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'failed', ...failure(e) } : x)))
    }
  }

  /** `dropFolders`: the folders a drop held besides (lib/fileDrop.ts filesOfDrop). A folder is never a chip: one line
   * says so, however many there were; the files beside them go on as usual (TC-4483). */
  const addFiles = async (all: File[], dropFolders = 0): Promise<boolean> => {
    if (noFiles) {
      toast({ level: 'info', text: noFiles })
      return false
    }
    const sorted = await withoutFolders(all)
    if (dropFolders + sorted.folders) toast({ level: 'warn', text: t('composer.folders') })
    const picked = sorted.files
    // (the box as it is now: sorting the folders out took a moment, and a file may have come or gone meanwhile)
    const files = useRoomUploads.getState().byPlace[key] ?? NO_UPLOADS
    // a file the page's reload stopped (store/roomUploads.ts `stopped`) picked again: the pick takes that chip's place
    // (no room is needed for it), and a large one goes on from the pieces the server has (lib/upload.ts)
    const again = new Set<number>()
    let count = files.length, over = false
    const added: Upload[] = []
    for (const file of picked) {
      const twin = files.find((f) => f.stopped && !again.has(f.key) && f.file.name === file.name && f.file.size === file.size)
      if (!twin && count >= ROOM_FILES_MAX) { over = true; continue }
      // refused here, before a checksum of a huge file is made (the server refuses it too, before any byte is sent)
      if (file.size > fileMax) {
        toast({ level: 'warn', text: t('rooms.tooBig', { name: file.name, max: formatSize(fileMax, locale) }) })
        continue
      }
      if (twin) again.add(twin.key)
      else count++
      added.push({ key: nextUploadKey(), file, status: 'uploading', abort: new AbortController() })
    }
    if (over) toast({ level: 'warn', text: t('rooms.tooMany', { n: ROOM_FILES_MAX }) })
    if (!added.length) return false
    setFiles((list) => [...list.filter((x) => !again.has(x.key)), ...added])
    for (const u of added) void upload(u)
    return true
  }

  // team files (a phone's attach sheet): each copied as my upload in this room, a chip at once while it is copied, then
  // sent by id like any upload; the limits a picked file has are checked first (the server checks them again)
  const copyTeamFile = async (u: Upload) => {
    try {
      const r = await api.call(API.attachRoomTeamFile, { params: { id: roomId }, body: { path: u.teamPath! }, signal: u.abort.signal })
      teamCopies.set(r.file.id, { path: u.teamPath!, unable: r.unable })
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'done', roomFile: r.file, unable: r.unable, file: { name: r.file.name, size: r.file.size } as File } : x)))
    } catch (e) {
      if (u.abort.signal.aborted) return
      setFiles((list) => list.map((x) => (x.key === u.key ? { ...x, status: 'failed', ...failure(e) } : x)))
    }
  }
  const addTeamFiles = (picked: FileEntry[]) => {
    const room = ROOM_FILES_MAX - files.length
    if (picked.length > room) toast({ level: 'warn', text: t('rooms.tooMany', { n: ROOM_FILES_MAX }) })
    const added: Upload[] = []
    for (const f of picked.slice(0, Math.max(0, room))) {
      if ((f.size ?? 0) > SMALL_UPLOAD_MAX) {
        toast({ level: 'warn', text: t('rooms.tooBig', { name: f.name, max: formatSize(SMALL_UPLOAD_MAX, locale) }) })
        continue
      }
      added.push({ key: nextUploadKey(), file: { name: f.name, size: f.size ?? 0 } as File, status: 'uploading', abort: new AbortController(), teamPath: f.path })
    }
    if (!added.length) return
    setFiles((list) => [...list, ...added])
    for (const u of added) void copyTeamFile(u)
  }
  // how many more people the team files reach once sent: one file's count, or with several the largest as "at least"
  // (each count is of its own file; who they are is never told, so they cannot be added up)
  const widening = files.filter((f) => f.teamPath && f.status === 'done' && (f.unable ?? 0) > 0)
  const widens = Math.max(0, ...widening.map((f) => f.unable ?? 0))

  // files dropped on the column around the box (the room's, the thread's: FileDropZone) come here, with its checks: a box
  // with no room left for one more refuses the whole drop. Outside every column the box takes drops on itself.
  const inZone = useDropTarget({ files: addFiles, refusal: () => (files.filter((f) => !f.stopped).length >= ROOM_FILES_MAX ? t('rooms.tooMany', { n: ROOM_FILES_MAX }) : null) })
  const { drag, dropProps } = useFileDrop({ files: inZone ? undefined : addFiles })

  const removeFile = (u: Upload) => {
    u.abort.abort()
    // a failed large file taken out: the pieces the server still holds are dropped (one still on its way drops them
    // itself when it stops: upload() above)
    if (u.status === 'failed' && !u.teamPath) void cancelUpload(u.file, roomTarget(u.file), api)
    setFiles((list) => list.filter((x) => x.key !== u.key))
  }

  const body = text.trim()
  const ready = files.filter((f) => f.status === 'done')
  const canSend = (body.length > 0 || ready.length > 0) && files.every((f) => f.status === 'done') && text.length <= ROOM_MESSAGE_MAX && !voice.busy

  // links to messages some readers here cannot see: Slack's "Only show link" / "Show message" (MessageLinkChoice.tsx)
  const linkChoice = useLinkChoice(roomId, threadRootId, text)
  const all = mention.mentionsAll()
  // the question shows while the message still has "@전체" (taken out, there is nothing to ask, and a later one asks anew)
  const ask = asking && all
  useEffect(() => {
    if (!all) { setAsking(false); setNoAsk(false) }
  }, [all])
  const submit = (sure = false) => {
    if (!canSend) return
    if (all && askAll && members.length >= MENTION_ALL_CONFIRM && !sure) {
      setAsking(true)
      return
    }
    // sent with "Don't ask again" ticked: from now on "@전체" goes without the question, in every room (a refusal says so
    // and the next one asks again)
    if (sure && noAsk) {
      void useSession.getState().updatePrefs({ mentionAllAsk: 'off' }).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
    }
    setNoAsk(false)
    setAsking(false)
    // "stopped" before the message, so nobody sees it arrive under "… is typing"
    typing.stop()
    useRooms.getState().send(roomId, { body, mentions: mention.mentions(), ...(all ? { mentionsAll: true } : {}), files: ready.map((f) => f.roomFile!), threadRootId, alsoInRoom: !!threadRootId && alsoInRoom, ...(linkChoice.showMessages.length ? { showMessages: linkChoice.showMessages } : {}) })
    linkChoice.reset()
    setText('')
    setFiles([])
    mention.reset()
    setAlsoInRoom(false)
    setVoiceError(null)
    onSent()
    input.current?.focus()
  }

  // the edit: ✕ / Esc leaves it (the reply comes back: the layout effect above); ✓ saves what changed. The new text shows
  // at once; a failure puts the old text back with its own toast (store/rooms.ts edit) and opens the edit again with
  // the words typed
  const editBody = editMsg ? lineBreaks(editMsg.body) : ''
  const canSave = editing && body.length > 0 && body !== editBody && text.length <= ROOM_MESSAGE_MAX
  const cancelEdit = () => useRoomEdit.getState().end(key)
  const saveEdit = () => {
    if (!editMsg || !body) return
    if (body === editBody) return cancelEdit()
    const m = editMsg, typed = text
    const mentions = mention.mentions(), all = mention.mentionsAll()
    cancelEdit()
    input.current?.focus()
    void useRooms.getState().edit(roomId, m.id, body, mentions, all).then((ok) => {
      if (ok) return
      failedEdits.set(m.id, { text: typed, mentions })
      // (this place's box still on screen: else the message keeps its old text, with the toast)
      if (!useRoomEdit.getState().editing[key] && hasRoomBox(key)) useRoomEdit.getState().start(key, m.id)
      setTimeout(() => failedEdits.delete(m.id), 1000)
    })
  }

  // attach: the + every message box has (composer/AttachMenu.tsx); team files are copied as my upload here, on a
  // computer too. A project room the person may only read: off, with why
  const clip = (
    <AttachMenu
      key={key}
      onFiles={(all) => void addFiles(all)}
      onTeamFiles={addTeamFiles}
      teamAttached={new Set(files.filter((f) => f.teamPath && f.status !== 'failed').map((f) => f.teamPath!))}
      room={ROOM_FILES_MAX - files.length}
      max={ROOM_FILES_MAX}
      fileMax={fileMax}
      off={noFiles}
      testId="room-attach"
      filesTestId="room-file-input"
      onPicked={() => input.current?.focus()}
    />
  )
  // the box's own keys before the field's (composer/ComposerField.tsx: voice, then Enter sends): the "@" list, then an
  // edit (Esc cancels, Enter saves with a keyboard; nothing else of the box's), then the "@전체" question's Esc
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (mention.onKeyDown(e)) return true
    if (editing) {
      if (composing(e)) return true
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelEdit()
      } else if (enterSends(e)) {
        // a keyboard: Enter saves, as it sends (a touch screen: a new line)
        e.preventDefault()
        if (canSave) saveEdit()
      }
      return true
    }
    // the question about "@전체": Esc puts it away, Enter answers it as 보내기
    if (ask && e.key === 'Escape' && !composing(e)) {
      e.preventDefault()
      e.stopPropagation()
      setAsking(false)
      return true
    }
    return false
  }
  const field = (
    <ComposerField
      ref={input}
      value={text}
      tokens={mention.inputProps}
      keys={keys}
      voice={editing ? undefined : voice}
      onSend={() => submit(ask)}
      aria-label={editing ? t('rooms.editLabel') : t('composer.label')}
      placeholder={placeholder}
      // not disabled: the focus stays in the box while the words are on their way
      readOnly={voice.busy}
      aria-busy={voice.transcribing || undefined}
      maxLength={ROOM_MESSAGE_MAX}
      grow={[editing, voice.recording]}
      onBlur={() => typing.stop()}
      onPaste={(e) => {
        // an edit takes words only
        if (!editing) {
          const pasted = pastedFiles(e.clipboardData)
          if (pasted.length) {
            e.preventDefault()
            void addFiles(pasted)
            return
          }
        }
        // text that would take the box over what a message holds is never cut (lib/longPaste.ts; the box's maxLength
        // would drop the rest without a word): it goes in as a text file, or, in an edit or with every file place
        // taken, the paste is refused with the reason
        const box = e.currentTarget
        const pastedText = e.clipboardData?.getData?.('text/plain') ?? ''
        const target = { value: box.value, selectionStart: box.selectionStart, selectionEnd: box.selectionEnd }
        if (!pasteOverLimit(target, pastedText, ROOM_MESSAGE_MAX)) {
          // it fits as the box keeps it (\n), but the browser's own maxLength counts the pasted \r\n twice and would
          // drop the whole paste: put it in here
          if (pastedText.includes('\r\n') && box.value.length - (box.selectionEnd - box.selectionStart) + pastedText.length > ROOM_MESSAGE_MAX) {
            e.preventDefault()
            const clean = pastedText.replace(/\r\n/g, '\n')
            const at = box.selectionStart
            setText(box.value.slice(0, at) + clean + box.value.slice(box.selectionEnd))
            requestAnimationFrame(() => input.current?.setSelectionRange(at + clean.length, at + clean.length))
          }
          return
        }
        e.preventDefault()
        const max = ROOM_MESSAGE_MAX.toLocaleString(locale)
        if (editing || files.length >= ROOM_FILES_MAX) {
          toast({ level: 'warn', text: t('composer.textTooLong', { max }) })
          return
        }
        // the notice only when the file was taken (a refusal has said its own reason)
        void addFiles([pastedTextFile(pastedText, t('composer.pastedTextName'))]).then((taken) => {
          if (taken) toast({ level: 'info', text: t('composer.pastedAsFile', { max }) })
        })
      }}
      data-testid="room-input"
    />
  )

  // ✕ and ✓ where send was (round, as send); a press keeps the focus in the box, so the keyboard stays up
  const keep = (e: React.PointerEvent) => e.preventDefault()
  const editControls = (
    <>
      <Tooltip label={t('common.cancel')}>
        <button type="button" onPointerDown={keep} onClick={cancelEdit} aria-label={t('common.cancel')} className="touch-hit flex size-9 shrink-0 items-center justify-center rounded-full bg-subtle text-muted transition hover:bg-hover hover:text-ink max-sm:size-10" data-testid="room-edit-cancel">
          <X size={18} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label={t('common.save')}>
        <button type="button" onPointerDown={keep} onClick={saveEdit} disabled={!canSave} aria-label={t('common.save')} className={clsx('touch-hit flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSave ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')} data-testid="room-edit-save">
          <Check size={18} aria-hidden />
        </button>
      </Tooltip>
    </>
  )

  return (
    <ComposerShell
      rootRef={root}
      rootAttrs={{ 'data-bottom-bar': '' }}
      className={clsx('relative shrink-0 pb-[var(--box-bottom)]', composerInset)}
      testId="room-composer"
      toolsTestId="room-composer-tools"
      frameClassName="mx-auto max-w-[780px]"
      frameAttrs={{ 'data-editing': editing ? '' : undefined }}
      line={phone}
      drag={drag}
      dropProps={editing ? undefined : dropProps}
      above={<>
        {/* who else is writing here; out of the way while the "@" list floats over the messages on a phone */}
        <RoomTypingLine roomId={roomId} threadRootId={threadRootId} members={members} meId={meId} hidden={!!mention.list && phone} />
        {above}
      </>}
      files={files.length > 0}
      text={text}
      hint={placeholder}
      heldTestId="room-text-held"
      voice={voice}
      mic={mic}
      top={<>
        {editing && (
          <p className="flex items-center gap-1.5 px-4 pt-2 text-xs font-medium text-muted" data-testid="room-editing-label">
            <Pencil size={12} aria-hidden />
            {t('rooms.editingNow')}
          </p>
        )}
        {/* a phone: the "@" list floats over the newest messages, right above the box, instead of pushing the box (and,
            with the keyboard up, the messages) out of sight */}
        {!voice.recording && mention.list && <div className="max-md:absolute max-md:inset-x-0 max-md:bottom-full max-md:z-10 max-md:border-t max-md:border-line max-md:bg-canvas max-md:pb-1 max-md:shadow-[0_-4px_12px_rgb(0_0_0/0.06)]">{mention.list}</div>}
        {/* the question about "@전체" (hidden while recording, like the "@" list) */}
        {ask && !voice.recording && !editing && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-2.5 max-md:px-4" data-testid="room-mention-all-confirm">
            <p role="status" className="min-w-0 flex-1 text-sm text-ink">
              {t('rooms.mentionAllConfirm', { n: others })}
            </p>
            {/* a phone: the tick and the buttons on a line of their own under the question, the tick on the left */}
            <div className="flex shrink-0 items-center gap-1.5 max-md:w-full">
              <label className="mr-1.5 flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none max-md:mr-auto" data-testid="room-mention-all-no-ask">
                <input type="checkbox" checked={noAsk} onChange={(e) => setNoAsk(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                {t('rooms.mentionAllNoAsk')}
              </label>
              <Button size="sm" variant="ghost" onClick={() => { setAsking(false); setNoAsk(false); input.current?.focus() }} data-testid="room-mention-all-cancel">
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => submit(true)} disabled={!canSend} data-testid="room-mention-all-send">
                {t('chat.send')}
              </Button>
            </div>
          </div>
        )}
        {!voice.recording && !editing && <MessageLinkChoice choice={linkChoice} />}
        {files.length > 0 && !editing && (
          // centred on the row: a file's compact chip beside a picture's 64 px square keeps its own height; the box's
          // pictures are one pane of the image viewer (← →)
          <ImageGroup>
          <ul
            // a phone: one sideways row (six files and the keyboard would push the text field out of sight).
            // @container: a failed chip follows this box's width (ChipThumb.tsx chipText)
            className="@container scroll-thin flex flex-wrap items-center gap-2 px-3 pt-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-1 max-md:*:shrink-0" aria-label={t('composer.attachments')} data-testid="room-file-chips">
            {files.map((f) =>
              picture(f) ? (
                // a picture as itself, at once: from this computer, or a photo of a send the server gave back (its room
                // thumbnail); its words for screen readers, a failure's reason beside it
                <li key={f.key} className="flex max-w-full items-center gap-2 pt-1.5 pr-1.5 text-xs" data-testid="room-file-chip" data-status={f.status}>
                  <PictureTile
                    name={f.file.name}
                    file={isLocalImage(f.file) ? f.file : undefined}
                    src={isLocalImage(f.file) || !f.roomFile?.thumb ? undefined : roomFileUrl(roomId, f.roomFile.id, { thumb: '1' })}
                    busy={f.status === 'uploading'}
                    failed={f.status === 'failed'}
                    removeLabel={t('rooms.removeFile', { name: f.file.name })}
                    onRemove={() => removeFile(f)}
                    // its own bytes in the image viewer, or the room's copy the server gave back
                    item={isLocalImage(f.file) ? localItem(String(f.key), f.file, f.file.name) : f.roomFile ? roomItem(roomId, f.roomFile) : null}
                  />
                  {/* a large picture says how far it is beside its tile (a small one is there in a moment) */}
                  {f.status === 'failed' ? (
                    // the reason (announced), then its links in the same run of text, outside the live region
                    <span className={FAILED_REASON}>
                      <span role="status">{failedText(f)}</span>
                      <RefusalLinks full={!!f.full && staff} plans={f.plans} mine={!!f.full && !staff} />
                    </span>
                  ) : (
                    <span role="status" className={f.status === 'uploading' && says(f) ? 'text-faint tabular-nums' : 'sr-only'}>
                      {f.status === 'uploading' ? (says(f) ? <span data-testid="room-file-progress"><UploadLabel progress={f.progress} busy={t('rooms.uploading', { name: f.file.name })} /></span> : t('rooms.uploading', { name: f.file.name })) : formatSize(f.file.size, locale)}
                    </span>
                  )}
                </li>
              ) : (
                <li key={f.key} className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : 'border-line bg-subtle')} data-testid="room-file-chip" data-status={f.status} data-team={f.teamPath ? '' : undefined}>
                  {f.status === 'uploading' ? <Loader2 size={14} className="animate-spin text-faint" aria-hidden /> : f.teamPath ? <FolderOpen size={14} className="text-accent-text" aria-hidden /> : <FileText size={14} className="text-muted" aria-hidden />}
                  {/* the name and what the chip says: a failed one's reason under the name in a narrow box (chipText) */}
                  <span className={chipText(f.status === 'failed')}>
                    <span className="max-w-[180px] truncate font-medium" data-testid="room-file-name">{f.file.name}</span>
                    {f.status === 'failed' ? (
                      <span className={FAILED_REASON}>
                        <span role="status">{failedText(f)}</span>
                        <RefusalLinks full={!!f.full && staff} plans={f.plans} mine={!!f.full && !staff} />
                      </span>
                    ) : (
                      <span role="status" className="text-faint">
                        {f.status === 'uploading' ? (says(f) ? <span className="tabular-nums" data-testid="room-file-progress"><UploadLabel progress={f.progress} busy={t('rooms.uploading', { name: f.file.name })} /></span> : <span className="sr-only">{t('rooms.uploading', { name: f.file.name })}</span>) : formatSize(f.file.size, locale)}
                      </span>
                    )}
                  </span>
                  <ChipRemove label={t('rooms.removeFile', { name: f.file.name })} onClick={() => removeFile(f)} />
                </li>
              ),
            )}
          </ul>
          </ImageGroup>
        )}
        {widens > 0 && !editing && (
          <p className="px-3 pt-1.5 text-xs text-muted max-md:px-4" data-testid="room-team-file-widen">
            {t(widening.length > 1 ? 'rooms.teamFileWidenAtLeast' : 'rooms.teamFileWiden', { n: widens })}
          </p>
        )}
      </>}
      field={field}
      start={editing ? undefined : clip}
      send={{ can: canSend, onSend: () => submit(ask), testId: 'room-send' }}
      // an edit: ✕ and ✓ in place of the mic and send
      replaceEnd={editing ? editControls : undefined}
      below={<>
        <div className="mx-auto max-w-[780px] max-sm:px-3">
          <ComposerNotices prefix="room" voice={voice} voiceError={voiceError} />
        </div>
        {/* a thread's reply may go to the room too: one quiet choice under the box (off again after each send) */}
        {threadRootId && !editing && (
          <label className="mx-auto flex max-w-[780px] cursor-pointer items-center gap-2 px-1 pt-1.5 text-xs text-muted select-none max-sm:px-4 max-sm:pt-0.5 max-sm:pb-1" data-testid="room-also-in-room">
            <input type="checkbox" checked={alsoInRoom} onChange={(e) => setAlsoInRoom(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            {t('rooms.alsoToRoom')}
          </label>
        )}
      </>}
    />
  )
}
