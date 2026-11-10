// The admin's part of the Files page's "Who can see it" panel (components/FolderAccess.tsx; docs/DECISIONS.md "Who
// can see a folder, in place"): where the access comes from, in the tree row's own words (sourceText), how many folders
// inside carry rules of their own, the people by name as Admin › Folder permissions lists them (FolderPeople.tsx), and
// the way to that page, and [규칙 바꾸기]: Admin's own edit panel for this folder, which comes back here when it closes
// (AccessTree's `from=files`). Loaded for admins only, and every answer here is from an admin endpoint the server
// refuses to members.
import { useEffect, useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { sourceSaysSomething, sourceText, type Names } from '../../lib/access-view'
import { useT } from '../../i18n'
import { Button, Skeleton } from '../../components/ui'
import type { AdminSelf } from '../../components/FolderAccess'
import { People, useFolderAnswer } from './FolderPeople'

/** `change`: offer [규칙 바꾸기] (not on a team project's own folder, whose members are changed on its page). */
export default function FolderAccessAdmin({ path, self, ready, change, onLeave }: { path: string; self: AdminSelf | null; ready: boolean; change: boolean; onLeave: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const answer = useFolderAnswer(path, 0)
  /** folders inside with rules of their own (the tree's "rule folders only" list, the folder itself left out) */
  const [below, setBelow] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    setBelow(null)
    api.call(API.explainAccessTree, { query: { path, rules: '1', limit: 1 } }).then(
      (r) => live && setBelow(Math.max(0, (r.levels[0]?.total ?? 0) - (r.self.rules > 0 ? 1 : 0))),
      () => {},
    )
    return () => {
      live = false
    }
  }, [path])
  // the names the reasons need: the people and groups whose rules decided here are the ones the tree row names
  const names: Names = useMemo(() => {
    const by = new Map<string, string>()
    for (const w of self?.self.who ?? []) if (w.subject?.id && w.subject.name) by.set(`${w.subject.type}:${w.subject.id}`, w.subject.name)
    return { group: (id) => by.get(`group:${id}`), person: (id) => by.get(`user:${id}`) }
  }, [self])
  if (!ready) return <Skeleton lines={4} />
  return (
    <div className="space-y-2" data-testid="folder-access-admin">
      {self && sourceSaysSomething(self.self) && (
        <p className="text-sm text-muted" data-testid="folder-access-source">
          {sourceText(t, self.self, self.members)}
        </p>
      )}
      {!!below && (
        <p className="text-sm">
          <Link to={`/admin/folders?folder=${encodeURIComponent(path)}`} onClick={onLeave} className="text-accent-text underline-offset-2 hover:underline" data-testid="folder-access-below">
            {t('folderAccess.below', { n: below })}
          </Link>
        </p>
      )}
      {change && (
        <Button
          size="sm"
          onClick={() => {
            onLeave()
            navigate(`/admin/folders?edit=${encodeURIComponent(path)}&from=files`)
          }}
          data-testid="folder-access-change"
        >
          <SlidersHorizontal size={14} aria-hidden /> {t(self && self.self.rules > 0 ? 'accessTree.editRules' : 'accessTree.addRules')}
        </Button>
      )}
      <People answer={answer} path={path} names={names} linkPeople />
      <p className="pt-1 text-sm">
        <Link to={`/admin/folders?folder=${encodeURIComponent(path)}`} onClick={onLeave} className="text-accent-text underline-offset-2 hover:underline" data-testid="folder-access-all">
          {t('folderAccess.all')}
        </Link>
      </p>
    </div>
  )
}
