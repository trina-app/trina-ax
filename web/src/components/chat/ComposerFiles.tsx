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
import clsx from 'clsx'
import { FileAudio, FileText, FolderOpen, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import { MESSAGE_ATTACHMENTS_MAX, uuidv7, type Attachment } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { SIGNED_OUT } from '../../lib/localData'
import { formatSize } from '../../lib/format'
import { previewKind, serverPreview } from '../../lib/preview'
import { openFilePreview, openTeamFile } from '../../lib/sidePanel'
import { loadChips, patchStash, readStash, saveChips, shareStash, subscribeStash, TEAM_FILE_DRAG_TYPE, writeStash, type AttachResult } from '../../lib/teamAttach'
import { cancelUpload, uploadFile, uploadPercent, type UploadProgress } from '../../lib/upload'
import { pastedFiles } from '../../lib/paste'
import { dragKind, type DropKind } from '../../lib/fileDrop'
import { attachmentItem, localItem } from '../../lib/imageViewer'
import { useFolderWords } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
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

/** The chips of a draft and what adds, removes and sends them. `ensureChat`: the chat the files go into (made by the
 * first file of a chat that does not exist yet). `onError`: a line for the box (null clears it): too many files, or
 * `teamFilesOnly` (a shared chat takes no file from this computer). `reload` false: the chips are not kept across a
 * reload (the box's chat is not either). */
export function useComposerFiles({ userId, draftId, ensureChat, onError, teamFilesOnly, reload = true }: {
  userId: string
  draftId: string
  ensureChat: () => Promise<string>
  onError: (message: string | null) => void
  teamFilesOnly?: string
  reload?: boolean
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
    if (!all.length) return
    // a shared chat takes no file from this computer (the server would refuse it: 409 shared_chat_upload)
    if (teamFilesOnly) return onError(teamFilesOnly)
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
          update(it.id, { status: 'done', attachment: r.attachment })
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
      const pasted = pastedFiles(e.clipboardData)
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

/** Drag events a drop target nearer the pointer took already: the targets around it let them be (the nearest wins). */
const taken = new WeakSet<object>()

/** A drop target: a box, or a panel around one (components/FileDropZone.tsx). `files`: files from this computer;
 * `teamPath`: a team file dragged from the file screen, a preview or a message (left out: not taken here); `refusal`:
 * why a drop of this kind would do nothing here (shown instead, and the drop does nothing), or null.
 * `drag`: something it takes is over it (not over a nearer target inside it); `refusal`: the reason for that drag.
 * Moving over its own parts is not leaving it: a count of the enters and leaves that reached it, and the element the
 * pointer goes to (`relatedTarget`) when the browser says. Off on a drop, on leaving it, at the drag's end and on Esc.
 * A picture or link dragged from the page itself is not a file from this computer (lib/fileDrop.ts dragKind). */
export function useFileDrop({ files, teamPath, refusal }: { files?: (files: File[]) => void; teamPath?: (path: string) => void; refusal?: (kind: DropKind) => string | null }) {
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
        const list = Array.from(e.dataTransfer.files ?? [])
        if (list.length && files) files(list)
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
                removeLabel={t('composer.removeAttachment', { name: f.name })}
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
            <Tooltip label={t('composer.removeAttachment', { name: f.name })}>
              <button type="button" aria-label={t('composer.removeAttachment', { name: f.name })} title="" onClick={() => onRemove(f)} className="-my-1 -mr-1 rounded-md p-1 text-faint hover:bg-hover hover:text-ink max-sm:p-1.5">
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
