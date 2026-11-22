// File preview next to the chat or the file screen: the file's name, its actions and, under them, its body
// (components/FileBody.tsx: the viewer of its kind, read by useFileBlob; a team file from /api/files/download, a file
// sent in a team chat room from /api/rooms/:id/files/:fileId, which has only the download).
// Text files the person may write can be fixed in place (tab 5 "텍스트 파일 고치기"): the editor keeps the sha256 it
// loaded and saves with it as baseSha256 (PUT /api/files/content); when someone changed the file in between, the
// server keeps their version and saves this one as a conflict copy, which the panel then opens.
// The pencil shows only where the person may write the file: the panel asks /api/files/content once (its `access`, the
// same answer the edit itself checks) and leaves the pencil out of a read-only folder, as "PDF로 저장" turns into a
// download there (QA TC-502).
// A chat's own file (a chat shared with people: source 'chat') is edited the same way by whoever may open it
// (docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md): a save is a new version (PUT
// /api/chats/:id/files/:fileId/content), nothing is overwritten. The server says whether the person may edit now
// (GET …/versions canEdit: not a project chat, not text, the trash, safe operations; canRestore: the same for any file
// type, QA TC-7040); the panel lists the versions under
// "Updated by <name> · <time>", opens one and restores it (a new newest version with its bytes).
// An .html file has "PDF로 저장" where the server can print HTML (Me.server.htmlPdf): the server's headless browser
// prints the page as a browser does and saves "<name>.pdf" next to it (POST /api/files/html-pdf); a folder the person
// cannot write gets the same PDF as a download (GET /api/files/html-pdf).
import clsx from 'clsx'
import { Download, FileDown, FileText, FolderOpen, History, Loader2, Paperclip, Pencil, RotateCcw, UserPlus, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API, chatFileUrl, fetchChatFileBlob, fileUrl, isApiError, roomFileUrl, saveBlob, startDownload, errorText } from '../lib/api'
import type { Attachment, ChatFileVersions } from '@mycel/shared/api'
import { CHAT_FILE_VERSIONS_KEPT, chatTextEditable, headUpdated, updatedLine, versionBy } from '../lib/chatFileVersions'
import { formatRelative, formatSize } from '../lib/format'
import { useChats } from '../store/chats'
import { extOf, parentPath } from '../lib/paths'
import { PREVIEW_TEXT_MAX, type PreviewKind } from '../lib/preview'
import { openTeamFile, setPanelExpanded, setPanelGuard, type PreviewFile } from '../lib/sidePanel'
import { markBusy } from '../lib/busy'
import { TEAM_FILE_DRAG_TYPE } from '../lib/teamAttach'
import { useTeamAttach } from '../lib/useTeamAttach'
import { useLocale, useT } from '../i18n'
import { aiName } from '../lib/tabs'
import { toast } from '../store/ui'
import { useMe } from '../store/session'
import { useGuestFolderHref } from './GuestView'
import { keptFolder } from '../store/teamFiles'
import { conflictText, savedHere, savingHere } from '../lib/conflictNotice'
import { PAGE_FIT_QUERY } from '../lib/pageFit'
import { Button, confirmDialog, IconButton, useMediaQuery } from './ui'
import { askTrinaInRoom, fileSeed } from '../lib/sideChatAsk'
import { MenuButton, type MenuItem } from './rooms/MenuButton'
import { AiMark } from './rooms/AiFace'
import { Tooltip } from './Tooltip'
import { PanelExpandButton } from './SidePanelFrame'
import FileBody, { useFileBlob } from './FileBody'
import { openFileShare } from './FileShareDialog'
import { isGuestMe } from '../lib/guests'

const MAX_TEXT = PREVIEW_TEXT_MAX
/** kinds the panel can edit as plain text */
const EDITABLE: PreviewKind[] = ['markdown', 'text', 'csv', 'html', 'svg', 'xml']
/** files a phone offers to edit (from the header's ⋯ sheet), by extension: prose only, Markdown and .txt. A page's, a
 * table's or a code file's raw source (.json, .yml, .ts…: the 'text' kind too) is no use to edit on a phone keyboard
 * (QA TC-259; computers keep the pencil for every EDITABLE kind). */
