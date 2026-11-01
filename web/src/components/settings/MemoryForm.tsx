// Adding or correcting one memory in Settings › Memory, in place in the list (like a row of Claude's memory list being
// edited). The rules are the server's, the same as the AI's remember (server/src/chat/prompt.ts cleanMemoryText): one
// line (spaces and line breaks fold into one space), at most MEMORY_TEXT_MAX characters, not empty. The count and the
// "too long" note follow the folded text; the server checks again and its words show under the field.
import clsx from 'clsx'
import { useId, useState } from 'react'
import { MEMORY_TEXT_MAX } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { Button, inputCls } from '../ui'

/** The text as the server keeps it. */
export const foldMemory = (s: string) => s.replace(/\s+/g, ' ').trim()

export function MemoryForm({ initial = '', submitLabel, onSubmit, onCancel, testId }: {
  initial?: string
  submitLabel: string
  /** throws (or rejects) with the words to show under the field */
  onSubmit: (text: string) => Promise<void>
  onCancel: () => void
  testId?: string
}) {
  const t = useT()
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const folded = foldMemory(text)
  const over = folded.length > MEMORY_TEXT_MAX
  const unchanged = folded === foldMemory(initial) && !!initial
  const can = !!folded && !over && !unchanged && !busy
  const submit = async () => {
    if (!can) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(folded)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const note = error ?? (over ? t('memory.tooLong', { max: MEMORY_TEXT_MAX }) : null)
  return (
    <form className="w-full" data-testid={testId} onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label htmlFor={`${id}-text`} className="mb-1.5 block text-[13px] font-medium text-ink">{t('memory.field')}</label>
      <textarea
        id={`${id}-text`}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        rows={2}
        value={text}
        placeholder={t('memory.placeholder')}
        aria-invalid={note ? true : undefined}
        aria-describedby={`${id}-note`}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        onKeyDown={(e) => {
          // one line: Enter saves (not while an IME is composing Korean or Japanese), Esc leaves it as it was
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        className={clsx(inputCls, 'h-auto min-h-16 resize-y py-2')}
        data-testid="memory-input"
      />
      <div className="mt-1 flex items-start gap-3">
        <span id={`${id}-note`} role={note ? 'alert' : undefined} className={clsx('min-w-0 flex-1 text-xs', note ? 'text-danger' : 'text-faint')} data-testid="memory-note">
          {note ?? t('memory.hint', { max: MEMORY_TEXT_MAX })}
        </span>
        <span className={clsx('shrink-0 text-xs tabular-nums', over ? 'text-danger' : 'text-faint')} data-testid="memory-count">
          {folded.length}/{MEMORY_TEXT_MAX}
        </span>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!can} busy={busy} data-testid="memory-save">{submitLabel}</Button>
      </div>
    </form>
  )
}
