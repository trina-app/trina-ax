import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { skillSummary, skillTitle, type PopularSkills as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { accessChanged, reloadAsked, skillsChanged } from '../store/live'

/** The text a skill row puts in the composer: the slash command and a space for the request. */
export const skillPrompt = (name: string) => '/' + name + ' '

/**
 * Team skills with the most uses in the last 30 days (uses · people).
 * The new-chat home (B-W7-7) shows the top `limit` rows, and a row fills the composer through `onChoose`; it waits
 * until `min` different skills were used (one skill is not a choice yet).
 */
export function PopularSkills({ limit, min, onChoose, className = 'mb-5' }: { limit?: number; min?: number; onChoose?: (prompt: string) => void; className?: string }) {
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
  return <PopularSkillsList result={result} limit={limit} min={min} onChoose={onChoose} className={className} />
}

/** The section without the data load. It shows nothing while the list loads or while fewer than `min` (1) skills have
 * uses. On Home (`onChoose`) the title alone heads the rows. */
export function PopularSkillsList({ result, limit, min = 1, onChoose, className = 'mb-5' }: { result: Result | null; limit?: number; min?: number; onChoose?: (prompt: string) => void; className?: string }) {
  const t = useT()
  const all = result?.items ?? []
  const items = all.slice(0, limit)
  if (!items.length || all.length < min) return null
  return <section className={`${className} rounded-2xl border border-line p-4`} data-testid="popular-skills" aria-labelledby="popular-skills-title">
    <h2 id="popular-skills-title" className={`text-sm font-semibold ${onChoose ? 'mb-3' : ''}`}>{t('skills.popularTitle')}</h2>
    {!onChoose && <p className="mb-3 mt-1 text-xs text-muted">{t('skills.popularHint')}</p>}
    <ol className="space-y-3">{items.map(item => <li key={item.path} className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {onChoose
          ? <button type="button" onClick={() => onChoose(skillPrompt(item.name))} className="text-left text-sm font-medium text-accent-text hover:underline">{skillTitle(item)}</button>
          : <Link to={`/?prompt=${encodeURIComponent(skillPrompt(item.name))}`} className="text-sm font-medium text-accent-text hover:underline">{skillTitle(item)}</Link>}
        <p className="line-clamp-2 text-xs text-muted">{skillSummary(item)}</p>
      </div>
      <span className="shrink-0 text-xs text-muted">{t('skills.popularCount', { uses: item.uses, users: item.users })}</span>
    </li>)}</ol>
  </section>
}
