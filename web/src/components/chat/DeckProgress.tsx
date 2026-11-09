// An intro deck being built (docs/DECISIONS.md "D2", round 2; deck-plan DESIGN §11 "Progress UI"): one block in the
// chat in place of the answer's intro_deck steps, from the click until the deck is done: "회사 소개서 만드는 중" and a
// clock, four steps in plain words with a live line under the running one, the slides as tiles (on a phone, and on a
// computer while the deck panel is closed: the panel has its own), and one quiet note. A slide that needed a second try
// is a normal step here (no red failed step). Done, the block folds to one step row ("회사 소개서 · 9장 · 2분 34초",
// which opens the four steps again) and the answer's deck card is the only picture left. The panel's view of a deck
// being built (the newest finished slide large, ‹ 4 / 9 ›, the tiles) is here too (components/ArtifactPanel.tsx).
import clsx from 'clsx'
import { Check, ChevronLeft, ChevronRight, CircleStop } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DECK_ARTIFACT_KEY, type DeckBuild, type Step } from '@mycel/shared/api'
import { buildMs, clock, deckRows, deckRunState, doneSlides, duration, slideUrl, tierMinutes, tileState, type DeckRow, type DeckRunState } from '../../lib/deckProgress'
import { useSidePanel } from '../../lib/sidePanel'
import { useT } from '../../i18n'
import { IconButton, useMediaQuery } from '../ui'
import { Tooltip } from '../Tooltip'

/** The time now, once a second while `on` (the block's clock). */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

function RowIcon({ state }: { state: DeckRow['state'] }) {
  const t = useT()
  if (state === 'done') return <Check size={15} strokeWidth={2.5} className="text-ok" aria-label={t('steps.done')} />
  if (state === 'running') return <span role="img" aria-label={t('steps.running')} className="block size-3.5 animate-spin rounded-full border-2 border-accent-soft border-t-accent" />
  if (state === 'stopped') return <CircleStop size={14} className="text-muted" aria-label={t('steps.stopped')} />
  return <span aria-hidden className="block size-3 rounded-full border-[1.5px] border-field-border" />
}

function Rows({ rows }: { rows: DeckRow[] }) {
  return (
    <ol data-testid="deck-rows">
      {rows.map((r) => (
        <li key={r.key} className="flex items-start gap-2.5 py-1.5 text-sm" data-testid={`deck-row-${r.key}`} data-state={r.state}>
          <span className="flex h-5 w-[18px] shrink-0 items-center justify-center">
            <RowIcon state={r.state} />
          </span>
          <span className={clsx('min-w-0 flex-1', r.state === 'done' ? 'text-muted' : r.state === 'todo' ? 'text-faint' : 'text-ink')}>
            {r.label}
            {r.now && (
              <span className="mt-0.5 block text-label text-accent-text" data-testid="deck-now">
                {r.now}
              </span>
            )}
          </span>
          {r.right && <span className="shrink-0 pt-px text-xs text-faint tabular-nums" data-testid={`deck-row-${r.key}-right`}>{r.right}</span>}
        </li>
      ))}
    </ol>
  )
}

/** A deck that stopped says so, and how far it got only while that cannot read as finished (the walk of PR #100: "6장
 * 중 6장" read as complete): some slides of all, "9장 중 3장"; every slide made, it stopped while finishing; none, no
 * count. */
function stoppedText(build: DeckBuild | null, t: ReturnType<typeof useT>): string {
  const n = build?.slides.length ?? 0
  const k = build ? doneSlides(build) : 0
  if (!k || !n) return t('deck.progress.stoppedEarly')
  return k >= n ? t('deck.progress.stoppedFinishing') : t('deck.progress.stopped', { n, k })
}

/**
 * The block for an answer that makes an intro deck: `build` once the server has the outline, else null while the AI
 * reads the material (the answer's question ran the deck skill). `start`: the answer's start, for the reading part.
 */
