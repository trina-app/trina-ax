// One message of the visible branch. User messages: bubble, attachments (image thumbnails), edit, "‹ 2/3 ›",
// "sending" / "not sent [send again]". Answers: steps, queue position, Markdown, artifact cards, ask_user cards,
// file summary, end state (error / stopped), copy, regenerate, branch switch.
import clsx from 'clsx'
import { AlertTriangle, BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, FileAudio, FileText, FileX, FolderOpen, Loader2, Pencil, RotateCcw, Shapes, Sparkles, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { chatErrorReason, ERROR_MESSAGES, type Attachment, type EngineId } from '@mycel/shared/api'
import { fileUrl, thumbnailUrl } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { previewKind } from '../../lib/preview'
import { openArtifact, openTeamFile, useSidePanel } from '../../lib/sidePanel'
import { TEAM_FILE_DRAG_TYPE } from '../../lib/teamAttach'
import { useChatArtifacts } from '../../lib/useArtifacts'
import { useLocale, useT } from '../../i18n'
import { useChats, useQueuePosition } from '../../store/chats'
import type { ViewMessage } from '../../store/thread'
import { TYPE_LABEL } from '../artifactLabels'
import { Markdown } from '../Markdown'
import { Button, CopyButton, IconButton, inputCls } from '../ui'
import AskCard from './AskCard'
import SuggestSkillDialog from '../SuggestSkillDialog'
import FileSummary from './FileSummary'
import Steps from './Steps'
import { ENGINE_LABEL, EngineOptions, type EnginePick } from './EngineMenu'

export { ENGINE_LABEL }

export function BranchNav({ m, onSelect, disabled }: { m: ViewMessage; onSelect: (id: string) => void; disabled?: boolean }) {
  const t = useT()
  const { index, count, siblingIds } = m.branch
  if (count < 2) return null
  return (
    <span className="inline-flex items-center text-xs text-faint" data-testid="branch-nav">
      <IconButton label={t('chat.prevBranch')} disabled={disabled || index === 0} onClick={() => onSelect(siblingIds[index - 1]!)}>
        <ChevronLeft size={14} />
      </IconButton>
      <span className="tabular-nums" data-testid="branch-label">
        {index + 1} / {count}
      </span>
      <IconButton label={t('chat.nextBranch')} disabled={disabled || index >= count - 1} onClick={() => onSelect(siblingIds[index + 1]!)}>
        <ChevronRight size={14} />
      </IconButton>
    </span>
  )
}

export function AttachmentView({ a, align = 'end' }: { a: Attachment; align?: 'start' | 'end' }) {
  const t = useT()
  const locale = useLocale()
  const [thumbFailed, setThumbFailed] = useState(false)
  const team = a.source === 'team'
  // a team file that was deleted or that the person can no longer open: the server sent nothing about it
  if (team && a.unavailable)
    return (
      <span className={clsx('inline-flex max-w-[80%] items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-faint', align === 'end' && 'self-end')} data-testid="attachment-unavailable">
        <FileX size={16} className="shrink-0" aria-hidden /> {t('attach.unavailable')}
      </span>
    )
  if (a.kind === 'image' && !thumbFailed)
    return (
      <button type="button" onClick={() => openTeamFile(a.path)} className={clsx('overflow-hidden rounded-xl border border-line', align === 'end' && 'self-end')} aria-label={t('common.previewNamed', { name: a.name })}>
        <img
          src={thumbnailUrl(a.id)}
          alt={a.name}
          loading="lazy"
          onError={() => setThumbFailed(true)}
          className="max-h-48 max-w-[260px] object-cover"
          style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
        />
      </button>
    )
  const icon = team ? (
    <FolderOpen size={16} className="shrink-0 text-accent-text" aria-label={t('composer.teamFile', { path: a.path })} />
  ) : a.kind === 'audio' ? (
    <FileAudio size={16} className="shrink-0 text-accent-text" aria-hidden />
  ) : (
    <FileText size={16} className="shrink-0 text-muted" aria-hidden />
  )
  const body = (
    <>
      {icon}
      <span className="truncate font-medium">{a.name}</span>
      <span className="shrink-0 text-xs text-faint">{formatSize(a.size, locale)}</span>
      {team && a.changed && <span className="shrink-0 text-xs text-warn">{t('attach.changed')}</span>}
      {team && a.moved && !a.changed && <span className="shrink-0 text-xs text-faint">{t('attach.moved')}</span>}
    </>
  )
  const cls = clsx('inline-flex max-w-[80%] items-center gap-2 rounded-xl border px-3 py-2 text-sm', team ? 'border-accent/30 bg-accent-soft' : 'border-line bg-surface')
  // a team file can be dragged from the message into the message box again
  const drag = team
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData(TEAM_FILE_DRAG_TYPE, a.path)
          e.dataTransfer.setData('text/plain', a.path)
          e.dataTransfer.effectAllowed = 'copy'
        },
      }
    : {}
  return previewKind(a.name) ? (
    <button type="button" className={clsx(cls, 'text-left hover:bg-hover')} onClick={() => openTeamFile(a.path)} title={team ? t('composer.teamFile', { path: a.path }) : t('common.preview')} data-source={a.source ?? 'upload'} {...drag}>
      {body}
    </button>
  ) : (
    <a className={clsx(cls, 'hover:bg-hover')} href={fileUrl(a.path)} download={a.name} title={team ? t('composer.teamFile', { path: a.path }) : undefined} data-source={a.source ?? 'upload'} {...drag}>
      {body}
    </a>
  )
}

