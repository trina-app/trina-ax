// Folder permissions (tab 2): folders that carry rules, each rule = who (everyone / role / group / person) gets
// none / read / write. Before saving, "who sees what" shows every active person's access before → after, and who
// loses access (their chats that touched those folders get a fresh engine session).
import clsx from 'clsx'
import { ArrowRight, Eye, FolderLock, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Access, Folder, FolderRuleInput, Group, PreviewResponse, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import FolderPicker from '../../components/FolderPicker'
import { Badge, Button, IconButton, Modal, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'

/** skills/ and its folders: write there = "팀 스킬 관리" (the Members / Groups toggle is the same rule) */
const isSkillsFolder = (p: string) => p === 'skills' || p.startsWith('skills/')

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

export default function Folders() {
  const t = useT()
  const act = useAction()
  const folders = useLoad(async () => (await api.call(API.listFolders)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [editing, setEditing] = useState<{ folder: Folder | null; path: string } | null>(null)
  const [picking, setPicking] = useState(false)

  const subject = (type: string, id: string | null) => {
    if (type === 'everyone') return t('rules.everyone')
    if (type === 'role') return t('rules.roleOf', { role: t(id === 'admin' ? 'role.admin' : 'role.member') })
    if (type === 'group') return t('rules.groupOf', { name: groups.data?.find((g) => g.id === id)?.name ?? '?' })
    return users.data?.find((u) => u.id === id)?.name ?? id ?? '?'
  }
  const remove = async (f: Folder) => {
    if (!(await confirmDialog({ title: t('rules.removeTitle', { path: f.path || t('files.root') }), body: t('rules.removeBody'), confirm: t('common.delete'), danger: true }))) return
    if ((await act(() => api.call(API.deleteFolder, { params: { id: f.id } }))) !== undefined) void folders.reload()
  }

  return (
    <>
      <Card
        title={t('admin.folders')}
        desc={t('rules.desc')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setPicking(true)} data-testid="folder-rule-new">
            <Plus size={14} aria-hidden /> {t('rules.addFolder')}
          </Button>
        }
      >
        <Loadable state={folders}>
          {(list) =>
            !list.length ? (
              <p className="text-sm text-faint">{t('rules.none')}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="folder-list">
                {[...list].sort((a, b) => a.path.localeCompare(b.path)).map((f) => (
                  <li key={f.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                    <FolderLock size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{f.path || t('files.root')}</span>
                      {!f.exists && <Badge tone="warn">{t('rules.missingOnDisk')}</Badge>}
                      <span className="mt-1 flex flex-wrap gap-1">
                        {f.rules.map((r) => (
                          <Badge key={r.id} tone={r.access === 'write' ? 'accent' : r.access === 'read' ? 'neutral' : 'danger'}>
                            {subject(r.subjectType, r.subjectId)}: {t(`access.${r.access}`)}
                            {isSkillsFolder(f.path) && r.access === 'write' && (r.subjectType === 'user' || r.subjectType === 'group') && <span data-testid="skill-manager-badge"> · {t('skillMgr.ruleBadge')}</span>}
                          </Badge>
                        ))}
                      </span>
                      {isSkillsFolder(f.path) && <span className="mt-1 block text-xs text-muted">{t('skillMgr.folderHint')}</span>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ folder: f, path: f.path })}>
                      {t('common.edit')}
                    </Button>
                    <IconButton label={t('common.delete')} onClick={() => remove(f)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>
      <FolderPicker
        open={picking}
        title={t('rules.addFolder')}
        confirmLabel={t('common.choose')}
        needWrite={false}
        onClose={() => setPicking(false)}
        onPick={(path) => {
          setPicking(false)
          const existing = folders.data?.find((f) => f.path === path) ?? null
          setEditing({ folder: existing, path })
        }}
      />
      {editing && (
        <RulesEditor
          folder={editing.folder}
          path={editing.path}
          users={users.data ?? []}
          groups={groups.data ?? []}
          subject={subject}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void folders.reload()
          }}
        />
      )}
    </>
  )
}

function RulesEditor({ folder, path, users, groups, subject, onClose, onSaved }: { folder: Folder | null; path: string; users: User[]; groups: Group[]; subject: (type: string, id: string | null) => string; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [rows, setRows] = useState<RuleRow[]>(folder?.rules.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access })) ?? [])
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const rules = rulesFromRows(rows)
  const set = (i: number, patch: Partial<RuleRow>) => {
    setPreview(null)
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
    const r = await act(() => (folder ? api.call(API.putFolderRules, { params: { id: folder.id }, body: { rules } }) : api.call(API.createFolder, { body: { path, create: true, rules } })), t('common.saved'))
    setBusy(null)
    if (r) onSaved()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rules.editTitle', { path: path || t('files.root') })}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={runPreview} busy={busy === 'preview'} disabled={!rules} data-testid="rules-preview">
            <Eye size={14} aria-hidden /> {t('rules.preview')}
          </Button>
          <Button variant="primary" onClick={save} busy={busy === 'save'} disabled={!rules} data-testid="rules-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">{t('rules.editHint')}</p>
      {isSkillsFolder(path) && (
        <p role="note" className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="skill-folder-warning">
          {t('skillMgr.folderHint')}
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
                    setPreview(null)
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
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setRows((r) => [...r, { subjectType: 'group', subjectId: groups[0]?.id ?? null, access: 'read' }])} data-testid="rule-add">
        <Plus size={14} aria-hidden /> {t('rules.addRule')}
      </Button>
      {!rules && rows.length > 0 && <p className="mt-2 text-xs text-warn">{t('rules.incomplete')}</p>}
      {preview && <PreviewTable preview={preview} subject={subject} />}
    </Modal>
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
