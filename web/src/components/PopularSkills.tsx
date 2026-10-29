import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PopularSkills as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { accessChanged, reloadAsked, skillsChanged } from '../store/live'

/** The text a skill row puts in the composer: the slash command and a space for the request. */
export const skillPrompt = (name: string) => '/' + name + ' '

/**
 * Team skills with the most uses in the last 30 days (uses · people). The Skills page shows the full list.
 * The new-chat home (B-W7-7) shows the top `limit` rows, and a row fills the composer through `onChoose`.
 */
export function PopularSkills({ limit, onChoose, className = 'mb-5' }: { limit?: number; onChoose?: (prompt: string) => void; className?: string }) {
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    let active = true, generation = 0
    const load = () => {
      const g = ++generation
      setResult(null)
      api.call(API.popularSkills).then(r => { if (active && g === generation) setResult(r) }, () => {})
    }
    load()
    const off = accessChanged.on(load), skills = skillsChanged.on(load), reload = reloadAsked.on(load)
    return () => { active = false; off(); skills(); reload() }
  }, [])
  return <PopularSkillsList result={result} limit={limit} onChoose={onChoose} className={className} />
}

/** The section without the data load. It shows nothing while the list loads or when no skill has uses. */
export function PopularSkillsList({ result, limit, onChoose, className = 'mb-5' }: { result: Result | null; limit?: number; onChoose?: (prompt: string) => void; className?: string }) {
  const t = useT()
  const items = (result?.items ?? []).slice(0, limit)
  if (!items.length) return null
  return <section className={`${className} rounded-2xl border border-line p-4`} data-testid="popular-skills" aria-labelledby="popular-skills-title">
    <h2 id="popular-skills-title" className="text-sm font-semibold">{t('skills.popularTitle')}</h2>
    <p className="mb-3 mt-1 text-xs text-muted">{t(onChoose ? 'home.popularSkillsHint' : 'skills.popularHint')}</p>
    <ol className="space-y-3">{items.map(item => <li key={item.path} className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {onChoose
          ? <button type="button" onClick={() => onChoose(skillPrompt(item.name))} className="text-left text-sm font-medium text-accent-text hover:underline">{item.name}</button>
          : <Link to={`/?prompt=${encodeURIComponent(skillPrompt(item.name))}`} className="text-sm font-medium text-accent-text hover:underline">{item.name}</Link>}
        <p className="line-clamp-2 text-xs text-muted">{item.description}</p>
      </div>
      <span className="shrink-0 text-xs text-muted">{t('skills.popularCount', { uses: item.uses, users: item.users })}</span>
    </li>)}</ol>
  </section>
}
