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
// failed, the reason beside it. The box takes files dropped on it (useFileDrop) and pasted into its text (`onPaste`).
// In a shared project chat a file from this computer is saved in the project folder by the server and attached as a team
// file (docs/DECISIONS.md "Shared project chats": "A file from the computer in a shared chat"): its chip looks as usual,
// one line under the row says where it went and who sees it (SharedUploadLine), and ✕ before sending moves that file to
// the team trash (DELETE /api/attachments/:id). Someone who may not write that folder (Project.chatUploads,
// Chat.shared.canUpload false: `computer` off) is offered team files only: pasted files are ignored and files dragged from
// the computer get the not-allowed cursor, so nobody picks a file only to be refused.
import clsx from 'clsx'
import { FileAudio, FileText, FolderOpen, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { DEFAULT_LOCALE, MESSAGE_ATTACHMENTS_MAX, uuidv7, type Attachment } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { SIGNED_OUT } from '../../lib/localData'
import { formatSize } from '../../lib/format'
import { previewKind, serverPreview } from '../../lib/preview'
import { openFilePreview, openTeamFile } from '../../lib/sidePanel'
import { loadChips, patchStash, readStash, saveChips, shareStash, subscribeStash, TEAM_FILE_DRAG_TYPE, writeStash, type AttachResult } from '../../lib/teamAttach'
import { cancelUpload, uploadFile, uploadPercent, type UploadProgress } from '../../lib/upload'
import { pastedFiles } from '../../lib/paste'
import { attachmentItem, localItem } from '../../lib/imageViewer'
import { useFolderWords } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { UploadLabel } from '../UploadLabel'
import { isLocalImage, PictureTile } from '../ChipThumb'
import { ImageGroup } from '../ImageViewer'
import { Tooltip } from '../Tooltip'

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
  abort: AbortController
}

/** A file from this computer that a shared chat saved in its project folder (the server attached it as a team file). */
export const savedInProject = (f: Pick<Pending, 'source' | 'attachment'>): boolean => f.source === 'upload' && f.attachment?.source === 'team'

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

  const addFiles = async (all: File[]) => {
    if (!all.length || !computer) return
    onError(null)
    const list = all.slice(0, Math.max(0, room()))
    if (list.length < all.length) onError(t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
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
          if (it.abort.signal.aborted) return saved ? discardSaved(r.attachment) : undefined
          // saved in the project folder: the chip shows the name it got there ("견적 (2).pdf", "CLAUDE (2).md")
          update(it.id, { status: 'done', attachment: r.attachment, ...(saved ? { name: r.attachment.name } : {}) })
        } catch (e) {
          // removed while uploading: drop the server's half-received session as well
          if (it.abort.signal.aborted) return it.abort.signal.reason === SIGNED_OUT ? undefined : void cancelUpload(it.file!, target, api)
          update(it.id, { status: 'failed', error: errorText(e, locale, t('error.network')) })
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
    if (f.status === 'done' && savedInProject(f)) discardSaved(f.attachment!)
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
    /** files pasted into the box's text (a screenshot, a copied file) are attached, not pasted as text */
    onPaste: (e: ClipboardEvent<HTMLElement>) => {
      // files are not taken here: the paste goes on as text (a screenshot alone adds nothing)
      const pasted = computer ? pastedFiles(e.clipboardData) : []
      if (pasted.length) {
        e.preventDefault()
        void addFiles(pasted)
      }
    },
    /** a file input's pick (the input is emptied, so the same file can be picked again) */
    onPicked: (e: ChangeEvent<HTMLInputElement>) => {
      void addFiles(Array.from(e.target.files ?? []))
      e.target.value = ''
    },
  }
}

/** The box as a drop target: files from this computer, and (`onTeamPath`) a team file dragged from the file screen, a
 * preview or a message. `drag`: something that can be dropped is over it. `files` false: files from this computer are
 * not taken: over the box they get the not-allowed cursor and no highlight, and the browser does not open them either
 * (the drag is the box's, ending in nothing). */
export function useFileDrop(onFiles: (files: File[]) => void, onTeamPath?: (path: string) => void, o: { files?: boolean } = {}) {
  const [drag, setDrag] = useState(false)
  const files = o.files !== false
  return {
    drag,
    dropProps: {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        const types = [...e.dataTransfer.types]
        const team = !!onTeamPath && types.includes(TEAM_FILE_DRAG_TYPE)
        if (!types.includes('Files') && !team) return
        e.preventDefault()
        if (!files && !team) {
          e.dataTransfer.dropEffect = 'none'
          setDrag(false)
          return
        }
        // attached as a copy: a file-list row's drag also allows "move" (for the list's folder rows)
        e.dataTransfer.dropEffect = 'copy'
        setDrag(true)
      },
      onDragLeave: () => setDrag(false),
      onDrop: (e: DragEvent<HTMLElement>) => {
        const teamPath = onTeamPath && e.dataTransfer.getData(TEAM_FILE_DRAG_TYPE)
        if (teamPath) {
          e.preventDefault()
          setDrag(false)
          onTeamPath(teamPath)
          return
        }
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDrag(false)
        if (files) onFiles(Array.from(e.dataTransfer.files))
      },
    },
  }
}

