// Folder permissions (tab 2): folders that carry rules, each rule = who (everyone / role / group / person) gets
// none / read / write. Before saving, "who sees what" shows every active person's access before → after, and who
// loses access (their chats that touched those folders get a fresh engine session). "By folder" (AccessTree.tsx) is the
// team folder as a tree: who sees each folder and from where, each person's access and why. "By person"
// (AccessPeople.tsx) shows, read only, what one person and their AI see and why. Both open the rule editor below.
import clsx from 'clsx'
import { ArrowRight, Eye, Loader2, Plus, Trash2 } from 'lucide-react'
import { lazy, Suspense, useId, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Access, Folder, FolderRuleInput, Group, PreviewResponse, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, IconButton, Modal, Spinner, TabPanel, Tabs, confirmDialog, inputCls } from '../../components/ui'
import { toast } from '../../store/ui'
import { useAction, useActionOk, useOneAtATime } from './common'

const AccessPeople = lazy(() => import('./AccessPeople'))
const AccessTree = lazy(() => import('./AccessTree'))

/** skills/ and its folders: write there = "팀 스킬 관리" (the Members / Groups toggle is the same rule) */
export const isSkillsFolder = (p: string) => p === 'skills' || p.startsWith('skills/')

type RuleRow = { subjectType: FolderRuleInput['subjectType']; subjectId: string | null; access: Access }

const toInput = (r: RuleRow): FolderRuleInput | null => {
  switch (r.subjectType) {
    case 'everyone':
      return { subjectType: 'everyone', subjectId: null, access: r.access }
    case 'role':
      return r.subjectId === 'admin' || r.subjectId === 'member' ? { subjectType: 'role', subjectId: r.subjectId, access: r.access } : null
    case 'group':
      return r.subjectId ? { subjectType: 'group', subjectId: r.subjectId, access: r.access } : null
    case 'user':
      return r.subjectId ? { subjectType: 'user', subjectId: r.subjectId, access: r.access } : null
  }
}

export function rulesFromRows(rows: RuleRow[]): FolderRuleInput[] | null {
  const out: FolderRuleInput[] = []
  for (const r of rows) {
    const x = toInput(r)
    if (!x) return null
    out.push(x)
  }
  return out
}

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
      {/* a flex row, so the switch is as wide as its two tabs */}
      <div className="mb-4 flex">
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
      </div>
      <TabPanel base={panels} value={view}>
        <Suspense fallback={<Spinner />}>{view === 'people' ? <AccessPeople /> : <AccessTree />}</Suspense>
      </TabPanel>
    </>
  )
}

/** The rules of one folder (`folder` null: a folder without a row yet), with "who sees what" before saving. Also
 * opened from Folder permissions › By person ("View or change rules"), which names the team root its own way
 * (`rootName`) and says when a folder is not on disk (`missing`): then nothing is made (create: false, and Save waits;
 * the server refuses a missing folder without create, tests/unit/access-explain-api.test.ts). */
