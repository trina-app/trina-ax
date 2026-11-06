// 내 스킬 가져오기, the welcome step (docs/DECISIONS.md "K — 내 스킬 가져오기"; pages/Welcome.tsx renders the eyebrow,
// the progress bar and the focus; this is the heading and what is under it). Three ways in, one list:
//  - a computer's browser: [내 스킬 찾기] opens the folder window (Chrome, Edge: showDirectoryPicker; Safari, Firefox:
//    <input webkitdirectory>, whose hint asks for .claude/skills), and a folder dropped on the step works everywhere.
//    lib/skillScan.ts reads only the known paths and filters before anything leaves the browser;
//  - the Mac App Store app (storeApp(), the one build that answers the page's file inputs itself): [이 컴퓨터에서 찾기]
//    is an <input webkitdirectory data-open-at="claude">, which it answers with its own window opened at the home
//    folder, .claude shown and picked; any other desktop build picks like a browser (proposals say "desktop");
//  - Claude Code (only when this server has the connector on): one line to paste; the step asks the server every few
//    seconds for a proposal Claude Code sent (GET /api/skill-shares?source=claude_code) and shows it as it arrives,
//    on a phone too.
// Then components/onboarding/SkillShareReview.tsx (checking, the list, what went in). A phone (or a browser that
// cannot pick folders) gets the phone version: skills live on a computer, so its primary goes on and the step waits
// there. The person closing the folder window changes nothing.
import clsx from 'clsx'
import { ArrowRight, Check, Copy, FolderOpen, Laptop, Loader2, Terminal } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { CreateSkillShare, SkillShare } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { isDesktop, storeApp } from '../../lib/desktop'
import { canPickHandle, canPickInput, droppedFolder, fromFiles, pickClaudeFolder, scanFolder, type ScanDir } from '../../lib/skillScan'
import { useLocale, useT } from '../../i18n'
import { CONNECTOR_NAME, CopyLine } from '../integrations/AiAppConnect'
import { Button, ErrorNote, useMediaQuery } from '../ui'
import { quietLink, SkillShareReview, withNodes } from './SkillShareReview'

/** How often the empty step asks whether Claude Code sent a proposal. */
export const CLAUDE_CODE_POLL_MS = 3000
/** A proposal made this long before the step opened still counts as new (the server's clock and this one differ). */
const CLOCK_SLACK_MS = 30_000

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

type Os = 'mac' | 'windows' | 'linux' | 'other'
function osOf(): Os {
  if (typeof navigator === 'undefined') return 'other'
  const n = navigator as Navigator & { userAgentData?: { platform?: string } }
  const p = `${n.userAgentData?.platform ?? ''} ${n.platform ?? ''} ${n.userAgent ?? ''}`
  if (/Mac|iPhone|iPad/i.test(p)) return 'mac'
  if (/Win/i.test(p)) return 'windows'
  if (/Linux|X11|CrOS/i.test(p)) return 'linux'
  return 'other'
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mx-px inline-block min-w-5 rounded-[5px] border border-b-2 border-line-strong bg-surface px-1 text-center font-mono text-xs leading-[17px] text-ink">{children}</kbd>
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
  const app = storeApp()
  const handle = !app && canPickHandle()
  const phone = narrow || (!app && !handle && !canPickInput())
  const os = osOf()
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
  // proposals this step let go of (그만 찾기, a newer folder): never shown again here
  const gone = useRef(new Set<string>())
  const input = useRef<HTMLInputElement>(null)
  const shareRef = useRef(share)
  shareRef.current = share

  // the Claude Code block shows only when this server has the connector on
  useEffect(() => {
    let live = true
    api.call(API.listRemoteConnectors).then((r) => live && setRemote({ configured: r.configured && !!r.resource, resource: r.resource }), () => live && setRemote({ configured: false, resource: null }))
    return () => { live = false }
  }, [])

  // while nothing is on screen: a proposal Claude Code sent since the step opened (or one still waiting) shows here
  const waitForClaudeCode = !share && !!remote?.configured
  useEffect(() => {
    if (!waitForClaudeCode) return
    let live = true
    const look = async () => {
      try {
        const r = await api.call(API.listSkillShares, { query: { source: 'claude_code' } })
        const since = openedAt.current - CLOCK_SLACK_MS
        const found = r.items.find((s) => !gone.current.has(s.id) && (s.status === 'ready' || (s.status === 'checking' && Date.parse(s.createdAt) >= since)))
        if (live && found && !shareRef.current) setShare(found)
      } catch { /* the next tick asks again */ }
    }
    void look()
    const id = setInterval(() => void look(), CLAUDE_CODE_POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [waitForClaudeCode])

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
        <div id="skills-cc-how" className="space-y-2 text-label text-muted" data-testid="skills-cc-how">
          <p>{t('welcome.skills.cc.step1')}</p>
          <CopyLine text={`claude mcp add --transport http ${CONNECTOR_NAME} ${remote.resource}`} testId="skills-cc-command" />
          <p>{t('welcome.skills.cc.step2')}</p>
          <CopyLine text="/mcp" testId="skills-cc-mcp" />
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
          onStopped={() => { gone.current.add(share.id); setShare(null) }}
          onOtherFolder={share.source === 'claude_code' || phone ? undefined : pick}
          busy={busy || reading}
        />
        {!phone && share.source !== 'claude_code' && folderInput}
        {error && <ErrorNote onRetry={error.retry}>{error.text}</ErrorNote>}
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

  // the hint for the folder window
  const folder = <b className="font-semibold text-ink">.claude</b>
  const keys = (shown: string[], said: string) => (
    <>
      <span aria-hidden>{shown.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
      <span className="sr-only">{said}</span>
    </>
  )
  let hint: ReactNode
  if (app) hint = withNodes(t('welcome.skills.hintDesktop'), { folder: <span className="font-mono">.claude</span>, button: <b className="font-semibold text-ink">{t('welcome.skills.desktopButton')}</b> })
  else if (!handle) hint = withNodes(t(os === 'mac' ? 'welcome.skills.hintSkillsOnlyMac' : 'welcome.skills.hintSkillsOnly'), { folder, keys: keys(['⌘', '⇧', '.'], t('welcome.skills.keysMac')) })
  else if (os === 'mac') hint = withNodes(t('welcome.skills.hintMac'), { folder, keys: keys(['⌘', '⇧', '.'], t('welcome.skills.keysMac')) })
  else if (os === 'linux') hint = withNodes(t('welcome.skills.hintLinux'), { folder, keys: keys(['Ctrl', 'H'], t('welcome.skills.keysLinux')) })
  else hint = withNodes(t('welcome.skills.hintWindows'), { folder })
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
