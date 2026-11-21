import clsx from 'clsx'
import type { Locale } from '@mycel/shared/api'
import { LOCALES } from '../i18n'
import { inputCls } from './ui'

/** The one language picker of the web app (owner 2026-11-16: "바꾸게 해야지 무슨 다 보여주고 있냐"): a select that
 * shows the current language and lists each language in its own name, never a row of every language. `teamDefault`
 * adds a first choice "Team default (…)", value `team` (a person's or a member's own setting). A phone's Settings keeps
 * its iPhone-style checkmark list (PhoneChecks / PhoneChoiceRow). */
export function LanguageSelect<V extends Locale | 'team'>({ value, onChange, teamDefault, className, compact, id, testId, label, describedBy, disabled, only }: {
  value: V
  onChange: (value: V) => void
  /** the label of the "team default" choice; without it there is no such choice */
  teamDefault?: string
  className?: string
  /** the small select of the sign-in screens */
  compact?: boolean
  id?: string
  testId?: string
  /** the accessible name when no <label> points at it */
  label?: string
  describedBy?: string
  disabled?: boolean
  /** only these languages (and the current one, whatever it is); default: every language */
  only?: readonly Locale[]
}) {
  return (
    <select
      id={id}
      className={clsx(compact ? 'rounded border border-field-border bg-surface px-1.5 py-1 text-xs text-ink max-md:min-h-11' : inputCls, className)}
      value={value}
      onChange={(e) => onChange(e.target.value as V)}
      data-testid={testId}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      {teamDefault !== undefined && <option value="team">{teamDefault}</option>}
      {LOCALES.filter((l) => !only || only.includes(l.id) || l.id === value).map((l) => (
        <option key={l.id} value={l.id} lang={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}
