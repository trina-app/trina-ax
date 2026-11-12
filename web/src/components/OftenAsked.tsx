// What people of my group (or my team) often ask, under Home's box (docs/DECISIONS.md "Home: what my group often asks";
// GET /api/questions/often-asked, server/src/chat/often-asked.ts). A small heading and 3 plain lines, no frame, no
// counts, no names; More opens the rest in place (up to 10), Less closes them. A line puts its question in the box
// (focused, never sent). Nothing at all while there is nothing to show.
import { useEffect, useId, useState } from 'react'
import type { OftenAsked as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'

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
  if (!result || result.scope === 'none' || !result.items.length) return null
  const heading = result.scope === 'group' ? t('home.oftenAsked.group', { group: result.group }) : result.scope === 'groups' ? t('home.oftenAsked.groups') : t('home.oftenAsked.team')
  const items = open ? result.items : result.items.slice(0, OFTEN_ASKED_FIRST)
  return (
    <section className="mt-6" aria-labelledby={`${id}-title`} data-testid="often-asked" data-scope={result.scope}>
      <h2 id={`${id}-title`} className="px-2 pb-1 text-xs text-muted max-md:px-3">{heading}</h2>
      {/* phones (below 768px): 44px rows in line with Home's other rows */}
      <ul id={`${id}-list`}>
        {items.map((q) => (
          <li key={q}>
            <button type="button" onClick={() => onChoose(q)} title={q} className="flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm text-ink transition hover:bg-hover max-md:min-h-11 max-md:px-3" data-testid="often-asked-item">
              <span className="min-w-0 flex-1 truncate">{q}</span>
            </button>
          </li>
        ))}
      </ul>
      {result.items.length > OFTEN_ASKED_FIRST && (
        <button type="button" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)} className="touch-hit mt-1 rounded px-2 text-label text-muted transition hover:text-ink max-md:min-h-11 max-md:px-3" data-testid="often-asked-more">
          {open ? t('home.oftenAsked.less') : t('home.oftenAsked.more')}
        </button>
      )}
    </section>
  )
}