export function RulesEditor({ folder, path, users, groups, subject, onClose, onSaved, rootName, missing }: { folder: Folder | null; path: string; users: User[]; groups: Group[]; subject: (type: string, id: string | null) => string; onClose: () => void; onSaved: () => void; rootName?: string; missing?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const [rows, setRows] = useState<RuleRow[]>(folder?.rules.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access })) ?? [])
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  /** the server's answer to Save when it refused (e.g. no rule left on shared/ or skills/), shown in the dialog */
  const [refused, setRefused] = useState<string | null>(null)
  const rules = rulesFromRows(rows)
  /** shared/ and skills/ keep at least one rule (the server refuses none): said here, and Save waits for a rule */
  const keepsOne = folder?.keep === 'team' && rows.length === 0
  const keepsOneId = useId()
  /** no row and no folder on disk: not made from here */
  const noFolder = !folder && !!missing
  const noFolderId = useId()
  const changed = () => {
    setPreview(null)
    setRefused(null)
  }
  const set = (i: number, patch: Partial<RuleRow>) => {
    changed()
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }
  const runPreview = async () => {
    if (!rules) return
    setBusy('preview')
    const r = await act(() => api.call(API.previewRules, { body: { changes: [{ path, rules }] } }))
    setBusy(null)
    if (r) setPreview(r)
  }
  const save = async () => {
    if (!rules) return
    setBusy('save')
    setRefused(null)
    try {
      await (folder ? api.call(API.putFolderRules, { params: { id: folder.id }, body: { rules } }) : api.call(API.createFolder, { body: { path, create: !noFolder, rules } }))
    } catch (e) {
      setRefused(errorText(e, locale, t('error.network')))
      return
    } finally {
      setBusy(null)
    }
    toast({ level: 'success', text: t('common.saved') })
    onSaved()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rules.editTitle', { path: path || (rootName ?? t('files.root')) })}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={runPreview} busy={busy === 'preview'} disabled={!rules} data-testid="rules-preview">
            <Eye size={14} aria-hidden /> {t('rules.preview')}
          </Button>
          <Button variant="primary" onClick={save} busy={busy === 'save'} disabled={!rules || keepsOne || noFolder} aria-describedby={keepsOne ? keepsOneId : noFolder ? noFolderId : undefined} data-testid="rules-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">{t('rules.editHint')}</p>
      {noFolder && (
        <p id={noFolderId} role="note" className="mb-3 rounded-lg bg-subtle px-3 py-2 text-xs text-muted" data-testid="rules-missing">
          {t('rules.missingNoCreate')}
        </p>
      )}
      {isSkillsFolder(path) && (
        <p role="note" className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="skill-folder-warning">
          {t('skillMgr.folderHint')} {t('skillMgr.readHint')}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="py-1 pr-2 font-medium">{t('rules.who')}</th>
            <th className="py-1 pr-2 font-medium">{t('rules.target')}</th>
            <th className="py-1 pr-2 font-medium">{t('rules.access')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-1 pr-2">
                <select aria-label={t('rules.who')} className={inputCls} value={r.subjectType} onChange={(e) => set(i, { subjectType: e.target.value as RuleRow['subjectType'], subjectId: e.target.value === 'everyone' ? null : e.target.value === 'role' ? 'member' : null })}>
                  <option value="everyone">{t('rules.everyone')}</option>
                  <option value="role">{t('rules.role')}</option>
                  <option value="group">{t('rules.group')}</option>
                  <option value="user">{t('rules.person')}</option>
                </select>
              </td>
              <td className="py-1 pr-2">
                {r.subjectType === 'role' && (
                  <select aria-label={t('rules.target')} className={inputCls} value={r.subjectId ?? 'member'} onChange={(e) => set(i, { subjectId: e.target.value })}>
                    <option value="member">{t('role.member')}</option>
                    <option value="admin">{t('role.admin')}</option>
                  </select>
                )}
                {r.subjectType === 'group' && (
                  <select aria-label={t('rules.target')} className={inputCls} value={r.subjectId ?? ''} onChange={(e) => set(i, { subjectId: e.target.value || null })}>
                    <option value="">—</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
                {r.subjectType === 'user' && (
                  <select aria-label={t('rules.target')} className={inputCls} value={r.subjectId ?? ''} onChange={(e) => set(i, { subjectId: e.target.value || null })}>
                    <option value="">—</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="py-1 pr-2">
                <select aria-label={t('rules.access')} className={inputCls} value={r.access} onChange={(e) => set(i, { access: e.target.value as Access })}>
                  <option value="none">{t('access.none')}</option>
                  <option value="read">{t('access.read')}</option>
                  <option value="write">{t('access.write')}</option>
                </select>
              </td>
              <td className="py-1">
                <IconButton
                  label={t('rules.removeRule')}
                  onClick={() => {
                    changed()
                    setRows((x) => x.filter((_, j) => j !== i))
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => { changed(); setRows((r) => [...r, { subjectType: 'group', subjectId: groups[0]?.id ?? null, access: 'read' }]) }} data-testid="rule-add">
        <Plus size={14} aria-hidden /> {t('rules.addRule')}
      </Button>
      {!rules && rows.length > 0 && <p className="mt-2 text-xs text-warn">{t('rules.incomplete')}</p>}
      {keepsOne && (
        <p id={keepsOneId} role="note" className="mt-2 text-xs text-warn" data-testid="rules-keep-one">
          {t('rules.keepTeam')}
        </p>
      )}
      {refused && (
        <div className="mt-3" data-testid="rules-refused">
          <ErrorNote>{refused}</ErrorNote>
        </div>
      )}
      {preview && <PreviewTable preview={preview} subject={subject} />}
    </Modal>
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

function PreviewTable({ preview }: { preview: PreviewResponse; subject: (type: string, id: string | null) => string }) {
  const t = useT()
  return (
    <div className="mt-5 space-y-4" data-testid="rules-preview-result">
      <h3 className="text-sm font-semibold">{t('rules.whoSeesWhat')}</h3>
      {preview.folders.map((f) => (
        <div key={f.path}>
          <p className="mb-1 text-xs font-medium text-muted">{f.path || t('files.root')}</p>
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
            {f.users.map((u) => {
              const changed = u.before !== u.after
              return (
                <li key={u.user.id} className={clsx('flex items-center gap-2 px-3 py-1.5', changed && 'bg-warn-soft')}>
                  <span className="min-w-0 flex-1 truncate">
                    {u.user.name} <span className="text-xs text-faint">{t(`role.${u.role}`)}</span>
                  </span>
                  <span className="text-xs text-muted">{t(`access.${u.before}`)}</span>
                  <ArrowRight size={12} className="text-faint" aria-label={t('rules.becomes')} />
                  <span className={clsx('text-xs font-medium', changed ? 'text-warn' : 'text-muted')}>{t(`access.${u.after}`)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {preview.losing.length > 0 && (
        <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger" role="note">
          <p className="mb-1 font-semibold">{t('rules.losing')}</p>
          <ul className="space-y-0.5">
            {preview.losing.map((l) => (
              <li key={l.user.id}>{t('rules.losingLine', { name: l.user.name, paths: l.paths.join(', '), n: l.chatsReset })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
