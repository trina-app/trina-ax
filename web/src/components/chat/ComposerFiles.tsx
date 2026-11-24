// The files of an AI chat's message box, before they are sent: the AI chat's box (components/chat/Composer.tsx) and the
// Trina side chat's (components/rooms/SideChatPanel.tsx). Each file is uploaded into the chat at once (chunked when
// large: lib/upload.ts) or, a team-folder file, attached by reference (POST /api/attachments/team-file); at most
// MESSAGE_ATTACHMENTS_MAX per message (uploads and team files together; a failed one does not count and is not sent).
// The chips live outside the component too (lib/teamAttach stash, per person and draft): leaving the page and coming back,
// adding files one at a time from the file screen, or a second box of the same draft (a room's side chat on the room
// page and beside a file in the viewer) shows the same chips. Finished chips also survive a reload of the tab, where the
// box's chat does (`reload`).
// The row above the box (ComposerFileList): a picture from this computer as its 64 px square at once, while it uploads
// (ChipThumb.tsx PictureTile), any other file as a compact chip with its size or its upload's progress; each with ✕ and,
// failed, the reason beside it. The box takes files dropped on it or on the panel around it (useFileDrop,
// components/FileDropZone.tsx) and pasted into its text (`onPaste`).
// In a shared project chat a file from this computer is saved in the project folder by the server and attached as a team
// file (docs/DECISIONS.md "Shared project chats": "A file from the computer in a shared chat"): its chip looks as usual,
// one line under the row says where it went and who sees it (SharedUploadLine), and ✕ before sending moves that file to
// the team trash (DELETE /api/attachments/:id). Someone who may not write that folder (Project.chatUploads,
// Chat.shared.canUpload false: `computer` off) is offered team files only: pasted files are ignored and files dragged from
// the computer get the not-allowed cursor (on the chat's page, its drop overlay says why), so nobody picks a file only
// to be refused.
// In a chat shared with people and groups the file is kept with the chat (Attachment source 'chat'): the line under the
// row says everyone who sees the chat can open it, and ✕ before sending removes it (DELETE /api/attachments/:id).
import clsx from 'clsx'
import { FileAudio, FileText, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import { CHAT_FILES_FOLDER, chatFilesWord } from '@mycel/shared'
import { DEFAULT_LOCALE, MESSAGE_ATTACHMENTS_MAX, MESSAGE_TEXT_MAX, UPLOAD_SESSION_MAX, uuidv7, type Attachment } from '@mycel/shared/api'
import { api, API, errorText, thumbnailUrl } from '../../lib/api'
import { useTeamPlace } from '../../lib/teamPlace'
import { markBusy } from '../../lib/busy'
import { SIGNED_OUT } from '../../lib/localData'
import { formatSize } from '../../lib/format'
import { previewKind, serverPreview } from '../../lib/preview'
import { openFilePreview, openTeamFile } from '../../lib/sidePanel'
import { loadChips, patchStash, readStash, saveChips, shareStash, subscribeStash, TEAM_FILE_DRAG_TYPE, writeStash, type AttachResult } from '../../lib/teamAttach'
import { cancelUpload, splitOversize, unreadableFile, uploadFile, uploadPercent, type UploadProgress } from '../../lib/upload'
import { pastedFiles } from '../../lib/paste'
import { pastedTextFile, pasteOverLimit, type PasteTarget } from '../../lib/longPaste'
import { toast } from '../../store/ui'
import { dragKind, filesOfDrop, withoutFolders, type DropKind } from '../../lib/fileDrop'
import { attachmentItem, localItem } from '../../lib/imageViewer'
import { useFolderWords } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { myUploadMaxNow, useMe } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { UploadLabel } from '../UploadLabel'
import { ChipRemove, FAILED_REASON, isHeicName, isLocalImage, PictureTile } from '../ChipThumb'
import { ImageGroup } from '../ImageViewer'
import { StoragePlansLink, storagePlansUrl } from '../StoragePlansLink'

export interface Pending {
  id: string
  /** upload: a file from this computer; team: a team-folder file attached by reference */
  source: 'upload' | 'team'
  name: string
  file?: File
  /** team files: the path picked */
  path?: string
  size: number | null
  status: 'uploading' | 'done' | 'failed'
  /** an upload on its way; null until it reports */
  progress: UploadProgress | null
  attachment?: Attachment
  error?: string
  /** a storage-full refusal: the plan page it names, linked for the owner and admins (StoragePlansLink.tsx) */
  plans?: string
  abort: AbortController
}

/** A file from this computer that a shared chat saved in its project folder (the server attached it as a team file). */
export const savedInProject = (f: Pick<Pending, 'source' | 'attachment'>): boolean => f.source === 'upload' && f.attachment?.source === 'team'
/** A file from this computer kept with a chat shared with people (not sent yet: ✕ removes it on the server too). */
export const keptWithChat = (f: Pick<Pending, 'source' | 'attachment'>): boolean => f.source === 'upload' && f.attachment?.source === 'chat'

/** Its chip taken out before sending: that file goes to the team trash (the server leaves it when it was sent, moved or
 * edited meanwhile). Nothing else about the box waits for it. */
const discardSaved = (a: Attachment) => void api.call(API.discardAttachment, { params: { id: a.id } }).catch(() => {})

/** The chips of a draft and what adds, removes and sends them. `ensureChat`: the chat the files go into (made by the
 * first file of a chat that does not exist yet). `onError`: a line for the box (null clears it): too many files.
 * `reload` false: the chips are not kept across a reload (the box's chat is not either). `computer` false: files from
 * this computer are not taken (a shared chat whose project folder the person may not write; team files still are). */
export function useComposerFiles({ userId, draftId, ensureChat, onError, reload = true, computer = true }: {
  userId: string
  draftId: string
  ensureChat: () => Promise<string>
  onError: (message: string | null) => void
  reload?: boolean
  computer?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const [files, setFilesState] = useState<Pending[]>(() => restoreChips(userId, draftId, reload))
  const filesRef = useRef(files)
  const setFiles = (fn: (cur: Pending[]) => Pending[]) => {
    const next = fn(filesRef.current)
    filesRef.current = next
    shareStash(userId, draftId, next)
    setFilesState(next)
  }
  // finished chips also survive a reload of this tab. Written when they change, not at each progress report of a running
  // upload, which also makes a new `files`.
  const finished = files.filter((f) => f.status === 'done' && f.attachment)
  const finishedIds = finished.map((f) => f.id).join()
  useEffect(() => {
    if (reload) saveChips(userId, draftId, finished.map((f) => ({ id: f.id, source: f.source, name: f.name, size: f.size, path: f.path, attachment: f.attachment! })))
  }, [userId, draftId, finishedIds])
  useEffect(() => {
    const cur = restoreChips(userId, draftId, reload)
    filesRef.current = cur
    setFilesState(cur)
    return subscribeStash<Pending>(userId, draftId, (items) => {
      filesRef.current = items
      setFilesState(items)
    })
  }, [userId, draftId])
  // an upload means "don't reload the page by yourself" after an update
  useEffect(() => (files.some((f) => f.status === 'uploading') ? markBusy('upload') : undefined), [files])

  // an upload / attach finishing goes to whichever box shows this draft by then (or stays in the stash)
  const update = (id: string, patch: Partial<Pending>) => patchStash<Pending>(userId, draftId, id, patch)
  // how many more attachments this message can take (uploads and team files together; the server's limit; failed
  // chips are not sent and do not count)
  const live = (list: Pending[]) => list.filter((f) => f.status !== 'failed')
  const room = () => MESSAGE_ATTACHMENTS_MAX - live(filesRef.current).length

  /** `dropFolders`: the folders a drop held besides (lib/fileDrop.ts filesOfDrop). A folder is never a chip: one line
   * says so, however many there were; the files beside them go on as usual. */
  const addFiles = async (picked: File[], dropFolders = 0) => {
    if ((!picked.length && !dropFolders) || !computer) return
    onError(null)
    const sorted = await withoutFolders(picked)
    const all = sorted.files
    if (dropFolders + sorted.folders) onError(t('composer.folders'))
    if (!all.length) return
    // a file over what the server takes is refused here, before anything is read or sent (the sha256 of a huge file
    // would take minutes before the server could say no)
    // (a guest: the team's guest limit)
    const max = myUploadMaxNow(UPLOAD_SESSION_MAX)
    const { fit, tooBig } = splitOversize(all, max)
    const list = fit.slice(0, Math.max(0, room()))
    if (list.length < fit.length) onError(t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
    else if (tooBig) onError(t('composer.fileTooBig', { name: tooBig.name, max: formatSize(max, locale) }))
    if (!list.length) return
    const items: Pending[] = list.map((file) => ({ id: uuidv7(), source: 'upload', name: file.name, file, size: file.size, status: 'uploading', progress: null, abort: new AbortController() }))
    setFiles((p) => [...p, ...items])
    let chatId: string
    try {
      chatId = await ensureChat()
    } catch (e) {
      const msg = errorText(e, locale, t('error.network'))
      for (const it of items) update(it.id, { status: 'failed', error: msg })
      return
    }
    await Promise.all(
      items.map(async (it) => {
        const target = { kind: 'attachment', chatId, name: it.file!.name } as const
        try {
          const r = await uploadFile(it.file!, target, { client: api, signal: it.abort.signal, onProgress: (progress) => update(it.id, { progress }) })
          if (r.kind !== 'attachment') throw new Error('unexpected upload result')
          // removed just as it finished: what it saved in a shared chat's project folder goes too
          const saved = savedInProject({ source: 'upload', attachment: r.attachment })
          if (it.abort.signal.aborted) return saved || r.attachment.source === 'chat' ? discardSaved(r.attachment) : undefined
          // saved in the project folder: the chip shows the name it got there ("견적 (2).pdf", "CLAUDE (2).md")
          update(it.id, { status: 'done', attachment: r.attachment, ...(saved ? { name: r.attachment.name } : {}) })
        } catch (e) {
          // removed while uploading: drop the server's half-received session as well
          if (it.abort.signal.aborted) return it.abort.signal.reason === SIGNED_OUT ? undefined : void cancelUpload(it.file!, target, api)
          // a file the browser could not read is not a lost connection (TC-4483)
          update(it.id, { status: 'failed', error: unreadableFile(e) ? t('composer.unreadable') : errorText(e, locale, t('error.network')), plans: storagePlansUrl(e) })
        }
      }),
    )
  }

  /** Team-folder files (picked, or handed over from the file screen): attached by reference, re-checked by the server. */
  const addTeamFiles = async (picked: { path: string; name?: string; size?: number | null }[]): Promise<AttachResult> => {
    onError(null)
    const have = new Set(live(filesRef.current).filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path))
    const fresh = picked.filter((p, i) => !have.has(p.path) && picked.findIndex((x) => x.path === p.path) === i)
    const list = fresh.slice(0, Math.max(0, room()))
    const already = picked.length - fresh.length
    if (list.length < fresh.length) onError(t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
    if (!list.length) return { added: already, failed: fresh.length, ...(fresh.length ? { error: t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }) } : {}) }
    const items: Pending[] = list.map((p) => ({ id: uuidv7(), source: 'team', path: p.path, name: p.name ?? p.path.slice(p.path.lastIndexOf('/') + 1), size: p.size ?? null, status: 'uploading', progress: null, abort: new AbortController() }))
    setFiles((p) => [...p, ...items])
    let chatId: string
    try {
      chatId = await ensureChat()
    } catch (e) {
      const msg = errorText(e, locale, t('error.network'))
      for (const it of items) update(it.id, { status: 'failed', error: msg })
      return { added: 0, failed: picked.length, error: msg }
    }
    const results = await Promise.all(
      items.map(async (it): Promise<string | null> => {
        try {
          const a = await api.call(API.attachTeamFile, { body: { chatId, path: it.path! }, signal: it.abort.signal })
          if (it.abort.signal.aborted) return null
          update(it.id, { status: 'done', attachment: a, size: a.size, name: a.name })
          return null
        } catch (e) {
          if (it.abort.signal.aborted) return null
          const msg = errorText(e, locale, t('error.network'))
          update(it.id, { status: 'failed', error: msg })
          return msg
        }
      }),
    )
    const errors = results.filter((r): r is string => r !== null)
    return { added: already + items.length - errors.length, failed: errors.length + (fresh.length - list.length), ...(errors[0] ? { error: errors[0] } : {}) }
  }

  const removeFile = (f: Pending) => {
    f.abort?.abort()
    setFiles((p) => p.filter((x) => x.id !== f.id))
    if (f.status === 'done' && (savedInProject(f) || keptWithChat(f))) discardSaved(f.attachment!)
  }

  const ready = files.filter((f) => f.status === 'done')
  return {
    files,
    /** the chips that count (not the failed ones) */
    live: live(files),
    uploading: files.some((f) => f.status === 'uploading'),
    ready,
    /** the attachments that go with the message */
    attachments: () => ready.map((f) => f.attachment!),
    addFiles,
    addTeamFiles,
    removeFile,
    /** sent: the finished chips leave the box (a failed one stays, with its reason) */
    clearSent: () => setFiles((p) => p.filter((f) => f.status !== 'done')),
    /** every chip goes, an upload on its way stops (the box's chat changed: they were for the other one) */
    clear: () => {
      for (const f of filesRef.current) f.abort.abort()
      setFiles(() => [])
    },
    /** files pasted into the box's text (a screenshot, a copied file) are attached, not pasted as text. Text that would
     * take the box over what a message holds is never cut (lib/longPaste.ts): it goes in as a text file where the box
     * takes files from this computer and has room for one more, else the paste is refused with the reason. */
    onPaste: (e: ClipboardEvent<HTMLElement>) => {
      // files are not taken here: the paste goes on as text (a screenshot alone adds nothing)
      const pasted = computer ? pastedFiles(e.clipboardData) : []
      if (pasted.length) {
        e.preventDefault()
        void addFiles(pasted)
        return
      }
      const box = e.currentTarget as HTMLElement & Partial<PasteTarget>
      const text = e.clipboardData?.getData?.('text/plain') ?? ''
      if (typeof box.value !== 'string' || !pasteOverLimit({ value: box.value, selectionStart: box.selectionStart ?? null, selectionEnd: box.selectionEnd ?? null }, text)) return
      e.preventDefault()
      const max = MESSAGE_TEXT_MAX.toLocaleString(locale)
      if (!computer || room() < 1) return onError(t('composer.textTooLong', { max }))
      void addFiles([pastedTextFile(text, t('composer.pastedTextName'))])
      toast({ level: 'info', text: t('composer.pastedAsFile', { max }) })
    },
    /** a file input's pick (the input is emptied, so the same file can be picked again) */
    onPicked: (e: ChangeEvent<HTMLInputElement>) => {
      void addFiles(Array.from(e.target.files ?? []))
      e.target.value = ''
    },
  }
}

/** Drag events a drop target nearer the pointer took already: the targets around it let them be (the nearest wins). */
const taken = new WeakSet<object>()

/** A drop target: a box, or a panel around one (components/FileDropZone.tsx). `files`: files from this computer;
 * `teamPath`: a team file dragged from the file screen, a preview or a message (left out: not taken here); `refusal`:
 * why a drop of this kind would do nothing here (shown instead, and the drop does nothing), or null.
 * `drag`: something it takes is over it (not over a nearer target inside it); `refusal`: the reason for that drag.
 * Moving over its own parts is not leaving it: a count of the enters and leaves that reached it, and the element the
 * pointer goes to (`relatedTarget`) when the browser says. Off on a drop, on leaving it, at the drag's end and on Esc.
 * A picture or link dragged from the page itself is not a file from this computer (lib/fileDrop.ts dragKind). */
export function useFileDrop({ files, teamPath, refusal }: { files?: (files: File[], folders: number) => void; teamPath?: (path: string) => void; refusal?: (kind: DropKind) => string | null }) {
  const [over, setOver] = useState<{ kind: DropKind; refusal: string | null; covered: boolean } | null>(null)
  const depth = useRef(0)
  const zone = useRef<HTMLElement | null>(null)
  const take = { files: !!files, team: !!teamPath }
  const off = () => {
    depth.current = 0
    zone.current = null
    setOver(null)
  }
  const offRef = useRef(off)
  offRef.current = off
  const showing = over !== null
  useEffect(() => {
    if (!showing) return
    const stop = () => offRef.current()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') stop() }
    // the pointer went somewhere else on the page without a leave reaching this target (the element it was over was
    // taken out of the page meanwhile, say)
    const elsewhere = (e: Event) => { if (zone.current && !zone.current.contains(e.target as Node | null)) stop() }
    // no pointer event comes while a drag lasts: one means the drag is over (it left the window and was dropped or
    // cancelled there, with a leave that never reached this target)
    const ends = ['dragend', 'drop', 'pointermove', 'pointerdown'] as const
    window.addEventListener('keydown', key)
    for (const type of ends) window.addEventListener(type, stop)
    window.addEventListener('dragover', elsewhere)
    return () => {
      window.removeEventListener('keydown', key)
      for (const type of ends) window.removeEventListener(type, stop)
      window.removeEventListener('dragover', elsewhere)
    }
  }, [showing])
  /** a drag event of this target's own part of the page (one from a dialog drawn elsewhere through a portal is not) */
  const own = (e: DragEvent<HTMLElement>) => e.currentTarget.contains(e.target as Node)
  const show = (e: DragEvent<HTMLElement>, kind: DropKind) => {
    zone.current = e.currentTarget
    const nearer = taken.has(e.nativeEvent)
    if (!nearer) taken.add(e.nativeEvent)
    const why = nearer ? null : (refusal?.(kind) ?? null)
    setOver((o) => (o && o.kind === kind && o.refusal === why && o.covered === nearer ? o : { kind, refusal: why, covered: nearer }))
    return { nearer, why }
  }
  return {
    drag: !!over && !over.covered,
    refusal: over && !over.covered ? over.refusal : null,
    dropProps: {
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        const kind = dragKind(e.dataTransfer, take)
        if (!kind || !own(e)) return
        depth.current++
        show(e, kind)
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        const kind = dragKind(e.dataTransfer, take)
        if (!kind || !own(e)) return
        depth.current = Math.max(depth.current, 1)
        const { nearer, why } = show(e, kind)
        if (nearer) return
        e.preventDefault()
        // attached as a copy (a file-list row's drag also allows "move", for the list's folder rows); refused: no drop
        e.dataTransfer.dropEffect = why ? 'none' : 'copy'
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!dragKind(e.dataTransfer, take) || !own(e)) return
        depth.current = Math.max(0, depth.current - 1)
        const to = e.relatedTarget as Node | null
        // still over one of its own parts
        if (to && e.currentTarget.contains(to)) return
        // out of it (where the browser says where the pointer went), else when every enter has had its leave
        if (to || depth.current === 0) off()
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const kind = dragKind(e.dataTransfer, take)
        if (!kind) return
        const nearer = taken.has(e.nativeEvent)
        off()
        if (nearer || !own(e)) return
        taken.add(e.nativeEvent)
        // taken here even when refused or empty: the browser would open a dropped file in place of the app
        e.preventDefault()
        if (refusal?.(kind)) return
        const path = kind === 'team' ? e.dataTransfer.getData(TEAM_FILE_DRAG_TYPE) : ''
        if (path) return teamPath?.(path)
        // the folders in it are left out here and counted (lib/fileDrop.ts filesOfDrop): the box says once that they
        // cannot be sent
        const { files: list, folders } = filesOfDrop(e.dataTransfer)
        if ((list.length || folders) && files) files(list, folders)
      },
    },
  }
}

