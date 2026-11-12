// A filter in the Claude Console style: a rounded pill that reads "Label  Value ⌄". It is a native <select> inside the
// pill, so the keyboard, screen readers and phone pickers all work as usual; the pill only draws the frame and the label.
// The ⌄ is the one every <select> draws (index.css), with its room on the right: the pill adds none of its own (two
// arrows showed side by side).
// A phone (below 768 px): a setting pill (`neutral`: Admin › Usage's Range and Group by, Me › Usage's Period) is no
// select box: "Range   Last 30 days ›" opens a bottom sheet with ✓ on the current choice (components/phone/PhoneChoice.tsx,
// QA TC-378); a pick changes the page at once, as the select did. The filters (inside the phone's Filters sheet) stay.
import clsx from 'clsx'
import { useId } from 'react'
import { useMediaQuery } from '../ui'
import { PhoneChoicePill } from '../phone/PhoneChoice'

export function FilterPill<T extends string>({ label, value, options, onChange, testId, className, neutral }: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  testId?: string
  className?: string
  /** a setting, not a filter (Range, Group by): never drawn as "applied" */
  neutral?: boolean
}) {
  const id = useId()
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (phone && neutral) return <PhoneChoicePill label={label} value={value} options={options} onChange={onChange} testId={testId} className={className} />
  // a filter away from its first choice ("All") gets a stronger border, like an applied filter in the Console
  const active = !neutral && options[0] ? value !== options[0].value : false
  return (
    <div
      className={clsx(
        'relative inline-flex h-9 max-w-full items-center rounded-lg border bg-surface text-sm transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent hover:bg-hover max-md:h-11',
        active ? 'border-line-strong' : 'border-line',
        className,
      )}
      data-testid={testId ? `${testId}-pill` : undefined}
    >
      <label htmlFor={id} className="shrink-0 pl-3 pr-1.5 text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-full min-w-0 max-w-[14rem] cursor-pointer max-md:-my-px max-md:h-11 truncate bg-transparent font-medium text-ink outline-none [field-sizing:content]"
        data-testid={testId}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
