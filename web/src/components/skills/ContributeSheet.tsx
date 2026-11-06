// Members contribute (docs/DECISIONS.md "MC"): what [올리기] opens under a member's first good run of the landing skill
// (components/onboarding/ResultSuggestion.tsx), on a computer. One sheet, one primary per state:
//   pick  the skill folder window (Chrome, Edge: showDirectoryPicker; Safari, Firefox and the desktop app: <input
//         webkitdirectory>) or a dropped folder; .claude, .codex or .agents, read by lib/skillScan.ts exactly as the
//         owner's 내 스킬 step reads it: only the known places are opened, and a skill with a key (or a key file) never
//         leaves the browser: it shows here as left out, with its name and the kind of key only;
//   list  the skills found, each ticked by the member (nothing ticked first: no AI judges them, the owner does), at most
//         CONTRIBUTE_LIMITS.batch, fewer when their waiting suggestions are near CONTRIBUTE_LIMITS.open; "팀장이
//         내용을 보고 정해요" right above [팀에 제안 · N개]; CLAUDE.md / AGENTS.md rules and MCP servers are not sent (not
//         in this version);
//   sent  how many went, what the server did not take and why; [닫기], or another folder (Claude Code and Codex).
// The files part is one quiet link to the team folder (Files, where the upload is), only when the member can write it
// (`folder`, from the server). Nothing here runs an AI.
import clsx from 'clsx'
import { ChevronDown, FileQuestionMark, FolderOpen, FolderUp, KeyRound, Laptop } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { CONTRIBUTE_LIMITS, readSkillTitle, skillLabel, type ContributedSkills, type ContributeRefusal, type ShareApp, type ShareCandidate, type ShareExcludedIn, type ShareSkillIn } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { isDesktop, storeApp } from '../../lib/desktop'
import { canPickHandle, droppedFolder, fromFiles, pickClaudeFolder, scanFolder, type ScanDir } from '../../lib/skillScan'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { FolderHint } from '../onboarding/FolderHint'
import { quietLink, reasonText } from '../onboarding/SkillShareReview'
import { Button, ErrorNote, Modal } from '../ui'

/** What the list shows of a found skill: its metadata title (else its folder name as words) and its description, read
 * from its SKILL.md header (a command: its own file) here in the browser; the server reads the header again. */