/** The row of chips above the box (nothing when there are none). `className`: its padding in the box. */
export function ComposerFileList({ files, onRemove, className }: { files: Pending[]; onRemove: (f: Pending) => void; className?: string }) {
  const t = useT()
  const words = useFolderWords()
  const place = useTeamPlace()
  // a guest: their project's folder without the Projects step on the way (lib/guestFiles.ts)
  const guest = isGuestMe(useMe())
  const locale = useLocale()
  if (!files.length) return null
  return (
    // centred on the row: a file's compact chip beside a picture's 64 px square keeps its own height
    // the box's pictures: ← → in the image viewer walks through these. A phone: one sideways row, so many files and the
    // keyboard do not push the text field out of sight
    <ImageGroup>
    <ul className={clsx('scroll-thin flex flex-wrap items-center gap-2 md:max-h-40 md:overflow-y-auto max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-1 max-md:*:shrink-0', className)} aria-label={t('composer.attachments')}>
      {files.map((f) => {
        const canOpen = !!previewKind(f.name) && (f.source === 'upload' || f.status === 'done')
        const open = () => (f.source === 'team' || !f.file || (serverPreview(f.name) && f.attachment?.path) ? openTeamFile(f.attachment?.path ?? f.path!) : openFilePreview({ source: 'local', name: f.name, blob: f.file }))
        // a picture from this computer shows as itself at once, while it uploads (a pasted screenshot too); its
        // words for screen readers, a failure's reason beside it. Both regions stay through the whole upload.
        // an iPhone photo (HEIC) shows as the server's thumbnail once it is uploaded (a picture icon if none could be made)
        const heic = f.source === 'upload' && !!f.file && isHeicName(f.name) && f.status !== 'failed'
        if (f.source === 'upload' && f.file && (isLocalImage(f.file) || heic))
          return (
            <li key={f.id} className="flex max-w-full items-center gap-2 pt-1.5 pr-1.5 text-xs" data-testid="attachment-chip" data-source={f.source} data-status={f.status}>
              <PictureTile
                name={f.name}
                file={heic ? undefined : f.file}
                src={heic && f.attachment ? thumbnailUrl(f.attachment.id) : undefined}
                busy={f.status === 'uploading'}
                percent={f.status === 'uploading' ? uploadPercent(f.progress) : null}
                failed={f.status === 'failed'}
                removeLabel={t(savedInProject(f) ? 'composer.removeUploadToTrash' : 'composer.removeAttachment', { name: f.name })}
                onRemove={() => onRemove(f)}
                // its own bytes in the image viewer; a HEIC photo, once uploaded, as the server's JPEG
                item={!canOpen ? null : serverPreview(f.name) && f.attachment ? attachmentItem(f.attachment) : localItem(f.id, f.file, f.name)}
              />
              <span className="sr-only" role="status">
                {f.status === 'uploading' && t('composer.attaching', { name: f.name })}
                {f.status === 'done' && `${t('composer.attached', { name: f.name })} ${f.size !== null ? formatSize(f.size, locale) : ''}`}
              </span>
              <span className={f.status === 'failed' ? FAILED_REASON : 'sr-only'} role="alert">
                {f.status === 'failed' && (
                  <>
                    <span className="sr-only">{f.name}: </span>
                    {f.error}
                  </>
                )}
              </span>
              {f.status === 'failed' && <StoragePlansLink url={f.plans} />}
            </li>
          )
        return (
          <li
            key={f.id}
            // a failed chip on a phone takes the row's width, so its reason wraps inside the box and ✕ stays in sight (an
            // oversize file's chip ran past the box with no ✕: QA 2026-11-22 F21)
            className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft max-md:w-full' : f.source === 'team' ? 'border-accent/30 bg-accent-soft' : 'border-line bg-subtle')}
            title={f.source === 'team' ? t('composer.teamFile', { path: f.attachment?.path ?? f.path ?? '' }) : undefined}
            data-testid="attachment-chip"
            data-source={f.source}
            data-status={f.status}
          >
            {f.source === 'team' ? (
              <FolderOpen size={15} className="text-accent-text" aria-label={t('composer.teamFile', { path: place(f.attachment?.path ?? f.path ?? '') })} />
            ) : (f.file?.type ?? f.attachment?.mime ?? '').startsWith('audio/') ? (
              <FileAudio size={15} className="text-accent-text" aria-hidden />
            ) : (
              <FileText size={15} className="text-muted" aria-hidden />
            )}
            <span className="flex min-w-0 flex-col">
              {canOpen ? (
                <button type="button" className="max-w-[180px] truncate text-left font-medium hover:underline" onClick={open}>
                  {f.name}
                </button>
              ) : (
                <span className="max-w-[180px] truncate font-medium">{f.name}</span>
              )}
              {/* the team folder it is in, visible without hovering (phones) */}
              {f.source === 'team' && <span className="max-w-[180px] truncate text-micro leading-tight text-faint" data-testid="chip-folder">{words.path(guest ? folderOf(f.attachment?.path ?? f.path ?? '').replace(/^projects\//, '') : folderOf(f.attachment?.path ?? f.path ?? '')) || t(guest ? 'picker.guestRoot' : 'files.root')}</span>}
            </span>
            {/* both stay through the whole upload, so a screen reader hears each change */}
            <span className="flex min-w-0 items-center">
              <span className="flex items-center gap-1 text-faint" role="status">
                {f.status === 'uploading' && (
                  <>
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                    {f.source === 'upload' ? <UploadLabel progress={f.progress} busy={t('composer.attaching', { name: f.name })} /> : <span className="sr-only">{t('composer.attaching', { name: f.name })}</span>}
                  </>
                )}
                {f.status === 'done' && (
                  <>
                    <span className="sr-only">{t('composer.attached', { name: f.name })} </span>
                    {f.size !== null && formatSize(f.size, locale)}
                  </>
                )}
              </span>
              <span className={FAILED_REASON} role="alert">
                {f.status === 'failed' && (
                  <>
                    <span className="sr-only">{f.name}: </span>
                    {f.error}
                  </>
                )}
              </span>
              {f.status === 'failed' && <StoragePlansLink url={f.plans} />}
            </span>
            <ChipRemove label={t(savedInProject(f) ? 'composer.removeUploadToTrash' : 'composer.removeAttachment', { name: f.name })} onClick={() => onRemove(f)} />
          </li>
        )
      })}
    </ul>
    </ImageGroup>
  )
}

/**
 * A shared project chat's line under the chips while a file from this computer is attached: it is saved in the project
 * folder (the folder it went to, else the one the team's language names) and who can see it there (`audience`: the
 * project's people, as the line under the box counts them). In a chat shared with people (`kind` people) the file is
 * kept with the chat: everyone who sees the chat can open it. Nothing while only team files are attached.
 */
export function SharedUploadLine({ files, audience, kind, className }: { files: Pending[]; audience: number; kind?: 'project' | 'people'; className?: string }) {
  const t = useT()
  const me = useMe()
  const team = me?.team.defaultLocale
  const locale = useLocale()
  if (kind === 'people') {
    const ups = files.filter((f) => f.source === 'upload' && (f.status === 'uploading' || keptWithChat(f)))
    // a My files attachment (QA TC-7286): one some people here can't open goes in as a copy everyone opens, people
    // added later and guests too (server chat/attach-copies.ts); said before Send, which is the consent
    const mine = files.some((f) => f.source === 'team' && ownFolderPath(f.attachment?.path ?? f.path, me?.user.id))
    if (!ups.length && !mine) return null
    return (
      <p className={clsx('text-xs leading-5 break-keep text-faint', className)} data-testid="shared-upload-line">
        {ups.length ? t('chat.share.uploadLine') : t('chat.share.attachCopyLine')}
      </p>
    )
  }
  // on its way, or saved there (an upload of my own folder from before the chat was shared is not: the send refuses it)
  const ups = files.filter((f) => f.source === 'upload' && (f.status === 'uploading' || savedInProject(f)))
  if (!ups.length) return null
  const saved = ups.find((f) => savedInProject(f))?.attachment?.path
  const folder = chatFilesWord(saved ? folderOf(saved).slice(folderOf(saved).lastIndexOf('/') + 1) : CHAT_FILES_FOLDER[team ?? DEFAULT_LOCALE], locale)
  return (
    <p className={clsx('text-xs leading-5 break-keep text-faint', className)} data-testid="shared-upload-line">
      {t('chat.sharedUploadLine', { folder, n: audience })}
    </p>
  )
}

/**
 * The same line under a waiting message of a shared chat (components/chat/QueuedMessages.tsx): a file from the computer
 * in it was saved when it was attached, so the line still says where and who can see it. A waiting message keeps only
 * its attachments: a file in the project's chat attachments folder (in any language's name) counts as one of those
 * uploads; a chat shared with people, a file kept with the chat.
 */
export function SharedQueuedLine({ attachments, audience, kind, className }: { attachments: readonly Attachment[]; audience: number; kind?: 'project' | 'people'; className?: string }) {
  const t = useT()
  const locale = useLocale()
  if (kind === 'people') {
    if (!attachments.some((a) => a.source === 'chat')) return null
    return <p className={clsx('text-xs leading-5 break-keep text-faint', className)} data-testid="outbox-upload-line">{t('chat.share.uploadLine')}</p>
  }
  const names = new Set<string>(Object.values(CHAT_FILES_FOLDER))
  const saved = attachments.find((a) => a.source === 'team' && names.has(folderOf(a.path).slice(folderOf(a.path).lastIndexOf('/') + 1)))
  if (!saved) return null
  const folder = chatFilesWord(folderOf(saved.path).slice(folderOf(saved.path).lastIndexOf('/') + 1), locale)
  return <p className={clsx('text-xs leading-5 break-keep text-faint', className)} data-testid="outbox-upload-line">{t('chat.sharedUploadLine', { folder, n: audience })}</p>
}

/** The chips of a draft: those kept in memory, else (`reload`) the finished ones kept for this tab (after a reload). */
function restoreChips(userId: string, draftId: string, reload: boolean): Pending[] {
  const mem = readStash<Pending>(userId, draftId)
  if (mem.length || !reload) return mem
  const saved: Pending[] = loadChips(userId, draftId).map((c) => ({ ...c, status: 'done', progress: null, abort: new AbortController() }))
  if (saved.length) writeStash(userId, draftId, saved)
  return saved
}

/** "groups/marketing/brief.md" -> "groups/marketing" */
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** Is this team path in the person's own folder (users/<id>/…)? */
export const ownFolderPath = (p: string | undefined | null, me: string | undefined): boolean => {
  if (!p || !me) return false
  const segs = p.split('/').filter(Boolean)
  return segs.length >= 3 && segs[0] === 'users' && segs[1] === me
}
