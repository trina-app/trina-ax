// An artifact next to the chat: live preview in the isolated frame or code, versions (‹ v2 / 3 ›), copy, download,
// "save to the team folder", and when it fails at runtime "ask the AI to fix it". While the AI is still writing it,
// the code shows as it arrives. Ported from Saram / chat-proto ArtifactPanel.
import clsx from 'clsx'
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FolderInput, Loader2, Shapes, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ArtifactType } from '@mycel/shared/api'
import { api, API, errorText, saveBlob } from '../lib/api'
import { artifactFileName, buildArtifactSrcdoc, FRAME_TYPES, sucraseCompile, type CompileFn, type Srcdoc } from '../lib/artifacts'
import { joinPath } from '../lib/paths'
import { useArtifactContent, useChatArtifacts } from '../lib/useArtifacts'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { TYPE_LABEL } from './artifactLabels'
import FolderPicker from './FolderPicker'
import { CodeBlock, Markdown } from './Markdown'
import SandboxFrame from './SandboxFrame'
import { CopyButton, IconButton, Spinner } from './ui'

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

  const [srcdoc, setSrcdoc] = useState<Srcdoc | null>(null)
  useEffect(() => {
    let alive = true
    setSrcdoc(null)
    setRuntimeError(null)
    if (writing || !artifact || !FRAME_TYPES.includes(artifact.type)) return
    const msgs = {
      unsupportedImports: (list: string) => t('artifact.unsupportedImports', { list }),
      compileError: (m: string) => t('artifact.compileError', { message: m }),
      noDefaultExport: t('artifact.noDefaultExport'),
    }
    const run = async () => {
      const compile = artifact.type === 'react' ? await (compiler ??= sucraseCompile()) : null
      if (alive) setSrcdoc(buildArtifactSrcdoc(artifact.type, artifact.content, location.origin, compile, msgs))
    }
    void run()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact, writing])

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

  const askFix = async () => {
    if (!artifact || !runtimeError) return
    setAsked(artifact.id)
    try {
      await send({
        chatId,
        content: t('artifact.fixPrompt', { title, key: artifact.key, version: artifact.version, error: runtimeError }),
        attachments: [],
        author: { id: me.user.id, name: me.user.name },
      })
    } catch (e) {
      setAsked(null)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }

  const showCode = writing || tab === 'code' || type === 'code'
  return (
    <aside aria-label={t('artifact.panel')} className="flex h-full min-w-0 flex-col bg-surface" data-testid="artifact-panel">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Shapes size={16} className="shrink-0 text-accent-text" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>
          {title}
        </h2>
        {type && <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{t(TYPE_LABEL[type])}</span>}
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
          {content !== null && <CopyButton text={content} />}
          {artifact && (
            <>
              <IconButton label={t('common.download')} onClick={() => saveBlob(new Blob([artifact.content], { type: 'text/plain;charset=utf-8' }), artifactFileName(artifact))}>
                <Download size={16} />
              </IconButton>
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
      {type && type !== 'code' && !writing && (
        <div className="flex gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label={t('artifact.view')}>
          {(['preview', 'code'] as const).map((x) => (
            <button key={x} role="tab" type="button" aria-selected={tab === x} onClick={() => setTab(x)} className={clsx('rounded-md px-2.5 py-1 text-xs', tab === x ? 'bg-ink text-canvas' : 'text-muted hover:bg-hover')}>
              {t(x === 'preview' ? 'artifact.preview' : 'artifact.code')}
            </button>
          ))}
        </div>
      )}
      {runtimeError && !showCode && artifact && (
        <div role="alert" className="flex items-start gap-2 border-b border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger">
          <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{t('artifact.runtimeError', { error: runtimeError })}</span>
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
        ) : srcdoc && !srcdoc.ok ? (
          <p className="p-6 text-sm text-danger">{srcdoc.error}</p>
        ) : srcdoc ? (
          <SandboxFrame key={artifact?.id} html={srcdoc.html} title={title} onError={setRuntimeError} />
        ) : (
          <Spinner className="p-6" />
        )}
      </div>
      <FolderPicker open={pickFolder} title={t('artifact.saveToTeam')} confirmLabel={t('artifact.saveHere')} onPick={saveTo} onClose={() => setPickFolder(false)} />
    </aside>
  )
}