export default function DeckProgress({ build, steps, streaming, start, chatId }: { build: DeckBuild | null; steps: Step[]; streaming: boolean; start: number; chatId: string }) {
  const t = useT()
  const run = deckRunState(build, streaming)
  const now = useNow(run === 'live')
  const [open, setOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 768px)')
  const panel = useSidePanel()
  const rows = deckRows(build, steps, start, run, t)
  if (run !== 'live') {
    const n = build?.slides.length ?? 0
    const text = run === 'done' && build ? t('deck.progress.done', { n, time: duration(buildMs(build), t) }) : stoppedText(build, t)
    return (
      <div className="mb-3" data-testid="deck-progress" data-run={run}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="touch-hit flex w-full items-center gap-2.5 rounded py-1 text-left text-sm text-muted hover:bg-hover hover:text-ink" data-testid="deck-folded">
          <span className="flex h-5 w-[18px] shrink-0 items-center justify-center">
            {run === 'done' ? <Check size={15} strokeWidth={2.5} className="text-ok" aria-hidden /> : <CircleStop size={14} className="text-muted" aria-hidden />}
          </span>
          <span className="min-w-0 flex-1 truncate">{text}</span>
          <ChevronRight size={15} className={clsx('shrink-0 text-faint transition', open && 'rotate-90')} aria-hidden />
        </button>
        {open && (
          <div className="mt-1 ml-2 border-l border-line pl-2.5">
            <Rows rows={rows} />
          </div>
        )}
      </div>
    )
  }
  const begin = build ? Date.parse(build.startedAt) : start
  // on a computer the deck panel shows the tiles itself while it is open
  const deckOpen = wide && panel?.kind === 'artifact' && panel.chatId === chatId && panel.artifactKey === DECK_ARTIFACT_KEY
  return (
    <section className="mb-3" aria-label={t('deck.progress.title')} data-testid="deck-progress" data-run={run} data-phase={build?.phase ?? 'reading'}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-reading font-semibold text-ink">{t('deck.progress.title')}</h3>
        <span className="shrink-0 text-xs text-faint tabular-nums" title={t('deck.progress.elapsed', { time: clock(now - begin) })} data-testid="deck-clock">
          {clock(now - begin)}
        </span>
      </div>
      <Rows rows={rows} />
      {build && build.slides.length > 0 && !deckOpen && <DeckStrip build={build} run={run} className="mt-3" />}
      <p className="mt-3 text-label text-faint">{t('deck.progress.note', { min: tierMinutes(build) })}</p>
    </section>
  )
}

/** The slides as tiles: done = its picture (or, where the server draws none, a quiet check and its section), the one
 * being made = an accent ring with a soft shimmer and "숫자 · 그리는 중", planned = its number and section. 3 columns on
 * a phone, 5 on a computer and in the panel. In the panel a done tile shows that slide large (`onPick`). */
export function DeckStrip({ build, run, panel, picked, onPick, className }: { build: DeckBuild; run: DeckRunState; panel?: boolean; picked?: number | null; onPick?: (i: number) => void; className?: string }) {
  const t = useT()
  return (
    <ol className={clsx('grid gap-1.5', panel ? 'grid-cols-5' : 'grid-cols-3 md:grid-cols-5', className)} aria-label={t('deck.progress.strip')} data-testid="deck-strip">
      {build.slides.map((_, i) => (
        <li key={i} className="min-w-0" data-testid="deck-tile" data-state={tileState(build, i, run)}>
          <Tile build={build} i={i} run={run} picked={picked === i} onPick={onPick} />
        </li>
      ))}
    </ol>
  )
}

const TILE = 'relative block aspect-video w-full overflow-hidden rounded-md'
const NUM = 'absolute top-1 left-1.5 text-micro font-semibold text-faint tabular-nums'
const LABEL = 'absolute right-1.5 bottom-1 left-1.5 line-clamp-2 text-micro leading-tight font-medium break-keep'

