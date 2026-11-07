// 내 스킬 가져오기, the welcome step (docs/DECISIONS.md "SK — 내 스킬 가져오기"; pages/Welcome.tsx renders the eyebrow,
// the progress bar and the focus; this is the heading and what is under it). Three ways in, one list:
//  - a computer's browser: [내 스킬 찾기] opens the folder window (Chrome, Edge: showDirectoryPicker; Safari, Firefox:
//    <input webkitdirectory>, whose hint asks for .claude/skills), and a folder dropped on the step works everywhere.
//    lib/skillScan.ts reads only the known paths and filters before anything leaves the browser;
//  - the Mac App Store app (answersFileInputs(), the one build that answers the page's file inputs itself): [이 컴퓨터에서 찾기]
//    is an <input webkitdirectory data-open-at="claude">, which it answers with its own window opened at the home
//    folder, .claude shown and picked; any other desktop build picks like a browser (proposals say "desktop");
//  - Claude Code or Codex (only when this server has the connector on; both reach it as a remote MCP server with
//    OAuth, docs/DECISIONS.md "W5"): one line to paste in either; the step asks the server every few seconds for a
//    proposal one of them sent and shows it as it arrives, on a phone too. While the step is on screen the live notice
//    about a proposal is held back (store/ui.ts holdToasts): the step lists it itself.
// The step opens on what the person already has (GET /api/skill-shares, their own, newest first; shownShare): the
// newest proposal still open (checking or ready, from any source), so leaving the step (the deck, 팀 스킬, a reload)
// and coming back finds the list again instead of the picker; a share applied elsewhere since the step opened (its
// link or notice opens /skills/share/:id) as done; and once 내 스킬 is done (the welcome progress), the newest share
// applied, so 이전 from the next step shows what went in. Under what went in, "다른 폴더도 가져오기" (on a computer)
// goes back to the picker for a second folder (Claude Code and Codex side by side); the primary stays the next step.
// What went in lists every skill shared in these steps (the progress's `shared.skills`), not only the last folder's.
// A picked folder may be Claude's (.claude) or Codex's (.codex, .agents): lib/skillScan.ts tells them apart.
// Then components/onboarding/SkillShareReview.tsx (checking, the list, what went in). A phone (or a browser that
// cannot pick folders) gets the phone version: skills live on a computer, so its primary goes on and the step waits
// there. The person closing the folder window changes nothing.
import clsx from 'clsx'
import { ArrowRight, Check, Copy, FolderOpen, Laptop, Loader2, Terminal } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { CONNECTOR_SHARE_SOURCES, type CreateSkillShare, type SkillShare, type SkillShareSource } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { answersFileInputs, isDesktop } from '../../lib/desktop'
import { canPickHandle, canPickInput, droppedFolder, fromFiles, pickClaudeFolder, scanFolder, type ScanDir } from '../../lib/skillScan'
import { useLocale, useT } from '../../i18n'
import { holdToasts, type Toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { CONNECTOR_NAME, CopyLine } from '../integrations/AiAppConnect'
import { Button, ErrorNote, Skeleton, useMediaQuery } from '../ui'
import { FolderHint } from './FolderHint'
import { quietLink, SkillShareReview } from './SkillShareReview'

/** How often the empty step asks whether Claude Code sent a proposal. */
export const CLAUDE_CODE_POLL_MS = 3000
/** A proposal made this long before the step opened still counts as new (the server's clock and this one differ). */
export const CLOCK_SLACK_MS = 30_000

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

export interface SkillsStepProps {
  /** the team's name, for the who lines */
  team: string
  /** label of the primary after sharing, and of the phone's primary (e.g. "다음: 팀 파일 가져오기") */
  nextLabel: string
  /** once, right after an apply succeeded (the parent records the step done) */
  onApplied: (share: SkillShare) => void
  /** the done state's primary */
  onNext: () => void
  /** "나중에 하기" on a computer (also after dismissing a list) */
  onSkip: () => void
  /** the phone's primary (put off for a computer) */
  onPhoneNext: () => void
  busy?: boolean
}

function StepHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {desc && <p className="text-sm text-balance text-muted">{desc}</p>}
    </div>
  )
}

