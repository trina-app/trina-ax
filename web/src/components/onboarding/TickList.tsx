// The rows of a list of files to tick before they go up: the welcome step's 팀 파일 list (TeamFilesStep.tsx) and Find work
// files on this computer (FindWorkFiles.tsx). One look for both: a row (a box, the name, one line of what it is, a note
// under it), a group that folds, the name search. Sizes come from the type tokens (text-sm, text-label); no list sets its
// own.
import clsx from 'clsx'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { ReactNode } from 'react'

/** A file's row. `checked` undefined: a row that cannot be ticked (already there), with a faint check instead of a box. */
export function TickRow({ id, name, meta, note, checked, onChange, disabled, first, pad, testId = 'team-file-row', rowKey, checkTestId = 'team-file-check' }: {
  id: string
  name: string
  meta: ReactNode
  /** under the meta (a ticked personal-looking file: who sees it) */
  note?: ReactNode
  checked?: boolean
  onChange?: (on: boolean) => void
  disabled?: boolean
  /** the first row of its list: no line above it */
  first: boolean
  /** the list's inner padding (a frame on a computer, none on a phone) */
  pad: string
  testId?: string
  rowKey: string
  checkTestId?: string
}) {
  const tickable = checked !== undefined
  return (
    <li className={clsx('flex items-start gap-3 border-line py-2.5', pad, !first && 'border-t')} data-testid={testId} data-key={rowKey} data-checked={tickable ? String(checked) : undefined}>
      {tickable ? (
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} disabled={disabled} className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]" data-testid={checkTestId} />
      ) : <Check size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />}
      <label htmlFor={tickable ? id : undefined} className={clsx('min-w-0 flex-1', tickable && 'cursor-pointer')}>
        <span className="block truncate text-sm font-medium text-ink">{name}</span>
        <span className="mt-0.5 line-clamp-2 break-words text-label text-muted">{meta}</span>
        {note}
      </label>
    </li>
  )
}

/** A group's header that folds it. */
export function TickFold({ label, aside, open, onToggle, controls, pad, phone, testId }: { label: string; aside?: ReactNode; open: boolean; onToggle: () => void; controls: string; pad: string; phone: boolean; testId: string }) {
  return (
    <button type="button" className={clsx('flex min-h-11 w-full items-center gap-1.5 border-t border-line py-2.5 text-left text-sm', pad, !phone && 'hover:bg-hover')}
      aria-expanded={open} aria-controls={controls} onClick={onToggle} data-testid={testId}>
      <span className="min-w-0 font-medium text-ink">{label}</span>
      {aside && <span className="min-w-0 truncate text-label text-muted">{aside}</span>}
      <ChevronDown size={16} className={clsx('ml-auto shrink-0 text-faint transition', open && 'rotate-180')} aria-hidden />
    </button>
  )
}

/** "Find by file name" over a list. */
export function TickSearch({ value, onChange, placeholder, pad, testId }: { value: string; onChange: (v: string) => void; placeholder: string; pad: string; testId: string }) {
  return (
    <label className={clsx('flex items-center gap-2 py-2', pad)}>
      <Search size={14} className="shrink-0 text-faint" aria-hidden />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="h-8 min-w-0 flex-1 rounded-md border border-field-border bg-surface px-2 text-sm text-ink" data-testid={testId} />
    </label>
  )
}