function Tile({ build, i, run, picked, onPick }: { build: DeckBuild; i: number; run: DeckRunState; picked: boolean; onPick?: (i: number) => void }) {
  const t = useT()
  const s = build.slides[i]!
  const state = tileState(build, i, run)
  // a picture that would not load (drawn again since, or gone): the quiet tile instead, until the next redraw
  const [broken, setBroken] = useState<number | null>(null)
  const name = t('deck.progress.slide', { n: i + 1, section: s.section })
  if (state === 'done' && build.thumbs && broken !== s.rev) {
    const img = <img src={slideUrl(build, i)} alt={name} loading="lazy" onError={() => setBroken(s.rev)} className="block size-full object-cover" />
    return onPick ? (
      <Tooltip label={name}>
        <button type="button" onClick={() => onPick(i)} aria-current={picked || undefined} className={clsx(TILE, 'border', picked ? 'border-field-border' : 'border-line hover:border-field-border')}>
          {img}
        </button>
      </Tooltip>
    ) : (
      <div className={clsx(TILE, 'border border-line bg-subtle')}>{img}</div>
    )
  }
  if (state === 'done')
    return (
      <div className={clsx(TILE, 'border border-line bg-surface')} title={name}>
        <Check size={13} strokeWidth={2.5} className="absolute top-1.5 left-1.5 text-ok" aria-hidden />
        <span className={clsx(LABEL, 'text-muted')}>{s.section}</span>
      </div>
    )
  if (state === 'current')
    return (
      <div className={clsx(TILE, 'deck-shimmer border-[1.5px] border-accent')}>
        <span className={NUM}>{i + 1}</span>
        <span className={clsx(LABEL, 'text-accent-text')}>{t('deck.progress.drawing', { section: s.section })}</span>
      </div>
    )
  return (
    <div className={clsx(TILE, 'border border-line bg-subtle')}>
      <span className={NUM}>{i + 1}</span>
      <span className={clsx(LABEL, 'text-faint')}>{s.section}</span>
    </div>
  )
}

/** The panel's header badge: "만드는 중 · 5 / 9", "다듬는 중", "멈췄어요". */
export function DeckBuildBadge({ build, run }: { build: DeckBuild; run: DeckRunState }) {
  const t = useT()
  const n = build.slides.length
  const k = Math.min(n, doneSlides(build) + (build.phase === 'slides' ? 1 : 0))
  const text = run === 'stopped' ? t('deck.progress.badgeStopped') : build.phase === 'review' ? t('deck.progress.badgeReview') : build.outlineAt && n ? t('deck.progress.badge', { k, n }) : t('deck.progress.badgeStart')
  return (
    <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums', run === 'stopped' ? 'bg-subtle text-muted' : 'bg-accent-soft text-accent-text')} data-testid="deck-build-badge">
      {text}
    </span>
  )
}

/** The panel while the deck is made: the newest finished slide large, ‹ 4 / 9 › through the finished ones, the tiles
 * under it. Before the first slide a quiet 16:9 stage (never an error or an empty state). */
export function DeckBuildView({ build, run }: { build: DeckBuild; run: DeckRunState }) {
  const t = useT()
  const done = build.slides.flatMap((s, i) => (s.status === 'done' ? [i] : []))
  // null: follow the newest finished slide
  const [picked, setPicked] = useState<number | null>(null)
  const shown = picked !== null && done.includes(picked) ? picked : (done.at(-1) ?? null)
  const at = shown === null ? -1 : done.indexOf(shown)
  const go = (d: number) => {
    const next = done[at + d]
    if (next !== undefined) setPicked(next === done.at(-1) ? null : next)
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pt-5 pb-8" data-testid="deck-build-view">
      {build.thumbs && (
        <>
          <div className="aspect-video overflow-hidden rounded-lg border border-line bg-subtle" data-testid="deck-stage">
            {shown !== null ? (
              <img key={`${shown}:${build.slides[shown]!.rev}`} src={slideUrl(build, shown)} alt={t('deck.progress.slide', { n: shown + 1, section: build.slides[shown]!.section })} className="block size-full object-cover" />
            ) : (
              <div className={clsx('size-full', run === 'live' && 'deck-shimmer')} />
            )}
          </div>
          {shown !== null && (
            <div className="mt-2 flex items-center justify-center gap-2 text-label text-faint">
              <IconButton label={t('deck.progress.prev')} disabled={at <= 0} onClick={() => go(-1)} data-testid="deck-prev">
                <ChevronLeft size={16} />
              </IconButton>
              <span className="min-w-12 text-center tabular-nums" data-testid="deck-page">
                {shown + 1} / {build.slides.length}
              </span>
              <IconButton label={t('deck.progress.next')} disabled={at >= done.length - 1} onClick={() => go(1)} data-testid="deck-next">
                <ChevronRight size={16} />
              </IconButton>
            </div>
          )}
        </>
      )}
      {build.slides.length > 0 && <DeckStrip build={build} run={run} panel picked={shown} onPick={(i) => setPicked(i === done.at(-1) ? null : i)} className={build.thumbs ? 'mt-4' : undefined} />}
    </div>
  )
}
