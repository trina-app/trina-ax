// An admin's "팀 파일 정리하기" on Admin › Home (docs/decisions/20261120-my-setup-card.md; before, a row of the welcome
// card): while nobody applied the setup's folder plan (GET /api/me/welcome `organizeFiles`; docs/DECISIONS.md "Setup
// 팀 파일: the AI proposes folders"), one quiet row that opens the 팀 파일 step in a dialog, as on the Files screen; its
// plan applied, the answer is read again and the row goes.
import { FolderTree } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { SHARED_HOME } from '@mycel/shared/api'
import { useFolderWords } from '../../lib/folderLabels'
import { hasResume } from '../../lib/workFilesResume'
import { useT } from '../../i18n'
import { useMemberWelcome } from '../../store/memberWelcome'
import { useMeStrict } from '../../store/session'
import { useWelcome } from '../../store/welcome'
import { Button, Modal } from '../ui'
import { TeamFilesStep } from './TeamFilesStep'

export function OrganizeTeamFiles() {
  const organize = useMemberWelcome((s) => s.organizeFiles)
  useEffect(() => { void useMemberWelcome.getState().load() }, [])
  return organize ? <OrganizeRow /> : null
}

function OrganizeRow() {
  const t = useT()
  const words = useFolderWords()
  const progress = useWelcome((s) => s.progress)
  const me = useMeStrict()
  const location = useLocation()
  // open again after "Restart <product>" on the step's Find work files (the step takes the note and shows that screen)
  const [open, setOpen] = useState(() => hasResume(me.user.id, 'team', location.pathname + location.search))
  useEffect(() => { void useWelcome.getState().load().catch(() => {}) }, [])
  const close = () => { setOpen(false); void useMemberWelcome.getState().load() }
  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3" data-testid="admin-organize-files">
      <FolderTree size={16} className="shrink-0 text-faint" aria-hidden />
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="text-sm font-medium text-ink">{t('memberWelcome.organize')}</p>
        <p className="text-label text-muted">{t('memberWelcome.organizeHint', { shared: words.name(SHARED_HOME, SHARED_HOME) })}</p>
      </div>
      <Button size="sm" className="max-md:min-h-11" disabled={!progress} onClick={() => setOpen(true)} data-testid="admin-organize-files-button">{t('memberWelcome.organizeButton')}</Button>
      {progress && (
        <Modal open={open} onClose={close} title={t('memberWelcome.organize')} width={640}>
          <TeamFilesStep progress={progress} busy={false} nextLabel={t('common.close')} dialog onDone={close} onSkip={close} />
        </Modal>
      )}
    </section>
  )
}
