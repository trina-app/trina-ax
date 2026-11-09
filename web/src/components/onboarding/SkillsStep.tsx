// 내 스킬, the owner's welcome step (docs/DECISIONS.md "W6 — Onboarding v6: skills catalog and 내 스킬", "SK — 내 스킬
// 가져오기"; FLOW-v6 §2; pages/Welcome.tsx renders the eyebrow, the progress bar and the focus; this is the heading and
// what is under it). Two parts under one primary:
//  - "트리나가 준비한 스킬": the kept skills the team does not have yet (components/skills/PackRows.tsx: GET
//    /api/onboarding/packs), each with 예시 (the viewer). 회사 소개서, 카드뉴스 and 홍보 영상 come checked when a company
//    profile is saved (all three are made from it), 자연스러운 글 never; no AI decides, and the checks never move while
//    the step is up. Nothing is checked on a revisit of a done step. With every kept skill in the team the part is gone.
//  - "내 스킬 가져오기": the bring-your-own step of before, under it, its folder button secondary. A computer's browser
//    picks a folder (Chrome, Edge: showDirectoryPicker; Safari, Firefox: <input webkitdirectory>), or one is dropped;
//    lib/skillScan.ts reads only the known paths and filters before anything leaves the browser. The Mac App Store app
//    answers the folder input with its own window at .claude. Claude Code or Codex (only with the team connector on)
//    send a proposal from one line behind one disclosure; the step asks every few seconds and shows it as it arrives,
//    on a phone too, and holds back the live notice about it meanwhile. The list is SkillShareReview, embedded: no
//    primary of its own. A check still running after SHARE_CHECK_LIMIT_MS is ended (stop-check): the list then shows
//    with nothing ticked.
// The one primary names what goes in, the kept skills and the own ones alike, up to three ("회사 소개서·카드뉴스·홍보 영상
// 넣기", "카드뉴스·주간 업무 보고 넣기"; from four on "팀에 넣기 · n개"); it waits ("내 스킬 살펴보는 중…") while own skills
// are checked, and hides when nothing is ticked (나중에 하기 takes its style). On press: the ticked own skills go in first
// (their apply records 내 스킬 done), then the checked kept skills (POST …/packs/:id/install per pack; the server runs
// the brand action first on the owner's press and records the step too). All in: a toast and the next step. When
// anything of the press failed, either part, the step stays: what went in is marked, the rest says why (a name taken,
// folder rules, a request that failed, with 다시 for only those; an own skill's error stays on screen until its own 다시
// or the primary sends the press again), and once nothing is left to send the primary reads 다음. 나중에 하기 installs
// nothing and drops an open own list. A phone: the same rows with their lines, and one line that own skills go in on
// a computer.
// The step opens on what the person already has (GET /api/skill-shares, newest first; shownShare): the newest proposal
// still open, a share applied elsewhere since the step opened, and once 내 스킬 is done the newest share applied.
import clsx from 'clsx'
import { Check, ChevronDown, Copy, FolderOpen, Laptop, Loader2, Terminal } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { CONNECTOR_SHARE_SOURCES, type CreateSkillShare, type PackCatalogSkill, type SkillShare, type SkillShareSource } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { answersFileInputs, isDesktop } from '../../lib/desktop'
import { canPickHandle, canPickInput, droppedFolder, fromFiles, pickClaudeFolder, scanFolder, type ScanDir } from '../../lib/skillScan'
import { useLocale, useT } from '../../i18n'
import { namedProduct } from '../../lib/tabs'
import { holdToasts, toast, type Toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { CONNECTOR_NAME, CopyLine } from '../integrations/AiAppConnect'
import { installPacks, outcomeEmpty, PackNotes, PackRows, usePackCatalog, type PackInstallOutcome } from '../skills/PackRows'
import { Button, ErrorNote, Skeleton, useMediaQuery } from '../ui'
import { FolderHint } from './FolderHint'
import { quietLink, SkillShareReview, type ShareReviewHandle, type ShareReviewState } from './SkillShareReview'

/** How often the empty step asks whether Claude Code sent a proposal. */
export const CLAUDE_CODE_POLL_MS = 3000
/** A proposal made this long before the step opened still counts as new (the server's clock and this one differ). */
export const CLOCK_SLACK_MS = 30_000
/** How long the step waits for the AI's check of own skills before it ends it (walk review M2). */
export const SHARE_CHECK_LIMIT_MS = 30_000
/** The primary names what it puts in while it covers at most this many items. */
const NAMED_MAX = 3

const fromConnector = (s: SkillShareSource) => (CONNECTOR_SHARE_SOURCES as readonly SkillShareSource[]).includes(s)

/**
 * What the step shows of the person's own proposals (GET /api/skill-shares, newest first); null: the picker.
 * - a share applied since `since` (its link or notice, another tab): as done;
 * - else the newest of: a proposal still open (checking, which turns ready; or ready, also one with some rows applied
 *   and some failed), from any source; and once 내 스킬 is done (`done`), a share applied (what went in);
 * - `fresh` (the person let go of what was shown: 그만 찾기, 다른 폴더도 가져오기): only a proposal made since `since`.
 * Dismissed and expired ones never show, nor the ones this step let go of (`gone`), nor one to a group (the step shares
 * with the team: docs/DECISIONS.md "Group skills"; a proposal to a group is done on its own page).
 */
export function shownShare(items: readonly SkillShare[], o: { since: number; done: boolean; gone: ReadonlySet<string>; fresh?: boolean }): SkillShare | null {
  const live = items.filter((s) => !o.gone.has(s.id) && !s.targetGroup)
  const appliedSince = live.find((s) => s.status === 'applied' && Date.parse(s.updatedAt ?? s.createdAt) >= o.since)
  if (appliedSince) return appliedSince
  return live.find((s) => {
    if (s.status === 'checking' || s.status === 'ready') return !o.fresh || Date.parse(s.createdAt) >= o.since
    return s.status === 'applied' && o.done && !o.fresh
  }) ?? null
}

/** The live notice about a proposal Claude Code or Codex sent (server/src/skills/share.ts "proposed", shown by
 * store/live.ts as a toast with the team skills' action and no code of its own): its action label and the app's name in
 * its text. Matched on those because the toast carries nothing else; a skill notice that names neither app shows. */
export function isProposalToast(t: Pick<Toast, 'text' | 'action'>, openLabel: string): boolean {
  return t.action?.label === openLabel && /Claude Code|Codex/.test(t.text)
}

/** The kept skills checked when the step first shows them: the visual ones when a company profile is saved, none on a
 * revisit of a done step. */
export function preChecked(rows: readonly Pick<PackCatalogSkill, 'name' | 'visual'>[], o: { profile: boolean; done: boolean }): Set<string> {
  return new Set(o.done || !o.profile ? [] : rows.filter((r) => r.visual).map((r) => r.name))
}

/** The primary's words (null: nothing to put in). `kept`: the titles of the checked kept skills; `own`: the titles of
 * the own skills ticked; `extras`: the team rule and the tools when ticked (they have no skill name). Up to NAMED_MAX
 * items every skill is named, kept and own alike ("…외 n개" for the extras); more: "팀에 넣기 · n개". */
export function primaryLabel(t: ReturnType<typeof useT>, kept: readonly string[], own: readonly string[] = [], extras = 0): string | null {
  const names = [...kept, ...own]
  const n = names.length + extras
  if (!n) return null
  if (n > NAMED_MAX || !names.length) return t('welcome.skills.putN', { n })
  return extras ? t('welcome.skills.putMore', { names: names.join('·'), n: extras }) : t('welcome.skills.put', { names: names.join('·') })
}

/** Picking a skill folder (the folder window, the folder input, a drop) and reading it here: what both 내 스킬 and the
 * Team skills page's bring-your-own sheet do before a proposal is made. `onFound` gets the body to send. */
export function useSkillPick({ busy, onFound }: { busy?: boolean; onFound: (body: CreateSkillShare) => Promise<void> }) {
  const t = useT()
  const locale = useLocale()
  // only the Mac App Store build answers the page's folder input with its own window (opened at .claude); any other
  // desktop build picks like a browser
  const app = answersFileInputs()
  const handle = !app && canPickHandle()
  const source = isDesktop() ? 'desktop' : 'browser'
  const [reading, setReading] = useState(false)
  const [misses, setMisses] = useState(0)
  const [none, setNone] = useState(false)
  const [error, setError] = useState<{ text: string; retry?: () => void } | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  /** a folder to read (null: the window was closed, nothing happens) */
  const begin = async (dir: ScanDir | null) => {
    if (!dir) return
    setReading(true)
    setError(null)
    try {
      const r = await scanFolder(dir, source)
      if (!r.body) {
        setNone(true)
        setMisses((m) => m + 1)
        return
      }
      setNone(false)
      await onFound(r.body)
    } catch (e) {
      setError({ text: errorText(e, locale, t('error.network')) })
    } finally {
      setReading(false)
    }
  }
  /** straight from the click: the folder window needs it */
  const pick = () => {
    if (reading || busy) return
    if (handle) pickClaudeFolder().then((d) => begin(d), (e) => setError({ text: errorText(e, locale, t('error.network')) }))
    else input.current?.click()
  }
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const dropProps = {
    onDragOver: (e: DragEvent) => { if (hasFiles(e) && !busy) { e.preventDefault(); setOver(true) } },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(false)
      if (reading || busy) return
      // read now: the browser empties the list when the event ends
      const dir = droppedFolder(e.dataTransfer)
      if (dir) void begin(dir)
      else { setNone(true); setMisses((m) => m + 1) }
    },
  }
  const folderInput = (
    <input
      ref={input}
      type="file"
      className="hidden"
      // not in React's types; the Mac App Store app opens its own window at the home folder with .claude picked
      {...{ webkitdirectory: '' }}
      data-open-at="claude"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        if (files.length) void begin(fromFiles(files))
      }}
      data-testid="skills-input"
    />
  )
  const reset = () => { setNone(false); setMisses(0); setError(null) }
  return { app, handle, source, reading, misses, none, error, setError, over, pick, dropProps, folderInput, reset }
}

