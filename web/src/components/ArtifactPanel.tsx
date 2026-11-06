// An artifact next to the chat: live preview in the isolated frame or code, versions (‹ v2 / 3 ›), copy, download,
// "save to the team folder", and when it fails at runtime or cannot be built (unsupported import, compile error)
// "ask the AI to fix it". While the AI is still writing it,
// the code shows as it arrives. Ported from Saram / chat-proto ArtifactPanel.
// A promo video (key "promo-video", docs/DECISIONS.md "V") plays in the frame; its header offers [영상 파일로 받기]
// where the server can make the MP4, instead of copying or downloading the page's code. An intro deck (key
// "intro-deck", "D2") pages through its slides in the frame; its header offers one [받기 ▾] (PowerPoint, and PDF where
// the server can make it) and no "save to the team folder": the deck never becomes team material by accident.
import clsx from 'clsx'
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Download, FileText, FolderInput, Loader2, Presentation, Shapes, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, type ArtifactType, type IntroDeckInfo, type PromoVideoInfo } from '@mycel/shared/api'
import { api, API, errorText, saveBlob, startDownload } from '../lib/api'
import { artifactFailure, artifactFileName, buildArtifactDocument, fixPromptError, fixPromptWords, FRAME_TYPES, staticSource, sucraseCompile, type CompileFn, type FrameDoc } from '../lib/artifacts'
import { useFrameScripts } from '../lib/confidential'
import { joinPath } from '../lib/paths'
import { useArtifactContent, useChatArtifacts } from '../lib/useArtifacts'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { TYPE_LABEL } from './artifactLabels'
import FolderPicker from './FolderPicker'
import { CodeBlock, Markdown, MermaidBlock } from './Markdown'
import SandboxFrame, { StaticFrame } from './SandboxFrame'
import ExternalImagesNote from './ExternalImagesNote'
import { useFrameFiles } from '../lib/useFrameFiles'
import type { FrameFiles } from '../lib/frame-files'
import { Button, CopyButton, IconButton, Spinner } from './ui'

let compiler: Promise<CompileFn> | null = null

