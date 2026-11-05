// Folder permissions (tab 2): folders that carry rules, each rule = who (everyone / role / group / person) gets
// none / read / write. "By folder" (AccessTree.tsx) is the team folder as a tree: who sees each folder and from where,
// each person's access and why; its rules change in the edit panel there (AccessEdit.tsx). "By person"
// (AccessPeople.tsx) shows, read only, what one person and their AI see and why; changing a folder's rules from there
// opens the same panel in By folder (`?edit=<path>&back=<the person view>`), and closing it goes back.
import { ArrowRight, Loader2, Trash2 } from 'lucide-react'
import { lazy, Suspense, useId, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Folder, PreviewResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { isSkillsPath } from '../../lib/access-view'
import { IconButton, Spinner, TabPanel, Tabs, confirmDialog } from '../../components/ui'
import { AdminPageHeader, useActionOk, useOneAtATime } from './common'

const AccessPeople = lazy(() => import('./AccessPeople'))
const AccessTree = lazy(() => import('./AccessTree'))

/** skills/ and its folders: write there = "팀 스킬 관리" (the Members / Groups toggle is the same rule). Compared as the
 * server compares it (any case or Unicode form of the first name), like the tree's label. */
export const isSkillsFolder = isSkillsPath

/** Rules inside a personal folder never applied (access.ts), so removing them changes nothing and the server has no
 * preview for them. */
const isPersonal = (p: string) => p === 'users' || p.startsWith('users/')

/** How long the remove dialog waits for the server's preview before it opens with the general text. */
const PREVIEW_WAIT_MS = 5000

/** The server's "who sees what" for no rules at `path`; null when it fails or takes longer than PREVIEW_WAIT_MS. */
async function removalPreview(path: string): Promise<PreviewResponse | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PREVIEW_WAIT_MS)
  try {
    return await api.call(API.previewRules, { body: { changes: [{ path, rules: [] }] }, signal: ctl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The people whose access a preview changes, per folder (the folder itself and rule folders below it). Access is decided
 * per person, walking up from the folder to the first rules that name them, so only the server can say who gains or
 * loses what (a rule above may not name them, and a rule higher up or none at all, owner and admins aside, then decides).
 */
export function previewChanges(preview: PreviewResponse): { path: string; users: PreviewResponse['folders'][number]['users'] }[] {
  return preview.folders.map((f) => ({ path: f.path, users: f.users.filter((u) => u.before !== u.after) })).filter((f) => f.users.length > 0)
}

/**
 * "Remove all rules of a folder", the way every list here does it: ask the server what that changes (the delete button
 * is busy meanwhile: `checking`), confirm with that answer, delete, then `onRemoved`. One at a time. Rows the server
 * keeps (Folder.keep) offer no delete; the server refuses them anyway.
 */
export function useRemoveRules(rootName: string) {
  const t = useT()
  const actOk = useActionOk()
  const once = useOneAtATime<string>()
  /** the row whose delete is asking the server what it would change (the button shows it is busy) */
  const [checking, setChecking] = useState<string | null>(null)
  const remove = (f: Folder, onRemoved: () => void | Promise<void>) =>
    once.run(f.id, async () => {
      // what removing the rules really does, from the server (the same "who sees what" as saving rules); without it,
      // the general text
      let body: ReactNode = t('rules.removeBodyPersonal')
      if (!isPersonal(f.path)) {
        setChecking(f.id)
        const preview = await removalPreview(f.path)
        setChecking(null)
        body = preview ? <RemovePreview preview={preview} /> : t('rules.removeBody')
      }
      if (!(await confirmDialog({ title: t('rules.removeTitle', { path: f.path || rootName }), body, confirm: t('common.delete'), danger: true }))) return
      if (!(await actOk(() => api.call(API.deleteFolder, { params: { id: f.id } })))) return
      await onRemoved()
    })
  return { remove, checking }
}

/** The delete button of a folder's rules: names the folder, busy while the server works out what deleting changes. */
export function RemoveRulesButton({ f, label, checking, onClick, testId }: { f: Folder; label: string; checking: string | null; onClick: () => void; testId?: string }) {
  return (
    <IconButton label={label} onClick={onClick} aria-busy={checking === f.id || undefined} data-row-focus data-testid={testId}>
      {checking === f.id ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Trash2 size={15} />}
    </IconButton>
  )
}

/** Folder permissions: by folder (the tree, AccessTree.tsx) or by person (what one person and their AI see, and why:
 * read only, AccessPeople.tsx). The choice is in the address (`?view=people&person=<id>`, `?folder=<path>`), so links
 * and Back work. */
export default function Folders() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const panels = useId()
  const view = params.get('view') === 'people' ? 'people' : 'folders'
  // a fresh start each way: the person, someone new's choices and the folder narrowed to stay with the person view.
  // Compared with the address itself: the router shows a change in a transition, so `view` can still be the one before
  // (two keys pressed quickly on the tabs)
  const choose = (v: 'folders' | 'people') => {
    const q = new URLSearchParams(window.location.search)
    const now = q.get('view') === 'people' ? 'people' : 'folders'
    // "By folder" again while a folder is chosen: back to the tree (the folder leaves the address)
    if (v !== now || (v === 'folders' && q.has('folder'))) setParams(v === 'people' ? { view: 'people' } : {})
  }
  return (
    <>
      {/* the same header as Members and Groups: title, one line, then the controls (here the by folder / by person
          switch, as wide as its two tabs) */}
      <AdminPageHeader
        title={t('admin.folders')}
        desc={t('folders.pageDesc')}
        testId="folders-header"
        still
        controls={
          <Tabs
            segmented
            value={view}
            onChange={choose}
            panels={panels}
            items={[
              { id: 'folders', label: t('accessView.byFolder') },
              { id: 'people', label: t('accessView.byPerson') },
            ]}
            label={t('accessView.tabs')}
          />
        }
      />
      <TabPanel base={panels} value={view}>
        <Suspense fallback={<Spinner />}>{view === 'people' ? <AccessPeople /> : <AccessTree />}</Suspense>
      </TabPanel>
    </>
  )
}

/** The remove dialog's body: the files stay, and who gains or loses what (only the people whose access changes). */
export function RemovePreview({ preview }: { preview: PreviewResponse }) {
  const t = useT()
  const changes = previewChanges(preview)
  return (
    <div className="space-y-3" data-testid="rules-remove-preview">
      <p>{t('rules.removeKeeps')}</p>
      {!changes.length && !preview.losing.length ? (
        <p>{t('rules.removeNoChange')}</p>
      ) : (
        <>
          {changes.map((f) => (
            <div key={f.path}>
              <p className="mb-1 text-xs font-medium text-muted">{t('rules.removeAt', { path: f.path || t('files.root') })}</p>
              <ul className="divide-y divide-line rounded-lg border border-line text-sm text-ink">
                {f.users.map((u) => (
                  <li key={u.user.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{u.user.name}</span>
                    <span className="text-xs text-muted">{t(`access.${u.before}`)}</span>
                    <ArrowRight size={12} className="text-faint" aria-label={t('rules.becomes')} />
                    <span className="text-xs font-medium text-warn">{t(`access.${u.after}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {preview.losing.length > 0 && (
            <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger" role="note">
              <p className="mb-1 font-semibold">{t('rules.losing')}</p>
              <ul className="space-y-0.5">
                {preview.losing.map((l) => (
                  <li key={l.user.id}>{t('rules.losingLine', { name: l.user.name, paths: l.paths.map((x) => x || t('files.root')).join(', '), n: l.chatsReset })}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