export function skillHead(s: ShareSkillIn): { title: string; description: string } {
  const own = s.files.find((f) => f.text !== undefined && (s.origin === 'command' ? /\.md$/i.test(f.path) : f.path.toLowerCase() === 'skill.md'))?.text ?? ''
  const head = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(own)?.[1] ?? ''
  const value = (re: RegExp) => (re.exec(head)?.[1] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  const title = readSkillTitle(value(/^[ \t]+title:[ \t]*(.+)$/m))
  const description = value(/^description:[ \t]*(.+)$/m).replace(/[\p{Cc}\p{Cf}]/gu, '')
  return { title: title ?? skillLabel({ name: s.name }), description }
}

/** A reason of the browser's or the server's as the owner's list words it (SkillShareReview reasonText). */
const asCandidate = (name: string, reason: ShareCandidate['reason'], detail: string | null): ShareCandidate =>
  ({ name, title: null, description: '', origin: 'user', project: null, group: 'excluded', reason, detail, personalPath: false, files: [], scriptsDropped: 0, sameName: null, similar: null, action: 'add', applied: null })

type Found = { app: ShareApp; skills: ShareSkillIn[]; excluded: ShareExcludedIn[] }

export function ContributeSheet({ folder, onClose }: { folder: string | null; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const ids = useId()
  // only the Mac App Store build answers the page's folder input with its own window (opened at .claude)
  const app = storeApp()
  const handle = !app && canPickHandle()
  const source = isDesktop() ? 'desktop' : 'browser'
  const [found, setFound] = useState<Found | null>(null)
  // by place in the list: a folder can hold two skills of one name (skills/review and commands/review.md)
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [sent, setSent] = useState<ContributedSkills | null>(null)
  const [reading, setReading] = useState(false)
  const [sending, setSending] = useState(false)
  const [none, setNone] = useState(false)
  const [over, setOver] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // how many of this member's suggestions wait already (CONTRIBUTE_LIMITS.open counts every kind)
  const [waiting, setWaiting] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    api.call(API.skillsOverview).then((o) => live && setWaiting(o.myPending), () => live && setWaiting(0))
    return () => { live = false }
  }, [])
  const room = Math.max(0, CONTRIBUTE_LIMITS.open - (waiting ?? 0))
  const cap = Math.min(CONTRIBUTE_LIMITS.batch, room)

  /** a folder to read (null: the window was closed, nothing happens) */
  const begin = async (dir: ScanDir | null) => {
    if (!dir) return
    setReading(true)
    setError(null)
    setNone(false)
    try {
      const r = await scanFolder(dir, source)
      // only skills go: a CLAUDE.md / AGENTS.md rule and MCP servers are not part of a member's suggestion yet
      if (!r.body || (!r.body.skills.length && !r.body.excluded?.length)) { setNone(true); return }
      setFound({ app: r.body.app ?? 'claude', skills: r.body.skills, excluded: r.body.excluded ?? [] })
      setTicked(new Set())
      setShowExcluded(false)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setReading(false)
    }
  }
  /** straight from the click: the folder window needs it */
  const pick = () => {
    if (reading || sending) return
    if (handle) pickClaudeFolder().then((d) => begin(d), (e) => setError(errorText(e, locale, t('error.network'))))
    else input.current?.click()
  }
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    if (reading || sending) return
    // read now: the browser empties the list when the event ends
    const dir = droppedFolder(e.dataTransfer)
    if (dir) void begin(dir)
    else setNone(true)
  }
  const toggle = (i: number, on: boolean) => setTicked((x) => {
    const next = new Set(x)
    if (on && next.size < cap) next.add(i)
    else next.delete(i)
    return next
  })
  const send = async () => {
    if (!found || !ticked.size || sending) return
    setSending(true)
    setError(null)
    try {
      const skills = found.skills.filter((_, i) => ticked.has(i))
      const r = await api.call(API.contributeSkills, { body: { ...(found.app === 'codex' ? { app: 'codex' as const } : {}), skills } })
      setWaiting((w) => (w ?? 0) + r.items.length)
      setSent(r)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setSending(false)
    }
  }
  const again = () => { setFound(null); setSent(null); setTicked(new Set()); setNone(false); setError(null) }

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
      data-testid="contribute-input"
    />
  )
  // the files part: only for a member who can write the team folder (Files has the upload)
  const filesLink = folder ? (
    <Link to={`/files?path=${encodeURIComponent(folder)}`} onClick={onClose} className={clsx(quietLink, 'touch-hit inline-flex items-center gap-1.5 text-label')} data-testid="contribute-files">
      <FolderUp size={15} className="shrink-0 text-faint" aria-hidden /> {t('contribute.files')}
    </Link>
  ) : null

  let body
  if (sent) {
    const refused = sent.refused
    body = (
      <div className="space-y-4" data-testid="contribute-sent">
        <p className="text-sm text-ink" role="status">{sent.items.length ? t('contribute.sent', { n: sent.items.length }) : t('contribute.sentNone')}</p>
        {refused.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-label font-medium text-ink">{t('contribute.refused', { n: refused.length })}</p>
            <ul className="space-y-1">
              {refused.map((r, i) => <li key={i} className="text-label text-muted" data-testid="contribute-refused">{r.name} · {refusalText(t, r)}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button variant="ghost" className="mr-auto" onClick={again} data-testid="contribute-more">{t('contribute.more')}</Button>
          <Button variant="primary" onClick={onClose} data-testid="contribute-close">{t('common.close')}</Button>
        </div>
      </div>
    )
  } else if (found) {
    const atCap = ticked.size >= cap
    // the member's waiting count decides the cap: nothing is ticked before it is in
    const counting = waiting === null
    body = (
      <div className="space-y-4" data-testid="contribute-list">
        <p className="text-sm text-muted">{t('contribute.found', { n: found.skills.length })}</p>
        {found.skills.length > 0 && (
          <fieldset className="min-w-0 rounded-xl border border-line" disabled={sending}>
            <legend className="sr-only">{t('contribute.title')}</legend>
            <ul className="max-h-72 overflow-y-auto">
              {found.skills.map((s, i) => {
                const head = skillHead(s)
                const id = `${ids}-${i}`
                const on = ticked.has(i)
                return (
                  <li key={i} className={clsx('flex items-start gap-3 border-line px-3 py-2.5', i > 0 && 'border-t')} data-testid="contribute-row" data-name={s.name}>
                    <input id={id} type="checkbox" checked={on} disabled={counting || (!on && atCap)} onChange={(e) => toggle(i, e.target.checked)}
                      className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]" data-testid="contribute-check" />
                    <label htmlFor={id} className={clsx('min-w-0 flex-1 cursor-pointer', !on && atCap && 'opacity-60')}>
                      <span className="block text-sm font-medium break-words text-ink">{head.title}<span className="ml-1.5 font-mono text-xs font-normal text-faint">/{s.name}</span></span>
                      {head.description && <span className="mt-0.5 line-clamp-2 block text-label text-muted">{head.description}</span>}
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )}
        {found.excluded.length > 0 && (
          <div>
            <button type="button" className="flex min-h-9 items-center gap-1.5 text-label text-muted hover:text-ink" aria-expanded={showExcluded} aria-controls={`${ids}-excluded`}
              onClick={() => setShowExcluded((x) => !x)} data-testid="contribute-excluded-toggle">
              <KeyRound size={14} className="shrink-0 text-faint" aria-hidden />
              {t('welcome.skills.excluded', { n: found.excluded.length })}
              <span className="text-faint">· {[...new Set(found.excluded.map((x) => x.reason))].map((r) => t(`welcome.skills.short.${r}` as MessageKey)).join(', ')}</span>
              <ChevronDown size={14} className={clsx('shrink-0 text-faint transition', showExcluded && 'rotate-180')} aria-hidden />
            </button>
            {showExcluded && (
              <ul id={`${ids}-excluded`} className="mt-1 space-y-1 pl-5" data-testid="contribute-excluded">
                {found.excluded.map((x, i) => <li key={i} className="text-label text-muted">{x.name} · {reasonText(t, asCandidate(x.name, x.reason, x.kind ?? null))}</li>)}
              </ul>
            )}
          </div>
        )}
        {atCap && found.skills.length > cap && <p className="text-label text-muted" role="status">{t('contribute.cap', { n: cap })}</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-2 pt-1">
          <p className="text-label text-muted" data-testid="contribute-owner">{t('contribute.owner')}</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" className="mr-auto" onClick={pick} disabled={sending || reading} data-testid="contribute-other">{t('contribute.other')}</Button>
            <Button variant="primary" busy={sending} disabled={!ticked.size || sending} onClick={() => void send()} data-testid="contribute-send">
              {t('contribute.send', { n: ticked.size })}
            </Button>
          </div>
        </div>
      </div>
    )
  } else if (waiting !== null && room === 0) {
    body = <p className="text-sm text-muted" role="status" data-testid="contribute-full">{t('contribute.full', { n: CONTRIBUTE_LIMITS.open })}</p>
  } else {
    body = (
      <div
        className={clsx('space-y-4 rounded-xl transition', over && 'bg-accent-soft/70 outline-2 outline-offset-[10px] outline-accent/55 outline-dashed')}
        onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
        onDrop={drop}
        data-testid="contribute-drop"
        data-over={over || undefined}
      >
        <p className="text-sm text-balance text-muted">{t('contribute.desc')}</p>
        <Button variant="primary" busy={reading} onClick={pick} data-testid="contribute-find">
          {!reading && (app ? <Laptop size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />)} {t(app ? 'welcome.skills.findDesktop' : 'contribute.find')}
        </Button>
        {over
          ? <p className="flex items-center gap-2 text-label font-medium text-accent-text"><FolderOpen size={15} aria-hidden /> {t('welcome.skills.drop')}</p>
          : <p className="text-label leading-6 text-muted" data-testid="contribute-hint"><FolderHint app={app} handle={handle} /></p>}
        {reading && <p className="sr-only" role="status">{t('welcome.skills.reading')}</p>}
        {none && <p className="flex items-center gap-2 text-label text-muted" role="status" data-testid="contribute-none"><FileQuestionMark size={15} className="shrink-0 text-faint" aria-hidden />{t('welcome.skills.none')}</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    )
  }

  return (
    <Modal open onClose={onClose} width={520} title={t('contribute.title')}>
      <div className="space-y-5" data-testid="contribute-sheet" data-state={sent ? 'sent' : found ? 'list' : 'pick'}>
        {folderInput}
        {body}
        {filesLink && <div className="border-t border-line pt-4">{filesLink}</div>}
      </div>
    </Modal>
  )
}

/** Why the server did not take a skill: the owner's words for the checks, or "already waiting". */
function refusalText(t: ReturnType<typeof useT>, r: ContributeRefusal): string {
  if (r.reason === 'pending') return t('contribute.pending')
  return reasonText(t, asCandidate(r.name, r.reason, r.detail))
}

export default ContributeSheet
