// The forms of the setup's folder plan become team skills (docs/DECISIONS.md "Setup 팀 파일: forms become skills";
// OrganizeFiles.tsx Result): on the result screen, for the forms the plan moved into its forms folder (formSkillPaths:
// at most three, Hangul, Excel or Word, none named for a customer), one question to owners and admins: "견적서 양식,
// 주간보고 양식을 스킬로 만들어둘까요? 팀원이 '견적서 만들어줘' 하면 이 양식대로 채워요." [만들기] "나중에". [만들기] drafts a
// skill per form on the server (POST /api/onboarding/skill-draft/from-form) and shows S's card for each (title, one
// line, what teammates are asked, the form; [팀에 공유] "나중에"); a shared one leaves one line. "나중에" drops the question
// (or that one card). The state lives in this tab with the plan's (another step and back: the same cards); sign-out
// forgets it.
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { create } from 'zustand'
import { formKind, formStem } from '@mycel/shared/api'
import { onFolderUploadsForgotten } from '../../lib/folderRuns'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { Button } from '../ui'
import { SkillShareCard } from './SkillShareCard'

interface FormsState {
  /** the forms the state is about (another plan: asked again) */
  key: string | null
  step: 'ask' | 'make' | 'later'
  /** per form: shared (its title) or put off */
  done: Record<string, { title: string } | 'later'>
}
export const useFormSkills = create<FormsState>(() => ({ key: null, step: 'ask', done: {} }))
onFolderUploadsForgotten(() => useFormSkills.setState({ key: null, step: 'ask', done: {} }))

const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export function FormSkills({ forms, phone }: { forms: string[]; phone: boolean }) {
  const t = useT()
  const me = useMeStrict()
  const key = forms.join('\n')
  const st = useFormSkills()
  const state: FormsState = st.key === key ? st : { key, step: 'ask', done: {} }
  const put = (s: Partial<FormsState>) => useFormSkills.setState({ ...state, ...s, key })
  /** one form shared or put off (read from the store: the card answers later) */
  const settle = (f: string, v: FormsState['done'][string]) => {
    const cur = useFormSkills.getState()
    useFormSkills.setState({ key, step: 'make', done: { ...(cur.key === key ? cur.done : {}), [f]: v } })
  }
  if (!forms.length || (me.user.role !== 'owner' && me.user.role !== 'admin') || state.step === 'later') return null
  const box = phone ? 'border-y border-line py-3' : 'rounded-xl border border-line bg-surface p-4'
  if (state.step === 'ask') {
    const stems = forms.map((f) => formStem(baseOf(f)))
    return (
      <div className={clsx('space-y-2', box)} data-testid="form-skills" data-state="ask">
        <p className="text-sm font-medium text-ink" data-testid="form-skills-question">{t('welcome.forms.ask', { names: stems.join(', ') })}</p>
        <p className="text-label text-muted" data-testid="form-skills-hint">{t('welcome.forms.hint', { kind: formKind(stems[0]!) })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="max-md:min-h-11" onClick={() => put({ step: 'make' })} data-testid="form-skills-make">{t('welcome.forms.make')}</Button>
          <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={() => put({ step: 'later' })} data-testid="form-skills-later">{t('welcome.organize.later')}</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-3" data-testid="form-skills" data-state="make">
      {forms.map((f) => {
        const d = state.done[f]
        if (d === 'later') return null
        if (d) return (
          <p key={f} className="flex items-center gap-2 text-sm text-ink" role="status" data-testid="form-skills-shared" data-path={f}>
            <Check size={16} className="shrink-0 text-ok" aria-hidden /> {t('welcome.forms.shared', { title: d.title })}
          </p>
        )
        return (
          <div key={f} className={box} data-testid="form-skill" data-path={f}>
            <SkillShareCard formPath={f}
              onShared={(saved) => settle(f, { title: saved.title })} onLater={() => settle(f, 'later')} />
          </div>
        )
      })}
    </div>
  )
}
