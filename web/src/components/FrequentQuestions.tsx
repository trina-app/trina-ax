import { useEffect, useState } from 'react'
import { plainRoomRefs, type FrequentQuestions as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'

export function FrequentQuestions({ onChoose }: { onChoose: (question: string) => void }) {
  const t = useT()
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    let active = true
    api.call(API.frequentQuestions).then(r => active && setResult(r), () => {})
    return () => { active = false }
  }, [])
  if (!result?.items.length) return null
  // phones (below 768px): no frame, the rows 44px high and in line with Home's other rows
  return <section className="mt-6 md:rounded-2xl md:border md:border-line md:p-4" data-testid="frequent-questions" aria-labelledby="frequent-title">
    <h2 id="frequent-title" className="text-sm font-semibold max-md:px-3">{t('home.frequentTitle')}</h2>
    <p className="mb-3 mt-1 text-xs text-muted max-md:mb-1 max-md:px-3">{t('home.frequentHint')}</p>
    {result.sampled && <p className="mb-2 text-xs text-faint max-md:px-3">{t('home.frequentSample')}</p>}
    <ul className="space-y-1 max-md:space-y-0">{result.items.map(item => <li key={item.question}>
      <button type="button" onClick={() => onChoose(item.question)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover max-md:min-h-11 max-md:px-3">
        <span className="line-clamp-2 min-w-0 flex-1 text-sm">{plainRoomRefs(item.question)}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums">{t('home.frequentCount', { count: item.count })}</span>
      </button>
    </li>)}</ul>
  </section>
}
