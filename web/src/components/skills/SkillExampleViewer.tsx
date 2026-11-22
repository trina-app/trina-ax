// The example of a kept skill (docs/DECISIONS.md "W6"; FLOW-v6 §2.2, EXAMPLES-PLAN.md), opened by a row's "예시" on 내
// 스킬, in the Team skills catalog and in Home's "팀에 준비된 것" (docs/DECISIONS.md "W6.3"): one dialog (on phones the
// sheet the dialogs are there), one example per open (no stepping to the next row's: FLOW-v6 §2.4, lean).
// It shows an image the web build serves (a result that is a picture anyway: the deck, the cards, the video's frames)
// or a short before → after text drawn in the page's own theme, the line that the company in it is invented, and where
// the skill comes from (only skills with a known origin ship; only the English 자연스러운 글 links out). Until an
// example is made the viewer says so ("예시를 준비하고 있어요"); one that does not load says that, under the skill's line.
// ✕, Esc and a tap outside close it, and the focus goes back to the 예시 of the row it shows.
import clsx from 'clsx'
import { ExternalLink, ImageOff } from 'lucide-react'
import { useState } from 'react'
import type { Locale, PackCatalogSkill } from '@mycel/shared/api'
import { koRo, useT } from '../../i18n'
import { namedProduct } from '../../lib/tabs'
import { Markdown } from '../LazyMarkdown'
import { quietLink } from '../onboarding/SkillShareReview'
import { Modal } from '../ui'

/** The invented company the examples are made on (EXAMPLES-PLAN.md §1), by the language of the example (the everyday
 * office skills have one in each app language: docs/decisions/20261122-onboarding-everyday-skills.md). */
export const EXAMPLE_COMPANY: Record<Locale, string> = { ko: '예시커피', en: 'Example Coffee', ja: '見本コーヒー', zh: '示例咖啡', es: 'Café Ejemplo', id: 'Kopi Contoh' }
/** The invented company of an example: the server names it when it is another one (the intro deck: 숲틈 / Soopteum, in
 * the picture's language), else the coffee roaster of the skill text's language (예시커피 / Example Coffee / 見本コーヒー …). */
export const exampleCompany = (e: PackCatalogSkill['example'], locale: Locale) => (e?.kind === 'image' && e.company) || EXAMPLE_COMPANY[locale]

/** "가상의 회사 '…'로 / '…'으로 만든 예시예요": the Korean particle chosen from the name's last sound (koRo: 으로 after a
 * final consonant other than ㄹ, 로 after a vowel or ㄹ; 숲틈 → 으로, 예시커피 → 로); the other languages read the same either way. */
export const fictionalLine = (t: ReturnType<typeof useT>, company: string) => t(takesEuro(company) ? 'skillPack.fictionalEuro' : 'skillPack.fictional', { company })
/** Does the name read with a final consonant (not ㄹ)? Hangul and digits by koRo; a Latin name koRo cannot tell by its last
 * letter: a consonant other than l, r, w and y reads as one ("Soopteum", "Notion"), else not ("Example Coffee", "Gmail"). */
export function takesEuro(name: string): boolean {
  const r = koRo(name)
  if (r === EURO) return true
  if (r !== '(\uc73c)\ub85c') return false
  return /[bcdfghjkmnpqstvxz]$/i.test(name.trim())
}
/** "으로" (written as code points: this file holds no Korean screen text) */
const EURO = '\uc73c\ub85c'

/** The source line of a kept skill, with its one link out (the open-source original) when it has one. The makers are
 * named as the app names its AI ("트리나 팀이 만들었어요", tabs.ts namedProduct). */
export function SourceLine({ skill }: { skill: Pick<PackCatalogSkill, 'source'> }) {
  const t = useT()
  const s = skill.source
  const product = namedProduct(t)
  if (s.kind === 'team') return <p className="text-label text-muted" data-testid="skill-example-source" data-kind="team">{t('skillPack.source.team', product)}</p>
  if (s.kind === 'team_writing') return <p className="text-label text-muted" data-testid="skill-example-source" data-kind="team_writing">{t('skillPack.source.teamWriting', product)}</p>
  return (
    <p className="text-label text-muted" data-testid="skill-example-source" data-kind="adapted">
      {t('skillPack.source.adapted', { ...product, author: s.author, project: s.project, license: s.license })}
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
  /** the row's skill (a catalog row, or Home's "팀에 준비된 것" row: components/onboarding/TeamPrepared.tsx) */
  skill: Pick<PackCatalogSkill, 'name' | 'title' | 'description' | 'example' | 'locale' | 'source'>
  onClose: () => void
  /** where the focus goes back to (the shown row's 예시) */
  returnTo?: HTMLElement | null
}

export function SkillExampleViewer({ skill, onClose, returnTo }: SkillExampleViewerProps) {
  const t = useT()
  // an image is loading until it says otherwise; one that fails shows the error state
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading')
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
      >
        {body}
        <div className="space-y-1">
          {e && shown !== 'failed' && (
            <p className="text-label text-muted" data-testid="skill-example-fictional">{fictionalLine(t, exampleCompany(e, skill.locale))}</p>
          )}
          <SourceLine skill={skill} />
        </div>
      </div>
    </Modal>
  )
}
