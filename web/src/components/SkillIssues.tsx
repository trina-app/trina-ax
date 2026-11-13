// R2-SKILL-03 / R2-SKILL-04: a warning for skill entries that do not load (an invalid SKILL.md, a name that is not
// its folder name, a legacy file with a broken header). The server reports only entries the viewer can read. A skill
// whose form does not parse (`inputs`) still works, so it gets a note of its own that says so.
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { SkillIssue } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { parentPath } from '../lib/paths'
import { isSkillsPath, issuesIn, issueText } from '../lib/skillIssues'
import { navigateTo } from '../lib/nav'
import { useT } from '../i18n'
import { useCachedRead } from '../store/listCache'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'

const NONE: SkillIssue[] = []
const readIssues = () => api.call(API.listSkillIssues).then((r) => r.items)

export function SkillIssues({ folder, className }: { folder?: string; className?: string }) {
  const t = useT()
  // as this window last read it (store/listCache.ts), read again behind it
  const { data, reload } = useCachedRead<SkillIssue[]>('skills:issues', readIssues)
  const items = data ?? NONE
  useEffect(() => {
    const load = () => void reload()
    const offs = [
      accessChanged.on(load), skillsChanged.on(load), reloadAsked.on(load),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) load() }),
    ]
    return () => { for (const off of offs) off() }
  }, [reload])
  // a new folder on the Files screen also loads again (the list may be older than the realtime connection)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    void reload()
  }, [folder, reload])
  const shown = issuesIn(items, folder)
  const broken = shown.filter((i) => i.problem !== 'inputs'), forms = shown.filter((i) => i.problem === 'inputs')
  if (!shown.length) return null
  return (
    <>
      {!!broken.length && <IssueNote title={t('skills.issues.title')} items={broken} className={className} testId="skill-issues" />}
      {!!forms.length && <IssueNote title={t('skills.issues.inputsTitle')} items={forms} className={className} testId="skill-form-issues" />}
    </>
  )
}

function IssueNote({ title, items, className, testId }: { title: string; items: SkillIssue[]; className?: string; testId: string }) {
  const t = useT()
  return (
    <div role="note" className={`rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn ${className ?? ''}`} data-testid={testId}>
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={13} aria-hidden /> {title}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((i) => (
          <li key={`${i.problem}:${i.path}`} data-testid="skill-issue" data-problem={i.problem}>
            <button type="button" className="font-mono hover:underline" onClick={() => navigateTo(`/files?path=${encodeURIComponent(parentPath(i.path))}&select=${encodeURIComponent(i.path)}`)}>{i.path}</button>
            {': '}{issueText(t, i)}
          </li>
        ))}
      </ul>
    </div>
  )
}
