// The team invite link (shared/src/api/team-links.ts): make it, copy it or the ready-made message for KakaoTalk or Slack,
// see how many joined and until when it works, change it or turn it off. Used by Admin › Members (TeamLinkCard) and
// by the onboarding wizard's InviteStep. Everyone who joins with it is a member; the owner/admin picks the groups.
import { Plus, QrCode as QrIcon, RefreshCw } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { TEAM_LINK_DAYS, TEAM_LINK_DEFAULT_DAYS, TEAM_LINK_DEFAULT_USES, TEAM_LINK_MAX_USES, type CreateTeamLinkBody, type Group, type SkillInfo, type TeamLinkResponse, type TeamLinkState } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { teamLinkMessage } from '../../lib/team-link'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useMe } from '../../store/session'
import QrCode from '../QrCode'
import { Badge, Button, CopyButton, Field, confirmDialog, inputCls } from '../ui'
import { GroupChecks } from '../../pages/admin/people-choices'
import { Card, Loadable, useAction, useActionOk, useLoad } from '../../pages/admin/common'

/** The panel with its data: loads the link, makes and revokes it. `skillPath`: the wizard's skill (no picker then). */
export function TeamLinkPanel({ withGroups = true, skillPath, onChange }: { withGroups?: boolean; skillPath?: string | null; onChange?: (r: TeamLinkResponse) => void }) {
  const me = useMe()
  const state = useLoad(() => api.call(API.getTeamLink))
  const groups = useLoad(async () => (withGroups ? (await api.call(API.listGroups)).items : []), [withGroups])
  // the picker lists the team skills the admin can read (skills/…, not their personal ones)
  const skills = useLoad(async () => (skillPath === undefined ? (await api.call(API.listSkills)).items.filter((s) => s.path.startsWith('skills/')) : []), [skillPath])
  const act = useAction()
  const actOk = useActionOk()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (state.data) onChange?.(state.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data])
  const create = async (body: CreateTeamLinkBody) => {
    setBusy(true)
    const r = await act(() => api.call(API.createTeamLink, { body }))
    setBusy(false)
    if (r) state.setData(r)
  }
  const revoke = async () => {
    setBusy(true)
    const ok = await actOk(() => api.call(API.revokeTeamLink))
    setBusy(false)
    if (ok) await state.reload()
  }
  return (
    <Loadable state={state} lines={3}>
      {(data) => (
        <TeamLinkView
          data={data}
          inviter={me?.user.name ?? ''}
          groups={groups.data ?? []}
          skills={skillPath === undefined ? (skills.data ?? []) : null}
          fixedSkillPath={skillPath}
          busy={busy}
          onCreate={(b) => void create(b)}
          onRevoke={() => void revoke()}
        />
      )}
    </Loadable>
  )
}

export interface TeamLinkViewProps {
  data: TeamLinkResponse
  /** the person copying the message: they are the one who sends it */
  inviter: string
  groups: Group[]
  /** the skills to pick from; null: no picker (fixedSkillPath decides) */
  skills: SkillInfo[] | null
  fixedSkillPath?: string | null
  busy: boolean
  onCreate: (body: CreateTeamLinkBody) => void
  onRevoke: () => void
}

/** Why the open link cannot be shared now (the form to make a new one follows). */
const STALE = {
  active: null,
  expired: 'teamLink.state.expired',
  used_up: 'teamLink.state.used_up',
  stopped: 'teamLink.state.stopped',
  unreadable: 'teamLink.state.unreadable',
} as const satisfies Record<TeamLinkState | 'unreadable', MessageKey | null>

/** What the panel shows, without loading anything (tests render it as it is). */
export function TeamLinkView({ data, inviter, groups, skills, fixedSkillPath, busy, onCreate, onRevoke }: TeamLinkViewProps) {
  const t = useT()
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const [qr, setQr] = useState(false)
  const link = data.link
  const left = data.seats.limit !== null ? Math.max(0, data.seats.limit - data.seats.used) : null
  const usable = link && link.state === 'active' && link.url
  if (!link || editing || !usable) {
    const stale = link && !editing ? STALE[link.url || link.state !== 'active' ? link.state : 'unreadable'] : null
    return (
      <div className="space-y-4">
        {stale && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="team-link-stale">{t(stale)}</p>}
        <CreateForm
          key={link?.id ?? 'new'}
          initial={link ? { groupIds: link.groupIds, skillPath: link.skill?.path ?? null } : null}
          groups={groups}
          skills={skills}
          fixedSkillPath={fixedSkillPath}
          seatsLeft={left}
          planLimit={data.seats.limit}
          replacing={!!link && link.state === 'active'}
          busy={busy}
          onCancel={editing ? () => setEditing(false) : undefined}
          onCreate={(b) => { setEditing(false); onCreate(b) }}
        />
      </div>
    )
  }
  const url = link.url!
  const skillName = link.skill?.name ?? null
  const message = teamLinkMessage(t, { name: inviter, url, skill: skillName })
  const groupNames = link.groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter((x): x is string => !!x)
  return (
    <div className="space-y-4" data-testid="team-link">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted">{t('teamLink.link')}</p>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-sm break-all select-all" data-testid="team-link-url">{url}</code>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={url} label={t('teamLink.copyLink')} showLabel className="border border-line" />
        <CopyButton text={message} label={t('teamLink.copyMessage')} showLabel className="border border-line" />
        <Button size="sm" variant="ghost" onClick={() => setQr((v) => !v)} aria-expanded={qr}>
          <QrIcon size={14} aria-hidden /> {t('members.qr')}
        </Button>
      </div>
      {qr && (
        <div className="flex justify-center">
          <QrCode text={url} label={t('members.qr')} />
        </div>
      )}
      <div className="rounded-lg border border-line px-3 py-2">
        <p className="mb-1 text-xs font-medium text-muted">{t('teamLink.messagePreview')}</p>
        <p className="text-sm whitespace-pre-wrap break-words text-ink" data-testid="team-link-message">{message}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">{t('teamLink.usesLabel')}</dt>
        <dd data-testid="team-link-uses">{t('teamLink.uses', { used: link.uses, max: link.maxUses })}</dd>
        <dt className="text-muted">{t('teamLink.expiresLabel')}</dt>
        <dd>{t('teamLink.until', { date: formatDateTime(link.expiresAt, locale) })}</dd>
        <dt className="text-muted">{t('admin.groups')}</dt>
        <dd>{groupNames.length ? groupNames.join(', ') : t('members.noGroups')}</dd>
        {link.skill && (
          <>
            <dt className="text-muted">{t('teamLink.skill')}</dt>
            <dd>{skillName ?? link.skill.path}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted">
        <Badge>{t('role.member')}</Badge> {t('teamLink.memberNote')}
        {left !== null && <> · {t('teamLink.seatsLeft', { n: left })}</>}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)} data-testid="team-link-replace">
          <RefreshCw size={14} aria-hidden /> {t('teamLink.replace')}
        </Button>
        <Button
          size="sm"
          variant="ghost-danger"
          busy={busy}
          data-testid="team-link-revoke"
          onClick={async () => {
            if (await confirmDialog({ title: t('teamLink.revokeTitle'), body: t('teamLink.revokeBody'), confirm: t('teamLink.revoke'), danger: true })) onRevoke()
          }}
        >
          {t('teamLink.revoke')}
        </Button>
      </div>
    </div>
  )
}