const PHONE_EDITABLE = ['md', 'markdown', 'txt']
export const phoneCanEdit = (name: string | null | undefined) => !!name && PHONE_EDITABLE.includes(extOf(name))

/** "Ask AI" and "add to chat" for the open file: team files only, not a missing one, and not a download-only file (the AI
 * is refused that file's bytes, so the action could only fail). */
export function chatActionsFor(file: { source: PreviewFile['source'] }, error: { kind: string } | null, downloadOnly: boolean): boolean {
  return file.source === 'team' && error?.kind !== 'missing' && !downloadOnly
}

/** May the person write this team file? The `access` of /api/files/content (what the edit checks before it opens the
 * editor), asked once per file. False until it answers, so a read-only file never flashes a pencil; true when the
 * question itself fails (the edit then says why, as before). */
export function useWritable(file: PreviewFile, editable: boolean): boolean {
  // the answer is kept with its path, so a file opened next never shows the last file's pencil for a frame
  const [answer, setAnswer] = useState<{ path: string; ok: boolean } | null>(null)
  const path = file.source === 'team' ? file.path : null
  useEffect(() => {
    if (!path || !editable) return
    // the file's row in its folder as last listed (store/teamFiles.ts) says it already: nothing to ask (the edit itself
    // asks again before it opens the editor)
    const row = keptFolder(parentPath(path))?.entries.find((e) => e.type === 'file' && e.path.normalize('NFC') === path.normalize('NFC'))
    if (row) return setAnswer({ path, ok: row.access === 'write' })
    let live = true
    api.call(API.content, { query: { path, maxBytes: 1 } }).then(
      (c) => live && setAnswer({ path, ok: c.access === 'write' }),
      () => live && setAnswer({ path, ok: true }),
    )
    return () => {
      live = false
    }
  }, [path, editable])
  return !!path && editable && answer?.path === path && answer.ok
}

/** A chat file's versions and whether I may edit it (GET /api/chats/:id/files/:fileId/versions), read again with `rev`;
 * null for any other file, while it loads, and when the server says no (a file I may not open: nothing about it). */
