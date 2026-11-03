// The role and group choices of the invite and add-member dialogs (Members.tsx), also used by Folder permissions › By
// person for "someone new" (AccessPeople.tsx), so the preview offers exactly the invite's choices.
import type { Group, Role } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { inputCls } from '../../components/ui'

export type MemberRole = Exclude<Role, 'owner'>

export function GroupChecks({ groups, value, onChange }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT()
  if (!groups.length) return <p className="text-xs text-faint">{t('groups.none')}</p>
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((g) => (
        <label key={g.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm">
          <input type="checkbox" checked={value.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))} />
          {g.name}
        </label>
      ))}
    </div>
  )
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
