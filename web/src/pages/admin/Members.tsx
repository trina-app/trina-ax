// Members and invites. Invites are links (no mail in v1): pick role and groups, copy the link or show its QR code,
// hand it over any way you like; revoke unused ones. Members: role, groups, disable (ends their sessions),
// temporary password reset (audited), remove.
import { KeyRound, Link2, Plus, QrCode as QrIcon, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import type { z } from 'zod'
import type { CreatedInvite as CreatedInviteSchema, Group, Invite, Role, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import QrCode from '../../components/QrCode'
import { Badge, Button, CopyButton, Field, IconButton, Modal, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, SecretBox, useAction, useLoad } from './common'

type MemberRole = Exclude<Role, 'owner'>
type CreatedInvite = z.infer<typeof CreatedInviteSchema>

export default function Members() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const act = useAction()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const invites = useLoad(async () => (await api.call(API.listInvites)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null)
  const [editing, setEditing] = useState<User | null>(null)

  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? '?'

  const resetPassword = async (u: User) => {
    if (!(await confirmDialog({ title: t('members.resetTitle', { name: u.name }), body: t('members.resetBody'), confirm: t('members.reset') }))) return
    const r = await act(() => api.call(API.resetPassword, { params: { id: u.id } }))
    if (r) setSecret({ title: t('members.tempPasswordFor', { name: u.name }), value: r.temporaryPassword })
  }
  const toggleDisabled = async (u: User) => {
    const disabling = u.status === 'active'
    if (disabling && !(await confirmDialog({ title: t('members.disableTitle', { name: u.name }), body: t('members.disableBody'), confirm: t('members.disable'), danger: true }))) return
    if (await act(() => api.call(API.updateUser, { params: { id: u.id }, body: { status: disabling ? 'disabled' : 'active' } }))) void users.reload()
  }
  const remove = async (u: User) => {
    if (!(await confirmDialog({ title: t('members.removeTitle', { name: u.name }), body: t('members.removeBody', { id: u.id }), confirm: t('common.delete'), danger: true }))) return
    if ((await act(() => api.call(API.deleteUser, { params: { id: u.id } }))) !== undefined) void users.reload()
  }
  const revoke = async (i: Invite) => {
    if ((await act(() => api.call(API.revokeInvite, { params: { id: i.id } }))) !== undefined) void invites.reload()
  }

  return (
    <>
      <Card
        title={t('members.title')}
        actions={
          <>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <UserPlus size={14} aria-hidden /> {t('members.add')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)} data-testid="invite-new">
              <Link2 size={14} aria-hidden /> {t('members.invite')}
            </Button>
          </>
        }
      >
        <Loadable state={users}>
          {(list) => (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="members-table">
                <thead>
                  <tr className="text-left text-xs text-faint">
                    <th className="py-2 pr-3 font-medium">{t('auth.name')}</th>
                    <th className="py-2 pr-3 font-medium">{t('members.role')}</th>
                    <th className="hidden py-2 pr-3 font-medium md:table-cell">{t('admin.groups')}</th>
                    <th className="hidden py-2 pr-3 font-medium md:table-cell">{t('members.lastSeen')}</th>
                    <th className="py-2">
                      <span className="sr-only">{t('files.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((u) => (
                    <tr key={u.id} className={u.status === 'disabled' ? 'opacity-60' : ''}>
                      <td className="py-2 pr-3">
                        <span className="block font-medium">{u.name}</span>
                        <span className="block text-xs text-faint">
                          {u.username} · users/{u.id}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={u.role === 'member' ? 'neutral' : 'accent'}>{t(`role.${u.role}`)}</Badge>
                        {u.status === 'disabled' && <Badge tone="danger" className="ml-1">{t('members.disabled')}</Badge>}
                        {u.mustChangePassword && <Badge tone="warn" className="ml-1">{t('members.mustChange')}</Badge>}
                      </td>
                      <td className="hidden py-2 pr-3 text-xs text-muted md:table-cell">{u.groupIds.map(groupName).join(', ') || '—'}</td>
                      <td className="hidden py-2 pr-3 text-xs text-muted md:table-cell">{u.lastSeenAt ? formatDateTime(u.lastSeenAt, locale) : '—'}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {u.role !== 'owner' && u.id !== me.user.id && (u.role !== 'admin' || isOwner(me)) && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                              {t('common.edit')}
                            </Button>
                            <IconButton label={t('members.reset')} onClick={() => resetPassword(u)}>
                              <KeyRound size={15} />
                            </IconButton>
                            <Button size="sm" variant="ghost" onClick={() => toggleDisabled(u)}>
                              {u.status === 'active' ? t('members.disable') : t('members.enable')}
                            </Button>
                            <IconButton label={t('common.delete')} onClick={() => remove(u)}>
                              <Trash2 size={15} />
                            </IconButton>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </Card>

      <Card title={t('members.invites')} desc={t('members.invitesDesc')}>
        <Loadable state={invites}>
          {(list) =>
            !list.length ? (
              <p className="text-sm text-faint">{t('members.noInvites')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="invite-list">
                {list.map((i) => {
                  const expired = Date.parse(i.expiresAt) < Date.now()
                  return (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Badge>{t(`role.${i.role}`)}</Badge>
                      <span className="min-w-0 flex-1 text-xs text-muted">
                        {i.groupIds.map(groupName).join(', ') || t('members.noGroups')} · {i.usedAt ? t('members.usedBy', { name: i.usedBy?.name ?? '?' }) : expired ? t('members.expired') : t('members.expires', { date: formatDateTime(i.expiresAt, locale) })}
                      </span>
                      {!i.usedAt && !expired && (
                        <Button size="sm" variant="ghost" onClick={() => revoke(i)}>
                          {t('members.revoke')}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )
          }
        </Loadable>
      </Card>

      {inviteOpen && (
        <InviteDialog
          groups={groups.data ?? []}
          onClose={() => setInviteOpen(false)}
          onCreated={(c) => {
            setInviteOpen(false)
            setCreated(c)
            void invites.reload()
          }}
        />
      )}
      {created && <InviteCreated invite={created} onClose={() => setCreated(null)} />}
      {addOpen && (
        <AddMember
          groups={groups.data ?? []}
          onClose={() => setAddOpen(false)}
          onCreated={(name, pw) => {
            setAddOpen(false)
            setSecret({ title: t('members.tempPasswordFor', { name }), value: pw })
            void users.reload()
          }}
        />
      )}
      {editing && (
        <EditMember
          user={editing}
          groups={groups.data ?? []}
          canChangeRole={isOwner(me)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void users.reload()
          }}
        />
      )}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title={secret.title} footer={<Button variant="primary" onClick={() => setSecret(null)}>{t('common.done')}</Button>}>
          <SecretBox label={t('members.tempPassword')} value={secret.value} note={t('members.tempPasswordNote')} />
          <div className="mt-2">
            <CopyButton text={secret.value} showLabel />
          </div>
        </Modal>
      )}
    </>
  )
}

function GroupChecks({ groups, value, onChange }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void }) {
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

function RoleSelect({ value, onChange, disabled }: { value: MemberRole; onChange: (r: MemberRole) => void; disabled?: boolean }) {
  const t = useT()
  return (
    <select className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as MemberRole)}>
      <option value="member">{t('role.member')}</option>
      <option value="admin">{t('role.admin')}</option>
    </select>
  )
}

function InviteDialog({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: (c: CreatedInvite) => void }) {
  const t = useT()
  const act = useAction()
  const me = useMeStrict()
  const [role, setRole] = useState<MemberRole>('member')
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [days, setDays] = useState(7)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('members.invite')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            data-testid="invite-create"
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.createInvite, { body: { role, groupIds, expiresInHours: days * 24 } }))
              setBusy(false)
              if (r) onCreated(r)
            }}
          >
            <Plus size={14} aria-hidden /> {t('members.createLink')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('members.role')}>
          <RoleSelect value={role} onChange={setRole} disabled={!isOwner(me)} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
        <Field label={t('members.validDays')}>
          <select className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {t('members.days', { n: d })}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">{t('members.inviteNote')}</p>
      </div>
    </Modal>
  )
}

function InviteCreated({ invite, onClose }: { invite: CreatedInvite; onClose: () => void }) {
  const t = useT()
  const [qr, setQr] = useState(false)
  const url = /^https?:\/\//.test(invite.url) ? invite.url : `${location.origin}${invite.url.startsWith('/') ? '' : '/'}${invite.url}`
  return (
    <Modal open onClose={onClose} title={t('members.inviteReady')} footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
      <SecretBox label={t('members.inviteLink')} value={url} note={t('members.inviteLinkNote')} />
      <div className="mt-3 flex gap-2">
        <CopyButton text={url} label={t('members.copyLink')} showLabel className="border border-line" />
        <Button size="sm" variant="ghost" onClick={() => setQr((v) => !v)}>
          <QrIcon size={14} aria-hidden /> {t('members.qr')}
        </Button>
      </div>
      {qr && (
        <div className="mt-4 flex justify-center">
          <QrCode text={url} label={t('members.qr')} />
        </div>
      )}
    </Modal>
  )
}

function AddMember({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: (name: string, pw: string) => void }) {
  const t = useT()
  const act = useAction()
  const me = useMeStrict()
  const [f, setF] = useState({ name: '', username: '', email: '', role: 'member' as MemberRole, groupIds: [] as string[] })
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('members.add')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!f.name.trim() || !f.username.trim()}
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.createUser, { body: { name: f.name.trim(), username: f.username.trim(), email: f.email.trim() || null, role: f.role, groupIds: f.groupIds } }))
              setBusy(false)
              if (r) onCreated(r.user.name, r.temporaryPassword)
            }}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('auth.name')}>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')}>
          <input className={inputCls} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" />
        </Field>
        <Field label={t('settings.email')}>
          <input className={inputCls} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label={t('members.role')}>
          <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} disabled={!isOwner(me)} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={f.groupIds} onChange={(groupIds) => setF({ ...f, groupIds })} />
        </div>
      </div>
    </Modal>
  )
}

function EditMember({ user, groups, canChangeRole, onClose, onSaved }: { user: User; groups: Group[]; canChangeRole: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [name, setName] = useState(user.name)
  const [role, setRole] = useState<MemberRole>(user.role === 'owner' ? 'admin' : user.role)
  const [groupIds, setGroupIds] = useState(user.groupIds)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('members.editTitle', { name: user.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.updateUser, { params: { id: user.id }, body: { name: name.trim(), groupIds, ...(canChangeRole ? { role } : {}) } }))
              setBusy(false)
              if (r) onSaved()
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('auth.name')}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('members.role')} hint={canChangeRole ? undefined : t('members.ownerChangesAdmins')}>
          <RoleSelect value={role} onChange={setRole} disabled={!canChangeRole} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
      </div>
    </Modal>
  )
}

