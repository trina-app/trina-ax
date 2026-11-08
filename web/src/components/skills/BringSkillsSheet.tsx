// "내 스킬 가져오기" on the Team skills page for owners and admins (docs/DECISIONS.md "W6"; FLOW-v6 §4.2): the lasting
// way in for skills from Claude Code or Codex, also for an owner who finished 내 스킬 on a phone. One sheet: pick a
// folder (the same window, hint and checks as 내 스킬: SkillsStep.tsx useSkillPick) → the list (SkillShareReview, which
// applies directly: [팀에 넣기 · n개], its secondary [닫기]) → what went in, [닫기]. A check still running after 30 seconds is ended, as on 내
// 스킬. Closing the sheet with a list open drops that list (nothing went in). Members get ContributeSheet instead.
import { FolderOpen, Laptop } from 'lucide-react'
import { useRef, useState } from 'react'
import type { CreateSkillShare, SkillShare } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { FolderHint } from '../onboarding/FolderHint'
import { SkillShareReview } from '../onboarding/SkillShareReview'
import { SHARE_CHECK_LIMIT_MS, useSkillPick } from '../onboarding/SkillsStep'
import { Button, ErrorNote, Modal } from '../ui'

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
