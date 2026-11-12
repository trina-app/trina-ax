// One setting's choice on a phone (below 768 px), like the iPhone's Settings, instead of a computer's select box: a row
// "Name   value ›" with the setting's short line under the name (PhoneChoiceRow), or in a toolbar a pill
// "Range   Last 30 days ›" (PhoneChoicePill). A tap opens the phone's bottom sheet of rooms/MenuButton.tsx (Back closes
// it, lib/backCloses.ts) with the choices and ✓ on the current one; a long list (time zones) opens at the current one.
// A pick calls `onChange` as the select's change did, and only for another choice, so each page saves as before (its
// save bar, a group's Save, or at once). The pages draw these on a phone only; computers keep their select boxes
// (QA TC-378, docs/AGENTS/plan/20261112-0507-phone-choice-rows.md). Also `phoneNumberCls`: a phone's number field.
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'

export interface PhoneChoiceOption<T extends string> {
  value: T
  label: string
  /** shown but not to be picked (an engine switched off) */
  disabled?: boolean
}

/** the current choice's words; a value not among the choices shows as it is */
const shown = <T extends string>(options: readonly PhoneChoiceOption<T>[], value: T) => options.find((o) => o.value === value)?.label ?? value

const items = <T extends string>(options: readonly PhoneChoiceOption<T>[], value: T, onChange: (v: T) => void, testId?: string): MenuItem[] =>
  options.map((o) => ({
    label: o.label,
    checked: o.value === value,
    disabled: o.disabled,
    onSelect: () => { if (o.value !== value) onChange(o.value) },
    testId: testId ? `${testId}-option-${o.value || 'default'}` : undefined,
  }))

/** In an open sheet, the current choice in sight: a list longer than the sheet (about 400 time zones) opens there, not
 * at its top. (MenuButton puts the focus on it without scrolling, which suits its short menus.) */
function ToChecked() {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const menu = ref.current?.closest<HTMLElement>('[role="menu"]')
    const on = menu?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (menu && on && menu.scrollHeight > menu.clientHeight) menu.scrollTop = on.offsetTop - (menu.clientHeight - on.offsetHeight) / 2
  }, [])
  return <span ref={ref} hidden />
}

/** A setting as one row: its name, then the current choice and › at the row's end, its short line under them; a tap
 * anywhere on it opens the sheet. `more`: the longer details behind "Learn more" under the row (as admin/common.tsx
 * SettingRow has them); `below`: under the row, always shown (a warning). `list`: a row of a phone list
 * (phone/PhoneList.tsx PhoneListGroup: an <li>, hairlines, across the screen) instead of a page's row. `testId`: the
 * row's button; `-value` its value, `-option-<v>` each choice in the sheet. */