export function UserMessage({ m, chatId, busy, onEdit, onSelectBranch }: { m: ViewMessage; chatId: string; busy: boolean; onEdit: (m: ViewMessage, text: string) => void; onSelectBranch: (id: string) => void }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const resend = useChats((s) => s.resend)
  const discard = useChats((s) => s.discardLocal)
  const long = m.content.length > 1200 || m.content.split('\n').length > 18
  const [open, setOpen] = useState(!long)
  return (
    <div className="group flex min-w-0 flex-col items-end gap-2" data-testid="user-message" data-message-id={m.id}>
      {m.attachments.map((a) => (
        <AttachmentView key={a.id} a={a} />
      ))}
      {editing ? (
        <form
          className="w-full max-w-[85%] rounded-2xl border border-line bg-surface p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            setEditing(false)
            onEdit(m, draft)
          }}
        >
          <textarea aria-label={t('chat.editMessage')} className={clsx(inputCls, 'h-auto min-h-24 resize-y border-0 py-2 focus:ring-0')} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <p className="px-1 pb-1 text-xs text-faint">{t('chat.editNote')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()} data-testid="edit-send">
              {t('chat.send')}
            </Button>
          </div>
        </form>
      ) : (
        m.content && (
          <div className={clsx('max-w-[85%] min-w-0 rounded-3xl bg-subtle px-4 py-2.5 text-[15px] leading-7 sm:max-w-[80%]', m.local && 'opacity-70')} data-testid="user-text">
            <div className={clsx('whitespace-pre-wrap [overflow-wrap:anywhere]', !open && 'line-clamp-[12]')}>{m.content}</div>
            {long && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-muted hover:text-ink">
                {open ? t('chat.showLess') : t('chat.showAll')}
              </button>
            )}
          </div>
        )
      )}
      {m.local?.state === 'sending' && (
        <span className="flex items-center gap-1 text-xs text-faint" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {t('chat.sending')}
        </span>
      )}
      {m.local?.state === 'failed' && (
        <span className="flex flex-wrap items-center justify-end gap-2 text-xs text-danger" role="alert" data-testid="send-failed">
          <AlertTriangle size={13} aria-hidden /> {t('chat.notSent')}
          {m.local.error && <span className="basis-full text-right">{m.local.error}</span>}
          <button type="button" className="font-medium underline" onClick={() => void resend(chatId, m.id)}>
            {t('chat.sendAgain')}
          </button>
          <button type="button" className="text-faint underline" onClick={() => discard(chatId, m.id)}>
            {t('common.delete')}
          </button>
        </span>
      )}
      {!m.local && !editing && (
        <div className="flex items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <BranchNav m={m} onSelect={onSelectBranch} disabled={busy} />
          <CopyButton text={m.content} />
          <IconButton
            label={t('chat.edit')}
            onClick={() => {
              setDraft(m.content)
              setEditing(true)
            }}
          >
            <Pencil size={13} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

function ArtifactCards({ chatId, messageId }: { chatId: string; messageId: string }) {
  const t = useT()
  const groups = useChatArtifacts(chatId)
  const live = useChats((s) => s.liveArtifacts[chatId])
  const panel = useSidePanel()
  const cards = useMemo(() => {
    const out = new Map<string, { key: string; title: string | null; type: keyof typeof TYPE_LABEL; version: number | null; writing: boolean }>()
    for (const g of groups ?? []) {
      const here = g.versions.filter((v) => v.messageId === messageId)
      const latest = here.sort((a, b) => b.version - a.version)[0]
      if (latest) out.set(g.key, { key: g.key, title: latest.title, type: latest.type, version: latest.version, writing: false })
    }
    for (const a of Object.values(live ?? {})) {
      if (a.messageId !== messageId) continue
      if (a.status === 'writing') out.set(a.key, { key: a.key, title: a.title, type: a.type, version: out.get(a.key)?.version ?? null, writing: true })
      else if (!out.has(a.key)) out.set(a.key, { key: a.key, title: a.title, type: a.type, version: a.version, writing: false })
    }
    return [...out.values()]
  }, [groups, live, messageId])
  if (!cards.length) return null
  return (
    <div className="mt-3 flex flex-col gap-2">
      {cards.map((a) => {
        const open = panel?.kind === 'artifact' && panel.artifactKey === a.key && panel.chatId === chatId
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => openArtifact(chatId, a.key)}
            data-testid="artifact-card"
            data-state={a.writing ? 'writing' : 'done'}
            className={clsx('flex max-w-md items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left shadow-sm transition hover:bg-hover', open ? 'border-accent' : 'border-line')}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">{a.writing ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Shapes size={18} aria-hidden />}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{a.title || a.key}</span>
              <span className="block text-xs text-muted">
                {t(TYPE_LABEL[a.type])}
                {a.version ? ` · v${a.version}` : ''} · {a.writing ? t('artifact.writing') : t('artifact.clickToOpen')}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function AssistantMessage({
  m,
  chatId,
  isLast,
  busy,
  switchedFrom,
  onRegenerate,
  retryWith,
  onSelectBranch,
  onAskOwnFolder,
}: {
  m: ViewMessage
  chatId: string
  isLast: boolean
  busy: boolean
  switchedFrom: EngineId | null
  onRegenerate: (m: ViewMessage, with_?: EnginePick) => void
  /** people who may pick the engine: "retry with another model" next to "retry" on a failed answer */
  retryWith?: { engines: EngineId[]; models: Partial<Record<EngineId, { id: string; label: string }[]>> }
  onSelectBranch: (id: string) => void
  onAskOwnFolder: (path: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const streaming = m.status === 'streaming'
  const queuePos = useQueuePosition(streaming ? m.id : undefined)
  const requests = useChats(useShallow((s) => Object.values(s.requests).filter((r) => r.messageId === m.id)))
  const thinking = streaming && !m.content
  const known = m.error ? ERROR_MESSAGES[m.error.code] : undefined
  const reason = m.error ? chatErrorReason(m.error) : null
  const errText = m.error
    ? reason ? t(`chat.error.${reason}`)
      : m.error.params?.reason === undefined && known && Object.values(known).includes(m.error.message) ? known[locale] : m.error.message
    : null
  const [suggesting, setSuggesting] = useState(false)

  return (
    <div className="group flex gap-3" data-testid="assistant-message" data-message-id={m.id} data-status={m.status} aria-busy={streaming}>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text" aria-hidden>
        <Sparkles size={15} />
      </div>
      <div className="min-w-0 flex-1 text-[15px]">
        {switchedFrom && m.engine && (
          <div className="mb-3 flex items-center gap-2 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />
            {t('chat.engineSwitched', { engine: ENGINE_LABEL[m.engine] })}
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {streaming && queuePos !== undefined && queuePos > 0 && (
          <p className="mb-2 text-sm text-muted" role="status" data-testid="queue-position">
            {t('chat.queued', { n: queuePos })} <span className="text-muted-foreground">{t('chat.queueHint')}</span>
          </p>
        )}
        <Steps steps={m.steps} streaming={streaming} />
        {thinking && (queuePos === undefined || queuePos === 0) && (
          <div className="flex h-7 items-center gap-1" aria-label={t('chat.thinking')} role="status">
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            {!m.steps.length && <span className="ml-2 text-sm text-faint">{t('chat.thinking')}</span>}
          </div>
        )}
        {m.content && <Markdown text={m.content} streaming={streaming} />}
        <ArtifactCards chatId={chatId} messageId={m.id} />
        {requests.map((r) => (
          <AskCard key={r.request.requestId} req={r} />
        ))}
        {m.files && <FileSummary files={m.files} onAskOwnFolder={onAskOwnFolder} disabled={busy} />}
        {m.status === 'error' && (
          <div role="alert" className="mt-3 flex flex-wrap items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" data-testid="answer-error">
            <AlertTriangle size={16} className="mt-2 shrink-0" aria-hidden />
            {/* at least ~12rem for the text: on a phone the buttons go to their own line instead of squeezing it; one
                line of text is as tall as the buttons, so text, icon and buttons share a centre line */}
            <span className="min-w-0 flex-[1_1_12rem] py-1 leading-6">{errText ?? t('chat.answerFailed')}</span>
            {isLast && (
              <span className="ml-auto flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRegenerate(m)} data-testid="retry">
                  <RotateCcw size={13} aria-hidden /> {t('common.retry')}
                </Button>
                {retryWith && retryWith.engines.length > 0 && <RetryWithModel m={m} busy={busy} retryWith={retryWith} onPick={(p) => onRegenerate(m, p)} />}
              </span>
            )}
          </div>
        )}
        {m.status === 'stopped' && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
            <Square size={11} className="fill-current" aria-hidden /> {t('chat.stopped')}
          </p>
        )}
        {!streaming && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" data-testid="answer-actions">
            {m.content && <CopyButton text={m.content} label={t('chat.copyAnswer')} />}
            <IconButton label={t('chat.regenerate')} disabled={busy} onClick={() => onRegenerate(m)} data-testid="regenerate">
              <RotateCcw size={13} />
            </IconButton>
            {m.content && m.status === 'done' && (
              <IconButton label={t('suggest.button')} onClick={() => setSuggesting(true)} data-testid="suggest-skill">
                <BookmarkPlus size={13} />
              </IconButton>
            )}
            <BranchNav m={m} onSelect={onSelectBranch} disabled={busy} />
            {m.model && <span className="ml-1 text-[11px] text-faint">{m.model}</span>}
          </div>
        )}
        {suggesting && (
          <SuggestSkillDialog source={{ kind: 'message', chatId, messageId: m.id }} initialContent={m.content} onClose={() => setSuggesting(false)} />
        )}
      </div>
    </div>
  )
}

/** "다른 모델로 다시 시도": the engines and models the person may pick, for a new answer to the same question. */
function RetryWithModel({ m, busy, retryWith, onPick }: { m: ViewMessage; busy: boolean; retryWith: NonNullable<Parameters<typeof AssistantMessage>[0]['retryWith']>; onPick: (p: EnginePick) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button size="sm" variant="secondary" disabled={busy} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="retry-other-model">
        {t('chat.retryOtherModel')} <ChevronDown size={13} aria-hidden />
      </Button>
      {open && (
        <ul role="listbox" aria-label={t('chat.retryOtherModel')} className="absolute top-full right-0 z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-lg" onMouseLeave={() => setOpen(false)}>
          <EngineOptions
            engines={retryWith.engines}
            models={retryWith.models}
            current={{ engine: (m.engine ?? undefined) as EngineId | undefined, model: m.model }}
            onPick={(p) => {
              setOpen(false)
              onPick(p)
            }}
          />
        </ul>
      )}
    </div>
  )
}
