// The team invite link (shared/src/api/team-links.ts): make it, copy it or the ready-made message for KakaoTalk or Slack,
// see how many joined and until when it works, change it or turn it off. Used by Admin › Members (TeamLinkCard) and
// by the onboarding wizard's InviteStep. Everyone who joins with it is a member; the owner/admin picks the groups.
// Folded (the invite step): the message and "메시지 복사" only; the link, its settings and "새 링크로 바꾸기" wait under
// one quiet "링크 관리" row, and the link cannot be turned off there (Admin › Members can). For the owner walking the
// welcome steps the link is made in advance (`prepare`), so the message and its one copy button show at once; a link
// that may still let someone in is never replaced by itself (making one ends the open one).
// The team's own group (made by the welcome steps, docs/DECISIONS.md "M — One meeting note, everyone's own tasks") is
// the default group of a new link, so people who join see the team's folder. A starter (the lead's meeting notes and
// what people who join get from them) goes with a new link, and an open link is changed to carry it (PATCH: same
// address); its ready-made message then says what is waiting instead of who invites.
import clsx from 'clsx'
import { Check, ChevronDown, Copy, Plus, QrCode as QrIcon, RefreshCw } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { TEAM_LINK_DAYS, TEAM_LINK_DEFAULT_DAYS, TEAM_LINK_DEFAULT_USES, TEAM_LINK_MAX_USES, skillTitle, type CreateTeamLinkBody, type Group, type SkillInfo, type TeamLink, type TeamLinkResponse, type TeamLinkStarter, type TeamLinkState } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { teamLinkMessage } from '../../lib/team-link'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isAdmin, isOwner, useMe } from '../../store/session'
import { useWelcome } from '../../store/welcome'
import QrCode from '../QrCode'
import { Button, Field, Skeleton, confirmDialog, inputCls, useCopy } from '../ui'
import { GroupChecks } from '../../pages/admin/people-choices'
import { Loadable, OneLine, useAction, useActionOk, useLoad } from '../../pages/admin/common'

/** `starter` null: the link leads to the skill alone (a team skill the lead just made, docs/DECISIONS.md "S") */
type Want = { skillPath: string; starter: TeamLinkStarter | null; groupId: string | null }
const sameFiles = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort()
  const y = [...new Set(b)].sort()
  return x.length === y.length && x.every((p, i) => p === y[i])
}
/** what a change asked for on this link (its id, the kind, the skill, the files): asked once per page load. The server
 * may keep fewer files (one a newcomer could not read) and the link then still differs: asking again would change
 * nothing, so it is not asked again. */
const patched = new Set<string>()
const patchKey = (link: TeamLink, want: Want) => `${link.id}|${want.starter?.kind ?? 'skill'}|${want.skillPath}|${[...(want.starter?.files ?? [])].sort().join('\u0000')}`
/** Call when the change went out (or was refused): this link is not changed again for the same wish. */
export const markPatched = (link: TeamLink, want: Want) => { patched.add(patchKey(link, want)) }
/** test hook */
export const forgetPatched = () => patched.clear()

/** Does the open link lead elsewhere than this starter, skill and team group (the file list itself, not only how many)?
 * A link that cannot be shared is replaced with a new one instead; a wish already sent for this link is not sent again. */
export function linkDiffers(link: TeamLink | null, want: Want): boolean {
  if (!link || link.state !== 'active' || !link.url) return false
  if (patched.has(patchKey(link, want))) return false
  const groupMissing = !!want.groupId && !link.groupIds.includes(want.groupId)
  // the skill alone: an open link that names another skill, or carries files, is changed to it
  if (!want.starter) return link.skill?.path !== want.skillPath || !!link.starter || groupMissing
  const files = link.starter?.paths
  return link.starter?.kind !== want.starter.kind || link.skill?.path !== want.skillPath
    || (files ? !sameFiles(files, want.starter.files) : link.starter?.files !== want.starter.files.length)
    || groupMissing
}

/** No link that lets anyone in, now or later: none open, or the open one ran out (its date or its uses); and a seat
 * left (a full team gets the form, which says so). A link made now ends nothing that still works. An active link, a
 * stopped one (it would work again if its maker got the right back) and one whose address this server cannot show
 * (it still works for whoever has it) are never replaced by themselves. */
export function linkToMake(data: TeamLinkResponse): boolean {
  const seat = data.seats.limit === null || data.seats.used < data.seats.limit
  return seat && (!data.link || data.link.state === 'expired' || data.link.state === 'used_up')
}

