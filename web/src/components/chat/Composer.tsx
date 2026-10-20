// The message box: auto-growing text, Enter sends (Shift+Enter new line, IME-safe), attachments (button, drag and
// drop, paste, camera on phones) uploaded right away (chunked when large), voice input → transcription job → text,
// engine / model choice, stop while an answer runs. The draft text is kept per chat across reloads.
import clsx from 'clsx'
import { ArrowUp, Camera, Check, FileAudio, FileText, Loader2, Mic, Paperclip, Square, X, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SMALL_UPLOAD_MAX, uuidv7, type Attachment, type EngineId, type TranscribeResult } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { readDraft, writeDraft } from '../../lib/localData'
import { fmtDuration, formatSize } from '../../lib/format'
import { previewKind } from '../../lib/preview'
import { RecorderError, useRecorder } from '../../lib/recorder'
import { openFilePreview } from '../../lib/sidePanel'
import { cancelUpload, uploadFile } from '../../lib/upload'
import { useLocale, useT } from '../../i18n'
import { waitForJob } from '../../store/jobs'
import { useMe } from '../../store/session'
import { ENGINE_LABEL } from './Messages'
import { IconButton } from '../ui'

interface Pending {
  id: string
  file: File
  status: 'uploading' | 'done' | 'failed'
  progress: number
  attachment?: Attachment
  error?: string
  abort: AbortController
}

export interface EngineChoice { engine: EngineId | undefined; model: string | null | undefined }


