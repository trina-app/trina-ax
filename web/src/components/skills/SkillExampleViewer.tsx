// The example of a kept skill (docs/DECISIONS.md "W6"; FLOW-v6 §2.2, EXAMPLES-PLAN.md), opened by a row's "예시" on 내
// 스킬 and in the Team skills catalog: one dialog (on phones the sheet the dialogs are there), ‹ › to the next row's.
// It shows an image the web build serves (a result that is a picture anyway: the deck, the cards, the video's frames)
// or a short before → after text drawn in the page's own theme, the line that the company in it is invented, and where
// the skill comes from (only skills with a known origin ship; only the English 자연스러운 글 links out). Until an
// example is made the viewer says so ("예시를 준비하고 있어요"); one that does not load says that, under the skill's line.
// ✕, Esc and a tap outside close it, and the focus goes back to the 예시 of the row it shows.
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff } from 'lucide-react'
import { useState } from 'react'
import type { PackCatalogSkill } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { Markdown } from '../Markdown'
import { quietLink } from '../onboarding/SkillShareReview'
import { IconButton, Modal } from '../ui'

/** The invented company the examples are made on (EXAMPLES-PLAN.md §1), by the language of the example. */
export const EXAMPLE_COMPANY: Record<'ko' | 'en', string> = { ko: '예시커피', en: 'Example Coffee' }

/** The source line of a kept skill, with its one link out (the open-source original) when it has one. */
export function SourceLine({ skill }: { skill: Pick<PackCatalogSkill, 'source'> }) {
  const t = useT()
  const s = skill.source
  if (s.kind === 'team') return <p className="text-label text-muted" data-testid="skill-example-source" data-kind="team">{t('skillPack.source.team')}</p>
  if (s.kind === 'team_writing') return <p className="text-label text-muted" data-testid="skill-example-source" data-kind="team_writing">{t('skillPack.source.teamWriting')}</p>
  return (
    <p className="text-label text-muted" data-testid="skill-example-source" data-kind="adapted">
      {t('skillPack.source.adapted', { author: s.author, project: s.project, license: s.license })}
      <span aria-hidden> · </span>
      <a href={s.url} target="_blank" rel="noopener noreferrer" className={clsx(quietLink, 'touch-hit inline-flex items-center gap-1')} data-testid="skill-example-original">
        {t('skillPack.source.original')}
        <ExternalLink size={13} aria-hidden />
        <span className="sr-only">{t('skillPack.newTab')}</span>
      </a>
    </p>
  )
}

export interface SkillExampleViewerProps {
  /** the rows it was opened from, in their order (‹ › go along them) */
  items: readonly PackCatalogSkill[]
  /** the one shown */
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  /** where the focus goes back to (the shown row's 예시) */
  returnTo?: HTMLElement | null
}

export function SkillExampleViewer({ items, index, onIndex, onClose, returnTo }: SkillExampleViewerProps) {
  const t = useT()
  const skill = items[index]
  // an image is loading until it says otherwise; one that fails shows the error state; another row starts over
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading')
  const [shownName, setShownName] = useState(skill?.name)
  if (shownName !== skill?.name) {
    setShownName(skill?.name)
    setState('loading')
  }
  if (!skill) return null
  const many = items.length > 1
  const go = (step: number) => onIndex((index + step + items.length) % items.length)
  const e = skill.example
  const shown = e ? (e.kind === 'text' ? 'shown' : state) : 'placeholder'

  let body
  if (!e) {
    body = (
      <div className="space-y-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center" data-testid="skill-example-body" data-state="placeholder">
        <p className="text-sm text-muted">{skill.description}</p>
        <p className="text-sm font-medium text-ink" role="status">{t('skillPack.preparing')}</p>
      </div>
    )
  } else if (e.kind === 'text') {
    body = (
      <div className="rounded-xl border border-line bg-subtle px-4 py-3" data-testid="skill-example-body" data-state="shown" data-kind="text">
        <Markdown text={e.markdown} size="small" teamImagesAsLinks />
      </div>
    )
  } else if (state === 'failed') {
    body = (
      <div className="space-y-2 rounded-xl border border-line px-4 py-6 text-center" data-testid="skill-example-body" data-state="failed">
        <ImageOff size={20} className="mx-auto text-faint" aria-hidden />
        <p className="text-sm text-muted">{skill.description}</p>
        <p className="text-sm font-medium text-ink" role="status">{t('skillPack.exampleFailed')}</p>
      </div>
    )
  } else {
    body = (
      <div className="relative overflow-hidden rounded-xl border border-line bg-subtle" data-testid="skill-example-body" data-state={state} data-kind="image">
        {state === 'loading' && <div aria-hidden className="aspect-video w-full animate-pulse bg-hover" />}
        <img
          key={e.url}
          src={e.url}
          alt={t('skillPack.exampleAlt', { title: skill.title })}
          className={clsx('block h-auto w-full', state === 'loading' && 'absolute inset-0 opacity-0')}
          onLoad={() => setState('shown')}
          onError={() => setState('failed')}
          data-testid="skill-example-image"
        />
      </div>
    )
  }

  return (
    <Modal open onClose={onClose} title={t('skillPack.exampleTitle', { title: skill.title })} width={560} returnTo={returnTo}>
      <div
        className="space-y-4 max-sm:min-h-[60dvh]"
        data-testid="skill-example"
        data-name={skill.name}
        data-state={shown}
        onKeyDown={(ev) => {
          if (!many || (ev.target as HTMLElement).closest('a,input,textarea')) return
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1) }
          else if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1) }
        }}
      >
        {body}
        <div className="space-y-1">
          {e && shown !== 'failed' && (
            <p className="text-label text-muted" data-testid="skill-example-fictional">{t('skillPack.fictional', { company: EXAMPLE_COMPANY[skill.locale === 'ko' ? 'ko' : 'en'] })}</p>
          )}
          <SourceLine skill={skill} />
        </div>
        {many && (
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <IconButton label={t('skillPack.prev')} onClick={() => go(-1)} data-testid="skill-example-prev">
              <ChevronLeft size={18} aria-hidden />
            </IconButton>
            <span className="text-xs text-faint tabular-nums" aria-live="polite">{index + 1}/{items.length}</span>
            <IconButton label={t('skillPack.next')} onClick={() => go(1)} data-testid="skill-example-next">
              <ChevronRight size={18} aria-hidden />
            </IconButton>
          </div>
        )}
      </div>
    </Modal>
  )
}
