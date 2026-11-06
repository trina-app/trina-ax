// How many of the person's skills the AI sees and how (server/src/chat/skill-list.ts): every name while they fit in
// the instructions' list, descriptions while they fit; the rest the AI finds with find_skills. Shown on the Team skills
// page only when the list is cut, or when there are more team rule files than the AI follows (prompt.ts teamRules).
import { Info } from 'lucide-react'
import type { SkillsOverview } from '@mycel/shared/api'
import { useT } from '../i18n'

export function SkillListNote({ list, className }: { list: SkillsOverview['aiList']; className?: string }) {
  const t = useT()
  if (!list) return null
  const rules = list.rules > list.rulesFollowed
  if (!list.cut && !rules) return null
  return (
    <div role="note" className={`rounded-lg bg-subtle px-3 py-2 text-xs text-muted ${className ?? ''}`} data-testid="skill-list-note">
      {list.cut && (
        <>
          <p className="flex flex-wrap items-center gap-x-1.5 font-medium text-ink" data-testid="skill-list-counts">
            <Info size={13} aria-hidden />
            <span>
              {t('skills.aiList', { skills: list.skills, described: list.described, nameOnly: list.nameOnly })}
              {list.unlisted > 0 && t('skills.aiListUnlisted', { unlisted: list.unlisted })}
            </span>
          </p>
          <p className="mt-0.5">{t('skills.aiListHint')}</p>
        </>
      )}
      {rules && <p className={list.cut ? 'mt-1' : ''} data-testid="skill-rules-count">{t('skills.aiRules', { followed: list.rulesFollowed, rules: list.rules })}</p>}
    </div>
  )
}