export default function ArtifactPanel({ chatId, artifactKey, versionId, onClose }: { chatId: string; artifactKey: string; versionId?: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const groups = useChatArtifacts(chatId)
  const live = useChats((s) => s.liveArtifacts[chatId]?.[artifactKey])
  const busy = useChats((s) => s.threads[chatId]?.messages.some((m) => m.status === 'streaming' || !!m.local) ?? false)
  const send = useChats((s) => s.send)
  const versions = useMemo(() => [...(groups?.find((g) => g.key === artifactKey)?.versions ?? [])].sort((a, b) => a.version - b.version), [groups, artifactKey])
  const [picked, setPicked] = useState<string | null>(versionId ?? null) // null = follow the newest
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [asked, setAsked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickFolder, setPickFolder] = useState(false)
  // a confidential chat outside the desktop app: shown without scripts (lib/artifacts.ts frameRunsScripts)
  const scripts = useFrameScripts(chatId)

  useEffect(() => {
    setPicked(versionId ?? null)
    setTab('preview')
  }, [chatId, artifactKey, versionId])

  const summary = versions.find((v) => v.id === picked) ?? versions.at(-1)
  const index = summary ? versions.indexOf(summary) : -1
  const writing = live?.status === 'writing' && (!summary || picked === null)
  const { artifact, error } = useArtifactContent(writing ? null : summary?.id)
  const content = writing ? live!.content : artifact?.content ?? null
  const type: ArtifactType | undefined = writing ? live!.type : artifact?.type ?? summary?.type ?? live?.type
  const title = (writing ? live!.title : summary?.title ?? live?.title) || artifactKey

  // an HTML or SVG artifact's team images and clips as data: URLs (lib/frame-files.ts; an artifact has no folder: paths
  // are from the team root). A React artifact makes its images while it runs: not covered (they stay blocked).
  const inlines = !writing && !!artifact && (artifact.type === 'html' || artifact.type === 'svg')
  const files = useFrameFiles(inlines ? artifact!.content : null, { folder: '' })
  const [frameDoc, setFrameDoc] = useState<FrameDoc | null>(null)
  useEffect(() => {
    let alive = true
    setFrameDoc(null)
    setRuntimeError(null)
    if (writing || !artifact || !FRAME_TYPES.includes(artifact.type)) return
    if (inlines && !files) return
    const msgs = {
      unsupportedImports: (list: string) => t('artifact.unsupportedImports', { list }),
      compileError: (m: string) => t('artifact.compileError', { message: m }),
      noDefaultExport: t('artifact.noDefaultExport'),
    }
    const run = async () => {
      const compile = artifact.type === 'react' ? await (compiler ??= sucraseCompile()) : null
      if (alive) setFrameDoc(buildArtifactDocument(artifact.type, inlines && files ? files.html : artifact.content, location.origin, compile, msgs))
    }
    void run()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact, writing, files])

  const saveTo = async (folder: string) => {
    if (!artifact) return
    setPickFolder(false)
    setSaving(true)
    try {
      const name = artifactFileName(artifact)
      const r = await api.call(API.saveContent, { body: { path: joinPath(folder, name), content: artifact.content, baseSha256: null } })
      toast({ level: 'success', text: r.conflict ? t('artifact.savedConflict', { path: r.path }) : t('artifact.saved', { path: r.path }) })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setSaving(false)
    }
  }

  const failure = writing ? null : artifactFailure(frameDoc, runtimeError)
  const askFix = async () => {
    if (!artifact || !failure) return
    setAsked(artifact.id)
    try {
      await send({
        chatId,
        content: t(failure.kind === 'build' ? 'artifact.fixPromptBuild' : 'artifact.fixPrompt', { title: fixPromptWords(title, 200), key: fixPromptWords(artifact.key, 100), version: artifact.version, error: fixPromptError(failure.error) }),
        attachments: [],
        author: { id: me.user.id, name: me.user.name },
      })
    } catch (e) {
      setAsked(null)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }

  // a promo video or an intro deck: the page is ours (server-built), so no code tab, no copy, no page download; the MP4
  // or the deck's files instead. The deck is never saved into team files from here either (it must not become a source)
  const promo = artifactKey === PROMO_ARTIFACT_KEY && type === 'html'
  const deck = artifactKey === DECK_ARTIFACT_KEY && type === 'html'
  const ours = promo || deck
  const showCode = writing || (!ours && tab === 'code') || type === 'code'
  return (
    <aside aria-label={t('artifact.panel')} className="flex h-full min-w-0 flex-col bg-surface" data-testid="artifact-panel">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Shapes size={16} className="shrink-0 text-accent-text" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>
          {title}
        </h2>
        {type && !ours && <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{t(TYPE_LABEL[type])}</span>}
        {writing && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-accent-text">
            <Loader2 size={12} className="animate-spin" aria-hidden /> {t('artifact.writing')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {versions.length > 1 && !writing && (
            <span className="mr-1 flex items-center text-xs text-muted">
              <IconButton label={t('artifact.prevVersion')} disabled={index <= 0} onClick={() => setPicked(versions[index - 1]!.id)}>
                <ChevronLeft size={14} />
              </IconButton>
              <span data-testid="artifact-version">
                v{summary?.version} / {versions.length}
              </span>
              <IconButton label={t('artifact.nextVersion')} disabled={index >= versions.length - 1} onClick={() => setPicked(versions[index + 1]!.id)}>
                <ChevronRight size={14} />
              </IconButton>
            </span>
          )}
          {content !== null && !ours && <CopyButton text={content} />}
          {artifact && promo && <PromoMp4Button key={artifact.id} id={artifact.id} />}
          {artifact && deck && <DeckGetButton key={artifact.id} id={artifact.id} />}
          {artifact && !deck && (
            <>
              {!promo && (
                <IconButton label={t('common.download')} onClick={() => saveBlob(new Blob([artifact.content], { type: 'text/plain;charset=utf-8' }), artifactFileName(artifact))}>
                  <Download size={16} />
                </IconButton>
              )}
              <IconButton label={t('artifact.saveToTeam')} disabled={saving} onClick={() => setPickFolder(true)}>
                {saving ? <Loader2 size={16} className="animate-spin" /> : <FolderInput size={16} />}
              </IconButton>
            </>
          )}
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      {type && type !== 'code' && !writing && !ours && (
        <div className="flex gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label={t('artifact.view')}>
          {(['preview', 'code'] as const).map((x) => (
            <button key={x} role="tab" type="button" aria-selected={tab === x} onClick={() => setTab(x)} className={clsx('rounded-md px-2.5 py-1 text-xs', tab === x ? 'bg-ink text-canvas' : 'text-muted hover:bg-hover')}>
              {t(x === 'preview' ? 'artifact.preview' : 'artifact.code')}
            </button>
          ))}
        </div>
      )}
      {failure && !showCode && artifact && (
        <div role="alert" className="flex items-start gap-2 border-b border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger">
          <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{failure.kind === 'build' ? failure.error : t('artifact.runtimeError', { error: failure.error })}</span>
          <button
            type="button"
            disabled={busy || asked === artifact.id}
            title={busy ? t('artifact.busy') : undefined}
            className="shrink-0 rounded-md bg-danger px-2 py-1 font-medium text-white disabled:opacity-50 dark:text-black"
            onClick={askFix}
            data-testid="ask-fix"
          >
            {asked === artifact.id ? t('artifact.fixAsked') : t('artifact.askFix')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-6 text-sm text-danger">{errorText(error, locale, t('error.network'))}</p>
        ) : content === null ? (
          <Spinner className="p-6" label={t('common.loading')} />
        ) : showCode ? (
          <div className="p-3">
            <CodeBlock lang={type === 'react' ? 'jsx' : type === 'html' || type === 'svg' ? 'xml' : type === 'code' ? artifact?.language ?? summary?.language ?? null : type ?? null} code={content} />
          </div>
        ) : type === 'markdown' ? (
          <div className="mx-auto max-w-3xl p-6">
            <Markdown text={content} />
          </div>
        ) : frameDoc && !frameDoc.ok ? (
          // the error and "ask the AI to fix it" are in the bar above
          <p className="p-6 text-sm text-muted">{t('artifact.buildFailed')}</p>
        ) : scripts === false && artifact && type && (!inlines || files) ? (
          <StaticArtifact key={artifact.id} type={type} content={artifact.content} title={title} files={inlines ? files : null} />
        ) : frameDoc && scripts && files?.external ? (
          <div className="flex h-full min-h-0 flex-col">
            <ExternalImagesNote count={files.external} />
            <SandboxFrame key={artifact?.id} html={frameDoc.html} title={title} onError={setRuntimeError} className="min-h-0 w-full flex-1 border-0 bg-white" />
          </div>
        ) : frameDoc && scripts ? (
          <SandboxFrame key={artifact?.id} html={frameDoc.html} title={title} onError={setRuntimeError} />
        ) : (
          <Spinner className="p-6" />
        )}
      </div>
      <FolderPicker open={pickFolder} title={t('artifact.saveToTeam')} confirmLabel={t('artifact.saveHere')} onPick={saveTo} onClose={() => setPickFolder(false)} />
    </aside>
  )
}

/** An artifact in a confidential chat outside the desktop app: nothing of it runs (lib/artifacts.ts frameRunsScripts). */
function StaticArtifact({ type, content, title, files }: { type: ArtifactType; content: string; title: string; files: FrameFiles | null }) {
  const t = useT()
  if (type === 'mermaid')
    return (
      <div className="p-6">
        <MermaidBlock code={content} />
      </div>
    )
  const html = staticSource(type, files ? files.html : content)
  if (html === null)
    return (
      <p className="p-6 text-sm text-muted" data-testid="static-notice">
        {t('artifact.needsScripts')}
      </p>
    )
  if (!files?.external) return <StaticFrame html={html} title={title} gutter={type === 'html'} />
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExternalImagesNote count={files.external} />
      <StaticFrame html={html} title={title} gutter={type === 'html'} />
    </div>
  )
}

/**
 * [영상 파일로 받기] on a promo video: shown only where this server can make the MP4 (GET /api/promo-videos/:id says
 * so; never a button that cannot work). The first press makes it (about half a minute; the button says so meanwhile)
 * and the download starts when it is ready; a later press downloads the one made before.
 */
export function PromoMp4Button({ id }: { id: string }) {
  const t = useT()
  const locale = useLocale()
  const [info, setInfo] = useState<PromoVideoInfo | null>(null)
  const [wanted, setWanted] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.getPromoVideo, { params: { id } }).then((r) => live && setInfo(r), () => live && setInfo(null))
    return () => { live = false }
  }, [id])
  const rendering = info?.mp4.state === 'rendering'
  // while it is made: ask again every two seconds
  useEffect(() => {
    if (!rendering) return
    const timer = setInterval(() => {
      api.call(API.getPromoVideo, { params: { id } }).then(setInfo, () => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [rendering, id])
  const download = (i: PromoVideoInfo) => startDownload(api.url(API.downloadPromoVideo, { params: { id } }), `${i.title}.mp4`)
  // made after a press: the download starts by itself; failed: say so once
  useEffect(() => {
    if (!wanted || !info) return
    if (info.mp4.state === 'done') { setWanted(false); download(info) }
    else if (info.mp4.state === 'failed') { setWanted(false); toast({ level: 'error', text: t('promo.mp4.failed') }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, wanted])
  if (!info?.mp4.available) return null
  const press = async () => {
    if (info.mp4.state === 'done') return download(info)
    setWanted(true)
    try { setInfo(await api.call(API.renderPromoVideo, { params: { id } })) } catch (e) {
      setWanted(false)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return (
    <Button size="sm" variant="secondary" className="mr-1" busy={rendering} disabled={rendering} onClick={() => void press()} data-testid="promo-mp4">
      {!rendering && <Download size={14} aria-hidden />} {rendering ? t('promo.mp4.making') : t('promo.mp4.get')}
    </Button>
  )
}

/**
 * [받기 ▾] on an intro deck (docs/DECISIONS.md "D2"): one button with a small menu of the files this server can make,
 * PowerPoint always and PDF only where it has typst (GET /api/intro-decks/:id says so; never a line that cannot work).
 * No button when that cannot be read. The server builds the file when it is asked for, so a line starts the download.
 */
export function DeckGetButton({ id }: { id: string }) {
  const t = useT()
  const [info, setInfo] = useState<IntroDeckInfo | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    api.call(API.getIntroDeck, { params: { id } }).then((r) => live && setInfo(r), () => live && setInfo(null))
    return () => { live = false }
  }, [id])
  const items = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const close = () => {
    setOpen(false)
    box.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
  }
  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const files = info ? ([
    info.pptx && { ext: 'pptx', label: t('deck.pptx'), icon: <Presentation size={14} aria-hidden />, endpoint: API.downloadIntroDeckPptx },
    info.pdf && { ext: 'pdf', label: t('deck.pdf'), icon: <FileText size={14} aria-hidden />, endpoint: API.downloadIntroDeckPdf },
  ] as const).filter((f) => !!f) : []
  if (!info || files.length === 0) return null
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.stopPropagation() // only the menu: not the artifact panel too (Layout)
      close()
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const all = items()
      const at = all.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length
      all[next]?.focus()
    }
  }
  return (
    <div ref={box} className="relative mr-1" onKeyDown={onKeyDown}>
      <Button size="sm" variant="secondary" aria-haspopup="menu" aria-expanded={open} aria-label={t('deck.menu')} onClick={() => setOpen((v) => !v)} data-testid="deck-get">
        <Download size={14} aria-hidden /> {t('deck.get')} <ChevronDown size={14} className="text-faint" aria-hidden />
      </Button>
      {open && (
        <div role="menu" aria-label={t('deck.menu')} className="absolute top-full right-0 z-30 mt-1 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg" data-testid="deck-menu">
          {files.map((f) => (
            <button
              key={f.ext}
              role="menuitem"
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover"
              onClick={() => {
                close()
                startDownload(api.url(f.endpoint, { params: { id } }), `${info.title}.${f.ext}`)
              }}
              data-testid={`deck-get-${f.ext}`}
            >
              {f.icon} {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