export interface SkillsStepProps {
  /** the team's name, for the who lines */
  team: string
  /** the primary once there is nothing to put in and 내 스킬 is done (e.g. "다음: 팀 파일 가져오기") */
  nextLabel: string
  /** once, right after an own apply succeeded (the parent reads the progress again) */
  onApplied: (share: SkillShare) => void
  /** on to the next step, 내 스킬 done */
  onNext: () => void
  /** 나중에 하기, or 다음 after a press that put nothing in */
  onSkip: () => void
  busy?: boolean
  /** one note under the heading (the parent's: e.g. the brand files not placed) */
  note?: ReactNode
}

function StepHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {desc && <p className="text-sm text-balance text-muted">{desc}</p>}
    </div>
  )
}

export function SkillsStep({ team, nextLabel, onApplied, onNext, onSkip, busy, note }: SkillsStepProps) {
  const t = useT()
  const locale = useLocale()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const [share, setShare] = useState<SkillShare | null>(null)
  const [remote, setRemote] = useState<{ configured: boolean; resource: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const [how, setHow] = useState(false)
  const [ccOpen, setCcOpen] = useState(false)
  const openedAt = useRef(Date.now())
  // proposals this step let go of (그만 찾기, a newer folder, 다른 폴더도 가져오기): never shown again here
  const gone = useRef(new Set<string>())
  // the person let go of what was shown: from then on only a proposal made since the step opened shows
  const fresh = useRef(false)
  // the first look at the person's proposals is in (until then the own part shows no picker that a list would replace)
  const [looked, setLooked] = useState(false)
  // 내 스킬 is done (the steps' progress, loaded by pages/Welcome.tsx): a revisit shows what went in, checks nothing
  const done = useWelcome((s) => s.progress?.steps.skills === 'done')
  // every skill shared in these steps so far (the server keeps them: `shared.skills`): what went in lists them all
  const sharedSoFar = useWelcome((s) => s.progress?.shared?.skills)
  const doneRef = useRef(done)
  doneRef.current = done
  const shareRef = useRef(share)
  shareRef.current = share

  // the kept skills: the rows are the ones missing when the step first gets them, and stay (checks never move)
  const { catalog, failed: catalogFailed, reload } = usePackCatalog()
  const [rows, setRows] = useState<PackCatalogSkill[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  if (catalog && rows === null) {
    const missing = catalog.skills.filter((s) => !s.inTeam)
    setRows(missing)
    setChecked(preChecked(missing, { profile: catalog.profile, done }))
  }
  const [outcome, setOutcome] = useState<PackInstallOutcome | null>(null)
  // the own list's state (embedded) and its apply
  const [own, setOwn] = useState<ShareReviewState | null>(null)
  const review = useRef<ShareReviewHandle>(null)
  const [pressing, setPressing] = useState(false)
  // after a press: own skills that went in, and the press's own error (an own apply that failed)
  const [ownIn, setOwnIn] = useState(0)
  const [pressError, setPressError] = useState<string | null>(null)
  const pressed = outcome !== null || ownIn > 0

  const pick = useSkillPick({ busy: busy || pressing, onFound: (body) => send(body) })
  const app = pick.app
  const phone = narrow || (!app && !pick.handle && !canPickInput())

  // the step lists a proposal itself: the live notice about one is held back while the step is on screen
  const openLabel = t('notice.openSkills')
  useEffect(() => holdToasts((x) => isProposalToast(x, openLabel)), [openLabel])

  // the Claude Code / Codex line shows only when this server has the connector on
  useEffect(() => {
    let live = true
    api.call(API.listRemoteConnectors).then((r) => live && setRemote({ configured: r.configured && !!r.resource, resource: r.resource }), () => live && setRemote({ configured: false, resource: null }))
    return () => { live = false }
  }, [])

  // while no list is on screen: the person's proposals (shownShare), once as the step opens (a list left behind, what
  // went in) and, with the connector on, every few seconds (a proposal Claude Code or Codex sends, a share applied
  // elsewhere: /skills/share/:id)
  const idle = !share
  const polling = !!remote?.configured
  useEffect(() => {
    if (!idle) return
    let live = true
    const look = async () => {
      try {
        const r = await api.call(API.listSkillShares, { query: {} })
        const found = shownShare(r.items, { since: openedAt.current - CLOCK_SLACK_MS, done: doneRef.current, gone: gone.current, fresh: fresh.current })
        if (live && found && !shareRef.current) setShare(found)
      } catch { /* the next tick asks again; a first look that fails leaves the picker */ }
    }
    void look().finally(() => { if (live) setLooked(true) })
    if (!polling) return () => { live = false }
    const id = setInterval(() => void look(), CLAUDE_CODE_POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [idle, polling])

  async function send(body: CreateSkillShare) {
    pick.setError(null)
    try {
      const s = await api.call(API.createSkillShare, { body })
      const before = shareRef.current
      if (before && before.id !== s.id) {
        gone.current.add(before.id)
        void api.call(API.dismissSkillShare, { params: { id: before.id } }).catch(() => {})
      }
      setShare(s)
    } catch (e) {
      pick.setError({ text: errorText(e, locale, t('error.network')), retry: () => void send(body) })
    }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(t('welcome.skills.cc.prompt')) } catch { /* the line stays selectable */ }
    setCopied(true)
  }
  /** drop the own list on screen (not one already applied) */
  const dropShare = () => {
    const s = shareRef.current
    if (s && s.status !== 'applied') {
      gone.current.add(s.id)
      void api.call(API.dismissSkillShare, { params: { id: s.id } }).catch(() => {})
    }
  }
  const later = () => { dropShare(); onSkip() }

  // ---- the primary
  const keptChecked = (rows ?? []).filter((r) => checked.has(r.name) && !outcome?.went.includes(r.name))
  // the list's own state as it is now (it reads the share again while the server checks it, and after an apply); the
  // share this step was handed is only where it started
  const ownList = own && share && own.id === share.id ? own : null
  const ownStatus = ownList?.status ?? share?.status ?? null
  const ownReady = ownStatus === 'ready' && ownList ? ownList : null
  const ownCount = ownReady ? ownReady.count + ownReady.extras : 0
  const checking = ownStatus === 'checking'
  // what failed on the press before: the kept skills to send again (a 다시, or the primary)
  const keptFailed = (rows ?? []).filter((r) => outcome?.failed.includes(r.name))
  const label = primaryLabel(t, keptChecked.map((r) => r.title), ownReady?.names ?? [], ownReady?.extras ?? 0)
  // something went in: on this press, before (내 스킬 done), or a share applied elsewhere since the step opened
  const anythingIn = ownIn > 0 || !!outcome?.went.length || done || ownStatus === 'applied'

  /** the kept skills of a press (or of 다시), and what then: on with a toast only when nothing of the press failed
   * (`ownFailed`: the own part's error still stands; it stays on screen) */
  const putKept = async (items: PackCatalogSkill[], ownNow: number, ownFailed: boolean) => {
    const r = items.length ? await installPacks(items) : outcomeEmpty()
    // a retry keeps what the press before it said about the others (a name taken stays said, a failure not retried stays)
    const tried = new Set(items.map((s) => s.name))
    const failedBefore = (outcome?.failed ?? []).filter((n) => !tried.has(n))
    const all: PackInstallOutcome = {
      went: [...(outcome?.went ?? []), ...r.went], taken: [...(outcome?.taken ?? []), ...r.taken], blocked: [...(outcome?.blocked ?? []), ...r.blocked],
      failed: [...failedBefore, ...r.failed], error: r.failed.length ? r.error : failedBefore.length ? outcome?.error ?? null : null,
    }
    setOutcome(all)
    // what a press tried leaves the checks: what went in is marked, the rest says why (and 다시 retries the failed ones)
    setChecked((x) => { const next = new Set(x); for (const s of items) next.delete(s.name); return next })
    if (!ownFailed && !all.failed.length && !all.taken.length && !all.blocked.length) {
      const n = ownNow + all.went.length
      if (n > 0) toast({ level: 'success', text: t('welcome.skills.installed', { n }) })
      onNext()
    }
  }
  const press = async () => {
    if (pressing || busy) return
    setPressing(true)
    setPressError(null)
    try {
      let ownNow = ownIn
      // the checked kept skills and the ones that failed before: a press is also the retry of both parts
      const items = [...keptChecked, ...keptFailed.filter((r) => !keptChecked.includes(r))]
      if (ownCount > 0 && review.current) {
        try {
          const s = await review.current.apply()
          ownNow = s.candidates.filter((c) => c.applied && c.applied.status !== 'failed').length + (s.rule?.path ? 1 : 0) + s.tools.filter((x) => x.templateId).length
          setOwnIn(ownNow)
          const failedOwn = s.candidates.filter((c) => c.applied?.status === 'failed')
          if (failedOwn.length) {
            // some own skills did not go in: the step stays and says why (the kept ones still go in, and never move on)
            setPressError(failedOwn[0]!.applied!.error ?? t('error.network'))
            await putKept(items, ownNow, true)
            return
          }
        } catch (e) {
          // nothing went: 다시 is the same press
          setPressError(errorText(e, locale, t('error.network')))
          return
        }
      }
      await putKept(items, ownNow, false)
    } finally {
      setPressing(false)
    }
  }
  /** 다시 under the kept skills' note: only those again; the own part's error, when there is one, stays and holds the step */
  const retryKept = () => {
    if (!keptFailed.length || pressing) return
    setPressing(true)
    void putKept(keptFailed, ownIn, !!pressError).finally(() => setPressing(false))
  }

  const ccBlock = remote?.configured ? (
    <div className="space-y-2" data-testid="skills-cc">
      <button type="button" className={clsx('flex min-h-9 items-center gap-1.5 text-label text-muted hover:text-ink', 'touch-hit')} aria-expanded={ccOpen} aria-controls="skills-cc-body" onClick={() => setCcOpen((x) => !x)} data-testid="skills-cc-toggle">
        <Terminal size={15} className="shrink-0 text-faint" aria-hidden />
        {t(phone ? 'welcome.skills.ccFoldPhone' : 'welcome.skills.ccFold')}
        <ChevronDown size={15} className={clsx('shrink-0 text-faint transition', ccOpen && 'rotate-180')} aria-hidden />
      </button>
      {ccOpen && (
        <div id="skills-cc-body" className="space-y-2">
          <p className="text-label leading-5 text-muted">{t(phone ? 'welcome.skills.cc.leadPhone' : 'welcome.skills.cc.lead')}</p>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3">
            <span className="min-w-0 flex-1 text-sm break-words text-ink" data-testid="skills-cc-prompt">{t('welcome.skills.cc.prompt')}</span>
            {copied ? (
              <span className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-label font-medium text-muted" data-testid="skills-cc-copied">
                <Check size={15} aria-hidden /> {t('welcome.skills.cc.copied')}
              </span>
            ) : (
              <Button size="sm" className="shrink-0" onClick={() => void copy()} data-testid="skills-cc-copy">
                <Copy size={15} aria-hidden /> {t('common.copy')}
              </Button>
            )}
          </div>
          {copied && (
            <p className="flex items-center gap-2 pt-1 text-label text-muted" role="status" aria-live="polite" data-testid="skills-cc-waiting">
              <Loader2 size={15} className="shrink-0 animate-spin text-faint" aria-hidden />
              <span>{t('welcome.skills.cc.waiting')}</span>
            </p>
          )}
          <p className="text-xs text-faint">
            {t('welcome.skills.cc.connect')}
            <span aria-hidden> · </span>
            <button type="button" className={clsx(quietLink, 'touch-hit')} aria-expanded={how} aria-controls="skills-cc-how" onClick={() => setHow((x) => !x)} data-testid="skills-cc-how-toggle">{t('welcome.skills.cc.how')}</button>
          </p>
          {how && remote.resource && (
            // once per app: Claude Code adds the server and signs in with /mcp; Codex signs in as it adds it
            <div id="skills-cc-how" className="space-y-2 text-label text-muted" data-testid="skills-cc-how">
              <p className="font-medium text-ink">Claude Code</p>
              <p>{t('welcome.skills.cc.step1')}</p>
              <CopyLine text={`claude mcp add --transport http ${CONNECTOR_NAME} ${remote.resource}`} testId="skills-cc-command" />
              <p>{t('welcome.skills.cc.step2')}</p>
              <CopyLine text="/mcp" testId="skills-cc-mcp" />
              <p className="pt-2 font-medium text-ink">Codex</p>
              <p>{t('welcome.skills.cc.codexStep')}</p>
              <CopyLine text={`codex mcp add ${CONNECTOR_NAME} --url ${remote.resource}`} testId="skills-cc-codex-command" />
            </div>
          )}
        </div>
      )}
    </div>
  ) : null

  // ---- the kept skills' part
  let keptPart: ReactNode = null
  if (catalogFailed && !rows) {
    keptPart = <div data-testid="skill-packs-failed"><ErrorNote onRetry={reload}>{t('skillPack.loadFailed')}</ErrorNote></div>
  } else if (!rows) {
    keptPart = <Skeleton lines={3} />
  } else if (rows.length) {
    keptPart = (
      <section className="space-y-1" aria-labelledby="skills-packs-title" data-testid="skill-packs">
        <h3 id="skills-packs-title" className="text-sm font-semibold text-ink">{t('skills.catalog.title', namedProduct(t))}</h3>
        <PackRows
          items={rows}
          checked={checked}
          onToggle={(name, on) => setChecked((x) => { const next = new Set(x); if (on) next.add(name); else next.delete(name); return next })}
          outcome={outcome}
          disabled={pressing || busy}
        />
        <div className="space-y-2 pt-1">
          {/* own skills went in and the kept ones did not: one note says both, with 다시 for only the kept ones */}
          <PackNotes outcome={outcome} onRetry={pressing ? undefined : retryKept} failedText={ownIn > 0 && !outcome?.went.length ? t('welcome.skills.partOwn', { k: ownIn }) : undefined} />
        </div>
      </section>
    )
  }

  // ---- the own skills' part
  let ownPart: ReactNode
  if (share) {
    ownPart = (
      <>
        <SkillShareReview
          share={share}
          team={team}
          doneLabel={nextLabel}
          onDone={onNext}
          onApplied={onApplied}
          onLater={later}
          onStopped={() => { gone.current.add(share.id); fresh.current = true; setOwn(null); setShare(null) }}
          onOtherFolder={fromConnector(share.source) || phone ? undefined : pick.pick}
          // what went in, on a computer: back to the picker for a second folder (this share is not shown again)
          onMore={phone ? undefined : () => { gone.current.add(share.id); fresh.current = true; pick.reset(); setOwn(null); setShare(null) }}
          busy={busy || pick.reading || pressing}
          // the welcome steps: setup is not finished while this step is on screen
          inSetup
          earlier={sharedSoFar}
          embedded
          onState={setOwn}
          handle={review}
          checkLimitMs={SHARE_CHECK_LIMIT_MS}
        />
        {!phone && !fromConnector(share.source) && pick.folderInput}
        {pick.error && <ErrorNote onRetry={pick.error.retry}>{pick.error.text}</ErrorNote>}
      </>
    )
  } else if (!looked) {
    ownPart = <Skeleton lines={2} />
  } else if (phone) {
    ownPart = (
      <>
        <p className="text-label text-muted" data-testid="skills-phone-own">{t('welcome.skills.phoneOwn')}</p>
        {ccBlock}
      </>
    )
  } else {
    // the hint for the folder window: Claude's folder, and Codex's beside it (FolderHint.tsx, shared with a member's
    // skill folder pick)
    ownPart = (
      <>
        <div
          className={clsx('space-y-2 rounded-xl transition', pick.over && 'bg-accent-soft/70 outline-2 outline-offset-[10px] outline-accent/55 outline-dashed')}
          {...pick.dropProps}
          data-testid="skills-drop"
          data-over={pick.over || undefined}
        >
          {pick.folderInput}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <Button busy={pick.reading} disabled={busy || pressing} onClick={pick.pick} className="shrink-0" data-testid="skills-find">
              {!pick.reading && (app ? <Laptop size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />)} {t(app ? 'welcome.skills.findDesktop' : 'welcome.skills.find')}
            </Button>
            {pick.over ? (
              <p className="flex min-w-0 flex-[1_1_16rem] items-center gap-2 text-label font-medium text-accent-text" data-testid="skills-drop-hint">
                <FolderOpen size={15} aria-hidden /> {t('welcome.skills.drop')}
              </p>
            ) : (
              <p className="min-w-0 flex-[1_1_16rem] text-label leading-6 text-muted" data-testid="skills-hint"><FolderHint app={app} handle={pick.handle} /></p>
            )}
          </div>
          <p className="text-xs text-faint" data-testid="skills-promise">{t('welcome.skills.promise')}</p>
          {pick.reading && <p className="sr-only" role="status">{t('welcome.skills.reading')}</p>}
          {pick.none && <p className="text-label text-muted" role="status" data-testid="skills-none">{t('welcome.skills.none')}</p>}
          {pick.error && <ErrorNote onRetry={pick.error.retry}>{pick.error.text}</ErrorNote>}
        </div>
        {ccBlock}
      </>
    )
  }

  // after a press, or on a revisit of a done step, with nothing left to put in: 다음
  const showNext = !label && !checking && (anythingIn || pressed)
  const primary = checking ? (
    <Button variant="primary" disabled className={phone ? 'w-full' : undefined} data-testid="skills-primary" data-state="checking">
      <Loader2 size={15} className="animate-spin" aria-hidden /> {t('welcome.skills.checking')}
    </Button>
  ) : label ? (
    <Button variant="primary" busy={pressing || ownList?.applying} disabled={busy} className={phone ? 'w-full' : undefined} onClick={() => void press()} data-testid="skills-primary" data-state="put">{label}</Button>
  ) : showNext ? (
    <Button variant="primary" disabled={busy || pressing} className={phone ? 'w-full' : undefined} onClick={anythingIn ? onNext : onSkip} data-testid="skills-primary" data-state="next">{nextLabel}</Button>
  ) : null

  return (
    <div className="space-y-6" data-testid="skills-step" data-state={share ? ownStatus ?? share.status : phone ? 'phone' : looked ? 'empty' : 'looking'}>
      <div className="space-y-2">
        <StepHead title={t('welcome.skills.title')} desc={t('welcome.skills.desc')} />
        {note}
      </div>
      {keptPart}
      <section className={clsx('space-y-3', keptPart && 'border-t border-line pt-5')} aria-labelledby="skills-own-title" data-testid="skills-own">
        <div className="space-y-0.5">
          <h3 id="skills-own-title" className="text-sm font-semibold text-ink">{t('welcome.skills.bring')}</h3>
          {!share && !phone && <p className="text-label text-muted">{t('welcome.skills.bringLead')}</p>}
        </div>
        {ownPart}
      </section>
      {pressError && <ErrorNote onRetry={pressing ? undefined : () => void press()}>{pressError}</ErrorNote>}
      <div className={phone ? 'space-y-2' : 'flex items-center justify-between gap-3'}>
        {primary ?? <span />}
        {!done && (
          <Button variant={primary ? 'ghost' : 'primary'} className={phone ? 'w-full' : undefined} onClick={later} disabled={busy || pressing || pick.reading} data-testid="skills-later">{t('welcome.later')}</Button>
        )}
      </div>
    </div>
  )
}
