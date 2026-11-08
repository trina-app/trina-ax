// 내 스킬 가져오기 (docs/DECISIONS.md "SK — 내 스킬 가져오기"): one share proposal (shared/src/api/skill-shares.ts) as the
// owner checks it: while the server checks it (`checking`) the skills found so far with skeleton reasons and "그만 찾기";
// then one list (the recommended skills ticked, "그 밖에" and "빠진 것" folded under them), the CLAUDE.md (Codex:
// AGENTS.md) rule line and the tools line (Claude Code's servers, or a .codex folder's config.toml), both unticked;
// [팀에 공유 · N개] applies what is ticked; then what went in (a merge waits in a chat for its confirmation; the welcome
// step on a computer adds a quiet "다른 폴더도 가져오기" beside its primary). Without the AI's judgement (`ai` none or
// failed) nothing is recommended and the rest is not "그 밖에 · 나만 쓰는 것, 개발용" (nothing judged it so): it is
// listed under a neutral "찾은 스킬 N개", each row with its own reason when it has one (a command, a path). Used by
// the welcome step (components/onboarding/SkillsStep.tsx) and by /skills/share/:id (pages/SkillSharePage.tsx), where
// the notice about a Claude Code or Codex proposal leads. During the owner's setup (`inSetup`, docs/DECISIONS.md "W5")
// the done rows have no 열기 (the steps go on; the skill form is a trip away from them), and a merge waits for the end
// of the setup ("합치기는 설정 끝나고 확인해요"; one Inbox notice then leads to the merge chat). The welcome step passes
// the skills shared earlier in the setup (`earlier`: another folder, Claude Code or Codex), so what went in lists them
// all, each once, not only this share's.
// Group skills (docs/DECISIONS.md "Group skills"): on the share page (`pickTarget`) the proposer chooses where it goes,
// the team or one of their groups (PATCH: the server checks it again for that target); a share to a group carries its
// skills only (no team rule, no tools), its primary says the group, and a member of the group who reviews it reads
// whose it is. The welcome step keeps the team.
// Embedded (docs/DECISIONS.md "W6": the owner's 내 스킬 step, under the kept skills' rows): no primary and no 나중에 하기
// of its own; the step's one primary covers both parts, so the list tells the step what is ticked (`onState`) and the
// step applies it (`handle.apply`). `checkLimitMs`: how long a check may run on screen before the page ends it (POST
// /api/skill-shares/:id/stop-check, walk review M2): the list then shows with nothing ticked ("AI 없이 찾았어요").
// One primary per screen; on phones the list loses its frame and keeps its hairlines.
import clsx from 'clsx'
import { ChevronDown, CircleAlert, CircleCheck, FileCode, FileQuestionMark, FolderOpen, GitMerge, KeyRound, Loader2, Package, Plug, Sparkles, Terminal, Users } from 'lucide-react'
import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { Link } from 'react-router-dom'
import { skillLabel, type ApplySkillShare, type ShareAction, type ShareCandidate, type ShareReason, type SkillShare, type SkillShareSource } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { skillRunLink } from '../../lib/skillForm'
import { skillNameOf } from '../../lib/welcome'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, ErrorNote, Modal, useMediaQuery } from '../ui'

/** How often a share the server is still checking is read again. */
export const SHARE_POLL_MS = 1500
/** Rows shown while checking; the rest is one "N개 더 보는 중…" line. */
const CHECKING_ROWS = 5

export const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

/** "{folder}" in a text filled with a React node (a mono path, kbd keys, a link). */
export function withNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    return <Fragment key={i}>{m && m[1]! in nodes ? nodes[m[1]!] : part}</Fragment>
  })
}

/** Secret kinds named after a service (shared/src/secrets.ts); the others (a private key, a random-looking value …) read
 * as "a secret" without a name. */
const SERVICE: Record<string, string> = { slack: 'Slack', github: 'GitHub', gitlab: 'GitLab', openai: 'OpenAI', anthropic: 'Anthropic', aws: 'AWS', google: 'Google', stripe: 'Stripe', npm: 'npm', huggingface: 'Hugging Face', notion: 'Notion', linear: 'Linear', groq: 'Groq' }

