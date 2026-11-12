// One choice out of a few on a phone (below 768 px), like the iPhone's Settings: a row per choice in the phone list's
// look (phone/PhoneList.tsx: a small heading, hairlines, a quiet footer), the chosen one with a checkmark on the right,
// no radio circles or chips. Settings' language and theme use it (docs/AGENTS/plan/20261111-1748-phone-settings-rows.md).
// It is a radio group, not a list: the rows are radios, one tab stop (the chosen one), and the arrow keys move to the
// next or previous choice and pick it, Home and End the first and last (the ARIA radio group pattern).
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface PhoneCheck<T extends string> {
  value: T
  label: ReactNode
  /** a quieter line under the name */
  hint?: ReactNode
  lang?: string
  testId?: string
}

export function PhoneChecks<T extends string>({ title, footer, label, value, options, onChange, testId }: {
  title?: ReactNode
  footer?: ReactNode
  /** the group's name for screen readers when there is no `title` */
  label?: string
  value: T
  options: readonly PhoneCheck<T>[]
  onChange: (v: T) => void
  testId?: string
}) {
  const titleId = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  const pick = (i: number) => {
    const o = options[i]
    if (!o) return
    refs.current[i]?.focus()
    if (o.value !== value) onChange(o.value)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i - 1 + n) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1
            : null
    if (next === null) return
    e.preventDefault()
    pick(next)
  }
  return (
    <section className="mt-6 first:mt-4" data-testid={testId}>
      {title && <h2 id={titleId} className="px-4 pb-1.5 text-xs font-medium text-faint">{title}</h2>}
      <div role="radiogroup" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label} className="border-y border-line">
        {options.map((o, i) => {
          const on = o.value === value
          return (
            <button key={o.value} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={on} tabIndex={i === at ? 0 : -1} lang={o.lang}
              onClick={() => pick(i)} onKeyDown={(e) => onKeyDown(e, i)}
              className="group/row flex w-full items-stretch pl-4 text-left text-sm transition hover:bg-hover focus-visible:-outline-offset-2" data-testid={o.testId}>
              <span className="flex min-h-12 min-w-0 flex-1 items-center gap-3 border-t border-line py-2.5 pr-4 group-first/row:border-t-0">
                <span className="min-w-0 flex-1">
                  <span className={clsx('block truncate', on && 'font-medium')}>{o.label}</span>
                  {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
                </span>
                <Check size={18} className={clsx('shrink-0 text-accent', !on && 'invisible')} aria-hidden />
              </span>
            </button>
          )
        })}
      </div>
      {footer && <div className="px-4 pt-2 text-xs text-faint">{footer}</div>}
    </section>
  )
}