export function PhoneChoiceRow<T extends string>({ title, desc, more, below, value, options, onChange, testId, list }: {
  title: string
  desc?: ReactNode
  more?: ReactNode
  below?: ReactNode
  value: T
  options: readonly PhoneChoiceOption<T>[]
  onChange: (v: T) => void
  testId?: string
  list?: boolean
}) {
  const t = useT()
  const descId = useId()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const current = shown(options, value)
  if (list)
    return (
      <li className="group/row" data-testid={testId ? `${testId}-row` : undefined}>
        <MenuButton label={`${title} ${current}`} heading={title} items={items(options, value, onChange, testId)} footer={<ToChecked />}
          className="w-full" buttonClassName="w-full !rounded-none !py-0 !pr-0 !pl-4 text-left" testId={testId}
          icon={
            <span className="flex min-h-12 w-full min-w-0 items-center gap-3 border-t border-line py-2.5 pr-4 text-sm group-first/row:border-t-0">
              <span className="min-w-0 flex-1 truncate text-ink">{title}</span>{' '}
              <span className="max-w-[55%] shrink-0 truncate text-muted" data-testid={testId ? `${testId}-value` : undefined}>{current}</span>
              <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
            </span>
          } />
      </li>
    )
  return (
    <div className="py-1.5" data-testid={testId ? `${testId}-row` : undefined}>
      {/* the button holds the name and the value only (its name is what it shows); the line under it describes it and
          opens the sheet too, for a finger */}
      <MenuButton label={`${title} ${current}`} heading={title} describedBy={desc ? descId : undefined} items={items(options, value, onChange, testId)} footer={<ToChecked />}
        className="w-full" buttonClassName="w-full !rounded-lg !p-0 text-left" testId={testId} buttonRef={button}
        icon={
          <span className="flex min-h-12 w-full min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1 text-sm font-medium text-ink">{title}</span>{' '}
            <span className="max-w-[55%] shrink-0 truncate text-sm text-muted" data-testid={testId ? `${testId}-value` : undefined}>{current}</span>
            <ChevronRight size={16} className="-mr-1 shrink-0 text-faint" aria-hidden />
          </span>
        } />
      {desc && <p id={descId} className="-mt-2 cursor-pointer pb-1 text-sm text-muted" onClick={() => button.current?.click()}>{desc}</p>}
      {more && (
        <>
          <button type="button" aria-expanded={open} className="touch-hit text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)} data-testid={testId ? `${testId}-more` : undefined}>
            {t(open ? 'common.less' : 'teamSettings.learnMore')}
          </button>
          <div hidden={!open} className="mt-2 max-w-prose text-xs leading-relaxed text-faint">{more}</div>
        </>
      )}
      {below}
    </div>
  )
}

/** A toolbar's choice (Range, Group by, Period): "Label   value ›" in a 44 px frame, as wide as its words, or as wide
 * as its place when that stretches it. `bare`: the value and › alone, no frame (the end of a list row that names what
 * it is about: a muted room's level); `label` then names it for screen readers and heads the sheet. `testId`: the
 * button; `-pill` the frame, `-option-<v>` each choice. */
export function PhoneChoicePill<T extends string>({ label, value, options, onChange, testId, className, bare }: {
  label: string
  value: T
  options: readonly PhoneChoiceOption<T>[]
  onChange: (v: T) => void
  testId?: string
  className?: string
  bare?: boolean
}) {
  const current = shown(options, value)
  if (bare)
    return (
      <div className={clsx('inline-flex max-w-full min-w-0', className)} data-testid={testId ? `${testId}-pill` : undefined}>
        <MenuButton label={`${label} ${current}`} heading={label} items={items(options, value, onChange, testId)} footer={<ToChecked />}
          className="flex w-full min-w-0" buttonClassName="h-11 w-full min-w-0 gap-1 !rounded-lg !py-0 !pr-0 !pl-2 text-sm" testId={testId}
          icon={
            <>
              <span className="min-w-0 truncate text-muted" data-testid={testId ? `${testId}-value` : undefined}>{current}</span>
              <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
            </>
          } />
      </div>
    )
  return (
    <div className={clsx('inline-flex max-w-full min-w-0', className)} data-testid={testId ? `${testId}-pill` : undefined}>
      <MenuButton label={`${label} ${current}`} heading={label} items={items(options, value, onChange, testId)} footer={<ToChecked />}
        className="flex w-full min-w-0" buttonClassName="h-11 w-full min-w-0 gap-1.5 !rounded-lg border border-line bg-surface !px-3 !py-0 text-sm" testId={testId}
        icon={
          <>
            <span className="shrink-0 text-muted">{label}</span>{' '}
            <span className="min-w-0 flex-1 truncate text-right font-medium text-ink">{current}</span>
            <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
          </>
        } />
    </div>
  )
}

/** A phone's number field (a short number with its unit after it): no ⌃⌄ arrows (a computer's Safari draws them; iPhones
 * and Android do not), 72 px wide, 44 px tall. Computers keep the field as it was. Use with inputMode="numeric". */
export const phoneNumberCls = 'max-md:!w-[4.5rem] max-md:[appearance:textfield] max-md:[&::-webkit-inner-spin-button]:appearance-none max-md:[&::-webkit-outer-spin-button]:appearance-none'