/** The link's settings: groups, how many people, how long, and a skill to land on. */
function CreateForm({ initial, groups, skills, fixedSkillPath, seatsLeft, planLimit, replacing, busy, onCancel, onCreate }: {
  initial: { groupIds: string[]; skillPath: string | null } | null
  groups: Group[]; skills: SkillInfo[] | null; fixedSkillPath?: string | null
  seatsLeft: number | null; planLimit: number | null; replacing: boolean; busy: boolean
  onCancel?: () => void; onCreate: (b: CreateTeamLinkBody) => void
}) {
  const t = useT()
  const id = useId()
  const [groupIds, setGroupIds] = useState<string[]>(initial?.groupIds ?? [])
  const [uses, setUses] = useState('')
  const [days, setDays] = useState<number>(TEAM_LINK_DEFAULT_DAYS)
  const [skill, setSkill] = useState<string>(initial?.skillPath ?? '')
  const max = planLimit ?? TEAM_LINK_MAX_USES
  const defaultUses = seatsLeft ?? TEAM_LINK_DEFAULT_USES
  const n = uses.trim() === '' ? null : Number(uses)
  const usesProblem = n !== null && (!Number.isInteger(n) || n < 1 || n > max) ? t('teamLink.usesRule', { max }) : null
  const full = seatsLeft === 0
  // a skill kept from the link before that the admin cannot see any more is not offered again
  const pickedSkill = skill && skills?.some((s) => s.path === skill) ? skill : ''
  const submit = () => {
    if (usesProblem || full) return
    const skillPath = fixedSkillPath !== undefined ? fixedSkillPath : pickedSkill || null
    onCreate({ groupIds, expiresInDays: days as 7 | 14 | 30, ...(n !== null ? { maxUses: n } : {}), ...(skillPath ? { skillPath } : {}) })
  }
  return (
    <div className="space-y-4" data-testid="team-link-form">
      {groups.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('teamLink.groups')}</p>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('teamLink.usesField')} hint={t('teamLink.usesHint', { n: defaultUses })} error={usesProblem}>
          <input id={`${id}-uses`} className={inputCls} type="number" inputMode="numeric" min={1} max={max} value={uses} placeholder={String(defaultUses)} onChange={(e) => setUses(e.target.value)} data-testid="team-link-uses-input" />
        </Field>
        <Field label={t('members.validDays')}>
          <select className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="team-link-days">
            {TEAM_LINK_DAYS.map((d) => (
              <option key={d} value={d}>
                {t('members.days', { n: d })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {skills && skills.length > 0 && (
        <Field label={t('teamLink.skillField')} hint={t('teamLink.skillHint')}>
          <select className={inputCls} value={pickedSkill} onChange={(e) => setSkill(e.target.value)} data-testid="team-link-skill">
            <option value="">{t('teamLink.noSkill')}</option>
            {skills.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="text-xs text-muted">{t('teamLink.memberNote')}</p>
      {full && <p className="text-sm text-warn" data-testid="team-link-full">{t('teamLink.noSeats')}</p>}
      {replacing && <p className="text-xs text-warn">{t('teamLink.replaceNote')}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" busy={busy} disabled={!!usesProblem || full} onClick={submit} data-testid="team-link-create">
          {replacing ? <RefreshCw size={14} aria-hidden /> : <Plus size={14} aria-hidden />} {replacing ? t('teamLink.replace') : t('teamLink.create')}
        </Button>
      </div>
    </div>
  )
}

/** Admin › Members: the team invite link as a card. */
export function TeamLinkCard() {
  const t = useT()
  return (
    <Card title={t('teamLink.title')} desc={t('teamLink.desc')}>
      <TeamLinkPanel />
    </Card>
  )
}
