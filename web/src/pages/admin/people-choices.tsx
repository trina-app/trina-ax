// The role and group choices of the invite and add-member dialogs (Members.tsx), also used by Folder permissions › By
// person for "someone new" (AccessPeople.tsx), so the preview offers exactly the invite's choices.
import { Link, useInRouterContext } from 'react-router-dom'
import type { Group, Role } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { inputCls } from '../../components/ui'

export type MemberRole = Exclude<Role, 'owner'>

/** `newGroupLink`: a small "Make a new group" link under the checks that opens Admin › Groups (groups are made there,
 * never inline; the team link's picker, QA TC-458). */
export function GroupChecks({ groups, value, onChange, newGroupLink = false }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void; newGroupLink?: boolean }) {
  const t = useT()
  const more = newGroupLink && <NewGroupLink label={t('teamLink.newGroup')} />
  if (!groups.length) return <div><p className="text-xs text-faint">{t('groups.none')}</p>{more}</div>
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <label key={g.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm">
            <input type="checkbox" checked={value.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))} />
            {g.name}
          </label>
        ))}
      </div>
      {more}
    </div>
  )
}

/** Admin › Groups (a plain link outside a router: the views are also rendered on their own). */
function NewGroupLink({ label }: { label: string }) {
  const cls = 'mt-2 inline-block text-label text-muted underline decoration-line-strong underline-offset-4 hover:text-ink max-sm:py-2'
  return useInRouterContext()
    ? <Link to="/admin/groups" className={cls} data-testid="group-checks-new">{label}</Link>
    : <a href="/admin/groups" className={cls} data-testid="group-checks-new">{label}</a>
}

export function RoleSelect({ value, onChange, disabled, testId }: { value: MemberRole; onChange: (r: MemberRole) => void; disabled?: boolean; testId?: string }) {
  const t = useT()
  return (
    <select className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as MemberRole)} data-testid={testId}>
      <option value="member">{t('role.member')}</option>
      <option value="admin">{t('role.admin')}</option>
    </select>
  )
}
