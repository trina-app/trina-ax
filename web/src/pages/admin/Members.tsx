// Members and invites. Invites are links (no mail in v1): pick role and groups, copy the link or show its QR code,
// hand it over any way you like; revoke unused ones. Members: role, groups, disable (ends their sessions),
// temporary password reset or a one-time reset link to hand over (both audited; the owner resets only on the server
// Mac), remove.
import { KeyRound, Link2, Plus, QrCode as QrIcon, RefreshCw, Trash2, UserPlus, UserRoundKey } from 'lucide-react'
import { useState } from 'react'
import type { z } from 'zod'
import type { CreatedInvite as CreatedInviteSchema, Group, Invite, Locale, Role, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { newTemporaryPassword } from '../../lib/temp-password'
import { PASSWORD_MIN } from '../Auth'
import { LOCALES, useLocale, useT } from '../../i18n'
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
  /** a temporary password to hand over, shown once with the username */
  const [secret, setSecret] = useState<{ name: string; username: string; password: string } | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const [resetLink, setResetLink] = useState<{ name: string; url: string; expiresAt: string } | null>(null)
  const [editing, setEditing] = useState<User | null>(null)

  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? '?'

  const resetPassword = (u: User) => setResetting(u)
  /** One-time link (24 h) the person opens to choose a new password; no email, the admin hands it over. */
  const createResetLink = async (u: User) => {
    if (!(await confirmDialog({ title: t('members.resetLinkConfirm', { name: u.name }), body: t('members.resetLinkBody'), confirm: t('members.resetLinkCreate') }))) return
    const r = await act(() => api.call(API.createResetLink, { params: { id: u.id } }))
    if (r) setResetLink({ name: u.name, url: /^https?:\/\//.test(r.url) ? r.url : `${location.origin}${r.url.startsWith('/') ? '' : '/'}${r.url}`, expiresAt: r.expiresAt })
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
                            <IconButton label={t('members.resetLinkButton')} onClick={() => createResetLink(u)} data-testid={`reset-link-${u.username}`}>
                              <UserRoundKey size={15} />
                            </IconButton>
                            <Button size="sm" variant="ghost" onClick={() => toggleDisabled(u)}>
                              {u.status === 'active' ? t('members.disable') : t('members.enable')}
                            </Button>
                            {isOwner(me) && (
                              <IconButton label={t('common.delete')} onClick={() => remove(u)}>
                                <Trash2 size={15} />
                              </IconButton>
                            )}
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
          onCreated={(u, password) => {
            setAddOpen(false)
            setSecret({ name: u.name, username: u.username, password })
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
      {resetLink && (
        <Modal open onClose={() => setResetLink(null)} title={t('members.resetLinkFor', { name: resetLink.name })} footer={<Button variant="primary" onClick={() => setResetLink(null)}>{t('common.done')}</Button>}>
          <SecretBox label={t('members.resetLink')} value={resetLink.url} note={t('members.resetLinkNote', { date: formatDateTime(resetLink.expiresAt, locale) })} />
          <div className="mt-3">
            <CopyButton text={resetLink.url} label={t('members.copyLink')} showLabel className="border border-line" />
          </div>
        </Modal>
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            setSecret({ name: resetting.name, username: resetting.username, password })
            setResetting(null)
            void users.reload()
          }}
        />
      )}
      {secret && <Handover {...secret} onClose={() => setSecret(null)} />}
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

/**
 * The temporary password an admin hands over: pre-filled with a memorable one ("tiger427"), editable, ↻ for another,
 * copy. The server checks it like any new password (8+ characters, not the username, not a common one).
 */
function TempPasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  const short = value.length > 0 && [...value].length < PASSWORD_MIN
  return (
    <Field label={t('members.tempPassword')} hint={t('members.tempPasswordHint')} error={short ? t('auth.passwordRule') : null}>
      <div className="flex items-center gap-1">
        <input className={`${inputCls} font-mono`} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} data-testid="temp-password" />
        <IconButton label={t('members.tempPasswordAnother')} onClick={() => onChange(newTemporaryPassword())} data-testid="temp-password-new">
          <RefreshCw size={15} />
        </IconButton>
        <CopyButton text={value} className="p-2" />
      </div>
    </Field>
  )
}

const tempPasswordOk = (v: string) => [...v].length >= PASSWORD_MIN && v.length <= 128

/** Shown once after "add member" / "reset password": the username and temporary password to hand over. */
function Handover({ name, username, password, onClose }: { name: string; username: string; password: string; onClose: () => void }) {
  const t = useT()
  return (
    <Modal open onClose={onClose} title={t('members.handoverFor', { name })} footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
      <div className="space-y-3" data-testid="handover">
        <SecretBox label={t('auth.username')} value={username} testId="handover-username" />
        <SecretBox label={t('members.tempPassword')} value={password} note={t('members.tempPasswordNote')} />
      </div>
      <div className="mt-3">
        <CopyButton text={t('members.handoverText', { username, password })} label={t('members.handoverCopy')} showLabel className="border border-line" />
      </div>
    </Modal>
  )
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (password: string) => void }) {
  const t = useT()
  const act = useAction()
  const [pw, setPw] = useState(newTemporaryPassword)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('members.resetTitle', { name: user.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!tempPasswordOk(pw)}
            data-testid="reset-temp-submit"
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.resetPassword, { params: { id: user.id }, body: { temporaryPassword: pw } }))
              setBusy(false)
              if (r) onDone(r.temporaryPassword)
            }}
          >
            {t('members.resetSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('members.resetBody')}</p>
        <TempPasswordField value={pw} onChange={setPw} />
      </div>
    </Modal>
  )
}

function AddMember({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: (user: User, pw: string) => void }) {
  const t = useT()
  const act = useAction()
  const me = useMeStrict()
  const [f, setF] = useState(() => ({ name: '', username: '', email: '', role: 'member' as MemberRole, groupIds: [] as string[], password: newTemporaryPassword() }))
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
            disabled={!f.name.trim() || !f.username.trim() || !tempPasswordOk(f.password)}
            data-testid="add-member-submit"
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.createUser, { body: { name: f.name.trim(), username: f.username.trim(), email: f.email.trim() || null, role: f.role, groupIds: f.groupIds, temporaryPassword: f.password } }))
              setBusy(false)
              if (r) onCreated(r.user, r.temporaryPassword)
            }}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('auth.name')}>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus data-testid="add-member-name" />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')}>
          <input className={inputCls} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" data-testid="add-member-username" />
        </Field>
        <TempPasswordField value={f.password} onChange={(password) => setF({ ...f, password })} />
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
  // '' = follows the team default (null on the wire)
  const [language, setLanguage] = useState<Locale | ''>(user.localeChoice ?? '')
  const teamDefault = useMeStrict().team.defaultLocale
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
              const r = await act(() => api.call(API.updateUser, { params: { id: user.id }, body: { name: name.trim(), groupIds, ...(canChangeRole ? { role } : {}), ...(language !== (user.localeChoice ?? '') ? { locale: language || null } : {}) } }))
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
        <Field label={t('settings.language')}>
          <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value as Locale | '')} data-testid="member-locale">
            <option value="">{t('settings.languageTeam', { language: LOCALES.find((l) => l.id === teamDefault)?.label ?? teamDefault })}</option>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id} lang={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
      </div>
    </Modal>
  )
}