/** The one line under a candidate: its reason (with the personal path and the scripts left out, when they apply). */
export function reasonText(t: ReturnType<typeof useT>, c: ShareCandidate): string {
  const parts: string[] = []
  const r: ShareReason = c.reason
  if (r === 'secret') {
    const d = c.detail?.trim() ?? ''
    // the server may send a kind ("slack") or words of its own ("Slack 토큰")
    const name = SERVICE[d.toLowerCase()] ?? (d && !/^[a-z0-9_-]+$/.test(d) ? d : null)
    parts.push(name ? t('welcome.skills.reason.secret', { detail: name }) : t('welcome.skills.reason.secretPlain'))
  } else if (r === 'with_file' || r === 'similar') {
    const detail = c.detail ?? (r === 'similar' ? c.similar?.title ?? '' : '')
    parts.push(detail ? t(`welcome.skills.reason.${r}` as MessageKey, { detail }) : t(r === 'similar' ? 'welcome.skills.reason.same_name' : 'welcome.skills.reason.team_files'))
  } else if (r !== 'unjudged') parts.push(t(`welcome.skills.reason.${r}` as MessageKey))
  if (c.personalPath && r !== 'personal_path' && c.group !== 'excluded') parts.push(t('welcome.skills.reason.personal_path'))
  if (c.scriptsDropped > 0 && c.group !== 'excluded') parts.push(t('welcome.skills.scriptsDropped'))
  return parts.join(' · ')
}

const EXCLUDED_ICON: Partial<Record<ShareReason, typeof KeyRound>> = { secret: KeyRound, scripts: FileCode, plugin: Plug, too_big: Package, not_skill: FileQuestionMark }
const EXCLUDED_ORDER: ShareReason[] = ['secret', 'scripts', 'plugin', 'too_big', 'not_skill']

/** The app that sent a share through the team connector, by its own name; null for a picked folder. */
export const connectorApp = (s: SkillShareSource): string | null => (s === 'claude_code' ? 'Claude Code' : s === 'codex' ? 'Codex' : null)

/** The name people read, and on a computer the skill's own name in mono (Claude Code users know it as /weekly-report). */
function SkillName({ c, phone, muted }: { c: Pick<ShareCandidate, 'name' | 'title'>; phone: boolean; muted?: boolean }) {
  const title = c.title?.trim() || c.name
  return (
    <span className={clsx('text-sm font-medium break-words', muted ? 'text-muted' : 'text-ink')}>
      {title}
      {!phone && <span className="ml-1.5 font-mono text-xs font-normal text-faint">/{c.name}</span>}
    </span>
  )
}

/** What an embedded list tells the step: its state, the titles ticked (skills only), how many skills, and the team rule
 * and the tools when ticked (`extras`). */
export interface ShareReviewState { id: string; status: SkillShare['status']; names: string[]; count: number; extras: number; applying: boolean }
/** An embedded list's apply, run by the step's primary: the share after it, or the error thrown. */
export interface ShareReviewHandle { apply: () => Promise<SkillShare> }

export interface SkillShareReviewProps {
  share: SkillShare
  /** the team's name, for the who lines */
  team: string
  /** the done state's primary: its label and what it does */
  doneLabel: string
  onDone: () => void
  /** once, right after an apply succeeded */
  onApplied?: (share: SkillShare) => void
  /** "나중에 하기" under the list (the parent decides whether the proposal is dismissed) */
  onLater: () => void
  /** "그만 찾기" while checking: the proposal is dismissed here first */
  onStopped: () => void
  /** "다른 폴더" on the source line of a picked folder; absent: no link */
  onOtherFolder?: () => void
  /** "다른 폴더도 가져오기" beside the done state's primary (the welcome step on a computer); absent: none */
  onMore?: () => void
  busy?: boolean
  /** the owner's welcome steps are unfinished: no 열기 on what went in, a merge waits for their end */
  inSetup?: boolean
  /** the skills shared earlier in the welcome steps (the progress's `shared.skills`, in the order they went in): listed
   * above this share's in what went in, a skill of this share's never twice */
  earlier?: readonly { path: string; title: string }[]
  /** the proposer may choose where it goes: the team or one of their groups (docs/DECISIONS.md "Group skills"; the
   * share page). The welcome step keeps the team: no choice there. */
  pickTarget?: boolean
  /** told the name of the group the share goes to now (null: the team), also after the proposer moved it: the share
   * page's title follows it */
  onTarget?: (group: string | null) => void
  /** under another primary (the 내 스킬 step): none of its own, and no 나중에 하기; the step reads `onState` and applies
   * through `handle` */
  embedded?: boolean
  onState?: (s: ShareReviewState) => void
  handle?: Ref<ShareReviewHandle>
  /** a check still running after this long on screen is ended (stop-check): nothing ticked, the list can go */
  checkLimitMs?: number
  /** the primary's words for n ticked skills (default "팀에 공유 · N개") */
  shareLabel?: (n: number) => string
  /** the words of the list's secondary button (default "나중에 하기"; the Team skills sheet: "닫기") */
  laterLabel?: string
}