/** The row of chips above the box (nothing when there are none). `className`: its padding in the box. */
export function ComposerFileList({ files, onRemove, className }: { files: Pending[]; onRemove: (f: Pending) => void; className?: string }) {
  const t = useT()
  const words = useFolderWords()
  const locale = useLocale()
  if (!files.length) return null
  return (
    // centred on the row: a file's compact chip beside a picture's 64 px square keeps its own height
    // the box's pictures: ← → in the image viewer walks through these
    <ImageGroup>
    <ul className={clsx('flex flex-wrap items-center gap-2', className)} aria-label={t('composer.attachments')}>
      {files.map((f) => {
        const canOpen = !!previewKind(f.name) && (f.source === 'upload' || f.status === 'done')
        const open = () => (f.source === 'team' || !f.file || (serverPreview(f.name) && f.attachment?.path) ? openTeamFile(f.attachment?.path ?? f.path!) : openFilePreview({ source: 'local', name: f.name, blob: f.file }))
        // a picture from this computer shows as itself at once, while it uploads (a pasted screenshot too); its
        // words for screen readers, a failure's reason beside it. Both regions stay through the whole upload.
        if (f.source === 'upload' && f.file && isLocalImage(f.file))
          return (
            <li key={f.id} className="flex max-w-full items-center gap-2 pt-1.5 pr-1.5 text-xs" data-testid="attachment-chip" data-source={f.source} data-status={f.status}>
              <PictureTile
                name={f.name}
                file={f.file}
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
              <span className={f.status === 'failed' ? 'max-w-[160px] truncate text-danger' : 'sr-only'} role="alert" title={f.error}>
                {f.status === 'failed' && (
                  <>
                    <span className="sr-only">{f.name}: </span>
                    {f.error}
                  </>
                )}
              </span>
            </li>
          )
        return (
          <li
            key={f.id}
            className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : f.source === 'team' ? 'border-accent/30 bg-accent-soft' : 'border-line bg-subtle')}
            title={f.source === 'team' ? t('composer.teamFile', { path: f.attachment?.path ?? f.path ?? '' }) : undefined}
            data-testid="attachment-chip"
            data-source={f.source}
            data-status={f.status}
          >
            {f.source === 'team' ? (
              <FolderOpen size={15} className="text-accent-text" aria-label={t('composer.teamFile', { path: f.attachment?.path ?? f.path ?? '' })} />
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
              {f.source === 'team' && <span className="max-w-[180px] truncate text-micro leading-tight text-faint" data-testid="chip-folder">{words.path(folderOf(f.attachment?.path ?? f.path ?? '')) || t('files.root')}</span>}
            </span>
            {/* both stay through the whole upload, so a screen reader hears each change */}
            <span className="flex items-center">
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
              <span className="max-w-[160px] truncate text-danger" role="alert" title={f.error}>
                {f.status === 'failed' && (
                  <>
                    <span className="sr-only">{f.name}: </span>
                    {f.error}
                  </>
                )}
              </span>
            </span>
            <Tooltip label={t(savedInProject(f) ? 'composer.removeUploadToTrash' : 'composer.removeAttachment', { name: f.name })}>
              <button type="button" aria-label={t(savedInProject(f) ? 'composer.removeUploadToTrash' : 'composer.removeAttachment', { name: f.name })} title="" onClick={() => onRemove(f)} className="-my-1 -mr-1 rounded-md p-1 text-faint hover:bg-hover hover:text-ink max-sm:p-1.5">
                <X size={14} />
              </button>
            </Tooltip>
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
 * project's people, as the line under the box counts them). Nothing while only team files are attached.
 */
export function SharedUploadLine({ files, audience, className }: { files: Pending[]; audience: number; className?: string }) {
  const t = useT()
  const team = useMe()?.team.defaultLocale
  // on its way, or saved there (an upload of my own folder from before the chat was shared is not: the send refuses it)
  const ups = files.filter((f) => f.source === 'upload' && (f.status === 'uploading' || savedInProject(f)))
  if (!ups.length) return null
  const saved = ups.find((f) => savedInProject(f))?.attachment?.path
  const folder = saved ? folderOf(saved).slice(folderOf(saved).lastIndexOf('/') + 1) : CHAT_FILES_FOLDER[team ?? DEFAULT_LOCALE]
  return (
    <p className={clsx('text-xs leading-5 break-keep text-faint', className)} data-testid="shared-upload-line">
      {t('chat.sharedUploadLine', { folder, n: audience })}
    </p>
  )
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