export default function Composer({
  draftId,
  ensureChat,
  running,
  onSend,
  onStop,
  engine,
  onEngine,
  models,
  initialText,
  autoFocus,
}: {
  /** chat id, or "new" / "project:<id>" for a chat not created yet */
  draftId: string
  /** the chat to upload attachments into (creates it on the first attachment of a new chat) */
  ensureChat: () => Promise<string>
  running: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onStop: () => Promise<void>
  engine: EngineChoice
  onEngine?: (e: EngineChoice) => void
  /** models per engine (admins see them; others choose the engine only) */
  models?: Partial<Record<EngineId, { id: string; label: string }[]>>
  initialText?: string
  autoFocus?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const userId = useMe()?.user.id ?? '-'
  const [text, setText] = useState(() => initialText ?? readDraft(userId, draftId))
  const [files, setFiles] = useState<Pending[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [drag, setDrag] = useState(false)
  const [engineMenu, setEngineMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const recorder = useRecorder()

  useEffect(() => writeDraft(userId, draftId, text), [userId, text, draftId])
  // a non-empty draft or an upload means "don't reload the page by yourself" after an update
  useEffect(() => (text.trim() ? markBusy('draft') : undefined), [text])
  useEffect(() => (files.some((f) => f.status === 'uploading') ? markBusy('upload') : undefined), [files])
  useEffect(() => {
    if (recorder.state !== 'recording') return
    const release = markBusy('recording')
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => {
      release()
      window.removeEventListener('beforeunload', h)
    }
  }, [recorder.state])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'
  }, [text])

  useEffect(() => {
    if (autoFocus && window.matchMedia?.('(pointer: fine)').matches && !document.querySelector('[role="dialog"]')) taRef.current?.focus()
  }, [autoFocus])

  const update = (id: string, patch: Partial<Pending>) => setFiles((p) => p.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  const addFiles = async (list: File[]) => {
    if (!list.length) return
    setError(null)
    const items: Pending[] = list.map((file) => ({ id: uuidv7(), file, status: 'uploading', progress: 0, abort: new AbortController() }))
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
        const target = { kind: 'attachment', chatId, name: it.file.name } as const
        try {
          const r = await uploadFile(it.file, target, { client: api, signal: it.abort.signal, onProgress: (p) => update(it.id, { progress: p.total ? p.loaded / p.total : 0 }) })
          if (r.kind !== 'attachment') throw new Error('unexpected upload result')
          update(it.id, { status: 'done', progress: 1, attachment: r.attachment })
        } catch (e) {
          // removed while uploading: drop the server's half-received session as well
          if (it.abort.signal.aborted) return void cancelUpload(it.file, target, api)
          update(it.id, { status: 'failed', error: errorText(e, locale, t('error.network')) })
        }
      }),
    )
  }

  const removeFile = (f: Pending) => {
    f.abort.abort()
    setFiles((p) => p.filter((x) => x.id !== f.id))
  }

  const uploading = files.some((f) => f.status === 'uploading')
  const ready = files.filter((f) => f.status === 'done')
  const canSend = !running && !sending && !uploading && !transcribing && recorder.state === 'idle' && (text.trim().length > 0 || ready.length > 0)

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    const body = text
    const atts = ready.map((f) => f.attachment!)
    try {
      await onSend(body, atts)
      setText('')
      writeDraft(userId, draftId, '')
      setFiles((p) => p.filter((f) => f.status !== 'done'))
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await onStop()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setStopping(false)
    }
  }

  const startVoice = async () => {
    setError(null)
    try {
      await recorder.start()
    } catch (e) {
      setError(e instanceof RecorderError ? t(e.code === 'denied' ? 'voice.denied' : 'voice.unsupported') : String(e))
    }
  }

  const finishVoice = async () => {
    const file = await recorder.stop()
    if (!file) return
    if (file.size > SMALL_UPLOAD_MAX) {
      setError(t('voice.tooLong'))
      return
    }
    setTranscribing(true)
    try {
      const r = await uploadFile(file, { kind: 'transcribe', name: file.name }, { client: api })
      if (r.kind !== 'transcribe') throw new Error('unexpected upload result')
      const job = await waitForJob(r.jobId)
      if (job.status !== 'done' || !job.result) throw new Error(job.error?.message ?? t('voice.failed'))
      const said = (job.result as TranscribeResult).text?.trim()
      if (said) setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said))
      else setError(t('voice.empty'))
      taRef.current?.focus()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setTranscribing(false)
    }
  }

  const engineLabel = engine.engine ? ENGINE_LABEL[engine.engine] + (engine.model ? ` · ${models?.[engine.engine]?.find((m) => m.id === engine.model)?.label ?? engine.model}` : '') : t('composer.defaultEngine')

  return (
    <div>
      <div
        className={clsx('rounded-3xl border bg-surface shadow-[var(--c-shadow)] transition focus-within:border-line-strong focus-within:ring-2 focus-within:ring-accent/20', drag ? 'border-accent ring-2 ring-accent/30' : 'border-line')}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setDrag(false)
          void addFiles(Array.from(e.dataTransfer.files))
        }}
        data-testid="composer"
      >
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-4 pt-3" aria-label={t('composer.attachments')}>
            {files.map((f) => (
              <li key={f.id} className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : 'border-line bg-subtle')} data-testid="attachment-chip">
                {f.file.type.startsWith('image/') ? <LocalThumb file={f.file} /> : f.file.type.startsWith('audio/') ? <FileAudio size={15} className="text-accent-text" aria-hidden /> : <FileText size={15} className="text-muted" aria-hidden />}
                {previewKind(f.file.name) ? (
                  <button type="button" className="max-w-[180px] truncate font-medium hover:underline" onClick={() => openFilePreview({ source: 'local', name: f.file.name, blob: f.file })}>
                    {f.file.name}
                  </button>
                ) : (
                  <span className="max-w-[180px] truncate font-medium">{f.file.name}</span>
                )}
                {f.status === 'uploading' ? (
                  <span className="flex items-center gap-1 text-faint" role="status">
                    <Loader2 size={12} className="animate-spin" aria-hidden /> {Math.round(f.progress * 100)}%
                  </span>
                ) : f.status === 'failed' ? (
                  <span className="max-w-[160px] truncate text-danger" title={f.error}>
                    {f.error}
                  </span>
                ) : (
                  <span className="text-faint">{formatSize(f.file.size, locale)}</span>
                )}
                <button type="button" aria-label={t('composer.removeAttachment', { name: f.file.name })} onClick={() => removeFile(f)} className="text-faint hover:text-ink">
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {recorder.state === 'recording' ? (
          <div className="flex items-center gap-3 px-3 py-3">
            <IconButton label={t('voice.cancel')} onClick={recorder.cancel}>
              <X size={18} />
            </IconButton>
            <div className="flex min-w-0 flex-1 items-center gap-3" role="status" aria-label={t('voice.recording')}>
              <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
              </span>
              <div className="flex h-8 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden>
                {Array.from({ length: 32 }, (_, i) => (
                  <span key={i} className="w-[3px] rounded-full bg-ink transition-[height] duration-100" style={{ height: `${Math.max(3, recorder.level * 32 * (0.4 + 0.6 * Math.abs(Math.sin((i + recorder.seconds) * 1.7))))}px` }} />
                ))}
              </div>
              <span className="shrink-0 text-sm text-muted tabular-nums">{fmtDuration(recorder.seconds)}</span>
            </div>
            <button type="button" onClick={finishVoice} className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink hover:bg-accent-hover sm:h-9 sm:w-9" aria-label={t('voice.done')}>
              <Check size={18} />
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              aria-label={t('composer.label')}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files)
                if (pasted.length) {
                  e.preventDefault()
                  void addFiles(pasted)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  // phones: Enter makes a new line (send with the button)
                  if (window.matchMedia?.('(pointer: coarse)').matches) return
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder={transcribing ? t('voice.transcribing') : t('composer.placeholder')}
              disabled={transcribing}
              className="block max-h-[240px] w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15px] outline-none placeholder:text-faint"
              data-testid="composer-input"
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              <div className="flex items-center gap-0.5">
                <IconButton label={t('composer.attach')} onClick={() => fileRef.current?.click()}>
                  <Paperclip size={18} />
                </IconButton>
                <IconButton label={t('composer.camera')} className="sm:hidden" onClick={() => camRef.current?.click()}>
                  <Camera size={18} />
                </IconButton>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  data-testid="file-input"
                  onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                <input
                  ref={camRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                {onEngine && (
                  <div className="relative">
                    <button type="button" aria-haspopup="listbox" aria-expanded={engineMenu} onClick={() => setEngineMenu((v) => !v)} className="ml-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover" data-testid="engine-picker">
                      {engineLabel} <ChevronDown size={13} aria-hidden />
                    </button>
                    {engineMenu && (
                      <ul role="listbox" aria-label={t('composer.engine')} className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg" onMouseLeave={() => setEngineMenu(false)}>
                        {(['claude-code', 'codex'] as EngineId[]).map((id) => (
                          <li key={id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={engine.engine === id && !engine.model}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
                              onClick={() => {
                                setEngineMenu(false)
                                onEngine({ engine: id, model: null })
                              }}
                            >
                              {ENGINE_LABEL[id]} <span className="text-xs text-faint">{t('composer.defaultModel')}</span>
                            </button>
                            {models?.[id]?.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                role="option"
                                aria-selected={engine.engine === id && engine.model === m.id}
                                className="flex w-full items-center rounded-lg py-1.5 pr-2.5 pl-6 text-left text-sm text-muted hover:bg-hover"
                                onClick={() => {
                                  setEngineMenu(false)
                                  onEngine({ engine: id, model: m.id })
                                }}
                              >
                                {m.label}
                              </button>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <IconButton label={t('voice.start')} onClick={startVoice} disabled={transcribing || sending} className="h-10 w-10 rounded-full sm:h-9 sm:w-9">
                  {transcribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
                </IconButton>
                {running ? (
                  <button type="button" onClick={stop} disabled={stopping} aria-label={t('composer.stop')} title={t('composer.stop')} className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-canvas transition hover:opacity-80 disabled:opacity-40 sm:h-9 sm:w-9" data-testid="stop">
                    {stopping ? <Loader2 size={17} className="animate-spin" /> : <Square size={14} className="fill-current" />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSend}
                    aria-label={t('chat.send')}
                    title={t('chat.send')}
                    className={clsx('flex h-10 w-10 items-center justify-center rounded-full transition sm:h-9 sm:w-9', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
                    data-testid="send"
                  >
                    {sending ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 px-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** A picked image before sending: a small thumbnail in its chip. */
function LocalThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url ? <img src={url} alt="" className="h-8 w-8 rounded object-cover" /> : null
}