export function SkillShareReview({ share: given, team, doneLabel, onDone, onApplied, onLater, onStopped, onOtherFolder, onMore, busy, inSetup = false, earlier, pickTarget = false, onTarget, embedded = false, onState, handle, checkLimitMs, shareLabel: labelFor, laterLabel }: SkillShareReviewProps) {
  const t = useT()
  const locale = useLocale()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [share, setShare] = useState(given)
  const [ticked, setTicked] = useState<Record<string, boolean> | null>(null)
  const [actions, setActions] = useState<Record<string, ShareAction>>({})
  const [ruleOn, setRuleOn] = useState(false)
  const [toolsOn, setToolsOn] = useState(false)
  const [open, setOpen] = useState<{ other: boolean; excluded: boolean } | null>(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ruleShown, setRuleShown] = useState(false)
  const applied = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const wasChecking = useRef(given.status === 'checking')
  const ids = useId()
  // the check ended by the page (checkLimitMs): its request failed, with a way to send it again
  const [stopError, setStopError] = useState<string | null>(null)
  const [stopAttempt, setStopAttempt] = useState(0)

  // another proposal from the parent (a new folder, Claude Code): start over with it
  const [shownId, setShownId] = useState(given.id)
  if (shownId !== given.id) {
    setShownId(given.id)
    setShare(given)
    setTicked(null)
    setOpen(null)
    setError(null)
    setStopError(null)
    applied.current = false
    wasChecking.current = given.status === 'checking'
  }

  // the server is still checking: read it again until it is ready (never after this list is gone)
  useEffect(() => {
    if (share.status !== 'checking') return
    let live = true
    const id = setInterval(() => {
      api.call(API.getSkillShare, { params: { id: share.id } }).then((s) => { if (live) setShare(s) }, () => {})
    }, SHARE_POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [share.id, share.status])

  // a check that runs past checkLimitMs on screen: the page ends it (the server stops the AI's turn; nothing is ticked
  // then, and no late answer can tick rows under the pointer). Its own timer per share; a failed request offers 다시.
  useEffect(() => {
    if (share.status !== 'checking' || !checkLimitMs) return
    let live = true
    const stop = () => api.call(API.stopSkillShareCheck, { params: { id: share.id } }).then(
      (s) => { if (live) { setStopError(null); setShare(s) } },
      (e) => { if (live) setStopError(errorText(e, locale, t('error.network'))) },
    )
    const id = setTimeout(() => void stop(), stopAttempt ? 0 : checkLimitMs)
    return () => { live = false; clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share.id, share.status, checkLimitMs, stopAttempt])

  // ready: the recommended rows ticked once, each row with its own default action
  if (share.status === 'ready' && ticked === null) {
    setTicked(Object.fromEntries(share.candidates.filter((c) => c.group !== 'excluded').map((c) => [c.name, c.group === 'recommended'])))
    setActions(Object.fromEntries(share.candidates.map((c) => [c.name, c.action])))
  }
  // the list replaced the checking rows: the focus goes to its heading (screen readers hear it arrive)
  useEffect(() => {
    if (share.status !== 'ready' || !wasChecking.current) return
    wasChecking.current = false
    requestAnimationFrame(() => heading.current?.focus())
  }, [share.status, share.id])

  const recommended = share.candidates.filter((c) => c.group === 'recommended')
  const other = share.candidates.filter((c) => c.group === 'other')
  const excluded = share.candidates.filter((c) => c.group === 'excluded')
  // nothing recommended (no AI): the other rows open, so the list is not empty
  const folds = open ?? { other: recommended.length === 0, excluded: false }
  const chosen = share.candidates.filter((c) => c.group !== 'excluded' && ticked?.[c.name])
  // a share to a group (docs/DECISIONS.md "Group skills") carries its skills only: a team rule and connection
  // templates are the team's
  const group = share.targetGroup ?? null
  const targetName = group?.name ?? null
  useEffect(() => { onTarget?.(targetName) }, [targetName]) // eslint-disable-line react-hooks/exhaustive-deps
  const rule = !group && share.rule && share.rule.lines > 0 && share.rule.text.trim() ? share.rule : null
  // the server checked each address again (https, no key, no query) for every source
  const tools = group ? [] : share.tools
  const anything = chosen.length > 0 || (ruleOn && !!rule) || (toolsOn && tools.length > 0)
  // the proposer for the team; a member of the group who may write its skills for a group (absent: older server)
  const canApply = share.canApply !== false && !(group && group.name === null)
  const [moving, setMoving] = useState(false)
  /** move the share to the team ('') or one of the proposer's groups; the server checks it again for that target */
  const retarget = async (to: string) => {
    setMoving(true)
    setError(null)
    try {
      const s = await api.call(API.setSkillShareTarget, { params: { id: share.id }, body: { group: to || null } })
      setShare(s)
      // the defaults follow the new target (a same-name skill there merges by default)
      setActions(Object.fromEntries(s.candidates.map((c) => [c.name, c.action])))
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setMoving(false)
    }
  }

  const stop = () => {
    // best effort: a proposal left behind expires by itself
    void api.call(API.dismissSkillShare, { params: { id: share.id } }).catch(() => {})
    onStopped()
  }
  /** what is ticked goes in; the share after it (thrown: the request failed) */
  const applyNow = async (): Promise<SkillShare> => {
    setApplying(true)
    try {
      const body: ApplySkillShare = {
        skills: chosen.map((c) => ({ name: c.name, action: c.sameName || c.similar ? actions[c.name] ?? c.action : 'add' })),
        rule: !!rule && ruleOn,
        tools: toolsOn ? tools.map((x) => x.name) : [],
      }
      const s = await api.call(API.applySkillShare, { params: { id: share.id }, body })
      setShare(s)
      if (!applied.current && s.status === 'applied') {
        applied.current = true
        onApplied?.(s)
      }
      if (!embedded) requestAnimationFrame(() => heading.current?.focus())
      return s
    } finally {
      setApplying(false)
    }
  }
  const apply = async () => {
    setError(null)
    try { await applyNow() } catch (e) { setError(errorText(e, locale, t('error.network'))) }
  }
  useImperativeHandle(handle, () => ({ apply: applyNow }))
  // an embedded list tells the step what its primary covers
  const extras = (ruleOn && !!rule ? 1 : 0) + (toolsOn && tools.length > 0 ? 1 : 0)
  const tickedNames = share.status === 'ready' ? chosen.map((c) => c.title?.trim() || skillLabel(c)) : []
  const stateKey = `${share.id}|${share.status}|${tickedNames.join('\n')}|${extras}|${applying}`
  useEffect(() => {
    onState?.({ id: share.id, status: share.status, names: tickedNames, count: tickedNames.length, extras, applying })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey])

  const frame = phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'
  const pad = phone ? 'px-0' : 'px-4'

  // ---- the source line
  const n = share.candidates.length
  const sender = connectorApp(share.source)
  const where = <span className="font-mono">{sender ?? share.where ?? ((share.app ?? 'claude') === 'codex' ? '.codex' : '.claude')}</span>
  let source: ReactNode
  if (share.status === 'checking') {
    source = (
      <p className="flex items-start gap-2 text-label leading-5 text-muted" role="status" aria-live="polite" data-testid="skill-review-source" data-state="checking">
        <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-faint" aria-hidden />
        <span>{withNodes(t('welcome.skills.scanning', { n }), { where })}</span>
      </p>
    )
  } else if (sender) {
    const time = formatRelative(share.createdAt, locale)
    source = (
      <p className="flex items-start gap-2 text-label leading-5 text-muted" data-testid="skill-review-source" data-state={share.source === 'codex' ? 'codex' : 'cc'}>
        <Terminal size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <span>{share.projects ? t('welcome.skills.foundCc', { app: sender, time, n, p: share.projects }) : t('welcome.skills.foundCcNoProjects', { app: sender, time, n })}</span>
      </p>
    )
  } else {
    source = (
      <p className="flex items-start gap-2 text-label leading-5 text-muted" data-testid="skill-review-source" data-state="folder">
        <FolderOpen size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <span>
          {withNodes(t('welcome.skills.found', { n }), { where })}
          {onOtherFolder && share.status === 'ready' && (
            <>
              <span aria-hidden> · </span>
              <button type="button" className={clsx(quietLink, 'touch-hit')} onClick={onOtherFolder} disabled={applying || busy} data-testid="skill-review-other-folder">{t('welcome.skills.otherFolder')}</button>
            </>
          )}
        </span>
      </p>
    )
  }
  const noAi = share.status === 'ready' && (share.ai === 'none' || share.ai === 'failed')
    ? <p className="text-xs text-faint" data-testid="skill-review-no-ai">{t('welcome.skills.noAi')}</p>
    : null

  // ---- checking: names so far, skeleton reasons, nothing to tick yet
  if (share.status === 'checking') {
    const rows = share.candidates.slice(0, CHECKING_ROWS)
    const more = n - rows.length
    return (
      <div className="space-y-4" data-testid="skill-review" data-status="checking">
        {source}
        <div className={frame}>
          <ul>
            {rows.map((c, i) => (
              <li key={c.name} className={clsx('flex items-start gap-3 border-line py-3', pad, i > 0 && 'border-t')} data-testid="skill-row" data-name={c.name}>
                <input type="checkbox" disabled checked={false} readOnly className="mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark] opacity-45" aria-label={c.title ?? c.name} />
                <span className="min-w-0 flex-1">
                  <SkillName c={c} phone={phone} />
                  <span aria-hidden className="mt-2 block h-2.5 animate-pulse rounded-full bg-hover" style={{ width: `${[62, 48, 70, 40, 56][i % 5]}%` }} />
                </span>
              </li>
            ))}
          </ul>
          {more > 0 && <p className={clsx('border-t border-line py-3 text-sm text-faint', pad)}>{t('welcome.skills.scanningMore', { n: more })}</p>}
        </div>
        <p className="text-xs text-faint">{t('welcome.skills.scanningNote')}</p>
        {stopError && <ErrorNote onRetry={() => { setStopError(null); setStopAttempt((n) => n + 1) }}>{stopError}</ErrorNote>}
        <div className={phone ? '' : 'flex justify-end'}>
          <Button variant="ghost" className={phone ? 'w-full' : undefined} onClick={stop} data-testid="skill-review-stop">{t('welcome.skills.stop')}</Button>
        </div>
      </div>
    )
  }

  // ---- dismissed or expired (opened from an old notice)
  if (share.status === 'dismissed' || share.status === 'expired') {
    return <p className="text-sm text-muted" data-testid="skill-review" data-status={share.status}>{t('welcome.skills.gone')}</p>
  }

  // ---- applied: what went in
  if (share.status === 'applied') {
    const rows = share.candidates.filter((c) => c.applied)
    // what went in before this share (another folder, Claude Code, Codex): each once, this share's own rows as they are
    const mine = new Set(share.candidates.map((c) => c.applied?.path).filter(Boolean))
    const before = (earlier ?? []).filter((s, i, all) => !mine.has(s.path) && all.findIndex((x) => x.path === s.path) === i)
    return (
      <div className="space-y-4" data-testid="skill-review" data-status="applied">
        <div className={frame}>
          <h3 ref={heading} tabIndex={-1} className={clsx('pt-3 pb-1 text-sm font-semibold text-ink outline-none', pad)} data-testid="skills-done">{t('welcome.skills.done')}</h3>
          <ul>
            {before.map((s, i) => <EarlierRow key={s.path} s={s} phone={phone} first={i === 0} pad={pad} />)}
            {rows.map((c, i) => <DoneRow key={c.name} c={c} phone={phone} first={!before.length && i === 0} pad={pad} inSetup={inSetup} />)}
            {share.rule?.path && (
              <li className={clsx('flex items-start gap-3 border-t border-line py-3', pad)} data-testid="skill-done-row" data-kind="rule">
                <CircleCheck size={18} className="shrink-0 text-ok" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-ink">{t('welcome.skills.ruleName')}</span>
                  <span className="ml-2 inline-flex rounded-md border border-line px-1.5 py-0.5 align-middle text-micro font-medium text-muted">{t('welcome.skills.ruleChip')}</span>
                  <span className="block text-label text-muted">{t('welcome.skills.ruleNoteAll')}</span>
                </span>
              </li>
            )}
            {share.tools.filter((x) => x.templateId || x.error).map((x) => (
              <li key={x.name} className={clsx('flex items-start gap-3 border-t border-line py-3', pad)} data-testid="skill-done-row" data-kind="tool">
                {x.templateId ? <CircleCheck size={18} className="shrink-0 text-ok" aria-hidden /> : <CircleAlert size={18} className="shrink-0 text-danger" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-ink">{x.name}</span>
                  <span className={clsx('block text-label', x.templateId ? 'text-muted' : 'text-danger')}>{x.templateId ? t('welcome.skills.doneTool') : x.error}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {group ? <p className="text-label text-muted" data-testid="skills-done-who">{t('skillShare.doneWhoGroup', { group: group.name ?? '' })}</p> : <DoneWho team={team} />}
        {embedded ? (
          onMore && <div><Button variant="ghost" className={clsx('-ml-2.5', phone && 'w-full')} onClick={onMore} disabled={busy} data-testid="skills-more">{t('welcome.skills.more')}</Button></div>
        ) : (
          <div className={phone ? 'space-y-2' : 'flex items-center justify-between gap-3'}>
            <Button variant="primary" className={phone ? 'w-full' : undefined} onClick={onDone} disabled={busy} data-testid="skills-done-next">{doneLabel}</Button>
            {onMore && <Button variant="ghost" className={phone ? 'w-full' : undefined} onClick={onMore} disabled={busy} data-testid="skills-more">{t('welcome.skills.more')}</Button>}
          </div>
        )}
      </div>
    )
  }

  // ---- ready: the list
  const toggle = (name: string, on: boolean) => setTicked((x) => ({ ...(x ?? {}), [name]: on }))
  const row = (c: ShareCandidate, i: number) => {
    const id = `${ids}-${c.name}`
    const choose = c.sameName || c.similar
    return (
      <li key={c.name} className={clsx('flex items-start gap-3 border-line py-3', pad, i > 0 && 'border-t')} data-testid="skill-row" data-name={c.name} data-group={c.group}>
        <input
          id={id}
          type="checkbox"
          checked={!!ticked?.[c.name]}
          onChange={(e) => toggle(c.name, e.target.checked)}
          disabled={applying}
          className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]"
          data-testid="skill-check"
        />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <SkillName c={c} phone={phone} />
          {reasonText(t, c) && <span className="mt-0.5 block text-label text-muted">{reasonText(t, c)}</span>}
        </label>
        {choose && (
          <select
            value={actions[c.name] === 'separate' ? 'separate' : 'merge'}
            onChange={(e) => setActions((x) => ({ ...x, [c.name]: e.target.value as ShareAction }))}
            disabled={applying}
            aria-label={t('welcome.skills.actionLabel', { name: c.title ?? c.name })}
            className="touch-hit h-7 shrink-0 rounded-md border border-field-border bg-surface px-1.5 text-label text-ink max-md:min-h-9"
            data-testid="skill-action"
          >
            <option value="merge">{t('welcome.skills.merge')}</option>
            <option value="separate">{t('welcome.skills.separate')}</option>
          </select>
        )}
      </li>
    )
  }
  const reasons = [...new Set(excluded.map((c) => c.reason))].sort((a, b) => EXCLUDED_ORDER.indexOf(a) - EXCLUDED_ORDER.indexOf(b))
  // no AI judged them: what can go is just what was found (not "나만 쓰는 것, 개발용")
  const unjudged = share.ai === 'none' || share.ai === 'failed'
  const fold = (key: 'other' | 'excluded', label: string, hint: string | null) => (
    <button
      type="button"
      className={clsx('flex min-h-11 w-full items-center gap-1.5 border-t border-line py-2.5 text-left text-sm', pad, !phone && 'hover:bg-hover')}
      aria-expanded={folds[key]}
      aria-controls={`${ids}-${key}`}
      onClick={() => setOpen({ ...folds, [key]: !folds[key] })}
      data-testid={`skills-${key}-toggle`}
    >
      <span className="shrink-0 font-medium text-ink">{label}</span>
      {hint && <span className="min-w-0 truncate text-faint">· {hint}</span>}
      <ChevronDown size={16} className={clsx('ml-auto shrink-0 text-faint transition', folds[key] && 'rotate-180')} aria-hidden />
    </button>
  )
  const shareLabel = group?.name
    ? chosen.length > 0 ? t('skillShare.shareGroup', { group: group.name, n: chosen.length }) : t('skillShare.shareGroupOnly', { group: group.name })
    : labelFor ? labelFor(chosen.length + extras)
    : chosen.length > 0 ? t('welcome.skills.share', { n: chosen.length }) : t('welcome.skills.shareOnly')
  // where it goes: the proposer picks on the share page (the team or one of their groups); a reviewer reads whose it is
  const choices = share.mine !== false && pickTarget ? share.targets ?? [] : []
  let target: ReactNode = null
  if (choices.length > 0) {
    target = (
      <label className="flex flex-wrap items-center gap-2 text-label text-muted" data-testid="skill-share-target-pick">
        <span>{t('skillShare.target')}</span>
        <select
          value={group?.id ?? ''}
          onChange={(e) => void retarget(e.target.value)}
          disabled={applying || moving}
          className="touch-hit h-8 min-w-0 rounded-md border border-field-border bg-surface px-2 text-label text-ink max-md:min-h-9"
          data-testid="skill-share-target"
        >
          <option value="">{t('skillShare.targetTeam', { team })}</option>
          {choices.map((g) => <option key={g.id} value={g.id}>{t('skillShare.targetGroup', { group: g.name })}</option>)}
          {/* the group it goes to now, when it is no choice any more (gone, or no longer the proposer's to write): shown
              as it is, so picking the team still changes it */}
          {group && !choices.some((g) => g.id === group.id) && (
            <option value={group.id} disabled>{group.name === null ? t('skillShare.groupGone') : t('skillShare.targetGroup', { group: group.name })}</option>
          )}
        </select>
      </label>
    )
  } else if (group) {
    target = (
      <p className="text-label text-muted" data-testid="skill-share-target-line">
        {group.name === null ? t('skillShare.groupGone')
          : share.mine === false ? t('skillShare.forGroupBy', { who: share.proposer?.name ?? '', group: group.name })
          : t('skillShare.forGroup', { group: group.name })}
      </p>
    )
  }

  return (
    <div className="space-y-4" data-testid="skill-review" data-status="ready" data-target={group?.id ?? 'team'}>
      <div className="space-y-1">
        {source}
        {noAi}
        {target}
      </div>
      <fieldset className={clsx('min-w-0', frame)} disabled={applying}>
        <legend className="sr-only">{t('welcome.skills.listLabel')}</legend>
        <h3 ref={heading} tabIndex={-1} className={clsx('flex items-center gap-2 pt-3 pb-1 text-sm font-semibold text-ink outline-none', pad, !recommended.length && 'sr-only')} data-testid="skills-recommended">
          {t('welcome.skills.recommended', { n: recommended.length })}
          <Badge tone="accent"><Sparkles size={12} aria-hidden />{t('welcome.skills.recommendedChip')}</Badge>
        </h3>
        {recommended.length > 0 && <ul>{recommended.map(row)}</ul>}
        {other.length > 0 && (
          <>
            {unjudged
              ? fold('other', t('welcome.skills.unjudged', { n: other.length }), null)
              : fold('other', t('welcome.skills.other', { n: other.length }), t('welcome.skills.otherHint'))}
            {folds.other && <ul id={`${ids}-other`} className={phone ? '' : 'bg-subtle'} data-testid="skills-other">{other.map((c) => row(c, 1))}</ul>}
          </>
        )}
        {excluded.length > 0 && (
          <>
            {fold('excluded', t('welcome.skills.excluded', { n: excluded.length }), reasons.map((r) => t(`welcome.skills.short.${r}` as MessageKey)).join(', '))}
            {folds.excluded && (
              <ul id={`${ids}-excluded`} className={phone ? '' : 'bg-subtle'} data-testid="skills-excluded">
                {excluded.map((c) => {
                  const Icon = EXCLUDED_ICON[c.reason] ?? FileQuestionMark
                  return (
                    <li key={c.name} className={clsx('flex items-start gap-3 border-t border-line py-3', pad)} data-testid="skill-row" data-name={c.name} data-group="excluded">
                      <Icon size={18} className="mt-px shrink-0 text-faint" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <SkillName c={c} phone={phone} muted />
                        <span className="mt-0.5 block text-label text-muted">{reasonText(t, c)}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </fieldset>
      {(rule || tools.length > 0) && (
        <div className="space-y-3">
          {rule && (
            <div className="flex items-start gap-3" data-testid="skills-rule">
              <input id={`${ids}-rule`} type="checkbox" checked={ruleOn} onChange={(e) => setRuleOn(e.target.checked)} disabled={applying} className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]" data-testid="skills-rule-check" />
              <span className="min-w-0 flex-1">
                <label htmlFor={`${ids}-rule`} className="cursor-pointer text-sm font-medium text-ink">{t('welcome.skills.rule', { n: rule.lines, file: share.app === 'codex' ? 'AGENTS.md' : 'CLAUDE.md' })}</label>
                <button type="button" className={clsx(quietLink, 'touch-hit ml-2 text-label')} onClick={() => setRuleShown(true)} aria-haspopup="dialog" data-testid="skills-rule-view">{t('welcome.skills.ruleView')}</button>
                <span className="mt-0.5 block text-label text-muted">{rule.dropped > 0 ? t('welcome.skills.ruleNote', { m: rule.dropped }) : t('welcome.skills.ruleNoteAll')}</span>
              </span>
            </div>
          )}
          {tools.length > 0 && (
            <div className="flex items-start gap-3" data-testid="skills-tools">
              <input id={`${ids}-tools`} type="checkbox" checked={toolsOn} onChange={(e) => setToolsOn(e.target.checked)} disabled={applying} className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]" data-testid="skills-tools-check" />
              <label htmlFor={`${ids}-tools`} className="min-w-0 flex-1 cursor-pointer">
                <span className="text-sm font-medium text-ink">{t('welcome.skills.tools', { n: tools.length, names: tools.map((x) => x.name).join(', ') })}</span>
                <span className="mt-0.5 block text-label text-muted">{t('welcome.skills.toolsNote')}</span>
                {/* each address as it will be stored, so a key in it can be seen before it goes to the team */}
                <ul className="mt-1 space-y-0.5 text-label text-muted" data-testid="skills-tools-urls">
                  {tools.map((x) => <li key={x.name} className="min-w-0 font-mono break-all">{x.name} · {x.url}</li>)}
                </ul>
              </label>
            </div>
          )}
        </div>
      )}
      <p className="text-label text-muted" data-testid="skills-who">{group?.name ? t('skillShare.whoGroup', { group: group.name }) : t('welcome.skills.who', { team })}</p>
      {!canApply && group?.name && <p className="text-label text-muted" data-testid="skills-cannot-apply">{t('skillShare.cannotApply')}</p>}
      {error && <ErrorNote onRetry={applying ? undefined : () => void apply()}>{error}</ErrorNote>}
      {!embedded && (
        <div className={phone ? 'space-y-2' : 'flex items-center justify-between gap-3'}>
          <Button variant="primary" className={phone ? 'w-full' : undefined} busy={applying} disabled={!anything || busy || moving || !canApply} onClick={() => void apply()} data-testid="skills-share">
            {!applying && <Users size={15} aria-hidden />} {shareLabel}
          </Button>
          <Button variant="ghost" className={phone ? 'w-full' : undefined} onClick={onLater} disabled={applying || busy} data-testid="skills-later">{laterLabel ?? t('welcome.later')}</Button>
        </div>
      )}
      {rule && (
        <Modal open={ruleShown} onClose={() => setRuleShown(false)} title={t('welcome.skills.ruleTitle')} width={560}>
          <p className="mb-3 text-label text-muted">{rule.dropped > 0 ? t('welcome.skills.ruleNote', { m: rule.dropped }) : t('welcome.skills.ruleNoteAll')}</p>
          <div className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink" data-testid="skills-rule-text">{rule.text}</div>
        </Modal>
      )}
    </div>
  )
}

function DoneRow({ c, phone, first, pad, inSetup }: { c: ShareCandidate; phone: boolean; first: boolean; pad: string; inSetup: boolean }) {
  const t = useT()
  const a = c.applied!
  const into = c.sameName?.title ?? c.similar?.title ?? c.detail ?? ''
  let icon: ReactNode
  let line: ReactNode
  let action: ReactNode = null
  if (a.status === 'added') {
    icon = <CircleCheck size={18} className="shrink-0 text-ok" aria-hidden />
    line = c.reason === 'with_file' && c.detail ? t('welcome.skills.doneWithFile', { file: c.detail }) : t('welcome.skills.doneAdded')
    // during the setup the steps go on: the skill opens from the end screen or the team skills afterwards
    if (a.path && !inSetup) action = <Link to={skillRunLink(a.path)} className={clsx(quietLink, 'touch-hit shrink-0 text-label')} data-testid="skill-done-open">{t('welcome.skills.open')}</Link>
  } else if (a.status === 'later') {
    // a merge into a team skill waits for the end of the setup (then one Inbox notice leads to the merge chat)
    icon = <GitMerge size={18} className="shrink-0 text-faint" aria-hidden />
    line = t('welcome.skills.mergeLater', { x: into })
  } else if (a.status === 'merge') {
    icon = <GitMerge size={18} className="shrink-0 text-accent-text" aria-hidden />
    line = t('welcome.skills.merged', { x: into })
    if (a.chatId) action = <Link to={`/c/${a.chatId}`} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-field-border bg-surface px-2.5 text-label font-medium text-ink hover:bg-hover max-sm:min-h-9" data-testid="skill-done-review">{t('welcome.skills.review')}</Link>
  } else {
    icon = <CircleAlert size={18} className="shrink-0 text-danger" aria-hidden />
    line = <span className="text-danger">{a.error ?? t('error.network')}</span>
  }
  return (
    <li className={clsx('flex items-start gap-3 border-line py-3', pad, !first && 'border-t')} data-testid="skill-done-row" data-kind={a.status} data-name={c.name}>
      {icon}
      <span className="min-w-0 flex-1">
        <SkillName c={c} phone={phone} />
        <span className="mt-0.5 block text-label text-muted">{line}</span>
      </span>
      {action}
    </li>
  )
}

/** A skill an earlier share of the setup added (the progress keeps its path and the name people read): as an added row
 * of this share reads, without 열기 (the steps go on). */
function EarlierRow({ s, phone, first, pad }: { s: { path: string; title: string }; phone: boolean; first: boolean; pad: string }) {
  const t = useT()
  const name = skillNameOf(s.path)
  return (
    <li className={clsx('flex items-start gap-3 border-line py-3', pad, !first && 'border-t')} data-testid="skill-done-row" data-kind="added" data-name={name}>
      <CircleCheck size={18} className="shrink-0 text-ok" aria-hidden />
      <span className="min-w-0 flex-1">
        <SkillName c={{ name, title: s.title }} phone={phone} />
        <span className="mt-0.5 block text-label text-muted">{t('welcome.skills.doneAdded')}</span>
      </span>
    </li>
  )
}

/** "지금은 나만 써요 · 팀원을 초대하면 {team} 모두가 같은 방식으로 써요", or with teammates "{team} n명이 팀 스킬에서 바로
 * 써요" (the people who are active: every one of them sees team skills). Until the count is known, nothing. */
function DoneWho({ team }: { team: string }) {
  const t = useT()
  const [n, setN] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.listUsers).then((r) => live && setN(r.items.filter((u) => u.status === 'active').length), () => live && setN(1))
    return () => { live = false }
  }, [])
  if (n === null) return null
  return <p className="text-label text-muted" data-testid="skills-done-who">{n <= 1 ? t('welcome.skills.doneWho', { team }) : t('welcome.skills.doneWhoCount', { team, n })}</p>
}
