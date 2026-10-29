// Members and invites. Invites are links (no mail in v1): pick role and groups, copy the link or show its QR code,
// hand it over any way you like; revoke unused ones. Members: role, groups, disable (ends their sessions),
// temporary password reset or a one-time reset link to hand over (both audited; the owner resets only on the server
// Mac), remove.
import { KeyRound, Link2, Plus, QrCode as QrIcon, RefreshCw, Trash2, UserPlus, UserRoundKey } from 'lucide-react'
import { useId, useState } from 'react'
import type { z } from 'zod'
import type { CreatedInvite as CreatedInviteSchema, Group, Invite, Locale, Role, User } from '@mycel/shared/api'
import { TEMP_PASSWORD_TTL_DAYS, tempPasswordCharsOk } from '@mycel/shared'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { chatTrashDays } from '../../lib/chat-trash'
import { newTemporaryPassword } from '../../lib/temp-password'
import { PASSWORD_MIN } from '../Auth'
import { LOCALES, useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import QrCode from '../../components/QrCode'
import { Badge, Button, CopyButton, Field, IconButton, Modal, confirmDialog, inputCls } from '../../components/ui'
import { SkillManagerCell, useSkillManagers } from './SkillManagers'
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
  const skillManagers = useSkillManagers()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  /** a temporary password to hand over, shown once with the sign-in address and the username */
  const [secret, setSecret] = useState<HandoverInfo | null>(null)
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
    if (!(await confirmDialog({ title: t('members.removeTitle', { name: u.name }), body: t('members.removeBody', { days: chatTrashDays(me) }), confirm: t('common.delete'), danger: true }))) return
    await act(async () => {
      await api.call(API.deleteUser, { params: { id: u.id } })
      await users.reload()
    })
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
                    <th className="py-2 pr-3 font-medium">{t('skillMgr.column')}</th>
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
                        {u.mustChangePassword && <TempPasswordBadge user={u} />}
                      </td>
                      <td className="hidden py-2 pr-3 text-xs text-muted md:table-cell">{u.groupIds.map(groupName).join(', ') || '—'}</td>
                      <td className="hidden py-2 pr-3 text-xs text-muted md:table-cell">{u.lastSeenAt ? formatDateTime(u.lastSeenAt, locale) : '—'}</td>
                      <td className="py-2 pr-3">
                        {u.status === 'active' ? (
                          <SkillManagerCell subject={{ type: 'user', id: u.id, name: u.name, always: u.role !== 'member' }} data={skillManagers.data} onChanged={() => void skillManagers.reload()} />
                        ) : (
                          <span className="text-xs text-faint">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        {u.role !== 'owner' && u.id !== me.user.id && (u.role !== 'admin' || isOwner(me)) && (
                          // one line when there is room; on a phone the buttons wrap here instead of scrolling the table sideways
                          <div className="flex flex-wrap items-center justify-end">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                              {t('common.edit')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => resetPassword(u)} data-testid={`reset-password-${u.username}`}>
                              <KeyRound size={14} aria-hidden /> {t('members.reset')}
                            </Button>
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
                          </div>
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
          onCreated={(u, r) => {
            setAddOpen(false)
            setSecret({ name: u.name, username: u.username, ...r })
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
          onDone={(r) => {
            setSecret({ name: resetting.name, username: resetting.username, ...r })
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
 * "Must change password", or why the member cannot sign in with the temporary password any more: voided after too
 * many wrong tries (anyone can try a guessable desk username) or past its 7 days. Either way: reset the password.
 */
function TempPasswordBadge({ user }: { user: User }) {
  const t = useT()
  const locale = useLocale()
  const tp = user.tempPassword
  const [tone, text, help, testId] = tp?.voided
    ? (['danger', t('members.tempVoided'), t('members.tempVoidedHelp'), 'temp-voided'] as const)
    : tp && Date.parse(tp.expiresAt) <= Date.now()
      ? (['danger', t('members.tempExpired'), t('members.tempExpiredHelp'), 'temp-expired'] as const)
      : (['warn', t('members.mustChange'), tp ? t('members.tempUntil', { date: formatDateTime(tp.expiresAt, locale) }) : undefined, 'must-change'] as const)
  return (
    <span className="ml-1" title={help} data-testid={testId}>
      <Badge tone={tone}>{text}</Badge>
    </span>
  )
}

/** A problem with the temporary password the admin typed (empty, too short, spaces or Hangul), or null. */
function tempPasswordProblem(v: string): MessageKey | null {
  if (!v) return 'members.tempPasswordEmpty'
  if (!tempPasswordCharsOk(v)) return 'members.tempPasswordChars'
  if ([...v].length < PASSWORD_MIN) return 'auth.passwordRule'
  if (v.length > 128) return 'members.tempPasswordLong'
  return null
}

/**
 * A server refusal shown inside the dialog (under the temporary password field when it is about that field), not as a
 * toast far from the field that stays up after the dialog succeeds. Cleared on the next try and on success.
 */
function useDialogError() {
  const t = useT()
  const locale = useLocale()
  const [error, setError] = useState<{ text: string; tempPassword: boolean } | null>(null)
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError({ text: errorText(e, locale, t('error.network')), tempPassword: isApiError(e, 'validation') && !!e.body.fields?.['body.temporaryPassword'] })
      return undefined
    }
  }
  return { error, clear: () => setError(null), run }
}

/**
 * The temporary password an admin hands over: pre-filled with a memorable one ("tiger4271"), editable, ↻ for another,
 * copy. Spaces are dropped as typed (they would be invisible on the hand-over screen); Hangul and other non-ASCII
 * characters are refused with a hint about the 한/영 key. The server checks it like any new password (8+ characters,
 * not the username, not a common one) and the same characters rule.
 */
function TempPasswordField({ value, onChange, serverError, hint }: { value: string; onChange: (v: string) => void; serverError?: string | null; hint: string }) {
  const t = useT()
  const id = useId()
  const problem = tempPasswordProblem(value)
  const error = problem ? t(problem) : serverError ?? null
  return (
    <div>
      <label htmlFor={`${id}-input`} className="mb-1.5 block text-[13px] font-medium text-ink">
        {t('members.tempPassword')}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={`${id}-input`}
          className={`${inputCls} font-mono`}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\s+/g, ''))}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={128}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-note`}
          data-testid="temp-password"
        />
        <IconButton label={t('members.tempPasswordAnother')} onClick={() => onChange(newTemporaryPassword())} data-testid="temp-password-new">
          <RefreshCw size={15} />
        </IconButton>
        <CopyButton text={value} className="p-2" />
      </div>
      {error ? (
        <span id={`${id}-note`} role="alert" className="mt-1 block text-xs text-danger" data-testid="temp-password-error">
          {error}
        </span>
      ) : (
        <span id={`${id}-note`} className="mt-1 block text-xs text-faint">
          {hint}
        </span>
      )}
    </div>
  )
}

/** A refusal that is not about the temporary password (e.g. the username is taken), at the bottom of the dialog. */
function DialogError({ error }: { error: { text: string; tempPassword: boolean } | null }) {
  if (!error || error.tempPassword) return null
  return (
    <p role="alert" className="text-sm text-danger" data-testid="dialog-error">
      {error.text}
    </p>
  )
}

/** What the admin hands over once: where to sign in, the username, the temporary password and until when it works. */
export interface HandoverInfo { name: string; username: string; password: string; expiresAt: string; signInUrl: string }

/** Shown once after "add member" / "reset password": the sign-in address, username and temporary password. */
function Handover({ name, username, password, expiresAt, signInUrl, onClose }: HandoverInfo & { onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const date = formatDateTime(expiresAt, locale)
  const text = t('members.handoverText', { url: signInUrl, username, password, date })
  return (
    <Modal open onClose={onClose} title={t('members.handoverFor', { name })} footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
      <div className="space-y-3" data-testid="handover">
        <SecretBox label={t('members.handoverUrl')} value={signInUrl} testId="handover-url" />
        <SecretBox label={t('auth.username')} value={username} testId="handover-username" large />
        <SecretBox label={t('members.tempPassword')} value={password} testId="handover-password" large />
        <p className="text-xs text-warn" data-testid="handover-note">
          {t('members.tempPasswordNote', { date })}
        </p>
      </div>
      <div className="mt-3">
        <CopyButton text={text} label={t('members.handoverCopy')} showLabel className="border border-line" />
      </div>
    </Modal>
  )
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (r: { password: string; expiresAt: string; signInUrl: string }) => void }) {
  const t = useT()
  const { error, clear, run } = useDialogError()
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
            disabled={!!tempPasswordProblem(pw)}
            data-testid="reset-temp-submit"
            onClick={async () => {
              setBusy(true)
              const r = await run(() => api.call(API.resetPassword, { params: { id: user.id }, body: { temporaryPassword: pw } }))
              setBusy(false)
              if (r) onDone({ password: r.temporaryPassword, expiresAt: r.expiresAt ?? inTempTtl(), signInUrl: r.signInUrl ?? location.origin })
            }}
          >
            {t('members.resetSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('members.resetBody', { name: user.name })}</p>
        <TempPasswordField
          value={pw}
          onChange={(v) => {
            setPw(v)
            clear()
          }}
          serverError={error?.tempPassword ? error.text : null}
          hint={t('members.resetHint')}
        />
        <DialogError error={error} />
      </div>
    </Modal>
  )
}

/** When a temporary password set now stops working (the server's answer is used when it gives one). */
const inTempTtl = () => new Date(Date.now() + TEMP_PASSWORD_TTL_DAYS * 24 * 3600_000).toISOString()

function AddMember({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: (user: User, r: { password: string; expiresAt: string; signInUrl: string }) => void }) {
  const t = useT()
  const { error, clear, run } = useDialogError()
  const me = useMeStrict()
  const [f, setF] = useState(() => ({ name: '', username: '', email: '', role: 'member' as MemberRole, groupIds: [] as string[], password: newTemporaryPassword() }))
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch })
    clear()
  }
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
            disabled={!f.name.trim() || !f.username.trim() || !!tempPasswordProblem(f.password)}
            data-testid="add-member-submit"
            onClick={async () => {
              setBusy(true)
              const r = await run(() => api.call(API.createUser, { body: { name: f.name.trim(), username: f.username.trim(), email: f.email.trim() || null, role: f.role, groupIds: f.groupIds, temporaryPassword: f.password } }))
              setBusy(false)
              if (r) onCreated(r.user, { password: r.temporaryPassword, expiresAt: r.expiresAt ?? inTempTtl(), signInUrl: r.signInUrl ?? location.origin })
            }}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('auth.name')}>
          <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} data-autofocus data-testid="add-member-name" />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')}>
          <input className={inputCls} value={f.username} onChange={(e) => set({ username: e.target.value })} autoCapitalize="none" data-testid="add-member-username" />
        </Field>
        <TempPasswordField value={f.password} onChange={(password) => set({ password })} serverError={error?.tempPassword ? error.text : null} hint={t('members.tempPasswordHint')} />
        <Field label={t('settings.email')}>
          <input className={inputCls} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label={t('members.role')}>
          <RoleSelect value={f.role} onChange={(role) => set({ role })} disabled={!isOwner(me)} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={f.groupIds} onChange={(groupIds) => set({ groupIds })} />
        </div>
        <DialogError error={error} />
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

