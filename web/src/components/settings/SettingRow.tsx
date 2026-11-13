// One setting as one row, for every settings screen (docs/DESIGN-SYSTEM.md "Typography", docs/DECISIONS.md "Settings
// rows: one component, the lists' sizes"): Settings (나: profile, about, apps; notifications), Admin (team settings, AI,
// connectors) and the connector pages. Its name is a list row's (`text-row`: 15px on a computer, 17px on a phone) and its
// line under the name is meta (`text-meta`, 13px), so a settings row reads like the rows of the other lists on the same
// screen size. A screen never sets its own sizes for a setting's name or line.
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { useT } from '../../i18n'

/** a setting's name: a list row's size, medium in ink */
export const settingName = 'text-row font-medium text-ink'
/** a setting's line under its name: meta size, muted */
export const settingDesc = 'text-meta text-muted'

/**
 * Its name, a short line on what it does under it, and the control on the right. Below 768 px a wide control (a select,
 * a text field, the logo's buttons) goes under the line; an `inline` one (a switch, a short number, a value to read)
 * stays on the right of the name, as on a phone's Settings, with the line under the name. `id` is the control's id: the
 * name labels it and the line describes it (`${id}-desc`, or `descId`). `more`: the longer details, behind "Learn more"
 * (kept in the page, hidden, so the row reads short). `heading`: the name is a heading, for a row whose control is not
 * one field (the team logo). `below`: under the line, always shown (an error, a state). `divided`: a hairline under the
 * row (none under the last), the name and the control centred on a computer and the control in a 288px column (the
 * profile form). `descError`: the line is an error (an alert in the danger colour); `quietDesc`: on a phone the line is
 * for screen readers only (an error still shows); `framed`: the control has its own frame, so no hairline under it on a
 * phone. `belowFull`: `below` goes under the whole row, the control's column too (a list of settings: Notifications).
 */
export function SettingRow({ id, title, desc, descId, more, control, below, heading, inline, divided, descError, quietDesc, framed, belowFull, testId, attrs }: {
  id?: string; title: ReactNode; desc?: ReactNode; descId?: string; more?: ReactNode; control?: ReactNode; below?: ReactNode; heading?: boolean; inline?: boolean
  divided?: boolean; descError?: boolean; quietDesc?: boolean; framed?: boolean; belowFull?: boolean; testId?: string; attrs?: Record<string, string>
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const lineId = descId ?? (id ? `${id}-desc` : undefined)
  const nameAttrs = { 'data-setting-name': '' }
  const row = (
    <div
      className={clsx(
        'flex md:flex-row',
        inline ? 'items-start gap-4' : divided ? 'flex-col gap-2' : 'flex-col gap-3',
        divided ? 'md:items-center md:justify-between md:gap-6' : belowFull ? 'md:gap-4' : 'md:items-start md:gap-8',
        !belowFull && (divided ? 'border-b border-line py-3 last:border-b-0' : 'py-4'),
        divided && framed && 'max-md:border-b-0',
      )}
      data-testid={belowFull ? undefined : testId}
      data-setting-row=""
      {...(belowFull ? {} : attrs)}
    >
      <div className="min-w-0 flex-1">
        {heading ? <h3 className={settingName} {...nameAttrs}>{title}</h3> : id ? <label htmlFor={id} className={settingName} {...nameAttrs}>{title}</label> : <p className={settingName} {...nameAttrs}>{title}</p>}
        {(desc || more) && (
          <div className={clsx('mt-0.5', settingDesc, descError && 'text-danger', quietDesc && !descError && 'max-md:sr-only')} role={descError ? 'alert' : undefined} data-setting-desc="">
            {desc && <span id={lineId}>{desc}</span>}
            {desc && more && ' '}
            {more && (
              <button type="button" aria-expanded={open} className="touch-hit font-medium whitespace-nowrap text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)} data-testid={testId ? `${testId}-more` : undefined}>
                {t(open ? 'common.less' : 'teamSettings.learnMore')}
              </button>
            )}
          </div>
        )}
        {more && <div hidden={!open} className="mt-2 max-w-prose text-meta text-faint">{more}</div>}
        {!belowFull && below}
      </div>
      {control && (
        divided
          // the profile form's column: a block 288px wide, its field filling it (a value to read stays on the right)
          ? <div className={clsx('min-w-0 md:w-72 md:max-w-[60%] md:shrink-0', inline && 'max-md:max-w-[60%] max-md:text-right')}>{control}</div>
          : <div className={clsx('flex shrink-0 md:pt-0.5', inline ? 'items-center gap-2 pt-0.5' : 'justify-start', !inline && !belowFull && 'md:justify-end')}>{control}</div>
      )}
    </div>
  )
  // `belowFull`: what is under the row takes the whole width, under the control too (quiet hours' times)
  return belowFull ? <div className="py-3.5" data-testid={testId} {...attrs}>{row}{below}</div> : row
}
