// The message box: auto-growing text, Enter sends (Shift+Enter new line, IME-safe), attachments (button, drag and
// drop, paste, camera on phones) uploaded right away (chunked when large), voice input → transcription job → text,
// engine / model choice, stop while an answer runs. The draft text is kept per chat across reloads.
// While an answer runs the box stays usable: Enter (or the clock button next to Stop) hands the message to the chat,
// which keeps it waiting and sends it when the answer is done (store/sendQueue.ts). While the AI waits for an answer
// to its question (an ask_user card), sending answers that question instead (lib/askAnswer.ts): text only, attached
// files stay in the box for the next message.
// The attach button opens a small menu: upload from this computer, or add files of the team folder (TeamFilePicker),
// which are attached as references (POST /api/attachments/team-file) and shown as chips with a folder icon. Team
// files also arrive from the file screen / preview ("Ask AI about this", "Add to current chat", drag from the preview).
// "/" at the start lists the team skills (SkillMenu).
import clsx from 'clsx'
import { ArrowUp, Camera, Check, Clock, FileAudio, FileText, FolderOpen, Loader2, MessageCircleQuestion, Mic, MicOff, Monitor, Paperclip, Smartphone, Square, Terminal, X, ChevronDown } from 'lucide-react'
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { MESSAGE_ATTACHMENTS_MAX, SMALL_UPLOAD_MAX, uuidv7, type Attachment, type EngineId, type FileEntry, type TranscribeResult } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { readDraft, writeDraft } from '../../lib/localData'
import { mergeDraft } from '../../lib/composerDraft'
import { fmtDuration, formatSize } from '../../lib/format'
import { previewKind, serverPreview } from '../../lib/preview'
import { RecorderError, useRecorder } from '../../lib/recorder'
import { micState, SPEECH_SETTINGS_PATH } from '../../lib/voice'
import { navigateTo } from '../../lib/nav'
import { openFilePreview, openTeamFile } from '../../lib/sidePanel'
import { loadChips, patchStash, readStash, registerComposer, saveChips, subscribeStash, TEAM_FILE_DRAG_TYPE, writeStash, type AttachResult } from '../../lib/teamAttach'
import { cancelUpload, uploadFile } from '../../lib/upload'
import { useLocale, useT } from '../../i18n'
import { waitForJob } from '../../store/jobs'
import { useMe } from '../../store/session'
import { ENGINE_LABEL, EngineOptions } from './EngineMenu'
import { IconButton } from '../ui'
import { useSkillMenu } from './SkillMenu'
import TeamFilePicker from './TeamFilePicker'

interface Pending {
  id: string
  /** upload: a file from this computer; team: a team-folder file attached by reference */
  source: 'upload' | 'team'
  name: string
  file?: File
  /** team files: the path picked */
  path?: string
  size: number | null
  status: 'uploading' | 'done' | 'failed'
  progress: number
  attachment?: Attachment
  error?: string
  abort: AbortController
}

export interface EngineChoice { engine: EngineId | undefined; model: string | null | undefined }
export interface ComposerHandle { prepareDraft: (request: string) => void; focus: () => void }


