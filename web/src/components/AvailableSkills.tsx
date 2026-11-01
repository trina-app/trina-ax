// "쓸 수 있는 스킬" on the Team skills page: every skill the person can use (GET /api/skills, the same list as the "/"
// menu: the team skills in the skills/ folders they can read, and their own personal skills), to read, start a chat
// with, or open in Files. The same read-only list for members and admins; what only skill managers and admins do
// (review suggestions, recent changes) stays in the page's other tabs. Before this tab a member's page listed no
// skill at all: only their own suggestions, and "Frequently used skills" once a skill had uses.
import { FileText, MessageSquarePlus, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SkillInfo } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { navigateTo } from '../lib/nav'
import { parentPath } from '../lib/paths'
import { isSkillsPath } from '../lib/skillIssues'
import { useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'
import { skillPrompt } from './PopularSkills'
import { Badge, Button, EmptyState, ErrorNote, Skeleton } from './ui'

/** The skill's file in Files (its folder, the file selected). */
export const skillFileLink = (path: string) => `/files?path=${encodeURIComponent(parentPath(path))}&select=${encodeURIComponent(path)}`
/** A new chat with "/<name> " in the message box. */
export const skillChatLink = (name: string) => `/?prompt=${encodeURIComponent(skillPrompt(name))}`

export function AvailableSkills() {
  const t = useT()
  const [items, setItems] = useState<SkillInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true, generation = 0
    const load = () => {
      const g = ++generation
      api.call(API.listSkills).then(
        (r) => { if (active && g === generation) { setItems(r.items); setFailed(false) } },
        () => { if (active && g === generation) setFailed(true) },
      )
    }
    load()
    const offs = [
      accessChanged.on(load), skillsChanged.on(load), reloadAsked.on(load),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) load() }),
    ]
    return () => { active = false; for (const off of offs) off() }
  }, [attempt])
  // never "no skills" for a list that did not load
  if (failed && !items) return <ErrorNote onRetry={() => { setFailed(false); setAttempt((n) => n + 1) }}>{t('error.network')}</ErrorNote>
  return <AvailableSkillsList items={items} />
}

/** The list without the data load (null: still loading). */
export function AvailableSkillsList({ items }: { items: SkillInfo[] | null }) {
  const t = useT()
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<Sparkles size={22} />} title={t('skills.noSkills')}>{t('skills.noSkillsHint')}</EmptyState>
  return (
    <>
      <p className="mb-3 text-xs text-muted">{t('skills.availableHint')}</p>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" data-testid="skill-list">
        {items.map((s) => (
          <li key={s.path} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm" data-testid="skill-row" data-path={s.path}>
            <span className="min-w-0 flex-1 basis-60">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium [overflow-wrap:anywhere]">{s.name}</span>
                {s.personal && <Badge tone="accent">{t('skills.personal')}</Badge>}
              </span>
              {s.description && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{s.description}</span>}
              <span className="mt-0.5 block truncate font-mono text-[11px] text-faint" title={s.path}>{s.path}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" onClick={() => navigateTo(skillChatLink(s.name))} aria-label={t('skills.useNamed', { name: s.name })} data-testid="skill-use">
                <MessageSquarePlus size={13} aria-hidden /> {t('skills.use')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigateTo(skillFileLink(s.path))} aria-label={t('skills.viewFileNamed', { name: s.name })} data-testid="skill-file">
                <FileText size={13} aria-hidden /> {t('skills.viewFile')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
