import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PopularSkills as Result } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { accessChanged, reloadAsked, skillsChanged } from '../store/live'

export function PopularSkills() {
  const t = useT()
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
  if (!result?.items.length) return null
  return <section className="mb-5 rounded-2xl border border-line p-4" data-testid="popular-skills" aria-labelledby="popular-skills-title">
    <h2 id="popular-skills-title" className="text-sm font-semibold">{t('skills.popularTitle')}</h2>
    <p className="mb-3 mt-1 text-xs text-muted">{t('skills.popularHint')}</p>
    <ol className="space-y-3">{result.items.map(item => <li key={item.path} className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <Link to={`/?prompt=${encodeURIComponent('/' + item.name + ' ')}`} className="text-sm font-medium text-accent-text hover:underline">{item.name}</Link>
        <p className="line-clamp-2 text-xs text-muted">{item.description}</p>
      </div>
      <span className="shrink-0 text-xs text-muted">{t('skills.popularCount', { uses: item.uses, users: item.users })}</span>
    </li>)}</ol>
  </section>
}