export default function Composer({
  ref,
  draftId,
  ensureChat,
  running,
  onSend,
  answering,
  choiceWaiting,
  onStop,
  engine,
  onEngine,
  engines,
  models,
  initialText,
  autoFocus,
}: {
  ref?: Ref<ComposerHandle>
  /** chat id, or "new" / "project:<id>" for a chat not created yet */
  draftId: string
  /** the chat to upload attachments into (creates it on the first attachment of a new chat) */
  ensureChat: () => Promise<string>
  running: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  /** the AI waits for the answer to its question in this chat: sending answers it with the text */
  answering?: { question: string; onAnswer: (text: string) => Promise<void> }
  /** a card in this chat waits for a choice only its own buttons make (a server safety check, a browser site) */
  choiceWaiting?: boolean
  onStop: () => Promise<void>
  engine: EngineChoice
  /** only for people who may pick the engine (store/session canChooseEngine): without it there is no picker */
  onEngine?: (e: EngineChoice) => void
  /** the engines this person may pick (switched on) */
  engines?: EngineId[]
  /** models per engine */
  models?: Partial<Record<EngineId, { id: string; label: string }[]>>
  initialText?: string
  autoFocus?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const userId = me?.user.id ?? '-'
  // voice input off (Admin > Team settings): no mic for members, a hint to the setting for admins
  const mic = micState(me)
  const [text, setText] = useState(() => initialText ?? readDraft(userId, draftId))
  const skillMenu = useSkillMenu(text, setText)
  // the chips live outside the component too (lib/teamAttach stash): leaving the page and coming back, or adding
  // files one at a time from the file screen, keeps what was attached for this draft until it is sent or removed
  const [files, setFilesState] = useState<Pending[]>(() => restoreChips(userId, draftId))
  const filesRef = useRef(files)
  const setFiles = (fn: (cur: Pending[]) => Pending[]) => {
    const next = fn(filesRef.current)
    filesRef.current = next
    writeStash(userId, draftId, next)
    setFilesState(next)
  }
  // finished chips also survive a reload of this tab
  useEffect(() => saveChips(userId, draftId, files.filter((f) => f.status === 'done' && f.attachment).map((f) => ({ id: f.id, source: f.source, name: f.name, size: f.size, path: f.path, attachment: f.attachment! }))), [userId, draftId, files])
  useEffect(() => {
    const cur = restoreChips(userId, draftId)
    filesRef.current = cur
    setFilesState(cur)
    return subscribeStash<Pending>(userId, draftId, (items) => {
      filesRef.current = items
      setFilesState(items)
    })
  }, [userId, draftId])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [drag, setDrag] = useState(false)
  const [engineMenu, setEngineMenu] = useState(false)
  const [attachMenu, setAttachMenu] = useState(false)
  const [picker, setPicker] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const recorder = useRecorder()
  const answeringId = useId()

  useImperativeHandle(ref, () => ({
    prepareDraft(request) {
      // Recovery is a draft edit, never a send. Keep text and all attachment states intact.
      // Do not race a send or voice transcription that will replace the current text.
      if (running || sending || transcribing || recorder.state !== 'idle') return
      setText((current) => mergeDraft(current, request))
      taRef.current?.focus()
    },
    focus() {
      taRef.current?.focus()
    },
  }), [running, sending, transcribing, recorder.state])

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

  // an upload / attach finishing goes to whichever composer shows this draft by then (or stays in the stash)
  const update = (id: string, patch: Partial<Pending>) => patchStash<Pending>(userId, draftId, id, patch)
  // how many more attachments this message can take (uploads and team files together; the server's limit; failed
  // chips are not sent and do not count)
  const live = (list: Pending[]) => list.filter((f) => f.status !== 'failed')
  const room = () => MESSAGE_ATTACHMENTS_MAX - live(filesRef.current).length

  const addFiles = async (all: File[]) => {
    if (!all.length) return
    setError(null)
    const list = all.slice(0, Math.max(0, room()))
    if (list.length < all.length) setError(t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
    if (!list.length) return
    const items: Pending[] = list.map((file) => ({ id: uuidv7(), source: 'upload', name: file.name, file, size: file.size, status: 'uploading', progress: 0, abort: new AbortController() }))
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
          const r = await uploadFile(it.file!, target, { client: api, signal: it.abort.signal, onProgress: (p) => update(it.id, { progress: p.total ? p.loaded / p.total : 0 }) })
          if (r.kind !== 'attachment') throw new Error('unexpected upload result')
          update(it.id, { status: 'done', progress: 1, attachment: r.attachment })
        } catch (e) {
          // removed while uploading: drop the server's half-received session as well
          if (it.abort.signal.aborted) return void cancelUpload(it.file!, target, api)
          update(it.id, { status: 'failed', error: errorText(e, locale, t('error.network')) })
        }
      }),
    )
  }

  /** Team-folder files (picked, or handed over from the file screen): attached by reference, re-checked by the server. */
  const addTeamFiles = async (picked: { path: string; name?: string; size?: number | null }[]): Promise<AttachResult> => {
    setError(null)
    const have = new Set(live(filesRef.current).filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path))
    const fresh = picked.filter((p, i) => !have.has(p.path) && picked.findIndex((x) => x.path === p.path) === i)
    const list = fresh.slice(0, Math.max(0, room()))
    const already = picked.length - fresh.length
    if (list.length < fresh.length) setError(t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
    if (!list.length) return { added: already, failed: fresh.length, ...(fresh.length ? { error: t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }) } : {}) }
    const items: Pending[] = list.map((p) => ({ id: uuidv7(), source: 'team', path: p.path, name: p.name ?? p.path.slice(p.path.lastIndexOf('/') + 1), size: p.size ?? null, status: 'uploading', progress: 0, abort: new AbortController() }))
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
          update(it.id, { status: 'done', progress: 1, attachment: a, size: a.size, name: a.name })
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
  const addTeamRef = useRef(addTeamFiles)
  addTeamRef.current = addTeamFiles
  useEffect(() => registerComposer(draftId, (paths) => addTeamRef.current(paths.map((path) => ({ path })))), [draftId])

  useEffect(() => {
    if (!attachMenu) return
    const close = (e: MouseEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setAttachMenu(false)
    }
    // Escape anywhere closes the menu (focus back on the button)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setAttachMenu(false)
      attachButton()?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [attachMenu])
  const attachButton = () => attachMenuRef.current?.querySelector<HTMLElement>('[data-testid="attach-button"]') ?? null
  const menuItems = () => [...(attachMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter((x) => x.offsetParent !== null)
  const openMenu = (focusFirst: boolean) => {
    setAttachMenu(true)
    if (focusFirst) requestAnimationFrame(() => menuItems()[0]?.focus())
  }
  // phones and tablets: "from this device", else "from this computer"
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

  const removeFile = (f: Pending) => {
    f.abort?.abort()
    setFiles((p) => p.filter((x) => x.id !== f.id))
  }

  const uploading = files.some((f) => f.status === 'uploading')
  const ready = files.filter((f) => f.status === 'done')
  // also while an answer runs: the chat keeps the message waiting and sends it when the answer is done. An answer to
  // the AI's question is the text alone (an upload in progress does not hold it up).
  const canSend = answering
    ? !sending && !transcribing && recorder.state === 'idle' && text.trim().length > 0
    : !sending && !uploading && !transcribing && recorder.state === 'idle' && (text.trim().length > 0 || ready.length > 0)

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    if (answering) {
      // a failure (the question was answered in another window or closed meanwhile) keeps the text and says why
      try {
        await answering.onAnswer(text)
        setText('')
        writeDraft(userId, draftId, '')
      } catch (e) {
        setError(errorText(e, locale, t('error.network')))
      } finally {
        setSending(false)
      }
      return
    }
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

  // the API engine has one model (the owner's): its name shows even when none was picked
  const shownModel = engine.engine && (engine.model ? models?.[engine.engine]?.find((m) => m.id === engine.model)?.label ?? engine.model : engine.engine === 'api' ? models?.api?.[0]?.label : undefined)
  const engineLabel = engine.engine ? ENGINE_LABEL[engine.engine] + (shownModel ? ` · ${shownModel}` : '') : t('composer.defaultEngine')

  return (
    <div>
      <div
        className={clsx('rounded-3xl border bg-surface shadow-[var(--c-shadow)] transition focus-within:border-line-strong focus-within:ring-2 focus-within:ring-accent/20', drag ? 'border-accent ring-2 ring-accent/30' : 'border-line')}
        onDragOver={(e) => {
          const types = [...e.dataTransfer.types]
          if (!types.includes('Files') && !types.includes(TEAM_FILE_DRAG_TYPE)) return
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          const teamPath = e.dataTransfer.getData(TEAM_FILE_DRAG_TYPE)
          if (teamPath) {
            e.preventDefault()
            setDrag(false)
            void addTeamFiles([{ path: teamPath }])
            return
          }
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
              <li
                key={f.id}
                className={clsx('inline-flex max-w-full items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2.5 text-xs', f.status === 'failed' ? 'border-danger/40 bg-danger-soft' : f.source === 'team' ? 'border-accent/30 bg-accent-soft' : 'border-line bg-subtle')}
                title={f.source === 'team' ? t('composer.teamFile', { path: f.attachment?.path ?? f.path ?? '' }) : undefined}
                data-testid="attachment-chip"
                data-source={f.source}
              >
                {f.source === 'team' ? (
                  <FolderOpen size={15} className="text-accent-text" aria-label={t('composer.teamFile', { path: f.attachment?.path ?? f.path ?? '' })} />
                ) : f.file?.type.startsWith('image/') ? (
                  <LocalThumb file={f.file} />
                ) : (f.file?.type ?? f.attachment?.mime ?? '').startsWith('audio/') ? (
                  <FileAudio size={15} className="text-accent-text" aria-hidden />
                ) : (
                  <FileText size={15} className="text-muted" aria-hidden />
                )}
                <span className="flex min-w-0 flex-col">
                  {previewKind(f.name) && (f.source === 'upload' || f.status === 'done') ? (
                    <button
                      type="button"
                      className="max-w-[180px] truncate text-left font-medium hover:underline"
                      onClick={() => (f.source === 'team' || !f.file || (serverPreview(f.name) && f.attachment?.path) ? openTeamFile(f.attachment?.path ?? f.path!) : openFilePreview({ source: 'local', name: f.name, blob: f.file }))}
                    >
                      {f.name}
                    </button>
                  ) : (
                    <span className="max-w-[180px] truncate font-medium">{f.name}</span>
                  )}
                  {/* the team folder it is in, visible without hovering (phones) */}
                  {f.source === 'team' && <span className="max-w-[180px] truncate text-[10px] leading-tight text-faint" data-testid="chip-folder">{folderOf(f.attachment?.path ?? f.path ?? '') || t('files.root')}</span>}
                </span>
                {f.status === 'uploading' ? (
                  <span className="flex items-center gap-1 text-faint" role="status">
                    <Loader2 size={12} className="animate-spin" aria-hidden /> {f.source === 'upload' && `${Math.round(f.progress * 100)}%`}
                  </span>
                ) : f.status === 'failed' ? (
                  <span className="max-w-[160px] truncate text-danger" title={f.error}>
                    {f.error}
                  </span>
                ) : (
                  f.size !== null && <span className="text-faint">{formatSize(f.size, locale)}</span>
                )}
                <button type="button" aria-label={t('composer.removeAttachment', { name: f.name })} onClick={() => removeFile(f)} className="-my-1 -mr-1 rounded-md p-1 text-faint hover:bg-hover hover:text-ink max-sm:p-1.5">
                  <X size={14} />
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
            {skillMenu.menu}
            {answering && (
              <div className="space-y-0.5 px-5 pt-3 text-xs">
                <p id={answeringId} className="flex items-center gap-1.5 text-muted" data-testid="composer-answering">
                  <MessageCircleQuestion size={13} className="shrink-0 text-accent-text" aria-hidden />
                  <span className="min-w-0 truncate">{t('composer.answering', { question: answering.question.slice(0, 300) })}</span>
                </p>
                {/* like under the card's own text box (tab 5 "확인 카드"): the typed answer goes to the AI */}
                <p id={`${answeringId}-secrets`} className="text-faint" data-testid="composer-no-secrets">
                  {t('ask.noSecrets')}
                </p>
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              aria-label={t('composer.label')}
              aria-describedby={answering ? `${answeringId} ${answeringId}-secrets` : undefined}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files)
                if (pasted.length) {
                  e.preventDefault()
                  void addFiles(pasted)
                }
              }}
              onKeyDown={(e) => {
                if (skillMenu.onKeyDown(e)) return
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  // phones: Enter makes a new line (send with the button)
                  if (window.matchMedia?.('(pointer: coarse)').matches) return
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder={transcribing ? t('voice.transcribing') : answering ? t('composer.answerPlaceholder') : running ? t(choiceWaiting ? 'outbox.placeholderChoice' : 'outbox.placeholder') : t('composer.placeholder')}
              disabled={transcribing}
              className={clsx('block max-h-[240px] w-full resize-none bg-transparent px-5 pb-2 text-[15px] outline-none placeholder:text-faint', answering ? 'pt-1.5' : 'pt-4')}
              data-testid="composer-input"
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              <div className="flex items-center gap-0.5">
                <div
                  className="relative"
                  ref={attachMenuRef}
                  onBlur={(e) => {
                    // focus moving out of the button and its menu (Tab, Shift+Tab) closes the menu; no new target (Safari
                    // does not focus a clicked button) is left to the click-outside handler
                    if (attachMenu && e.relatedTarget && !attachMenuRef.current?.contains(e.relatedTarget as Node)) setAttachMenu(false)
                  }}
                >
                  <IconButton
                    label={t('composer.attach')}
                    aria-haspopup="menu"
                    aria-expanded={attachMenu}
                    // a click opens the menu; Enter / Space (detail 0) and the arrow keys also put focus on its first item
                    onClick={(e) => (attachMenu ? setAttachMenu(false) : openMenu(e.detail === 0))}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        openMenu(true)
                      }
                    }}
                    data-testid="attach-button"
                  >
                    <Paperclip size={18} />
                  </IconButton>
                  {attachMenu && (
                    <div
                      role="menu"
                      aria-label={t('composer.attach')}
                      className="absolute bottom-full left-0 z-30 mb-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1 shadow-lg"
                      onKeyDown={(e) => {
                        const items = menuItems()
                        const i = items.indexOf(document.activeElement as HTMLElement)
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
                        } else if (e.key === 'Home' || e.key === 'End') {
                          e.preventDefault()
                          items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
                        } else if (e.key === 'Tab') setAttachMenu(false)
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:py-2"
                        onClick={() => {
                          setAttachMenu(false)
                          fileRef.current?.click()
                        }}
                        data-testid="attach-computer"
                      >
                        {coarse ? <Smartphone size={16} className="text-muted" aria-hidden /> : <Monitor size={16} className="text-muted" aria-hidden />} {t(coarse ? 'composer.fromDevice' : 'composer.fromComputer')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:hidden"
                        onClick={() => {
                          setAttachMenu(false)
                          camRef.current?.click()
                        }}
                        data-testid="attach-camera"
                      >
                        <Camera size={16} className="text-muted" aria-hidden /> {t('composer.camera')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:py-2"
                        onClick={() => {
                          // focus on the attach button first: closing the picker without picking brings it back there
                          attachButton()?.focus()
                          setAttachMenu(false)
                          setPicker(true)
                        }}
                        data-testid="attach-team"
                      >
                        <FolderOpen size={16} className="text-accent-text" aria-hidden /> {t('composer.fromTeam')}
                      </button>
                    </div>
                  )}
                </div>
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
                {me?.user.codeSandbox && (
                  // the AI may run code for this person (Admin > Team settings "Code sandbox"): always in sight
                  <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-text" title={t('composer.codeSandboxHint')} data-testid="code-sandbox-badge">
                    <Terminal size={12} aria-hidden /> {t('composer.codeSandbox')}
                  </span>
                )}
                {onEngine && (
                  <div className="relative">
                    <button type="button" aria-haspopup="listbox" aria-expanded={engineMenu} onClick={() => setEngineMenu((v) => !v)} className="ml-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover" data-testid="engine-picker">
                      {engineLabel} <ChevronDown size={13} aria-hidden />
                    </button>
                    {engineMenu && (
                      <ul role="listbox" aria-label={t('composer.engine')} className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg" onMouseLeave={() => setEngineMenu(false)}>
                        <EngineOptions
                          engines={engines ?? []}
                          models={models}
                          current={engine}
                          onPick={(p) => {
                            setEngineMenu(false)
                            onEngine(p)
                          }}
                        />
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {mic === 'on' && (
                  <IconButton label={t('voice.start')} onClick={startVoice} disabled={transcribing || sending} className="h-10 w-10 rounded-full sm:h-9 sm:w-9">
                    {transcribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
                  </IconButton>
                )}
                {mic === 'adminHint' && (
                  <IconButton label={t('voice.offAdmin')} onClick={() => navigateTo(SPEECH_SETTINGS_PATH)} className="h-10 w-10 rounded-full text-faint sm:h-9 sm:w-9" data-testid="voice-off-hint">
                    <MicOff size={18} />
                  </IconButton>
                )}
                {answering
                  ? canSend && (
                      // the AI's question: also how phones (Enter makes a new line there) answer from the box
                      <button type="button" onClick={submit} aria-label={t('composer.sendAnswer')} title={t('composer.sendAnswer')} className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink transition hover:bg-accent-hover sm:h-9 sm:w-9" data-testid="send-answer">
                        {sending ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}
                      </button>
                    )
                  : running &&
                    canSend && (
                      // phones make a new line with Enter: this button is how a message waits for the answer there
                      <button type="button" onClick={submit} aria-label={t('outbox.sendLater')} title={t('outbox.sendLater')} className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink transition hover:bg-accent-hover sm:h-9 sm:w-9" data-testid="send-later">
                        <Clock size={17} aria-hidden />
                      </button>
                    )}
                {running ? (
                  <button type="button" onClick={stop} disabled={stopping} aria-label={t('composer.stop')} title={t('composer.stop')} className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-canvas transition hover:opacity-80 disabled:opacity-40 sm:h-9 sm:w-9" data-testid="stop">
                    {stopping ? <Loader2 size={17} className="animate-spin" /> : <Square size={14} className="fill-current" />}
                  </button>
                ) : (
                  !answering && (
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
                  )
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
      <TeamFilePicker
        open={picker}
        onClose={() => setPicker(false)}
        room={Math.max(0, MESSAGE_ATTACHMENTS_MAX - live(files).length)}
        max={MESSAGE_ATTACHMENTS_MAX}
        attached={new Set(live(files).filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path!))}
        onPick={(picked: FileEntry[]) => {
          setPicker(false)
          void addTeamFiles(picked.map((f) => ({ path: f.path, name: f.name, size: f.size })))
          // after the dialog has handed focus back (to the attach button): on to the message
          setTimeout(() => taRef.current?.focus(), 0)
        }}
      />
    </div>
  )
}

/** The chips of a draft: those kept in memory, else the finished ones kept for this tab (after a reload). */
function restoreChips(userId: string, draftId: string): Pending[] {
  const mem = readStash<Pending>(userId, draftId)
  if (mem.length) return mem
  const saved: Pending[] = loadChips(userId, draftId).map((c) => ({ ...c, status: 'done', progress: 1, abort: new AbortController() }))
  if (saved.length) writeStash(userId, draftId, saved)
  return saved
}

/** "groups/marketing/brief.md" -> "groups/marketing" */
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

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
