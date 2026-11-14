// The warning before a group change (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)", C1-A): people
// the one-time folder access conversion added to a folder by name keep that access when they leave the group, like a
// Google Drive share given by name. Admin › Groups (a member taken out, a group deleted) and the person's page (a group
// taken off) ask the server first (POST /api/admin/groups/origin-check, nothing saved) and, when someone keeps access,
// say so before saving; each line can take the person off that folder right there ("Remove now": it acts at once,
// whatever the dialog's answer). A folder inside a team project offers no Remove: its members manage it there.
import { useState } from 'react'
import type { Folder, FolderRuleInput } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useFolderWords } from '../../lib/folderLabels'
import { inProjects } from '../../lib/folder-sharing'
import { toast } from '../../store/ui'
import { Button, confirmDialog } from '../../components/ui'
import { useActionOk } from './common'

type Kept = { user: { id: string; name: string }; path: string }

/** People leaving groups: `changes` = each person and the group they leave (or the deleted group's members). True:
 * save (nobody keeps access by name, the check failed, or the admin went on). */
export async function confirmOriginKept(changes: { userId: string; groupId: string }[], text: { title: string; confirm: string }): Promise<boolean> {
  if (!changes.length) return true
  let kept: Kept[]
  try {
    kept = (await api.call(API.originCheck, { body: { changes } })).kept
  } catch {
    return true // the warning only informs: the save itself is checked by the server as always
  }
  // one line per person and folder (the same rule can come from two groups the person leaves)
  const lines = [...new Map(kept.map((k) => [`${k.user.id}\0${k.path}`, k])).values()]
  if (!lines.length) return true
  return confirmDialog({ title: text.title, body: <OriginKeptList kept={lines} />, confirm: text.confirm })
}

function OriginKeptList({ kept }: { kept: Kept[] }) {
  const t = useT()
  const words = useFolderWords()
  const actOk = useActionOk()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const remove = async (k: Kept, id: string) => {
    setBusy(id)
    let gone = false
    const ok = await actOk(async () => {
      const f = (await api.call(API.listFolders)).items.find((x: Folder) => x.path === k.path)
      // not in the list (removed meanwhile): nothing was taken off, so never "Removed"
      if (!f) { gone = true; return }
      // the folder's own rules without this person (no access rows and the managed marker are the server's own; the
      // limit stays)
      const rules = f.rules.filter((r) => r.access !== 'none' && r.subjectType !== 'role' && !(r.subjectType === 'user' && r.subjectId === k.user.id)).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access }) as FolderRuleInput)
      await api.call(API.putFolderRules, { params: { id: f.id }, body: { rules, limited: !!f.limited, ...(f.rulesHash ? { expectedHash: f.rulesHash } : {}) } })
    })
    setBusy(null)
    if (gone) toast({ level: 'error', text: t('groups.originGone') })
    else if (ok) setDone((d) => new Set(d).add(id))
  }
  return (
    <ul className="space-y-2 text-sm" data-testid="origin-kept">
      {kept.map((k) => {
        const id = `${k.user.id}\0${k.path}`
        return (
          <li key={id} className="flex items-start gap-3" data-testid="origin-kept-row">
            <span className="min-w-0 flex-1">{t('groups.originWarning', { name: k.user.name, folder: words.path(k.path, ' › ') })}</span>
            {done.has(id) ? (
              <span className="shrink-0 py-1 text-xs text-muted">{t('groups.originRemoved')}</span>
            ) : inProjects(k.path) ? null : (
              <Button variant="ghost" size="sm" busy={busy === id} disabled={busy !== null} onClick={() => void remove(k, id)} data-testid="origin-kept-remove">
                {t('groups.originRemove')}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
