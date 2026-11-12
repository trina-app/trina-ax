// What people of my group (or my team) often ask, under Home's box (docs/DECISIONS.md "Home: what my group often asks";
// GET /api/questions/often-asked, server/src/chat/often-asked.ts). A small heading and 3 plain lines, no frame, no
// counts, no names; More opens the rest in place (up to 10), Less closes them. A line puts its question in the box
// (focused, never sent). Nothing at all while there is nothing to show. Phones (below 768 px; QA TC-253): the same
// heading, then the lines as one row of chips above the docked box that scrolls sideways (components/SuggestionRow.tsx),
// More and Less the row's last chip.
import { useEffect, useId, useState } from 'react'
import type { OftenAsked as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { useMediaQuery } from './ui'
import { chip, SuggestionRow } from './SuggestionRow'

/** Lines before More. */
export const OFTEN_ASKED_FIRST = 3

export function OftenAsked({ onChoose }: { onChoose: (question: string) => void }) {
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.oftenAsked).then((r) => live && setResult(r), () => {})
    return () => { live = false }
  }, [])
  return <OftenAskedList result={result} onChoose={onChoose} />
}

/** The list without the data load (exported for its test). */
export function OftenAskedList({ result, onChoose }: { result: Result | null; onChoose: (question: string) => void }) {
  const t = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (!result || result.scope === 'none' || !result.items.length) return null
  const heading = result.scope === 'group' ? t('home.oftenAsked.group', { group: result.group }) : result.scope === 'groups' ? t('home.oftenAsked.groups') : t('home.oftenAsked.team')
  const items = open ? result.items : result.items.slice(0, OFTEN_ASKED_FIRST)
  const more = result.items.length > OFTEN_ASKED_FIRST
  const toggle = (className: string) => (
    <button type="button" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)} className={className} data-testid="often-asked-more">
      {open ? t('home.oftenAsked.less') : t('home.oftenAsked.more')}
    </button>
  )
  if (phone)
    return (
      <section className="mt-2 mb-1" aria-labelledby={`${id}-title`} data-testid="often-asked" data-scope={result.scope}>
        <h2 id={`${id}-title`} className="pb-1.5 text-xs text-muted">{heading}</h2>
        <SuggestionRow id={`${id}-list`}>
          {items.map((q) => (
            <li key={q} className="flex shrink-0">
              {/* a question longer than the chip: two lines, then cut (its whole text in the box once tapped) */}
              <button type="button" onClick={() => onChoose(q)} title={q} className={`${chip} max-w-60 px-3 py-2 text-sm text-ink`} data-testid="often-asked-item">
                <span className="line-clamp-2 min-w-0">{q}</span>
              </button>
            </li>
          ))}
          {more && <li className="flex shrink-0">{toggle(`${chip} px-3 text-label text-muted`)}</li>}
        </SuggestionRow>
      </section>
    )
  return (
    <section className="mt-6" aria-labelledby={`${id}-title`} data-testid="often-asked" data-scope={result.scope}>
      <h2 id={`${id}-title`} className="px-2 pb-1 text-xs text-muted">{heading}</h2>
      <ul id={`${id}-list`}>
        {items.map((q) => (
          <li key={q}>
            <button type="button" onClick={() => onChoose(q)} title={q} className="flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm text-ink transition hover:bg-hover" data-testid="often-asked-item">
              <span className="min-w-0 flex-1 truncate">{q}</span>
            </button>
          </li>
        ))}
      </ul>
      {more && toggle('touch-hit mt-1 rounded px-2 text-label text-muted transition hover:text-ink')}
    </section>
  )
}
