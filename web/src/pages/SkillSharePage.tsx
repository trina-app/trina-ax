// /skills/share/:id: one share proposal of the owner's or admin's own (docs/DECISIONS.md "SK — 내 스킬 가져오기"), where
// the notice "Claude Code에서 스킬 N개를 공유하자고 했어요 · 확인" (or Codex's) and the link the app gives lead; the same
// list as the welcome step (components/onboarding/SkillShareReview.tsx) under its own heading. "나중에 하기" leaves the
// proposal as it is (it waits until it expires, and the notice still leads here); after [팀에 공유] the primary goes
// to the team skills. While the owner's welcome steps are unfinished (docs/DECISIONS.md "W5": the link and the notice
// are exits from 내 스킬 가져오기) both go back to /welcome ("설정으로 돌아가기"), which resumes at its step; the server
// records the share as 내 스킬 done. Members make no proposals (their way is "스킬로 제안"), but a proposal to one of their
// groups is theirs to review (docs/DECISIONS.md "Group skills"): the notice and Team skills › 검토 lead here; any
// other proposal is "gone" for them (the server answers 404). Here the proposer may also choose where it goes (the
// team or one of their groups).
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { SkillShare } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { ErrorNote, Skeleton } from '../components/ui'
import { quietLink, SkillShareReview } from '../components/onboarding/SkillShareReview'

export default function SkillSharePage() {
  const me = useMeStrict()
  return <SharePage team={me.team.name} owner={isOwner(me)} />
}

function SharePage({ team, owner }: { team: string; owner: boolean }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  // the owner's welcome steps, still unfinished: this page is a trip away from them (the way back is /welcome)
  const progress = useWelcome((s) => s.progress)
  const welcomeLoaded = useWelcome((s) => s.loaded)
  useEffect(() => {
    if (owner) void useWelcome.getState().load(true).catch(() => {})
  }, [owner])
  const inSetup = owner && !!progress && !progress.finishedAt
  const { id = '' } = useParams()
  const [share, setShare] = useState<SkillShare | null | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  // the group the proposal goes to now (the proposer may move it on this page): the title says it
  const [target, setTarget] = useState<string | null>(null)
  const load = () => {
    setError(null)
    api.call(API.getSkillShare, { params: { id } }).then(setShare, (e) => (isApiError(e, 'not_found') ? setShare(null) : setError(e)))
  }
  useEffect(() => {
    setShare(undefined)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const toSkills = () => navigate('/skills')
  const toSetup = () => navigate('/welcome')

  let body
  if (error) body = <ErrorNote onRetry={load}>{errorText(error, locale, t('error.network'))}</ErrorNote>
  // the owner's progress is read before the list, so its primary never changes under the pointer
  else if (share === undefined || (owner && !welcomeLoaded)) body = <Skeleton lines={5} />
  else if (share === null) {
    body = (
      <p className="text-sm text-muted" data-testid="skill-share-gone">
        {t('welcome.skills.gone')}
        <span aria-hidden> · </span>
        <Link to="/skills" className={quietLink}>{t('skillShare.page.toSkills')}</Link>
      </p>
    )
  } else if (inSetup) body = <SkillShareReview share={share} team={team} doneLabel={t('skillShare.page.toSetup')} onDone={toSetup} onLater={toSetup} onStopped={toSetup} inSetup />
  else body = <SkillShareReview share={share} team={team} doneLabel={t('skillShare.page.toSkills')} onDone={toSkills} onLater={toSkills} onStopped={toSkills} pickTarget onTarget={setTarget} />

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="skill-share-page">
      <div className="mx-auto w-full max-w-[640px] space-y-5 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">{target ? t('skillShare.page.titleGroup', { group: target }) : t('skillShare.page.title')}</h1>
          <p className="text-sm text-balance text-muted">{target ? t('skillShare.page.descGroup', { group: target }) : t('skillShare.page.desc')}</p>
        </div>
        {body}
      </div>
    </div>
  )
}
