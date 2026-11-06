// /skills/share/:id: one share proposal of the owner's or admin's own (docs/DECISIONS.md "K — 내 스킬 가져오기"), where
// the notice "Claude Code에서 스킬 N개를 공유하자고 했어요 · 확인" leads; the same list as the welcome step
// (components/onboarding/SkillShareReview.tsx) under its own heading. "나중에 하기" leaves the proposal as it is (it waits
// until it expires, and the notice still leads here); after [팀에 공유] the primary goes to the team skills. Members
// have no proposals (their way is "스킬로 제안"): they go Home.
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import type { SkillShare } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { isAdmin, useMeStrict } from '../store/session'
import { ErrorNote, Skeleton } from '../components/ui'
import { quietLink, SkillShareReview } from '../components/onboarding/SkillShareReview'

export default function SkillSharePage() {
  const me = useMeStrict()
  if (!isAdmin(me)) return <Navigate to="/" replace />
  return <SharePage team={me.team.name} />
}

function SharePage({ team }: { team: string }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const { id = '' } = useParams()
  const [share, setShare] = useState<SkillShare | null | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
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

  let body
  if (error) body = <ErrorNote onRetry={load}>{errorText(error, locale, t('error.network'))}</ErrorNote>
  else if (share === undefined) body = <Skeleton lines={5} />
  else if (share === null) {
    body = (
      <p className="text-sm text-muted" data-testid="skill-share-gone">
        {t('welcome.skills.gone')}
        <span aria-hidden> · </span>
        <Link to="/skills" className={quietLink}>{t('skillShare.page.toSkills')}</Link>
      </p>
    )
  } else body = <SkillShareReview share={share} team={team} doneLabel={t('skillShare.page.toSkills')} onDone={toSkills} onLater={toSkills} onStopped={toSkills} />

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="skill-share-page">
      <div className="mx-auto w-full max-w-[640px] space-y-5 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-ink">{t('skillShare.page.title')}</h1>
          <p className="text-sm text-balance text-muted">{t('skillShare.page.desc')}</p>
        </div>
        {body}
      </div>
    </div>
  )
}