export function useChatFileVersions(file: PreviewFile, rev: number): ChatFileVersions | null {
  const [answer, setAnswer] = useState<{ key: string; v: ChatFileVersions | null } | null>(null)
  const key = file.source === 'chat' ? `${file.chatId}:${file.fileId}` : null
  useEffect(() => {
    if (file.source !== 'chat' || !key) return
    let live = true
    api.call(API.chatFileVersions, { params: { id: file.chatId, fileId: file.fileId } }).then(
      (v) => live && setAnswer({ key, v }),
      () => live && setAnswer({ key, v: null }),
    )
    return () => {
      live = false
    }
    // the file's ids are its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rev])
  return key && answer?.key === key ? answer.v : null
}

/** The newest version of a chat file as the chat on screen has it (Attachment.updated, which the server sends again to
 * everyone in the chat after a save: chat/chat-file-edit.ts tellChat), so an open panel reads it again: its number and
 * time, since the AI's saves within one answer keep one version (its number stays, its time moves) */
function useLiveVersion(file: PreviewFile): string | null {
  const chatId = file.source === 'chat' ? file.chatId : null
  const fileId = file.source === 'chat' ? file.fileId : null
  return useChats((s) => {
    if (!chatId) return null
    for (const m of s.threads[chatId]?.messages ?? []) for (const a of m.attachments ?? []) if (a.id === fileId) return a.updated ? `${a.updated.version}@${a.updated.at}` : '1'
    return null
  })
}

/** Who saved the newest version of a chat file as the chat on screen has it (Attachment.updated; the store's own object,
 * so it is the same while nothing changed), for the editor's "<name> saved a newer version" line; null: none known */
function useLiveUpdated(file: PreviewFile): NonNullable<Attachment['updated']> | null {
  const chatId = file.source === 'chat' ? file.chatId : null
  const fileId = file.source === 'chat' ? file.fileId : null
  return useChats((s) => {
    if (!chatId) return null
    for (const m of s.threads[chatId]?.messages ?? []) for (const a of m.attachments ?? []) if (a.id === fileId) return a.updated ?? null
    return null
  })
}

export default function FilePanel({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatAttach = useTeamAttach()
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [rev, setRev] = useState(0)
  // a download-only (quarantined) file: the AI cannot read it either, so "Ask AI" and "add to chat" are left out and the
  // body's notice says why
  // a chat's file: an earlier version opened from the list (its number), else the newest
  const [shownVersion, setShownVersion] = useState<number | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const viewed: PreviewFile = useMemo(() => (file.source === 'chat' && shownVersion ? { ...file, version: shownVersion } : file), [file, shownVersion])
  const loaded = useFileBlob(viewed, rev)
  const { kind, error, downloadOnly } = loaded
  // the file does not open for me: the server answers 'not_found' alike for gone and not mine (the "only its creator can
  // add it to the chat" ask, components/ChatFileAsk.tsx, and the "can't be found, or you don't have access" line). The
  // header keeps the name and Close only: no file action that needs the file, nothing about where it is.
  const noAccess = error?.kind === 'missing'
  // `from`: the number and time of the version the editor opened (a chat's file), so a newer save by someone else shows
  // in the editor at once (QA TC-6956); `theirs`: that version's text, opened with View
  const [editing, setEditing] = useState<{ base: string; text: string; draft: string; from?: { version: number; at: string }; theirs?: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)
  const versions = useChatFileVersions(file, rev)
  const live = useLiveVersion(file)
  const liveBy = useLiveUpdated(file)
  const canEdit = file.source === 'team' && !!kind && EDITABLE.includes(kind)
  // a chat's file: text, the server's yes, and the newest version on screen (an earlier one is restored, not edited)
  const canEditChat = file.source === 'chat' && !!kind && EDITABLE.includes(kind) && chatTextEditable(file.name) && !!versions?.canEdit && !shownVersion
  // a phone (narrow and touch: the pencil's max-md:pointer-coarse:hidden) edits from the ⋯ sheet, prose only; a mouse
  // (a narrow window too) and a wide touch screen keep the pencil, so there is never a second edit
  const phone = useMediaQuery(PAGE_FIT_QUERY)
  const me = useMe()
  const [pdfBusy, setPdfBusy] = useState(false)
  const writable = useWritable(file, canEdit && !error && !downloadOnly)
  const showEdit = (canEdit && writable) || (canEditChat && !downloadOnly)

  useEffect(() => {
    setEditing(null)
    setShownVersion(null)
    setListOpen(false)
  }, [file])
  // someone saved a new version of the chat's file (the chat's tiles changed): read it and the list again, unless I am
  // editing it (my save then is `beside` theirs, both kept)
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (live === null) return
    if (seen.current !== null && seen.current !== live && !editing) setRev((v) => v + 1)
    seen.current = live
  }, [live, editing])

  /** "PDF로 저장": the server prints the page and saves the PDF next to it; a read-only folder gets it as a download */
  const savePdf = async () => {
    if (file.source !== 'team' || pdfBusy) return
    setPdfBusy(true)
    try {
      const r = await api.call(API.saveHtmlPdf, { body: { path: file.path } })
      const detail = [r.blocked ? t('preview.pdfBlocked', { count: r.blocked }) : '', r.scripts ? t('preview.pdfScripts') : ''].filter(Boolean).join(' ')
      toast({ level: 'success', text: t('preview.pdfSaved', { name: r.entry.name }), ...(detail ? { detail } : {}), action: { label: t('preview.pdfOpen'), run: () => openTeamFile(r.entry.path) } })
    } catch (e) {
      // only a folder the person cannot write gets the download; any other refusal (the PDF would let more people see
      // a file of the page) says why and saves nothing
      if (isApiError(e, 'forbidden') && e.body.params?.reason === 'read_only') {
        startDownload(api.url(API.downloadHtmlPdf, { query: { path: file.path } }), file.name.replace(/\.[^./]+$/, '') + '.pdf')
        toast({ level: 'info', text: t('preview.pdfDownloaded') })
      } else toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setPdfBusy(false)
    }
  }

  const startEdit = async () => {
    if (file.source === 'chat') return void startChatEdit()
    if (file.source !== 'team') return
    setLoadingEdit(true)
    try {
      const c = await api.call(API.content, { query: { path: file.path, maxBytes: MAX_TEXT } })
      if (c.access !== 'write') return toast({ level: 'warn', text: t('files.readOnlyFolder') })
      if (c.binary || c.content === null || c.truncated) return toast({ level: 'warn', text: t('preview.editTooLarge') })
      setEditing({ base: c.sha256, text: c.content, draft: c.content })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setLoadingEdit(false)
    }
  }
  // a chat's file: its newest bytes and the version they are (a save after someone else's is `beside` it)
  const startChatEdit = async () => {
    if (file.source !== 'chat') return
    const head = versions?.items.find((v) => v.head) ?? versions?.items[versions.items.length - 1]
    if (!head) return
    setLoadingEdit(true)
    try {
      const b = await fetchChatFileBlob(file.chatId, file.fileId, MAX_TEXT, undefined, { truncate: true })
      if (b.size > MAX_TEXT) return toast({ level: 'warn', text: t('preview.editTooLarge') })
      const text = await b.text()
      setEditing({ base: head.id, text, draft: text, from: { version: head.version, at: head.createdAt } })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setLoadingEdit(false)
    }
  }
  const saveChatEdit = async () => {
    if (!editing || file.source !== 'chat') return
    setSaving(true)
    try {
      const r = await api.call(API.saveChatFile, { params: { id: file.chatId, fileId: file.fileId }, body: { content: editing.draft, baseVersion: editing.base } })
      setPanelGuard(null)
      setEditing(null)
      // someone saved in between: theirs is kept, named, and View opens it (QA TC-6956)
      const theirs = r.beside ? r.besideOf : undefined
      toast(theirs ? { level: 'warn', text: t('chatFile.savedBesideBy', { name: versionBy(t, theirs) }), action: { label: t('chatFile.view'), run: () => setShownVersion(theirs.version) } }
        : r.beside ? { level: 'warn', text: t('chatFile.savedBeside') } : { level: 'success', text: t('preview.saved') })
      setRev((v) => v + 1)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setSaving(false)
    }
  }
  /** "Restore this version": a new newest version with its bytes; at the cap the oldest after the first goes, and the
   * notice says which (QA TC-6949) */
  const restore = async (n: number) => {
    if (file.source !== 'chat' || restoring !== null) return
    setRestoring(n)
    try {
      const r = await api.call(API.restoreChatFileVersion, { params: { id: file.chatId, fileId: file.fileId, version: String(n) } })
      // (restoring the oldest kept one at the cap: its own old entry is what goes)
      toast({ level: 'success', text: !r.pruned?.length ? t('chatFile.restored', { n })
        : r.pruned.includes(n) ? t('chatFile.restoredMoved', { n, kept: CHAT_FILE_VERSIONS_KEPT })
        : t('chatFile.restoredPruned', { n, old: r.pruned.join(t('rooms.nameSep')), kept: CHAT_FILE_VERSIONS_KEPT }) })
      setShownVersion(null)
      setRev((v) => v + 1)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setRestoring(null)
    }
  }
  // someone else saved while I edit: the chat's newest version is past the one the editor opened (a higher number, or the
  // AI's same-answer save of it later), and not my own save: their name, and View
  const past = (u: NonNullable<Attachment['updated']>, f: { version: number; at: string }) => u.version > f.version || (u.version === f.version && u.at > f.at)
  const newer = editing?.from && file.source === 'chat' && liveBy && past(liveBy, editing.from) && !(liveBy.by === me?.user.id && !liveBy.ai) ? liveBy : null
  const viewTheirs = async () => {
    if (!editing || file.source !== 'chat' || !newer) return
    if (typeof editing.theirs === 'string') return setEditing({ ...editing, theirs: null })
    try {
      const b = await fetchChatFileBlob(file.chatId, file.fileId, MAX_TEXT, undefined, { truncate: true, version: newer.version })
      const text = await b.text()
      setEditing((e) => (e ? { ...e, theirs: text } : e))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const unsaved = !!editing && editing.draft !== editing.text
  const askDiscard = () => confirmDialog({ title: t('preview.discardTitle'), confirm: t('preview.discard'), danger: true })
  // closing the panel (✕, Back on a phone, Esc), opening another file or leaving the page with edits not saved asks
  // first (lib/sidePanel.ts); a full reload or closing the tab gets the browser's own question
  useEffect(() => {
    if (!unsaved) return
    setPanelGuard(askDiscard)
    // nothing reloads or restarts by itself over the edits (web update, desktop update restart)
    const release = markBusy('draft')
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      setPanelGuard(null)
      release()
      window.removeEventListener('beforeunload', beforeUnload)
    }
    // askDiscard only reads the language; the guard is set while there are edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsaved])
  const cancelEdit = async () => {
    if (unsaved && !(await askDiscard())) return
    setEditing(null)
  }
  const saveEdit = async () => {
    if (file.source === 'chat') return void saveChatEdit()
    if (!editing || file.source !== 'team') return
    setSaving(true)
    try {
      savingHere(file.path)
      const r = await api.call(API.saveContent, { body: { path: file.path, content: editing.draft, baseSha256: editing.base } })
      // saved: nothing to lose any more, so what follows (a conflict copy opening in this panel) is not asked about
      setPanelGuard(null)
      setEditing(null)
      if (r.conflict) {
        // one notice (the live event for this save is not shown again): my content is in the copy, opened now
        toast({ level: 'warn', text: conflictText(file.path, me ? { id: me.user.id, name: me.user.name } : null) })
        openTeamFile(r.path)
      } else {
        savedHere(file.path)
        toast({ level: 'success', text: t('preview.saved') })
        setRev((v) => v + 1)
      }
    } catch (e) {
      savedHere(file.path)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setSaving(false)
    }
  }

  // the viewers fit the panel's width. When it changes (크게 보기, the divider, the window) the pages grow or shrink: the
  // place being read, as a share of the scroll height, is brought back while they settle (until the person scrolls).
  // A body that keeps its own place (a PDF, viewers/PdfView: `data-keeps-place`) is left to do it
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    let share = 0
    let last = el.clientWidth
    let until = 0
    let frame = 0
    const settling = () => until > performance.now()
    const settle = () => {
      frame = 0
      if (!settling()) return
      el.scrollTop = share * el.scrollHeight
      frame = requestAnimationFrame(settle)
    }
    const onScroll = () => {
      if (!settling()) share = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0
    }
    // the person scrolls: theirs from now on
    const stop = () => {
      until = 0
      cancelAnimationFrame(frame)
    }
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      if (el.clientWidth === last) return
      last = el.clientWidth
      if (share <= 0 || el.querySelector('[data-keeps-place]')) return
      until = performance.now() + 800
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(settle)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    el.addEventListener('scroll', onScroll, { passive: true })
    for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.addEventListener(e, stop, { passive: true })
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
      for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.removeEventListener(e, stop)
    }
  }, [])

  const download = () =>
    file.source === 'team' ? startDownload(fileUrl(file.path), file.name)
    : file.source === 'room' ? startDownload(roomFileUrl(file.roomId, file.fileId, { download: '1' }), file.name)
    : file.source === 'chat' ? startDownload(chatFileUrl(file.chatId, file.fileId, { download: '1', ...(shownVersion ? { version: shownVersion } : {}) }), file.name)
    : saveBlob(file.blob, file.name)
  // phones: "add to chat", "open in Files" and "download" sit behind one ⋯ (a computer keeps them as icons)
  const teamPath = file.source === 'team' ? file.path : null
  const addToChat = teamPath && chatActionsFor(file, error, downloadOnly) && chatAttach.target ? { title: chatAttach.target.title, add: () => chatAttach.addToChat([teamPath]) } : null
  // the folder shows beside the panel: a big panel goes back side by side
  // a guest has no 파일 screen: their project's files screen, or no button (their own folder has no screen)
  const guestFolder = useGuestFolderHref()
  const filesHref = teamPath === null || noAccess ? null
    : guestFolder ? guestFolder(parentPath(teamPath), teamPath)
    : `/files?path=${encodeURIComponent(parentPath(teamPath))}&select=${encodeURIComponent(file.name)}`
  const openInFiles = () => {
    if (!filesHref) return
    setPanelExpanded(false)
    navigate(filesHref)
  }
  const canDownload = !noAccess
  // an .html team file the server can print (never a button that cannot work), not while editing or after an error
  const canPdf = file.source === 'team' && kind === 'html' && !!me?.server.htmlPdf && !error && !editing
  // the app's "…" menu (rooms/MenuButton.tsx): arrow keys, Home / End, Esc back to the button; a bottom sheet on phones
  const more: MenuItem[] = [
    ...(showEdit && phone && phoneCanEdit(file.name) && !editing && !error ? [{ label: t('preview.edit'), icon: <Pencil size={15} className="shrink-0" aria-hidden />, onSelect: () => { if (!loadingEdit) void startEdit() }, testId: 'file-more-edit' }] : []),
    ...(canPdf ? [{ label: pdfBusy ? t('preview.savingPdf') : t('preview.savePdf'), icon: pdfBusy ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden /> : <FileDown size={15} className="shrink-0" aria-hidden />, onSelect: () => void savePdf(), testId: 'file-more-save-pdf' }] : []),
    ...(addToChat ? [{ label: addToChat.title ? t('files.addToChatNamed', { title: addToChat.title }) : t('files.addToCurrentChat'), icon: <Paperclip size={15} className="shrink-0" aria-hidden />, onSelect: addToChat.add, testId: 'file-more-add-to-chat' }] : []),
    ...(filesHref ? [{ label: t('preview.openInFiles'), icon: <FolderOpen size={15} className="shrink-0" aria-hidden />, onSelect: openInFiles, testId: 'file-more-open-in-files' }] : []),
    // a team file shared with chosen people (QA TC-3093; components/FileShareDialog.tsx)
    ...(file.source === 'team' && !isGuestMe(me) && !noAccess ? [{ label: t('folderAccess.menu'), icon: <UserPlus size={15} className="shrink-0" aria-hidden />, onSelect: () => openFileShare(file.path), testId: 'file-more-share' }] : []),
    ...(canDownload ? [{ label: t('common.download'), icon: <Download size={15} className="shrink-0" aria-hidden />, onSelect: download, testId: 'file-more-download' }] : []),
  ]

  return (
    <aside aria-label={t('preview.panel')} className="flex h-full min-w-0 flex-col bg-surface" data-testid="file-panel">
      {/* @container: a narrow panel (the divider at its least) shows "AI에게 묻기" as its icon, so the name keeps room */}
      <header className="@container flex items-center gap-2 border-b border-line px-3 py-2">
        <FileText size={16} className="shrink-0 text-muted" aria-hidden />
        <h2
          className={clsx('min-w-0 truncate text-sm font-semibold', file.source === 'team' && !noAccess && 'cursor-grab')}
          title={file.source === 'team' && !noAccess ? `${file.path}\n${t('files.dragToChat')}` : file.name}
          draggable={file.source === 'team' && !noAccess}
          onDragStart={(e) => {
            if (file.source !== 'team' || noAccess) return
            e.dataTransfer.setData(TEAM_FILE_DRAG_TYPE, file.path)
            e.dataTransfer.setData('text/plain', file.path)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          data-testid="file-panel-title"
        >
          {file.name}
        </h2>
        <div className="ml-auto flex shrink-0 items-center">
          {file.source === 'team' && chatActionsFor(file, error, downloadOnly) && (
            <Tooltip label={t('files.askAi', { name: aiName(t) })}>
              <button type="button" onClick={() => chatAttach.askAi([file.path])} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-md:p-1.5 max-sm:p-2" data-testid="file-ask-ai">
                {/* phones: the icon alone, as large as the header's other icons, in an IconButton's padding */}
                <AiMark place="label" /> <span className="max-md:sr-only @max-md:sr-only">{t('files.askAiShort', { name: aiName(t) })}</span>
              </button>
            </Tooltip>
          )}
          {file.source === 'room' && !noAccess && (
            <Tooltip label={t('sideChat.askAboutFile')}>
              <button type="button" onClick={() => askTrinaInRoom(file.roomId, fileSeed(file.fileId, file.name))}
                className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-md:p-1.5 max-sm:p-2" data-testid="file-ask-trina">
                <AiMark place="label" /> <span className="max-md:sr-only">{t('sideChat.askAboutFileShort')}</span>
              </button>
            </Tooltip>
          )}
          {addToChat && (
            <IconButton label={addToChat.title ? t('files.addToChatNamed', { title: addToChat.title }) : t('files.addToCurrentChat')} className="max-md:hidden" onClick={addToChat.add} data-testid="file-add-to-chat">
              <Paperclip size={16} />
            </IconButton>
          )}
          {canPdf && (
            <button type="button" onClick={() => void savePdf()} disabled={pdfBusy} aria-busy={pdfBusy} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted transition hover:bg-hover hover:text-ink disabled:opacity-60 max-md:hidden" data-testid="file-save-pdf">
              {pdfBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileDown size={14} aria-hidden />} {pdfBusy ? t('preview.savingPdf') : t('preview.savePdf')}
            </button>
          )}
          {showEdit && !editing && !error && (
            // computers (a narrow mouse window too); phones (narrow and touch) edit from the ⋯ sheet, and only prose
            // (PHONE_EDITABLE)
            <IconButton label={t('preview.edit')} className="max-md:pointer-coarse:hidden" onClick={() => void startEdit()} disabled={loadingEdit} data-testid="file-edit">
              {loadingEdit ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
            </IconButton>
          )}
          {filesHref && (
            <IconButton label={t('preview.openInFiles')} className="max-md:hidden" onClick={openInFiles}>
              <FolderOpen size={16} />
            </IconButton>
          )}
          {canDownload && (
            <IconButton label={t('common.download')} className="max-md:hidden" onClick={download}>
              <Download size={16} />
            </IconButton>
          )}
          {more.length > 0 && <MenuButton label={t('files.actionsFor', { name: file.name })} items={more} className="md:hidden" muted testId="file-panel-more" />}
          {!noAccess && <PanelExpandButton />}
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      {versions && !editing && (
        <ChatFileHistory versions={versions} shown={shownVersion} open={listOpen} setOpen={setListOpen} restoring={restoring}
          onOpen={(n) => { setShownVersion(n); setListOpen(false) }} onNewest={() => setShownVersion(null)} onRestore={(n) => void restore(n)} />
      )}
      <div ref={body} className="min-h-0 flex-1 overflow-auto bg-subtle/50">
        {editing ? (
          <div className="flex h-full flex-col gap-2 p-3">
            {newer && (
              <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted" role="status" data-testid="file-editor-newer">
                <span className="break-words">{t('chatFile.newerWhileEditing', { name: versionBy(t, { byName: newer.byName, ...(newer.ai ? { ai: true as const } : {}) }) })}</span>{' '}
                <button type="button" onClick={() => void viewTheirs()} className="touch-hit font-medium text-accent-text underline-offset-2 hover:underline" data-testid="file-editor-newer-view">
                  {typeof editing.theirs === 'string' ? t('chatFile.hide') : t('chatFile.view')}
                </button>
                {typeof editing.theirs === 'string' ? (
                  <pre className="mt-2 max-h-40 overflow-auto rounded border border-line bg-subtle/50 p-2 font-mono text-code leading-5 whitespace-pre-wrap text-ink" data-testid="file-editor-theirs">{editing.theirs}</pre>
                ) : null}
              </div>
            )}
            <textarea
              aria-label={t('preview.editorLabel', { name: file.name })}
              className="min-h-0 flex-1 resize-none rounded-lg border border-field-border bg-surface p-3 font-mono text-code leading-5 text-ink focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
              value={editing.draft}
              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
              spellCheck={false}
              autoFocus
              data-testid="file-editor"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void cancelEdit()} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void saveEdit()} busy={saving} disabled={editing.draft === editing.text} data-testid="file-save">
                {t('common.save')}
              </Button>
            </div>
          </div>
        ) : (
          <FileBody file={viewed} loaded={loaded} width={width} download={download} onRetry={() => setRev((v) => v + 1)} />
        )}
      </div>
    </aside>
  )
}

/** Under the header of a chat's file changed since it was sent: "Updated by <name> · <time>" and "Versions (n)"; the
 * list (who, when, size; Open, Restore this version); and, while an earlier version is open, which one it is with
 * Restore and Back to the newest. Nothing for a file never changed. */
function ChatFileHistory({ versions, shown, open, setOpen, restoring, onOpen, onNewest, onRestore }: {
  versions: ChatFileVersions; shown: number | null; open: boolean; setOpen: (v: boolean) => void; restoring: number | null
  onOpen: (n: number) => void; onNewest: () => void; onRestore: (n: number) => void
}) {
  const t = useT()
  const locale = useLocale()
  const who = headUpdated(versions.items)
  if (!who) return null
  const old = shown ? versions.items.find((v) => v.version === shown) : null
  // Restore for every file type (a version's own bytes, QA TC-7040); an older server only says canEdit
  const mayRestore = versions.canRestore ?? versions.canEdit
  // newest first in the list
  const rows = [...versions.items].reverse()
  // the newest kept besides the first, when the cap pruned the ones between (0: no gap)
  const gap = versions.items.length > 1 && (versions.items[1]?.version ?? 2) > 2 ? versions.items.length - 1 : 0
  return (
    <div className="border-b border-line bg-surface text-xs" data-testid="file-panel-history">
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <History size={14} className="shrink-0 text-faint" aria-hidden />
        {/* wraps rather than cutting the name ("Trina for Q…" and "Trina for QA Member Two" look alike: QA TC-6952) */}
        <span className="min-w-0 flex-1 break-words text-muted" title={updatedLine(t, locale, who)} data-testid="file-panel-updated">{updatedLine(t, locale, who)}</span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="touch-hit shrink-0 rounded-md px-2 py-1 font-medium text-accent-text hover:bg-accent-soft" data-testid="file-versions-toggle">
          {t('chatFile.versions', { count: versions.items.length })}
        </button>
      </div>
      {old && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-accent-soft/40 px-3 py-1.5" data-testid="file-version-shown">
          <span className="min-w-0 flex-1 text-ink">{t('chatFile.viewing', { n: old.version, by: versionBy(t, old), when: formatRelative(old.createdAt, locale) })}</span>
          {mayRestore && (
            <Button size="sm" variant="primary" busy={restoring === old.version} onClick={() => onRestore(old.version)} data-testid="file-version-restore-shown">
              <RotateCcw size={13} aria-hidden /> {t('chatFile.restore')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onNewest} data-testid="file-version-newest">{t('chatFile.backToNewest')}</Button>
        </div>
      )}
      {open && (
        <VersionsList>
          {rows.map((v) => (
            <Fragment key={v.id}>
            {/* after the cap pruned some (the numbers jump from 1 to 9), one quiet line where they jump (QA TC-6950) */}
            {gap > 0 && v.version === 1 && <li className="px-3 py-2 text-faint [&+&]:border-t [&+&]:border-line" data-testid="file-versions-pruned">{t('chatFile.olderRemoved', { n: gap })}</li>}
            <li className={clsx('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&+&]:border-t [&+&]:border-line', shown === v.version && 'bg-accent-soft/40')} data-testid="file-version-row" data-version={v.version}>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink" id={`file-version-${v.id}`}>{t('chatFile.versionN', { n: v.version })}</span>
                {v.head && <span className="ml-1.5 rounded border border-line px-1 text-micro text-muted">{t('chatFile.current')}</span>}
                <span className="block text-faint">{versionBy(t, v)} · {formatRelative(v.createdAt, locale)} · {formatSize(v.size, locale)}</span>
              </span>
              {!v.head && (
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onOpen(v.version)} aria-describedby={`file-version-${v.id}`} data-testid="file-version-open">{t('chatFile.open')}</Button>
                  {mayRestore && (
                    <Button size="sm" variant="secondary" busy={restoring === v.version} onClick={() => onRestore(v.version)} aria-describedby={`file-version-${v.id}`} data-testid="file-version-restore">{t('chatFile.restore')}</Button>
                  )}
                </span>
              )}
            </li>
            </Fragment>
          ))}
        </VersionsList>
      )}
    </div>
  )
}

/** The versions' rows: as tall as most of the panel (no small fixed box: QA TC-6948), and a fade at the bottom while
 * more rows are below. */
function VersionsList({ children }: { children: ReactNode }) {
  const t = useT()
  const list = useRef<HTMLOListElement>(null)
  const [more, setMore] = useState(false)
  const measure = () => {
    const el = list.current
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }
  // the rows may change (a restore, a save): measured again after each render; the box's own size by an observer
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const el = list.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="relative border-t border-line">
      <ol ref={list} onScroll={measure} className="max-h-[min(60vh,36rem)] overflow-auto" aria-label={t('chatFile.versionsLabel')} data-testid="file-versions">
        {children}
      </ol>
      {more && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" aria-hidden data-testid="file-versions-more" />}
    </div>
  )
}
