// One choice out of a few on a phone (below 768 px), like the iPhone's Settings: a row per choice in a phone list
// (phone/PhoneList.tsx), the chosen one with a checkmark on the right, no radio circles or chips. Settings' language,
// theme and "messages to be notified about" use it (docs/AGENTS/plan/20261111-1748-phone-settings-rows.md).
import clsx from 'clsx'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { PhoneListGroup } from './PhoneList'

export interface PhoneCheck<T extends string> {
  value: T
  label: ReactNode
  /** a quieter line under the name */
  hint?: ReactNode
  lang?: string
  testId?: string
}

export function PhoneChecks<T extends string>({ title, footer, label, value, options, onChange, testId, labelId }: {
  title?: ReactNode
  footer?: ReactNode
  /** the group's name for screen readers when `title` is not plain text */
  label?: string
  value: T
  options: readonly PhoneCheck<T>[]
  onChange: (v: T) => void
  testId?: string
  labelId?: string
}) {
  return (
    <PhoneListGroup title={title} footer={footer} testId={testId} labelId={labelId}>
      <li role="radiogroup" aria-label={label} aria-labelledby={label ? undefined : labelId} className="contents">
        {options.map((o) => {
          const on = o.value === value
          return (
            <span key={o.value} className="group/row block">
              <button type="button" role="radio" aria-checked={on} lang={o.lang} onClick={() => { if (!on) onChange(o.value) }}
                className="flex w-full items-stretch pl-4 text-left text-sm transition hover:bg-hover focus-visible:-outline-offset-2" data-testid={o.testId}>
                <span className="flex min-h-12 min-w-0 flex-1 items-center gap-3 border-t border-line py-2.5 pr-4 group-first/row:border-t-0">
                  <span className="min-w-0 flex-1">
                    <span className={clsx('block truncate', on && 'font-medium')}>{o.label}</span>
                    {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
                  </span>
                  <Check size={18} className={clsx('shrink-0 text-accent', !on && 'invisible')} aria-hidden />
                </span>
              </button>
            </span>
          )
        })}
      </li>
    </PhoneListGroup>
  )
}
