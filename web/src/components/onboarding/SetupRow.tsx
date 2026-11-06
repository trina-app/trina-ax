// The setup row (docs/DECISIONS.md "W5 — Onboarding v5"): the owner's one way back to the welcome steps from every
// page, one line in the sidebar above Recents (Sidebar.tsx mounts it; on a phone it is in the ☰ drawer). While the steps
// are unfinished and not hidden: "설정 이어서 하기 · 2/4" (or, with one step left, "남은 일: 팀 파일"), which opens /welcome
// at the step it resumes on; while no AI answers the owner: "AI 연결하기", which opens the same connect dialog as every
// other "AI 연결하기" (ConnectAi.tsx).
// Never on /welcome itself. Without AI it hides on Home, where the no-AI card stands; on a phone it hides on Home,
// whose own quiet row under the message box says the same (WelcomeResume); on a computer it replaces that row. ✕ hides
// it (the row's `dismissedAt`) with an undo toast; Admin › Home's "시작 설정 다시 보기" brings it back. The rules are
// lib/welcome.ts setupRowState; the words and counts are the steps' own (setupRowWords: the same as Home's row).
import { Sparkles, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { setupRowState, setupRowWords } from '../../lib/welcome'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { useMediaQuery } from '../ui'
import { ConnectAiButton } from './ConnectAi'

/** a phone (the drawer): the same query as the steps' own */
const PHONE = '(max-width: 767.98px)'
/** the progress is read again on a page change at most this often (another tab, a share applied on its own page) */
const FRESH_MS = 5000

const row = 'flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent max-sm:h-10'

export function SetupRow({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const ai = useAiAccess()
  const aiReady = !ai.loaded || ai.usable
  const computer = !useMediaQuery(PHONE)
  const { pathname } = useLocation()
  const readAt = useRef(0)
  useEffect(() => { if (owner) void useAiAccess.getState().load() }, [owner])
  // read once, and again on a page change while the row can show: unfinished and not hidden (the steps' own writes, ✕,
  // its undo and Admin › Home's "시작 설정 다시 보기" update the store copy themselves)
  const open = !!progress && !progress.finishedAt && !progress.dismissedAt
  useEffect(() => {
    if (!owner) return
    const w = useWelcome.getState()
    if (w.loaded && !open) return
    if (w.loaded && Date.now() - readAt.current < FRESH_MS) return
    readAt.current = Date.now()
    void w.load(w.loaded).catch(() => {})
  }, [owner, pathname, open])
  if (!owner || !loaded) return null
  const state = setupRowState(progress, { path: pathname, aiReady, computer })
  if (state === 'hidden') return null
  const hide = () => {
    void useWelcome.getState().update({ dismissed: true }).then(
      () => toast({ level: 'info', text: t('setupRow.hidden'), action: { label: t('common.undo'), run: () => void useWelcome.getState().update({ dismissed: false }).catch(() => toast({ level: 'error', text: t('error.network') })) } }),
      () => toast({ level: 'error', text: t('error.network') }),
    )
  }
  const words = setupRowWords(t, progress, aiReady, computer)
  return (
    <div className="group/setup mb-3 flex items-center gap-0.5 pr-1" data-testid="setup-row" data-state={state}>
      {state === 'ai' ? (
        <ConnectAiButton row={row} panel data-testid="setup-row-ai">
          <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 truncate">{t('aiAccess.connectTeam')}</span>
        </ConnectAiButton>
      ) : (
        <Link to="/welcome" onClick={onNavigate} className={row} data-testid="setup-row-link">
          <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 truncate">{words.text}</span>
          {words.count && (
            <span className="shrink-0 text-xs font-normal text-faint tabular-nums" data-testid="setup-row-count">
              <span aria-hidden>· </span>{words.count}
            </span>
          )}
        </Link>
      )}
      <button
        type="button"
        onClick={hide}
        aria-label={t('setupRow.hide')}
        title={t('setupRow.hide')}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/setup:opacity-100 max-md:size-9 max-md:opacity-100"
        data-testid="setup-row-hide"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

export default SetupRow
