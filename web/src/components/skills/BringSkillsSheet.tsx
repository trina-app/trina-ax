// "내 스킬 가져오기" on the Team skills page for owners and admins (docs/DECISIONS.md "W6", "W7"; FLOW-v6 §4.2): the
// one way in for an owner's or admin's own skills from Claude Code or Codex (the setup steps do not bring them). One
// sheet: pick a folder (useSkillPick below: Chrome and Edge showDirectoryPicker, Safari and Firefox <input
// webkitdirectory>, or a drop; lib/skillScan.ts reads only the known paths and filters before anything leaves the
// browser; the Mac App Store app answers the folder input with its own window at .claude) → the list
// (SkillShareReview, which applies directly: [팀에 넣기 · n개], its secondary [닫기]) → what went in, [닫기]. A check
// still running after SHARE_CHECK_LIMIT_MS is ended (stop-check): the list then shows with nothing ticked. Closing the
// sheet with a list open drops that list (nothing went in). Members get ContributeSheet instead.
import { FolderOpen, Laptop } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import type { CreateSkillShare, SkillShare } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { answersFileInputs, isDesktop } from '../../lib/desktop'
import { canPickHandle, droppedFolder, fromFiles, pickClaudeFolder, scanFolder, type ScanDir } from '../../lib/skillScan'
import { useLocale, useT } from '../../i18n'
import { FolderHint } from '../onboarding/FolderHint'
import { SkillShareReview } from '../onboarding/SkillShareReview'
import { Button, ErrorNote, Modal } from '../ui'

/** How long the sheet waits for the AI's check of own skills before it ends it (walk review M2). */
export const SHARE_CHECK_LIMIT_MS = 30_000

/** Picking a skill folder (the folder window, the folder input, a drop) and reading it here, before a proposal is made.
 * `onFound` gets the body to send. */
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


export function BringSkillsSheet({ team, onClose }: { team: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [share, setShare] = useState<SkillShare | null>(null)
  const shareRef = useRef(share)
  shareRef.current = share
  const send = async (body: CreateSkillShare) => {
    try {
      const s = await api.call(API.createSkillShare, { body })
      const before = shareRef.current
      if (before && before.id !== s.id) void api.call(API.dismissSkillShare, { params: { id: before.id } }).catch(() => {})
      setShare(s)
    } catch (e) {
      pick.setError({ text: errorText(e, locale, t('error.network')), retry: () => void send(body) })
    }
  }
  const pick = useSkillPick({ onFound: send })
  /** drop the list on screen (one that went in stays) */
  const drop = () => {
    const s = shareRef.current
    if (s && s.status !== 'applied') void api.call(API.dismissSkillShare, { params: { id: s.id } }).catch(() => {})
  }
  const close = () => { drop(); onClose() }

  return (
    <Modal open onClose={close} width={560} title={t('skills.catalog.bring')}>
      <div className="space-y-4" data-testid="bring-sheet" data-state={share ? share.status : 'pick'}>
        {pick.folderInput}
        {share ? (
          <SkillShareReview
            share={share}
            team={team}
            doneLabel={t('common.close')}
            onDone={onClose}
            onLater={close}
            onStopped={() => { pick.reset(); setShare(null) }}
            onOtherFolder={pick.pick}
            onMore={() => { pick.reset(); setShare(null) }}
            busy={pick.reading}
            checkLimitMs={SHARE_CHECK_LIMIT_MS}
            shareLabel={(n) => t('skills.catalog.install', { n })}
            laterLabel={t('common.close')}
          />
        ) : (
          <div
            className={pick.over ? 'space-y-3 rounded-xl bg-accent-soft/70 outline-2 outline-offset-[10px] outline-accent/55 outline-dashed' : 'space-y-3'}
            {...pick.dropProps}
            data-testid="bring-drop"
          >
            <p className="text-sm text-balance text-muted">{t('welcome.skills.bringLead')}</p>
            <Button variant="primary" busy={pick.reading} onClick={pick.pick} data-testid="bring-find">
              {!pick.reading && (pick.app ? <Laptop size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />)} {t(pick.app ? 'welcome.skills.findDesktop' : 'welcome.skills.find')}
            </Button>
            <p className="text-label leading-6 text-muted" data-testid="bring-hint">{pick.over ? t('welcome.skills.drop') : <FolderHint app={pick.app} handle={pick.handle} />}</p>
            <p className="text-xs text-faint">{t('welcome.skills.promise')}</p>
            {pick.reading && <p className="sr-only" role="status">{t('welcome.skills.reading')}</p>}
            {pick.none && <p className="text-label text-muted" role="status" data-testid="bring-none">{t('welcome.skills.none')}</p>}
            {pick.error && <ErrorNote onRetry={pick.error.retry}>{pick.error.text}</ErrorNote>}
          </div>
        )}
      </div>
    </Modal>
  )
}

export default BringSkillsSheet
