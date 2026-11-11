// File preview next to the chat or the file screen: the file's name, its actions and, under them, its body
// (components/FileBody.tsx: the viewer of its kind, read by useFileBlob; a team file from /api/files/download, a file
// sent in a team chat room from /api/rooms/:id/files/:fileId, which has only the download).
// Text files the person may write can be fixed in place (tab 5 "텍스트 파일 고치기"): the editor keeps the sha256 it
// loaded and saves with it as baseSha256 (PUT /api/files/content); when someone changed the file in between, the
// server keeps their version and saves this one as a conflict copy, which the panel then opens.
// An .html file has "PDF로 저장" where the server can print HTML (Me.server.htmlPdf): the server's headless browser
// prints the page as a browser does and saves "<name>.pdf" next to it (POST /api/files/html-pdf); a folder the person
// cannot write gets the same PDF as a download (GET /api/files/html-pdf).
import clsx from 'clsx'
import { Download, FileDown, FileText, FolderOpen, Loader2, Paperclip, Pencil, Sparkles, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API, fileUrl, isApiError, roomFileUrl, saveBlob, startDownload, errorText } from '../lib/api'
import { parentPath } from '../lib/paths'
import { PREVIEW_TEXT_MAX, type PreviewKind } from '../lib/preview'
import { openTeamFile, setPanelExpanded, type PreviewFile } from '../lib/sidePanel'
import { TEAM_FILE_DRAG_TYPE } from '../lib/teamAttach'
import { useTeamAttach } from '../lib/useTeamAttach'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { useMe } from '../store/session'
import { conflictText, savedHere, savingHere } from '../lib/conflictNotice'
import { PAGE_FIT_QUERY } from '../lib/pageFit'
import { Button, confirmDialog, IconButton, useMediaQuery } from './ui'
import { askTrinaInRoom, fileSeed } from '../lib/sideChatAsk'
import { MenuButton, type MenuItem } from './rooms/MenuButton'
import { Tooltip } from './Tooltip'
import { PanelExpandButton } from './SidePanelFrame'
import FileBody, { useFileBlob } from './FileBody'

const MAX_TEXT = PREVIEW_TEXT_MAX
/** kinds the panel can edit as plain text */
const EDITABLE: PreviewKind[] = ['markdown', 'text', 'csv', 'html', 'svg', 'xml']
/** kinds a phone offers to edit (from the header's ⋯ sheet): prose only. A page's or a table's raw source is no use to
 * edit on a phone keyboard (QA TC-259; computers keep the pencil for every EDITABLE kind). */
const PHONE_EDITABLE: PreviewKind[] = ['markdown', 'text']
export const phoneCanEdit = (kind: PreviewKind | null | undefined) => !!kind && PHONE_EDITABLE.includes(kind)

/** "Ask AI" and "add to chat" for the open file: team files only, not a missing one, and not a download-only file (the AI
 * is refused that file's bytes, so the action could only fail). */
