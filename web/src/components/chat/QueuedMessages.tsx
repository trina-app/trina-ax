// Messages waiting for the running answer to end (store/sendQueue.ts), under the conversation: each one can be
// edited or taken back; a stopped or failed answer pauses them with "Send now". The status line is a polite live
// region, so a screen reader hears "waiting" and "paused" without the focus moving.
import clsx from 'clsx'
import { Clock, FileText, FolderOpen, Pencil, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { QueuedMessage } from '../../lib/sendQueue'
import { useSendQueue } from '../../store/sendQueue'
import { Button, IconButton, inputCls, useAnnounce } from '../ui'

export default function QueuedMessages({ chatId, onFocusComposer }: { chatId: string; onFocusComposer: () => void }) {
  const t = useT()
  const announce = useAnnounce()
  const q = useSendQueue((s) => s.queues[chatId])
  const editing = useSendQueue((s) => s.editing[chatId] ?? null)
  const list = useRef<HTMLUListElement>(null)
  if (!q?.items.length) return null
  const { remove, update, setEditing, sendNow } = useSendQueue.getState()

  const status = q.paused === 'stopped' ? t('outbox.pausedStopped')
    : q.paused === 'error' ? t('outbox.pausedError')
    : q.paused === 'away' ? t('outbox.pausedAway')
    : q.items.length > 1 ? t('outbox.waitingMany', { n: q.items.length }) : t('outbox.waitingOne')

  /** After an item went away: focus the next item's "don't send" (or the one before), else the message box. */
  const focusAfterRemove = (index: number) => {
    requestAnimationFrame(() => {
      const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[data-testid="outbox-remove"]') ?? [])]
      const next = buttons[Math.min(index, buttons.length - 1)]
      if (next) next.focus()
      else onFocusComposer()
    })
  }

  return (
    <section aria-label={t('outbox.label')} className="flex flex-col items-end gap-2" data-testid="outbox" data-paused={q.paused ?? undefined}>
      <ul ref={list} className="flex w-full flex-col items-end gap-2">
        {q.items.map((it, i) => (
          <QueuedItem
            key={it.id}
            item={it}
            editing={editing === it.id}
            onEdit={() => setEditing(chatId, it.id)}
            onCancelEdit={() => setEditing(chatId, null)}
            onSave={(content) => {
              update(chatId, it.id, content)
              setEditing(chatId, null)
            }}
            onRemove={() => {
              remove(chatId, it.id)
              announce(t('outbox.removed'))
              focusAfterRemove(i)
            }}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted" data-testid="outbox-status">
          <Clock size={12} className="shrink-0" aria-hidden /> {status}
        </p>
        {q.paused && (
          <Button
            size="sm"
            variant="primary"
            disabled={!!editing}
            onClick={() => {
              sendNow(chatId)
              onFocusComposer()
            }}
            data-testid="outbox-send-now"
          >
            {t('outbox.sendNow')}
          </Button>
        )}
      </div>
    </section>
  )
}

function QueuedItem({ item, editing, onEdit, onCancelEdit, onSave, onRemove }: { item: QueuedMessage; editing: boolean; onEdit: () => void; onCancelEdit: () => void; onSave: (content: string) => void; onRemove: () => void }) {
  const t = useT()
  const [draft, setDraft] = useState(item.content)
  const row = useRef<HTMLLIElement>(null)
  const backToEdit = () => requestAnimationFrame(() => row.current?.querySelector<HTMLElement>('[data-testid="outbox-edit"]')?.focus())
  const canSave = draft.trim().length > 0 || item.attachments.length > 0
  return (
    <li ref={row} className="flex w-full max-w-[85%] flex-col items-end gap-1.5 sm:max-w-[80%]" data-testid="outbox-item" data-item-id={item.id}>
      {item.attachments.length > 0 && (
        <span className="flex flex-wrap justify-end gap-1.5">
          {item.attachments.map((a) => (
            <span key={a.id} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-1 text-xs text-muted">
              {a.source === 'team' ? <FolderOpen size={12} className="shrink-0" aria-hidden /> : <FileText size={12} className="shrink-0" aria-hidden />}
              <span className="truncate">{a.name || t('attach.unavailable')}</span>
            </span>
          ))}
        </span>
      )}
      {editing ? (
        <form
          className="w-full rounded-2xl border border-line bg-surface p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSave) return
            onSave(draft)
            backToEdit()
          }}
        >
          <textarea
            aria-label={t('outbox.edit')}
            className={clsx(inputCls, 'h-auto min-h-20 resize-y border-0 py-2 focus:ring-0')}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDraft(item.content)
                onCancelEdit()
                backToEdit()
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !window.matchMedia?.('(pointer: coarse)').matches) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            data-testid="outbox-edit-input"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(item.content)
                onCancelEdit()
                backToEdit()
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!canSave} data-testid="outbox-save">
              {t('common.save')}
            </Button>
          </div>
        </form>
      ) : (
        item.content && (
          <div className="max-w-full min-w-0 rounded-3xl border border-dashed border-line-strong bg-surface px-4 py-2.5 text-[15px] leading-7 text-muted" data-testid="outbox-text">
            <div className="line-clamp-[8] whitespace-pre-wrap [overflow-wrap:anywhere]">{item.content}</div>
          </div>
        )
      )}
      {!editing && (
        <span className="flex items-center gap-1">
          <IconButton
            label={t('outbox.edit')}
            onClick={() => {
              setDraft(item.content)
              onEdit()
            }}
            data-testid="outbox-edit"
          >
            <Pencil size={13} />
          </IconButton>
          <IconButton label={t('outbox.remove')} onClick={onRemove} data-testid="outbox-remove">
            <X size={14} />
          </IconButton>
        </span>
      )}
    </li>
  )
}