/** The panel with its data: loads the link, makes and revokes it. `skillPicker` false: no skill list (the wizard);
 * `skillPath`: the wizard's skill for a new link (without one, a changed link keeps the skill it had); `starter`: the
 * lead's files for people who join (with `skillPath`); `retarget`: an open link that leads elsewhere is changed to
 * `skillPath` alone (no files), keeping its address; `prepare`: the owner walking the welcome steps, the link is made
 * as the panel opens when none could let anyone in (`linkToMake`; never for anyone else); `folded`: the invite step's
 * short view (TeamLinkView). */
export function TeamLinkPanel({ withGroups = true, skillPicker = true, skillPath, starter, made, retarget, prepare, folded, onChange }: { withGroups?: boolean; skillPicker?: boolean; skillPath?: string | null; starter?: TeamLinkStarter | null; made?: boolean; retarget?: boolean; prepare?: boolean; folded?: boolean; onChange?: (r: TeamLinkResponse) => void }) {
  const me = useMe()
  const admin = isAdmin(me)
  const owner = isOwner(me)
  const state = useLoad(() => api.call(API.getTeamLink))
  const groups = useLoad(async () => (withGroups ? (await api.call(API.listGroups)).items : []), [withGroups])
  // the team's own group from the welcome steps (owners and admins read their progress; a failed read is no group)
  const welcomeLoaded = useWelcome((s) => s.loaded)
  const welcomeGroup = useWelcome((s) => s.progress?.teamGroup ?? null)
  useEffect(() => {
    if (admin) void useWelcome.getState().load().catch(() => {})
  }, [admin])
  const teamGroup = welcomeGroup && groups.data?.some((g) => g.id === welcomeGroup.id) ? welcomeGroup : null
  const ready = (!admin || welcomeLoaded) && (groups.data !== null || !!groups.error)
  // the picker lists the team skills the admin can read (skills/…, not their personal ones)
  const skills = useLoad(async () => (skillPicker ? (await api.call(API.listSkills)).items.filter((s) => s.path.startsWith('skills/')) : []), [skillPicker])
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
  // The person pressed 팀원 초대 with the lead's files: an open link that leads elsewhere is changed once to carry them
  // (its address stays, so a link already posted in a chat now leads there too)
  const [patch, setPatch] = useState<'idle' | 'running' | 'done'>('idle')
  const want = (starter || made || retarget) && skillPath ? { skillPath, starter: starter ?? null, groupId: teamGroup?.id ?? null } : null
  const wantPatch = !!want && ready && patch === 'idle' && linkDiffers(state.data?.link ?? null, want)
  useEffect(() => {
    if (!wantPatch || !want) return
    setPatch('running')
    // once for this link and this wish, whatever the answer (a refusal says so; trying again on every open would not help)
    if (state.data?.link) markPatched(state.data.link, want)
    void act(() => api.call(API.updateTeamLink, { body: { skillPath: want.skillPath, starter: want.starter, addGroupIds: want.groupId ? [want.groupId] : [] } })).then((r) => {
      if (r) state.setData(r)
      setPatch('done')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPatch])
  // The owner walking the welcome steps: no link that could let anyone in, so one is made as the step opens, with the
  // settings the form would start with (the team's group, the skill and files of this step, the default uses and
  // days); once per panel, whatever the answer (a refusal says why and the form stays, with its button)
  const [early, setEarly] = useState<'idle' | 'running' | 'done'>('idle')
  const earlyAsked = useRef(false)
  const wantEarly = !!prepare && owner && ready && early === 'idle' && !!state.data && linkToMake(state.data)
  useEffect(() => {
    const data = state.data
    if (!wantEarly || !data || earlyAsked.current) return
    earlyAsked.current = true
    setEarly('running')
    const old = data.link
    const groupIds = [...new Set([...(old?.groupIds ?? []), ...(teamGroup ? [teamGroup.id] : [])])]
    const skill = skillPath ?? old?.skill?.path ?? null
    const body: CreateTeamLinkBody = { groupIds, expiresInDays: TEAM_LINK_DEFAULT_DAYS, ...(skill ? { skillPath: skill } : {}), ...(skill && starter ? { starter } : {}) }
    void act(() => api.call(API.createTeamLink, { body })).then((r) => {
      if (r) state.setData(r)
      setEarly('done')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantEarly])
  // the message of the link as it was would be copied a moment too early; a link being made shows nothing to copy yet
  if (wantPatch || patch === 'running' || wantEarly || early === 'running') return <Skeleton lines={3} />
  return (
    <Loadable state={state} lines={3}>
      {(data) => (
        <TeamLinkView
          data={data}
          inviter={me?.user.name ?? ''}
          groups={groups.data ?? []}
          skills={skillPicker ? (skills.data ?? []) : null}
          fixedSkillPath={skillPath}
          starter={starter}
          made={made}
          defaultGroupIds={teamGroup ? [teamGroup.id] : []}
          busy={busy}
          folded={folded}
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
  /** the skills to pick from; null: no picker (fixedSkillPath, else the skill the link had) */
  skills: SkillInfo[] | null
  fixedSkillPath?: string | null
  /** goes with a new link that has a skill (the lead's files and what people who join get from them) */
  starter?: TeamLinkStarter | null
  /** `fixedSkillPath` is a team skill the lead just made: the message says so ("우리 팀 '…' 스킬을 만들어 뒀어요") */
  made?: boolean
  /** the groups a new link starts with (the team's own group); a link before keeps its own */
  defaultGroupIds?: string[]
  busy: boolean
  /** the invite step: the message and its copy button; the rest under a collapsed "링크 관리", no "링크 끄기" */
  folded?: boolean
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
export function TeamLinkView({ data, inviter, groups, skills, fixedSkillPath, starter, made = false, defaultGroupIds = [], busy, folded = false, onCreate, onRevoke }: TeamLinkViewProps) {
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
        {stale && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2" data-testid="team-link-stale">
            <p className="min-w-0 flex-1 text-sm text-warn">{t(stale)}</p>
            {/* a stopped link would work again if its maker got the right back: it can be turned off for good here (on
                Admin › Members; the folded invite step never turns a link off) */}
            {!folded && <RevokeButton busy={busy} onRevoke={onRevoke} />}
          </div>
        )}
        <CreateForm
          // the team's group arriving after the form showed starts it again with that group checked (nothing typed yet)
          key={link?.id ?? `new:${defaultGroupIds.join()}`}
          initial={link ? { groupIds: link.groupIds, skillPath: link.skill?.path ?? null } : { groupIds: defaultGroupIds, skillPath: null }}
          groups={groups}
          skills={skills}
          fixedSkillPath={fixedSkillPath}
          starter={starter}
          seatsLeft={left}
          planLimit={data.seats.limit}
          replacing={!!link && link.state === 'active'}
          // a change the person asked for ("새 링크로 바꾸기") shows its settings open
          folded={folded && !editing}
          busy={busy}
          onCancel={editing ? () => setEditing(false) : undefined}
          onCreate={(b) => { setEditing(false); onCreate(b) }}
        />
      </div>
    )
  }
  const url = link.url!
  // the skill as people read it (its title, else its name): in the message and the line under it
  const skillName = link.skill ? (link.skill.title ?? link.skill.name) : null
  // a starter with no file left that a newcomer could read leads nowhere: the usual message
  const waiting = link.starter && link.starter.files > 0 ? link.starter : null
  const message = teamLinkMessage(t, { name: inviter, url, skill: skillName, starter: waiting?.kind, made: made && !!fixedSkillPath && link.skill?.path === fixedSkillPath })
  const groupNames = link.groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter((x): x is string => !!x)
  // the groups line: always when the link puts people in groups; "그룹 없음" only on a team that has groups
  const showGroups = link.groupIds.length > 0 || groups.length > 0
  // the link, its facts and its changes: in place on Admin › Members, under "링크 관리" in the invite step
  const details = (
    <>
      <div>
        <p className="text-xs font-medium text-muted">{t('teamLink.link')}</p>
        <p className="mt-1 font-mono text-[13px] leading-5 break-all text-ink select-all" data-testid="team-link-url">{url}</p>
        <div className="mt-1 -ml-2.5 flex flex-wrap items-center gap-1">
          <CopyQuiet text={url} label={t('teamLink.copyLink')} />
          <Button size="sm" variant="ghost" onClick={() => setQr((v) => !v)} aria-expanded={qr} data-testid="team-link-qr">
            <QrIcon size={14} aria-hidden /> {t('members.qr')}
          </Button>
        </div>
        {qr && (
          <div className="mt-2">
            <QrCode text={url} label={t('members.qr')} />
          </div>
        )}
      </div>
      <div className="space-y-1 text-[13px] leading-5 text-muted" data-testid="team-link-facts">
        <p>
          {t('teamLink.usesLabel')} <span className="text-ink tabular-nums" data-testid="team-link-uses">{t('teamLink.uses', { used: link.uses, max: link.maxUses })}</span>
          {' · '}{t('teamLink.expiresLabel')} <span className="text-ink" data-testid="team-link-expires">{t('teamLink.until', { date: formatDateTime(link.expiresAt, locale) })}</span>
        </p>
        {(link.skill || showGroups) && (
          <p>
            {link.skill && <>{t('teamLink.skill')} <span className="text-ink" data-testid="team-link-skill-name">{skillName ?? link.skill.path}</span></>}
            {link.skill && showGroups && ' · '}
            {showGroups && (link.groupIds.length
              // the names once the groups loaded; until then (or when they did not load) how many
              ? <>{t('admin.groups')} <span className="text-ink" data-testid="team-link-groups">{groupNames.length ? groupNames.join(', ') : link.groupIds.length}</span></>
              : t('members.noGroups'))}
          </p>
        )}
        {waiting && <p data-testid="team-link-starter">{t(waiting.kind === 'brief' ? 'teamLink.starterBrief' : 'teamLink.starterTasks', { n: waiting.files })}</p>}
        <p>
          {t('teamLink.memberNote')}
          {left !== null && <> · {t('teamLink.seatsLeft', { n: left })}</>}
        </p>
      </div>
      <div className="-ml-2.5 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)} data-testid="team-link-replace">
          <RefreshCw size={14} aria-hidden /> {t('teamLink.replace')}
        </Button>
        {!folded && <RevokeButton busy={busy} onRevoke={onRevoke} />}
      </div>
    </>
  )
  // on a phone a frame near the screen edge reads as tight: one primary action (the message holds the link), the rest
  // as plain text, a hairline and quiet text buttons (docs/DESIGN-SYSTEM.md, Layout patterns)
  return (
    <div className="space-y-5" data-testid="team-link" data-folded={folded || undefined}>
      {link.limitedUntil && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="team-link-limited">
          {t('teamLink.limited', { time: formatDateTime(link.limitedUntil, locale) })}
        </p>
      )}
      <div>
        <p className="text-xs font-medium text-muted">{t('teamLink.messagePreview')}</p>
        <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm leading-6 whitespace-pre-wrap break-words text-ink" data-testid="team-link-message">
          {message}
        </blockquote>
        <CopyPrimary text={message} label={t('teamLink.copyMessage')} />
      </div>
      {folded ? <ManageFold>{details}</ManageFold> : details}
    </div>
  )
}

/** "링크 관리": one quiet row that opens the link's details and settings in place (collapsed at first). `keepOpen`: a
 * setting that does not fit stays in view (the row does not close it until it is fixed). */
function ManageFold({ keepOpen = false, children }: { keepOpen?: boolean; children: ReactNode }) {
  const t = useT()
  const id = useId()
  const [opened, setOpen] = useState(false)
  const open = opened || keepOpen
  return (
    <div data-testid="team-link-manage-fold">
      <div className="-ml-2.5">
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => { if (!keepOpen) setOpen(!open) }} data-testid="team-link-manage">
          {t('teamLink.manage')} <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      </div>
      <div id={id} hidden={!open} className="mt-3 space-y-5" data-testid="team-link-manage-panel">
        {open && children}
      </div>
    </div>
  )
}

/** The one primary action: copy the ready-made message (it ends with the link). Full width on a phone. */
function CopyPrimary({ text, label }: { text: string; label: string }) {
  const t = useT()
  const { copied, copy } = useCopy()
  return (
    <Button variant="primary" className="mt-3 max-sm:w-full" onClick={() => void copy(text)} data-testid="team-link-copy-message">
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? t('common.copied') : label}
    </Button>
  )
}

/** A quiet text button that copies (the link alone). */
function CopyQuiet({ text, label }: { text: string; label: string }) {
  const t = useT()
  const { copied, copy } = useCopy()
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy(text)} data-testid="team-link-copy-link">
      {copied ? <Check size={14} className="text-ok" aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? t('common.copied') : label}
    </Button>
  )
}