export function SkillsStep({ team, nextLabel, onApplied, onNext, onSkip, onPhoneNext, busy }: SkillsStepProps) {
  const t = useT()
  const locale = useLocale()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  // only the Mac App Store build answers the page's folder input with its own window (opened at .claude); any other
  // desktop build picks like a browser
  const app = answersFileInputs()
  const handle = !app && canPickHandle()
  const phone = narrow || (!app && !handle && !canPickInput())
  const source = isDesktop() ? 'desktop' : 'browser'
  const [share, setShare] = useState<SkillShare | null>(null)
  const [reading, setReading] = useState(false)
  const [misses, setMisses] = useState(0)
  const [none, setNone] = useState(false)
  const [error, setError] = useState<{ text: string; retry?: () => void } | null>(null)
  const [over, setOver] = useState(false)
  const [remote, setRemote] = useState<{ configured: boolean; resource: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const [how, setHow] = useState(false)
  const openedAt = useRef(Date.now())
  // proposals this step let go of (그만 찾기, a newer folder, 다른 폴더도 가져오기): never shown again here
  const gone = useRef(new Set<string>())
  // the person let go of what was shown: from then on only a proposal made since the step opened shows
  const fresh = useRef(false)
  // the first look at the person's proposals is in (until then the step shows no picker that a list would replace)
  const [looked, setLooked] = useState(false)
  // 내 스킬 is done (the steps' progress, loaded by pages/Welcome.tsx): a revisit shows what went in
  const done = useWelcome((s) => s.progress?.steps.skills === 'done')
  // every skill shared in these steps so far (the server keeps them: `shared.skills`): what went in lists them all, not
  // only the last folder's (다른 폴더도 가져오기, Claude Code and Codex side by side)
  const sharedSoFar = useWelcome((s) => s.progress?.shared?.skills)
  const doneRef = useRef(done)
  doneRef.current = done
  const input = useRef<HTMLInputElement>(null)
  const shareRef = useRef(share)
  shareRef.current = share

  // the step lists a proposal itself: the live notice about one is held back while the step is on screen
  const openLabel = t('notice.openSkills')
  useEffect(() => holdToasts((x) => isProposalToast(x, openLabel)), [openLabel])

  // the Claude Code / Codex block shows only when this server has the connector on
  useEffect(() => {
    let live = true
    api.call(API.listRemoteConnectors).then((r) => live && setRemote({ configured: r.configured && !!r.resource, resource: r.resource }), () => live && setRemote({ configured: false, resource: null }))
    return () => { live = false }
  }, [])

  // while nothing is on screen: the person's proposals (shownShare), once as the step opens (a list left behind, what
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

  const send = async (body: CreateSkillShare) => {
    setError(null)
    try {
      const s = await api.call(API.createSkillShare, { body })
      const before = shareRef.current
      if (before && before.id !== s.id) {
        gone.current.add(before.id)
        void api.call(API.dismissSkillShare, { params: { id: before.id } }).catch(() => {})
      }
      setNone(false)
      setShare(s)
    } catch (e) {
      setError({ text: errorText(e, locale, t('error.network')), retry: () => void send(body) })
    }
  }
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
      await send(r.body)
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
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    if (reading || busy) return
    // read now: the browser empties the list when the event ends
    const dir = droppedFolder(e.dataTransfer)
    if (dir) void begin(dir)
    else { setNone(true); setMisses((m) => m + 1) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(t('welcome.skills.cc.prompt')) } catch { /* the line stays selectable */ }
    setCopied(true)
  }
  const later = () => {
    const s = shareRef.current
    if (s && s.status !== 'applied') {
      gone.current.add(s.id)
      void api.call(API.dismissSkillShare, { params: { id: s.id } }).catch(() => {})
    }
    onSkip()
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

  const ccBlock = remote?.configured ? (
    <div className="space-y-2" data-testid="skills-cc">
      <p className="flex items-start gap-2 text-label leading-5 text-muted">
        <Terminal size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <span>{t(phone ? 'welcome.skills.cc.leadPhone' : 'welcome.skills.cc.lead')}</span>
      </p>
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
  ) : null

  // a proposal on screen: the heading and its list (checking, the list, done)
  if (share) {
    return (
      <div className="space-y-5" data-testid="skills-step" data-state={share.status}>
        <StepHead title={t('welcome.skills.title')} />
        <SkillShareReview
          share={share}
          team={team}
          doneLabel={nextLabel}
          onDone={onNext}
          onApplied={onApplied}
          // on a phone "later" waits for the computer (the proposal stays); on a computer it is dropped
          onLater={phone ? onPhoneNext : later}
          onStopped={() => { gone.current.add(share.id); fresh.current = true; setShare(null) }}
          onOtherFolder={fromConnector(share.source) || phone ? undefined : pick}
          // what went in, on a computer: back to the picker for a second folder (this share is not shown again)
          onMore={phone ? undefined : () => { gone.current.add(share.id); fresh.current = true; setNone(false); setMisses(0); setError(null); setShare(null) }}
          busy={busy || reading}
          // the welcome steps: setup is not finished while this step is on screen
          inSetup
          earlier={sharedSoFar}
        />
        {!phone && !fromConnector(share.source) && folderInput}
        {error && <ErrorNote onRetry={error.retry}>{error.text}</ErrorNote>}
      </div>
    )
  }

  // the first look is not in yet: a list left behind (or what went in) would replace the picker under the pointer
  if (!looked) {
    return (
      <div className="space-y-5" data-testid="skills-step" data-state="looking" aria-busy>
        <StepHead title={t('welcome.skills.title')} />
        <Skeleton lines={3} />
      </div>
    )
  }

  if (phone) {
    return (
      <div className="space-y-6" data-testid="skills-step" data-state="phone">
        <StepHead title={t('welcome.skills.title')} desc={t('welcome.skills.descPhone')} />
        {ccBlock}
        <div className="space-y-2 pt-2">
          <Button variant="primary" className="w-full" onClick={onPhoneNext} disabled={busy} data-testid="skills-phone-next">
            <ArrowRight size={15} aria-hidden /> {nextLabel}
          </Button>
          <p className="text-center text-xs text-faint">{t('welcome.skills.laterPhone')}</p>
        </div>
      </div>
    )
  }

  // the hint for the folder window: Claude's folder, and Codex's beside it (its settings in .codex, its skills in
  // .agents since 2026; either one reads): FolderHint.tsx, shared with a member's skill folder pick
  const hint = <FolderHint app={app} handle={handle} />
  // after a second folder with no skills, going on is the suggested way
  const stuck = misses >= 2

  return (
    <div className="space-y-6" data-testid="skills-step" data-state="empty">
      <div
        className={clsx('space-y-5 rounded-xl transition', over && 'bg-accent-soft/70 outline-2 outline-offset-[10px] outline-accent/55 outline-dashed')}
        onDragOver={(e) => { if (hasFiles(e) && !busy) { e.preventDefault(); setOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
        onDrop={drop}
        data-testid="skills-drop"
        data-over={over || undefined}
      >
        <StepHead title={t('welcome.skills.title')} desc={t('welcome.skills.desc')} />
        <div className="space-y-3">
          {folderInput}
          <Button variant={stuck ? 'secondary' : 'primary'} busy={reading} disabled={busy} onClick={pick} data-testid="skills-find">
            {!reading && (app ? <Laptop size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />)} {t(app ? 'welcome.skills.findDesktop' : 'welcome.skills.find')}
          </Button>
          <div className="space-y-1">
            {over ? (
              <p className="flex items-center gap-2 text-label font-medium text-accent-text" data-testid="skills-drop-hint">
                <FolderOpen size={15} aria-hidden /> {t('welcome.skills.drop')}
              </p>
            ) : (
              <p className="text-label leading-6 text-muted" data-testid="skills-hint">{hint}</p>
            )}
            <p className="text-xs text-faint" data-testid="skills-promise">{t('welcome.skills.promise')}</p>
          </div>
          {reading && <p className="sr-only" role="status">{t('welcome.skills.reading')}</p>}
          {none && <p className="text-label text-muted" role="status" data-testid="skills-none">{t('welcome.skills.none')}</p>}
          {error && <ErrorNote onRetry={error.retry}>{error.text}</ErrorNote>}
        </div>
      </div>
      {ccBlock && <div className="border-t border-line pt-5">{ccBlock}</div>}
      <div className="flex justify-end">
        <Button variant={stuck ? 'primary' : 'ghost'} onClick={later} disabled={busy || reading} data-testid="skills-later">{t('welcome.later')}</Button>
      </div>
    </div>
  )
}
