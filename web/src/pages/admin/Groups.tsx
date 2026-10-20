// Groups: name, description, members. Folder rules can name a group; deleting a group removes its rules too.
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Group, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { Button, Field, IconButton, Modal, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'

export default function Groups() {
  const t = useT()
  const act = useAction()
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const name = (id: string) => users.data?.find((u) => u.id === id)?.name ?? id
  const remove = async (g: Group) => {
    if (!(await confirmDialog({ title: t('groups.deleteTitle', { name: g.name }), body: t('groups.deleteBody'), confirm: t('common.delete'), danger: true }))) return
    if ((await act(() => api.call(API.deleteGroup, { params: { id: g.id } }))) !== undefined) void groups.reload()
  }
  return (
    <>
      <Card
        title={t('admin.groups')}
        desc={t('groups.desc')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')} data-testid="group-new">
            <Plus size={14} aria-hidden /> {t('groups.new')}
          </Button>
        }
      >
        <Loadable state={groups}>
          {(list) =>
            !list.length ? (
              <p className="text-sm text-faint">{t('groups.none')}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="group-list">
                {list.map((g) => (
                  <li key={g.id} className="flex items-start gap-3 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{g.name}</span>
                      {g.description && <span className="block text-xs text-muted">{g.description}</span>}
                      <span className="block text-xs text-faint">{g.memberIds.map(name).join(', ') || t('groups.noMembers')}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                      {t('common.edit')}
                    </Button>
                    <IconButton label={t('common.delete')} onClick={() => remove(g)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>
      {editing && (
        <GroupForm
          group={editing === 'new' ? null : editing}
          users={users.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void groups.reload()
          }}
        />
      )}
    </>
  )
}

function GroupForm({ group, users, onClose, onSaved }: { group: Group | null; users: User[]; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? [])
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const body = { name: name.trim(), description: description.trim() || null, memberIds }
    const r = await act(() => (group ? api.call(API.updateGroup, { params: { id: group.id }, body }) : api.call(API.createGroup, { body })))
    setBusy(false)
    if (r) onSaved()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? t('groups.edit') : t('groups.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={save} data-testid="group-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('groups.name')}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus data-testid="group-name" />
        </Field>
        <Field label={t('groups.description')}>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">{t('groups.members')}</legend>
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover">
                <input type="checkbox" checked={memberIds.includes(u.id)} onChange={(e) => setMemberIds(e.target.checked ? [...memberIds, u.id] : memberIds.filter((x) => x !== u.id))} />
                {u.name} <span className="text-xs text-faint">{u.username}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  )
}
