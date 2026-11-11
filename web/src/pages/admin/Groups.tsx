// Groups: name, description, members. Folder rules can name a group; deleting a group removes its rules too, and
// switches off the team AI connections only it may use (the confirmation names them).
// Laid out like Members (and the Claude Console): title with the count, one line, New group, a search box, then quiet
// rows (name · members · "…"); Edit and Delete are in the row's "…". The members column starts with their faces
// (FaceStack: at most 3 and "+N"), then the count and the names in words. A phone (below 768 px) has one compact row per
// group (components/CompactRow.tsx): the name, "N members" on the right and "…", the description under it only when
// there is one; the faces and the names are in the group's dialog (docs/DECISIONS.md "Admin and Settings on phones").
// Who may change team skills is on the Team skills page (SkillManagers.tsx), not here: a group's own skills are its
// members' anyway (docs/DECISIONS.md "Group skills").
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Group, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { Button, Field, Modal, confirmDialog, inputCls, useMediaQuery } from '../../components/ui'
import { CompactRow } from '../../components/CompactRow'
import { FaceStack, FACES_SHOWN } from '../../components/FaceStack'
import { useFaceOf } from '../../store/people'
import { useMeStrict } from '../../store/session'
import { AdminPageHeader, CountBadge, Loadable, SearchBox, matches, useAction, useActionOk, useFocusAfterRemove, useLoad } from './common'
import { MemberMenu } from './RowMenu'
import { connectionsOnlyFor, loadConnections } from './ai-assignees'

export default function Groups() {
  const t = useT()
  const locale = useLocale()
  const actOk = useActionOk()
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const connections = useLoad(loadConnections)
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const [query, setQuery] = useState('')
  const q = query.trim().toLocaleLowerCase(locale)
  const focus = useFocusAfterRemove(groups.data, () => document.querySelector<HTMLElement>('[data-testid="group-new"]'))
  const name = (id: string) => users.data?.find((u) => u.id === id)?.name ?? id
  const faceOf = useFaceOf()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const remove = async (g: Group) => {
    // AI connections only this group may use are switched off by the delete (never given to the whole team): named here
    const off = connectionsOnlyFor(connections.data, { subjectType: 'group', subjectId: g.id })
    const body = off.length ? <><p>{t('groups.deleteBody')}</p><p className="mt-2" data-testid="group-delete-ai-off">{t('groups.deleteAiOff', { names: off.join(', ') })}</p></> : t('groups.deleteBody')
    if (!(await confirmDialog({ title: t('groups.deleteTitle', { name: g.name }), body, confirm: t('common.delete'), danger: true }))) return
    if (!(await actOk(() => api.call(API.deleteGroup, { params: { id: g.id } })))) return
    focus.removed(groups.data?.findIndex((x) => x.id === g.id) ?? 0)
    if (off.length) void connections.reload()
    await groups.reload()
  }
  return (
    <>
      <AdminPageHeader
        title={
          <>
            {t('admin.groups')}
            <CountBadge n={groups.data?.length} testId="groups-count" />
          </>
        }
        desc={t('groups.desc')}
        testId="groups-header"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')} data-testid="group-new">
            <Plus size={14} aria-hidden /> {t('groups.new')}
          </Button>
        }
        controls={<SearchBox value={query} onChange={setQuery} label={t('groups.search')} testId="group-search" className="sm:w-80" />}
      />
      <section className="mb-8" aria-label={t('admin.groups')} ref={focus.box}>
        <Loadable state={groups}>
          {(all) => {
            if (!all.length) return <p className="border-y border-line py-6 text-sm text-faint">{t('groups.none')}</p>
            const list = all.filter((g) => matches(q, locale, g.name, g.description))
            if (!list.length)
              return (
                <p className="border-y border-line py-6 text-sm text-faint" data-testid="groups-no-match">
                  {t('groups.noMatch')}
                </p>
              )
            const menu = (g: Group) => (
              <MemberMenu
                name={g.name}
                rowFocus
                items={[
                  { label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(g), testId: 'group-edit' },
                  { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void remove(g), danger: true, testId: 'group-delete' },
                ]}
              />
            )
            if (phone)
              return (
                <ul className="divide-y divide-line border-y border-line" data-testid="group-list">
                  {list.map((g) => (
                    <CompactRow
                      key={g.id}
                      testId="group-row"
                      title={g.name}
                      chip={<span className="px-2 text-sm text-muted tabular-nums" data-testid="group-member-count">{t('groups.memberCount', { n: g.memberIds.length })}</span>}
                      second={g.description && <span className="truncate">{g.description}</span>}
                      menu={menu(g)}
                    />
                  ))}
                </ul>
              )
            return (
              <>
                {/* the column names of the rows below (each row reads on its own, so this is for the eye only) */}
                <div aria-hidden className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_2.5rem] gap-4 border-b border-line py-2.5 text-label font-medium text-muted">
                  <span>{t('auth.name')}</span>
                  <span>{t('groups.members')}</span>
                  <span />
                </div>
                <ul className="divide-y divide-line border-b border-line" data-testid="group-list">
                  {list.map((g) => (
                    <li key={g.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_2.5rem] items-center gap-x-4 gap-y-2 py-3.5 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink">{g.name}</span>
                        {g.description && <span className="block truncate text-xs text-faint">{g.description}</span>}
                      </span>
                      <span className="flex min-w-0 items-center gap-2.5 text-muted">
                        {/* a slot as wide as 3 faces and "+99", so the counts below each other line up */}
                        <span className="flex min-w-20 shrink-0">
                          {g.memberIds.length > 0 && (
                            <FaceStack people={g.memberIds.slice(0, FACES_SHOWN).map((id) => faceOf({ id, name: name(id) }))} count={g.memberIds.length} testId="group" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-label">{t('groups.memberCount', { n: g.memberIds.length })}</span>
                          <span className="block truncate text-xs text-faint">{g.memberIds.map(name).join(', ') || t('groups.noMembers')}</span>
                        </span>
                      </span>
                      <span className="flex justify-end">{menu(g)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )
          }}
        </Loadable>
      </section>
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
  // you first, so adding yourself is the first tick; the rest keep the team's order (by when they joined)
  const meId = useMeStrict().user.id
  // a disabled account is offered only while it is already in the group (to take it out): the server never adds one
  const people = [...users].filter((u) => u.status === 'active' || group?.memberIds.includes(u.id)).sort((a, b) => Number(b.id === meId) - Number(a.id === meId))
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
          <legend className="mb-1.5 text-label font-medium">{t('groups.members')}</legend>
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {people.map((u) => (
              <label key={u.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover" data-testid="group-member">
                <input type="checkbox" checked={memberIds.includes(u.id)} onChange={(e) => setMemberIds(e.target.checked ? [...memberIds, u.id] : memberIds.filter((x) => x !== u.id))} />
                {u.name} <span className="text-xs text-faint">{u.username}</span>
                {u.id === meId && <span className="text-xs text-faint">· {t('groups.you')}</span>}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  )
}