/** Turn the link off, after a confirm: the address already sent stops working for good. */
function RevokeButton({ busy, onRevoke }: { busy: boolean; onRevoke: () => void }) {
  const t = useT()
  return (
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
  )
}

/** The link's settings: groups, how many people, how long, and a skill to land on. */
function CreateForm({ initial, groups, skills, fixedSkillPath, starter, seatsLeft, planLimit, replacing, folded, busy, onCancel, onCreate }: {
  initial: { groupIds: string[]; skillPath: string | null } | null
  groups: Group[]; skills: SkillInfo[] | null; fixedSkillPath?: string | null; starter?: TeamLinkStarter | null
  seatsLeft: number | null; planLimit: number | null; replacing: boolean
  /** the invite step: the button first, the settings (defaults kept) under a collapsed "링크 관리" */
  folded?: boolean
  busy: boolean
  onCancel?: () => void; onCreate: (b: CreateTeamLinkBody) => void
}) {
  const t = useT()
  const id = useId()
  const [groupIds, setGroupIds] = useState<string[]>(initial?.groupIds ?? [])
  const [uses, setUses] = useState('')
  const [days, setDays] = useState<number>(TEAM_LINK_DEFAULT_DAYS)
  const [skill, setSkill] = useState<string>(initial?.skillPath ?? '')
  const max = Math.min(planLimit ?? TEAM_LINK_MAX_USES, TEAM_LINK_MAX_USES)
  const defaultUses = seatsLeft ?? TEAM_LINK_DEFAULT_USES
  const n = uses.trim() === '' ? null : Number(uses)
  const usesProblem = n !== null && (!Number.isInteger(n) || n < 1 || n > max) ? t('teamLink.usesRule', { max }) : null
  const full = seatsLeft === 0
  // a skill kept from the link before that the admin cannot see any more is not offered again
  const pickedSkill = skill && skills?.some((s) => s.path === skill) ? skill : ''
  const submit = () => {
    if (usesProblem || full) return
    // the wizard's skill; else the picker's; without a picker, the skill the link had
    const skillPath = fixedSkillPath ? fixedSkillPath : skills ? pickedSkill || null : (initial?.skillPath ?? null)
    onCreate({ groupIds, expiresInDays: days as 7 | 14 | 30, ...(n !== null ? { maxUses: n } : {}), ...(skillPath ? { skillPath } : {}), ...(skillPath && starter ? { starter } : {}) })
  }
  const settings = (
    <>
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
                {/* two skills that read the same (a title and another skill's name) are told apart by their path */}
                {skills.some((o) => o !== s && skillTitle(o) === skillTitle(s)) ? `${skillTitle(s)} · ${s.path}` : skillTitle(s)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="text-xs text-muted">{t('teamLink.memberNote')}</p>
    </>
  )
  const fullNote = full && <p className="text-sm text-warn" data-testid="team-link-full">{t('teamLink.noSeats')}</p>
  const replaceNote = replacing && <p className="text-xs text-warn">{t('teamLink.replaceNote')}</p>
  const create = (
    <Button variant="primary" className={folded ? 'max-sm:w-full' : undefined} busy={busy} disabled={!!usesProblem || full} onClick={submit} data-testid="team-link-create">
      {replacing ? <RefreshCw size={14} aria-hidden /> : <Plus size={14} aria-hidden />} {replacing ? t('teamLink.replace') : t('teamLink.create')}
    </Button>
  )
  if (folded)
    return (
      <div className="space-y-4" data-testid="team-link-form" data-folded>
        {/* why the button is off stays in view */}
        {fullNote}
        <div>{create}</div>
        {/* a number that does not fit keeps its settings open: the reason the button is off stays readable */}
        <ManageFold keepOpen={!!usesProblem}>
          {settings}
          {replaceNote}
        </ManageFold>
      </div>
    )
  return (
    <div className="space-y-4" data-testid="team-link-form">
      {settings}
      {fullNote}
      {replaceNote}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        {create}
      </div>
    </div>
  )
}

/** Admin › Members: the team invite link. A card from 640px (the admin cards' frame); on a phone no frame of its own,
 * only a hairline under it, as the Home goal card (a frame near the screen edge reads as tight). */
export function TeamLinkCard() {
  const t = useT()
  const id = useId()
  return (
    <section className="mb-6 border-b border-line pb-6 sm:rounded-2xl sm:border sm:bg-surface sm:pb-0" aria-labelledby={id} data-testid="team-link-card">
      <header className="pb-4 sm:border-b sm:border-line sm:px-4 sm:py-3">
        <h2 id={id} className="text-sm font-semibold">{t('teamLink.title')}</h2>
        <OneLine className="mt-0.5 text-xs text-muted">{t('teamLink.desc')}</OneLine>
      </header>
      <div className="sm:p-4">
        <TeamLinkPanel />
      </div>
    </section>
  )
}
