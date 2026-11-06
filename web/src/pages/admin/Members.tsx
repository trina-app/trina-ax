// Members and invites. Invites are links (no mail in v1): pick role and groups, copy the link or show its QR code,
// hand it over any way you like; revoke unused ones. The team invite link (components/onboarding/TeamLinkPanel.tsx) is
// one link for many people, members only, with a ready-made message for KakaoTalk or Slack. Members: role, groups, disable (ends their sessions),
// temporary password reset or a one-time reset link to hand over (both audited; the owner resets only on the server
// Mac), remove. Each person links to the folders they see (Folder permissions › By person); the invite and add dialogs
// preview the folders someone new with that role and those groups will see.
//
// Laid out like the Claude Console's Members: title with the count, one line, Invite on the right, then a search box
// and a Role filter, then a quiet table (name · username · role · skills switch · "…"). The owner changes a role right
// in the row; every other action, and "Folders they see", is in the row's "…". Below the md width each member is a
// stacked row with the same parts. Invites (the team link and the invite links) stay under the table.
// The owner sees who asked for their account to be deleted (Settings › Profile › 계정 삭제 요청): a badge. Removing
// that person works as for anyone: their personal files go to the owner's archive. The owner's inbox entry opens
// /admin/members?member=<id>: that person's row is marked and scrolled to.
import { FolderLock, KeyRound, Link2, Pencil, Plus, QrCode as QrIcon, RefreshCw, Trash2, UserPlus, UserRoundKey, UserRoundX, UserRoundCheck } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useId, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { z } from 'zod'
import type { CreatedInvite as CreatedInviteSchema, Group, Invite, Locale, User } from '@mycel/shared/api'
import { TEMP_PASSWORD_TTL_DAYS, tempPasswordCharsOk } from '@mycel/shared'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { chatTrashDays } from '../../lib/chat-trash'
import { newTemporaryPassword } from '../../lib/temp-password'
import { PASSWORD_MIN } from '../Auth'
import { toast } from '../../store/ui'
import { LOCALES, useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import QrCode from '../../components/QrCode'
import { Badge, Button, CopyButton, Field, IconButton, Modal, confirmDialog, inputCls, noKeyRepeat, useMediaQuery } from '../../components/ui'
import { SkillManagerCell, skillsVia, useFolderPeople, useSkillManagers } from './SkillManagers'
import { AdminPageHeader, Card, CountBadge, Loadable, OneLine, SearchBox, SecretBox, matches, useAction, useActionOk, useFocusAfterRemove, useLoad, useOneAtATime } from './common'
import { FilterPill } from '../../components/usage/FilterPill'
import { MemberMenu, type MemberMenuItem } from './RowMenu'
import { GroupChecks, RoleSelect, type MemberRole } from './people-choices'
import { NewPersonPreview, personViewLink } from './AccessResults'
import { TeamLinkDialog } from '../../components/onboarding/TeamLinkPanel'

// the row menu lives in RowMenu.tsx (Groups uses it too); importers of Members keep working
export { MemberMenu, type MemberMenuItem }

type CreatedInvite = z.infer<typeof CreatedInviteSchema>

export default function Members() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const act = useAction()
  const actOk = useActionOk()
  // the members and who cannot use AI now ("No AI": no AI connection of their own and none of the team's for them)
  const users = useLoad(() => api.call(API.listUsers, { query: { noAi: '1' } }))
  const invites = useLoad(async () => (await api.call(API.listInvites)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const skillManagers = useSkillManagers()
  // who writes in skills/ through a group's rule or everyone's: their switch is on, and says why
  const skillsAccess = useFolderPeople('skills', users.data, skillManagers.data)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  /** a temporary password to hand over, shown once with the sign-in address and the username */
  const [secret, setSecret] = useState<HandoverInfo | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const [resetLink, setResetLink] = useState<{ name: string; url: string; expiresAt: string } | null>(null)
  const [editing, setEditing] = useState<User | null>(null)
  // the person an inbox entry points at (?member=<id>): marked, and scrolled to once
  const focusId = useSearchParams()[0].get('member')
  const scrolled = useRef<string | null>(null)
  const focusRow = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current === focusId) return
    scrolled.current = focusId
    el.scrollIntoView?.({ block: 'center' })
  }, [focusId])
  /** asked for their account to be deleted (the owner's list only) */
  const requested = (u: User) => !!users.data?.deletionRequested?.includes(u.id)
  const navigate = useNavigate()
  // the team invite link: made and managed in a popup (TeamLinkDialog); the page lists it under the members
  const teamLink = useLoad(() => api.call(API.getTeamLink))
  const [teamLinkOpen, setTeamLinkOpen] = useState(false)
  const revokeTeamLink = async () => {
    if (!(await confirmDialog({ title: t('teamLink.revokeTitle'), body: t('teamLink.revokeBody'), confirm: t('teamLink.revoke'), danger: true }))) return
    if (await actOk(() => api.call(API.revokeTeamLink))) await teamLink.reload()
  }

  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? '?'
  // a phone: one card per member instead of a squeezed table (the same query as Tailwind's md)
  const phone = useMediaQuery('(max-width: 767.98px)')
  /** the owner and yourself have no actions here; an admin is managed by the owner only */
  const canManage = (u: User) => u.role !== 'owner' && u.id !== me.user.id && (u.role !== 'admin' || isOwner(me))
  const skillCell = (u: User) =>
    u.status === 'active' ? (
      <SkillManagerCell subject={{ type: 'user', id: u.id, name: u.name, always: u.role !== 'member' }} data={skillManagers.data} via={skillsVia(skillsAccess.data?.get(u.id), (id) => groups.data?.find((g) => g.id === id)?.name)} onChanged={() => void skillManagers.reload()} />
    ) : (
      <span className="text-xs text-faint">—</span>
    )

  const resetPassword = (u: User) => setResetting(u)
  /** One-time link (24 h) the person opens to choose a new password; no email, the admin hands it over. */
  const createResetLink = async (u: User) => {
    if (!(await confirmDialog({ title: t('members.resetLinkConfirm', { name: u.name }), body: t('members.resetLinkBody'), confirm: t('members.resetLinkCreate') }))) return
    const r = await act(() => api.call(API.createResetLink, { params: { id: u.id } }))
    if (r) setResetLink({ name: u.name, url: /^https?:\/\//.test(r.url) ? r.url : `${location.origin}${r.url.startsWith('/') ? '' : '/'}${r.url}`, expiresAt: r.expiresAt })
  }
  const toggleDisabled = async (u: User) => {
    const disabling = u.status === 'active'
    // an admin who leaves could see the team invite link: their own link ends with them, someone else's may need replacing
    const body = u.role === 'admin' ? <><p>{t('members.disableBody')}</p><p className="mt-2" data-testid="disable-team-link-hint">{t('teamLink.adminHint')}</p></> : t('members.disableBody')
    if (disabling && !(await confirmDialog({ title: t('members.disableTitle', { name: u.name }), body, confirm: t('members.disable'), danger: true }))) return
    if (await act(() => api.call(API.updateUser, { params: { id: u.id }, body: { status: disabling ? 'disabled' : 'active' } }))) void users.reload()
  }
  const remove = async (u: User) => {
    // personal files are archived for the owner either way; the text only says that this person asked
    const body = requested(u) ? t('accountDeletion.removeBody', { name: u.name, days: chatTrashDays(me) }) : t('members.removeBody', { days: chatTrashDays(me) })
    if (!(await confirmDialog({ title: t('members.removeTitle', { name: u.name }), body, confirm: t('common.delete'), danger: true }))) return
    if (await actOk(() => api.call(API.deleteUser, { params: { id: u.id } }))) await users.reload()
  }
  /** The actions used less often: on a phone in the card's "…" menu with the others, on a wide screen in the row's
   * "…" menu next to Edit and Reset password, so the row keeps one line. */
  const moreActions = (u: User): MemberMenuItem[] => [
    { label: t('members.resetLinkButton'), icon: <UserRoundKey size={14} aria-hidden />, onSelect: () => void createResetLink(u), testId: `reset-link-${u.username}` },
    u.status === 'active'
      ? { label: t('members.disable'), icon: <UserRoundX size={14} aria-hidden />, onSelect: () => void toggleDisabled(u), testId: `disable-member-${u.username}` }
      : { label: t('members.enable'), icon: <UserRoundCheck size={14} aria-hidden />, onSelect: () => void toggleDisabled(u), testId: `enable-member-${u.username}` },
    ...(isOwner(me) ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void remove(u), danger: true, testId: `delete-member-${u.username}` }] : []),
  ]
  // an invite is revoked at once, with no confirm dialog: one at a time, a held key does not repeat it, and the focus goes
  // to the list's title (the next row's button is another revoke)
  const invitesTitle = useRef<HTMLHeadingElement>(null)
  // (with no link left the list goes away: then to the Invite button)
  const inviteFocus = useFocusAfterRemove(invites.data, () => invitesTitle.current ?? document.querySelector<HTMLElement>('[data-testid="invite-new"]'))
  const revoking = useOneAtATime<string>()
  const revoke = (i: Invite) =>
    revoking.run(i.id, async () => {
      if (!(await actOk(() => api.call(API.revokeInvite, { params: { id: i.id } })))) return
      inviteFocus.removed(0)
      await invites.reload()
    })

  // search and role filter (like the Claude Console's Members): they narrow what is loaded, nothing is asked again
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const q = query.trim().toLocaleLowerCase(locale)
  const shown = (list: User[]) => list.filter((u) => (roleFilter === 'all' || u.role === roleFilter) && matches(q, locale, u.name, u.username, u.email))
  /** the owner changes roles (members ↔ admins) right in the row, on anyone but themselves; everyone else reads it */
  const roleEditable = (u: User) => isOwner(me) && u.role !== 'owner' && u.id !== me.user.id
  const roleBusy = useOneAtATime<string>()
  const changeRole = (u: User, role: MemberRole) =>
    roleBusy.run(u.id, async () => {
      const r = await act(() => api.call(API.updateUser, { params: { id: u.id }, body: { role } }))
      if (!r) return
      toast({ level: 'success', text: t('members.roleChanged', { name: u.name, role: t(`role.${r.role}`) }) })
      // an admin made a member could see the team invite link: suggest replacing it (as the edit dialog does)
      if (u.role === 'admin' && r.role === 'member') toast({ level: 'info', text: t('teamLink.adminHint') })
      await users.reload()
    })
  const roleCell = (u: User) =>
    roleEditable(u) ? (
      <InlineRole user={u} busy={roleBusy.busy === u.id} onChange={(r) => void changeRole(u, r)} />
    ) : (
      <span className="text-sm text-ink" data-testid={`member-role-${u.username}`}>
        {t(`role.${u.role}`)}
      </span>
    )
  /** Every row's "…": the folders this person sees (anyone's), then the actions on the people this viewer manages. */
  const menuItems = (u: User): MemberMenuItem[] => [
    { label: t('accessView.membersLink'), icon: <FolderLock size={14} aria-hidden />, onSelect: () => navigate(personViewLink({ person: u.id })), testId: 'member-access-link' },
    ...(canManage(u)
      ? [
          { label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(u), testId: `edit-member-${u.username}` },
          { label: t('members.reset'), icon: <KeyRound size={14} aria-hidden />, onSelect: () => resetPassword(u), testId: `reset-password-${u.username}` },
          ...moreActions(u),
        ]
      : []),
  ]

  return (
    <>
      <AdminPageHeader
        title={
          <>
            {t('members.title')}
            <CountBadge n={users.data?.items.length} testId="members-count" />
          </>
        }
        desc={t('members.pageDesc')}
        testId="members-header"
        actions={
          <>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <UserPlus size={14} aria-hidden /> {t('members.add')}
            </Button>
            <Button size="sm" onClick={() => setTeamLinkOpen(true)} data-testid="team-link-open">
              <Link2 size={14} aria-hidden /> {t('teamLink.title')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)} data-testid="invite-new">
              <Plus size={14} aria-hidden /> {t('members.inviteToTeam')}
            </Button>
          </>
        }
        controls={
          <>
            <SearchBox value={query} onChange={setQuery} label={t('members.search')} testId="member-search" className="sm:w-80" />
            <FilterPill
              label={t('members.role')}
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: 'all', label: t('members.roleAll') },
                { value: 'owner', label: t('role.owner') },
                { value: 'admin', label: t('role.admin') },
                { value: 'member', label: t('role.member') },
              ]}
              testId="member-role-filter"
            />
          </>
        }
      />
      <section className="mb-8" aria-label={t('members.title')}>
        <Loadable state={users}>
          {({ items, noAi }) => {
            const list = shown(items)
            if (!list.length)
              return (
                <p className="border-y border-line py-6 text-sm text-faint" data-testid="members-no-match">
                  {t('members.noMatch')}
                </p>
              )
            // a phone: one stacked row per member instead of a squeezed table
            return phone ? (
              <ul className="divide-y divide-line border-y border-line" data-testid="members-list">
                {list.map((u) => (
                  <li key={u.id} ref={u.id === focusId ? focusRow : undefined} className={clsx('flex items-start gap-2 py-3.5 text-sm', u.status === 'disabled' && 'opacity-60', u.id === focusId && 'bg-accent-soft')} data-testid={`member-card-${u.username}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{u.name}</p>
                      <p className="truncate text-xs text-faint">
                        {u.username}
                        {u.email ? ` · ${u.email}` : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {roleCell(u)}
                        <AttentionBadges user={u} noAi={!!noAi?.includes(u.id)} requested={requested(u)} />
                      </div>
                      <div className="mt-2 flex items-start gap-3 text-xs">
                        <span className="pt-0.5 text-muted">{t('skillMgr.column')}</span>
                        {skillCell(u)}
                      </div>
                    </div>
                    <MemberMenu name={u.name} items={menuItems(u)} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="members-table">
                  <thead>
                    <tr className="border-b border-line text-left text-label whitespace-nowrap text-muted">
                      <th scope="col" className="py-2.5 pr-4 font-medium">{t('auth.name')}</th>
                      <th scope="col" className="py-2.5 pr-4 font-medium">{t('auth.username')}</th>
                      <th scope="col" className="py-2.5 pr-4 font-medium">{t('members.role')}</th>
                      {/* the only long header: it may take two lines */}
                      <th scope="col" className="w-28 py-2.5 pr-4 font-medium whitespace-normal">{t('skillMgr.column')}</th>
                      <th scope="col" className="hidden py-2.5 pr-4 font-medium xl:table-cell">{t('members.lastSeen')}</th>
                      <th scope="col" className="w-10 py-2.5">
                        <span className="sr-only">{t('files.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {list.map((u) => (
                      <tr key={u.id} ref={u.id === focusId ? focusRow : undefined} className={clsx(u.status === 'disabled' && 'opacity-60', u.id === focusId && 'bg-accent-soft')}>
                        <td className="py-3.5 pr-4">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-ink">{u.name}</span>
                            <AttentionBadges user={u} noAi={!!noAi?.includes(u.id)} requested={requested(u)} />
                          </span>
                          {u.groupIds.length > 0 && <span className="mt-0.5 block text-xs text-faint">{u.groupIds.map(groupName).join(', ')}</span>}
                        </td>
                        <td className="py-3.5 pr-4 text-muted">
                          <span className="block">{u.username}</span>
                          {u.email && <span className="block text-xs text-faint">{u.email}</span>}
                        </td>
                        <td className="py-3.5 pr-4">{roleCell(u)}</td>
                        <td className="py-3.5 pr-4">{skillCell(u)}</td>
                        <td className="hidden py-3.5 pr-4 text-xs whitespace-nowrap text-muted xl:table-cell">{u.lastSeenAt ? formatDateTime(u.lastSeenAt, locale) : '—'}</td>
                        <td className="py-3.5 text-right">
                          <MemberMenu name={u.name} items={menuItems(u)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }}
        </Loadable>
      </section>

      <ScheduleReviews />

      {/* Invite links, quiet and only when there are any: the team link (copy, or "…" to change or turn it off in its
          popup) and the single-use links (revoke at once). Making a link happens in the popups of the header buttons. */}
      {(!!teamLink.data?.link || !!invites.data?.length) && (
        <section className="mb-8" aria-labelledby="invite-links-title" data-testid="invite-links">
          <h2 id="invite-links-title" ref={invitesTitle} tabIndex={-1} className="text-sm font-semibold">
            {t('members.invites')}
          </h2>
          <OneLine className="mt-0.5 mb-2 text-xs text-muted">{t('members.invitesDesc')}</OneLine>
          <div className="divide-y divide-line border-y border-line text-sm">
            {teamLink.data?.link && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid="team-link-row">
                <Link2 size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="font-medium">{t('teamLink.title')}</span>
                <span className="min-w-0 flex-1 text-xs text-muted">
                  {teamLink.data.link.groupIds.map(groupName).join(', ') || t('members.noGroups')} · {t('teamLink.uses', { used: teamLink.data.link.uses, max: teamLink.data.link.maxUses })} ·{' '}
                  {Date.parse(teamLink.data.link.expiresAt) < Date.now() ? t('members.expired') : t('teamLink.until', { date: formatDateTime(teamLink.data.link.expiresAt, locale) })}
                </span>
                {teamLink.data.link.url && <CopyButton text={teamLink.data.link.url} label={t('teamLink.copyLink')} showLabel className="border border-line" />}
                <MemberMenu
                  name={t('teamLink.title')}
                  items={[
                    { label: t('members.teamLinkOpen'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setTeamLinkOpen(true), testId: 'team-link-row-open' },
                    { label: t('teamLink.revoke'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void revokeTeamLink(), danger: true, testId: 'team-link-row-revoke' },
                  ]}
                />
              </div>
            )}
            {!!invites.data?.length && (
              <ul className="divide-y divide-line" data-testid="invite-list">
                {invites.data.map((i) => {
                  const expired = Date.parse(i.expiresAt) < Date.now()
                  return (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 py-2.5">
                      <Badge>{t(`role.${i.role}`)}</Badge>
                      <span className="min-w-0 flex-1 text-xs text-muted">
                        {i.groupIds.map(groupName).join(', ') || t('members.noGroups')} · {i.usedAt ? t('members.usedBy', { name: i.usedBy?.name ?? '?' }) : expired ? t('members.expired') : t('members.expires', { date: formatDateTime(i.expiresAt, locale) })}
                      </span>
                      {!i.usedAt && !expired && (
                        <Button size="sm" variant="ghost" onClick={() => void revoke(i)} onKeyDown={noKeyRepeat} aria-disabled={revoking.busy !== null || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                          {t('members.revoke')}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>
      )}
      {teamLinkOpen && <TeamLinkDialog onClose={() => setTeamLinkOpen(false)} onChange={(r) => teamLink.setData(r)} />}

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

type RoleFilter = 'all' | User['role']

/** What needs the admin's eye, next to the name: disabled, a temporary password, no AI. (The role has its own column.) */
function AttentionBadges({ user: u, noAi, requested = false }: { user: User; noAi: boolean; requested?: boolean }) {
  const t = useT()
  return (
    <>
      {u.status === 'disabled' && <Badge tone="danger">{t('members.disabled')}</Badge>}
      {requested && <span className="inline-flex" data-testid="member-deletion-requested"><Badge tone="danger">{t('accountDeletion.badge')}</Badge></span>}
      {u.mustChangePassword && <TempPasswordBadge user={u} />}
      {noAi && <NoAiBadge />}
    </>
  )
}

/** The role as a small select in the row (the owner's view): member ↔ admin. A change is saved at once; while it is
 * saved a second choice waits (aria-busy, not disabled, so the keyboard focus stays on it). */
function InlineRole({ user, busy, onChange }: { user: User; busy: boolean; onChange: (r: MemberRole) => void }) {
  const t = useT()
  // the arrow is every select's own (index.css), so none is drawn here
  return (
    <select
      aria-label={t('members.roleFor', { name: user.name })}
      aria-busy={busy || undefined}
      value={user.role === 'owner' ? 'admin' : user.role}
      onChange={(e) => {
        if (!busy) onChange(e.target.value as MemberRole)
      }}
      className="h-8 cursor-pointer rounded-md border border-line bg-surface pl-2.5 text-sm text-ink hover:bg-hover focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none aria-busy:opacity-60"
      data-testid={`member-role-${user.username}`}
    >
      <option value="member">{t('role.member')}</option>
      <option value="admin">{t('role.admin')}</option>
    </select>
  )
}

/** "No AI": this person cannot use any AI connection now (none of their own, none of the team's for them). Opens
 * Admin › AI providers, where the owner adds one or assigns one to them. */
function NoAiBadge() {
  const t = useT()
  return (
    <Link to="/admin/providers" title={t('members.noAiHint')} className="inline-flex" data-testid="member-no-ai">
      <Badge tone="warn">{t('members.noAi')}</Badge>
      <span className="sr-only">{t('members.noAiHint')}</span>
    </Link>
  )
}

/** Scheduled tasks paused until their owners confirm them again (made without the schedule card). Metadata only: the
 * title and the instruction are the person's own words; the owner checks them in Scheduled tasks (sidebar). Shown
 * only while some task waits. */
function ScheduleReviews() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(async () => (await api.call(API.listSchedulesAwaitingReview)).items)
  if (!state.data?.length) return null
  const weekday = (n: number) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))
  return (
    <Card title={t('members.scheduleReviews')} desc={t('members.scheduleReviewsDesc')}>
      <ul className="divide-y divide-line rounded-xl border border-line text-sm" data-testid="admin-schedule-reviews">
        {state.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5" data-testid="admin-schedule-review">
            <span className="font-medium">{s.user.name}</span>
            <span className="text-muted">{t(`schedules.repeat.${s.repeat}` as MessageKey, { time: s.time, date: s.date ?? '', day: String(s.day ?? ''), weekday: weekday(s.weekday ?? 0) })}</span>
            {s.reviewSince && <span className="text-xs text-faint">{t('members.scheduleReviewSince', { date: formatDateTime(s.reviewSince, locale) })}</span>}
          </li>
        ))}
      </ul>
    </Card>
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
          <p className="mb-1.5 text-label font-medium">{t('admin.groups')}</p>
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
        <NewPersonPreview role={role} groupIds={groupIds} groups={groups} />
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
    <span className="inline-flex" title={help} data-testid={testId}>
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
      <label htmlFor={`${id}-input`} className="mb-1.5 block text-label font-medium text-ink">
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
          <p className="mb-1.5 text-label font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={f.groupIds} onChange={(groupIds) => set({ groupIds })} />
        </div>
        <NewPersonPreview role={f.role} groupIds={f.groupIds} groups={groups} />
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
              // an admin made a member could see the team invite link: suggest replacing it
              if (r && user.role === 'admin' && r.role === 'member') toast({ level: 'info', text: t('teamLink.adminHint') })
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
          <p className="mb-1.5 text-label font-medium">{t('admin.groups')}</p>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
      </div>
    </Modal>
  )
}

