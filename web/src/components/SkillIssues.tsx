// R2-SKILL-03 / R2-SKILL-04: a warning for skill entries that do not load (an invalid SKILL.md, a name that is not
// its folder name, a legacy file with a broken header). The server reports only entries the viewer can read.
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SkillIssue } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { parentPath } from '../lib/paths'
import { isSkillsPath, issuesIn } from '../lib/skillIssues'
import { navigateTo } from '../lib/nav'
import { useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'

export function SkillIssues({ folder, className }: { folder?: string; className?: string }) {
  const t = useT()
  const [items, setItems] = useState<SkillIssue[]>([])
  useEffect(() => {
    let active = true, generation = 0
    const load = () => {
      const g = ++generation
      api.call(API.listSkillIssues).then((r) => { if (active && g === generation) setItems(r.items) }, () => {})
    }
    load()
    const offs = [
      accessChanged.on(load), skillsChanged.on(load), reloadAsked.on(load),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) load() }),
    ]
    return () => { active = false; for (const off of offs) off() }
  }, [])
  const shown = issuesIn(items, folder)
  if (!shown.length) return null
  return (
    <div role="note" className={`rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn ${className ?? ''}`} data-testid="skill-issues">
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={13} aria-hidden /> {t('skills.issues.title')}</p>
      <ul className="mt-1 space-y-0.5">
        {shown.map((i) => (
          <li key={i.path} data-testid="skill-issue" data-problem={i.problem}>
            <button type="button" className="font-mono hover:underline" onClick={() => navigateTo(`/files?path=${encodeURIComponent(parentPath(i.path))}&select=${encodeURIComponent(i.path)}`)}>{i.path}</button>
            {': '}{t(`skills.issues.${i.problem}`, { folder: parentPath(i.path).split('/').pop() ?? '' })}
          </li>
        ))}
      </ul>
    </div>
  )
}