export function chatActionsFor(file: { source: PreviewFile['source'] }, error: { kind: string } | null, downloadOnly: boolean): boolean {
  return file.source === 'team' && error?.kind !== 'missing' && !downloadOnly
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
  const loaded = useFileBlob(file, rev)
  const { kind, error, downloadOnly } = loaded
  const [editing, setEditing] = useState<{ base: string; text: string; draft: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const canEdit = file.source === 'team' && !!kind && EDITABLE.includes(kind)
  // a phone (narrow and touch: the pencil's max-md:pointer-coarse:hidden) edits from the ⋯ sheet, prose only; a mouse
  // (a narrow window too) and a wide touch screen keep the pencil, so there is never a second edit
  const phone = useMediaQuery(PAGE_FIT_QUERY)
  const me = useMe()
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => setEditing(null), [file])

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
  const cancelEdit = async () => {
    if (editing && editing.draft !== editing.text && !(await confirmDialog({ title: t('preview.discardTitle'), confirm: t('preview.discard'), danger: true }))) return
    setEditing(null)
  }
  const saveEdit = async () => {
    if (!editing || file.source !== 'team') return
    setSaving(true)
    try {
      savingHere(file.path)
      const r = await api.call(API.saveContent, { body: { path: file.path, content: editing.draft, baseSha256: editing.base } })
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
    : saveBlob(file.blob, file.name)
  // phones: "add to chat", "open in Files" and "download" sit behind one ⋯ (a computer keeps them as icons)
  const teamPath = file.source === 'team' ? file.path : null
  const addToChat = teamPath && chatActionsFor(file, error, downloadOnly) && chatAttach.target ? { title: chatAttach.target.title, add: () => chatAttach.addToChat([teamPath]) } : null
  // the folder shows beside the panel: a big panel goes back side by side
  const openInFiles = () => {
    if (!teamPath) return
    setPanelExpanded(false)
    navigate(`/files?path=${encodeURIComponent(parentPath(teamPath))}&select=${encodeURIComponent(file.name)}`)
  }
  const canDownload = error?.kind !== 'missing'
  // an .html team file the server can print (never a button that cannot work), not while editing or after an error
  const canPdf = file.source === 'team' && kind === 'html' && !!me?.server.htmlPdf && !error && !editing
  // the app's "…" menu (rooms/MenuButton.tsx): arrow keys, Home / End, Esc back to the button; a bottom sheet on phones
  const more: MenuItem[] = [
    ...(canEdit && phone && phoneCanEdit(kind) && !editing && !error ? [{ label: t('preview.edit'), icon: <Pencil size={15} className="shrink-0" aria-hidden />, onSelect: () => { if (!loadingEdit) void startEdit() }, testId: 'file-more-edit' }] : []),
    ...(canPdf ? [{ label: pdfBusy ? t('preview.savingPdf') : t('preview.savePdf'), icon: pdfBusy ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden /> : <FileDown size={15} className="shrink-0" aria-hidden />, onSelect: () => void savePdf(), testId: 'file-more-save-pdf' }] : []),
    ...(addToChat ? [{ label: t('files.addToChatNamed', { title: addToChat.title }), icon: <Paperclip size={15} className="shrink-0" aria-hidden />, onSelect: addToChat.add, testId: 'file-more-add-to-chat' }] : []),
    ...(file.source === 'team' ? [{ label: t('preview.openInFiles'), icon: <FolderOpen size={15} className="shrink-0" aria-hidden />, onSelect: openInFiles, testId: 'file-more-open-in-files' }] : []),
    ...(canDownload ? [{ label: t('common.download'), icon: <Download size={15} className="shrink-0" aria-hidden />, onSelect: download, testId: 'file-more-download' }] : []),
  ]

  return (
    <aside aria-label={t('preview.panel')} className="flex h-full min-w-0 flex-col bg-surface" data-testid="file-panel">
      {/* @container: a narrow panel (the divider at its least) shows "AI에게 묻기" as its icon, so the name keeps room */}
      <header className="@container flex items-center gap-2 border-b border-line px-3 py-2">
        <FileText size={16} className="shrink-0 text-muted" aria-hidden />
        <h2
          className={clsx('min-w-0 truncate text-sm font-semibold', file.source === 'team' && 'cursor-grab')}
          title={file.source === 'team' ? `${file.path}\n${t('files.dragToChat')}` : file.name}
          draggable={file.source === 'team'}
          onDragStart={(e) => {
            if (file.source !== 'team') return
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
            <Tooltip label={t('files.askAi')}>
              <button type="button" onClick={() => chatAttach.askAi([file.path])} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-md:p-1.5 max-sm:p-2" data-testid="file-ask-ai">
                {/* phones: the icon alone, as large as the header's other icons, in an IconButton's padding */}
                <Sparkles size={14} className="max-md:size-4" aria-hidden /> <span className="max-md:sr-only @max-md:sr-only">{t('files.askAiShort')}</span>
              </button>
            </Tooltip>
          )}
          {file.source === 'room' && (
            <Tooltip label={t('sideChat.askAboutFile')}>
              <button type="button" onClick={() => askTrinaInRoom(file.roomId, fileSeed(file.fileId, file.name))}
                className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-md:p-1.5 max-sm:p-2" data-testid="file-ask-trina">
                <Sparkles size={14} className="max-md:size-4" aria-hidden /> <span className="max-md:sr-only">{t('sideChat.askAboutFileShort')}</span>
              </button>
            </Tooltip>
          )}
          {addToChat && (
            <IconButton label={t('files.addToChatNamed', { title: addToChat.title })} className="max-md:hidden" onClick={addToChat.add} data-testid="file-add-to-chat">
              <Paperclip size={16} />
            </IconButton>
          )}
          {canPdf && (
            <button type="button" onClick={() => void savePdf()} disabled={pdfBusy} aria-busy={pdfBusy} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted transition hover:bg-hover hover:text-ink disabled:opacity-60 max-md:hidden" data-testid="file-save-pdf">
              {pdfBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileDown size={14} aria-hidden />} {pdfBusy ? t('preview.savingPdf') : t('preview.savePdf')}
            </button>
          )}
          {canEdit && !editing && !error && (
            // computers (a narrow mouse window too); phones (narrow and touch) edit from the ⋯ sheet, and only prose
            // (PHONE_EDITABLE)
            <IconButton label={t('preview.edit')} className="max-md:pointer-coarse:hidden" onClick={() => void startEdit()} disabled={loadingEdit} data-testid="file-edit">
              {loadingEdit ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
            </IconButton>
          )}
          {file.source === 'team' && (
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
          <PanelExpandButton />
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div ref={body} className="min-h-0 flex-1 overflow-auto bg-subtle/50">
        {editing ? (
          <div className="flex h-full flex-col gap-2 p-3">
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
          <FileBody file={file} loaded={loaded} width={width} download={download} onRetry={() => setRev((v) => v + 1)} />
        )}
      </div>
    </aside>
  )
}
