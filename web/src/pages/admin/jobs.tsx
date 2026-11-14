// A running job in Admin: its progress line, the runner that starts one and waits for it, and the update install shared
// by Admin > System ("업데이트 설치" / roll back) and Admin > Home ("지금 설치") so both ask the same question and show
// the same progress.
import { useState } from 'react'
import type { Job } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useJobs, waitForJob } from '../../store/jobs'
import { toast } from '../../store/ui'
import { updateOutcome } from '../../lib/updateOutcome'
import { ReauthDialog, useReauthCall } from './common'

/** Progress line of a running job. */
export function JobLine({ jobId }: { jobId: string }) {
  const t = useT()
  const job = useJobs((s) => s.jobs[jobId])
  const pct = job?.progress !== null && job?.progress !== undefined ? Math.round(job.progress * 100) : null
  return (
    <div className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs" role="status">
      <span className="font-medium">{job?.message ?? t('system.working')}</span>
      {pct !== null && ` · ${pct}%`}
      {pct !== null && (
        <div className="mt-1 h-1 rounded bg-line" aria-hidden>
          <div className="h-full rounded bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

export function useJobRunner() {
  const t = useT()
  const [jobId, setJobId] = useState<string | null>(null)
  const run = async (start: () => Promise<{ jobId: string } | undefined>, done: (j: Job) => unknown) => {
    const r = await start()
    if (!r) return
    setJobId(r.jobId)
    try {
      const j = await waitForJob(r.jobId)
      if (j.status === 'done') await done(j)
      else toast({ level: 'error', text: j.error?.message ?? t('system.jobFailed') })
    } finally {
      setJobId(null)
    }
  }
  return { jobId, run }
}

/** Install the available version (or go back to `previous`): the password dialog, the job and its toast. `ask('update')`
 * / `ask('rollback')` opens the dialog; render `dialog` once and `jobId` with JobLine. */
export function useUpdateInstall(o: { version?: string; previous?: string | null; running?: number; onDone: () => void }) {
  const t = useT()
  const reauth = useReauthCall()
  const runner = useJobRunner()
  const [ask, setAsk] = useState<'update' | 'rollback' | null>(null)
  // tasks running now: the update waits for them (at most 30 minutes) unless the owner picks "Update now anyway"
  const running = o.running ?? 0
  const start = async (password: string, force: boolean) => {
    // a wrong password stays in the dialog, under the field (QA TC-221); it closes once the install started
    const r = await reauth(() => api.call(API.startUpdate, { body: ask === 'rollback' ? { password, rollback: true, ...(force ? { force } : {}) } : { password, version: o.version, ...(force ? { force } : {}) } }))
    if (r && 'refused' in r) return r.refused
    setAsk(null)
    if (!r) return
    await runner.run(
      async () => r.value,
      // "finished" only once the server answers with the new version; a version that did not stay (a Go back that
      // bounced, QA TC-336) is said as such (lib/updateOutcome.ts)
      async (job) => {
        const out = await updateOutcome(job, { health: () => api.call(API.health), fetchJob: (id) => api.call(API.getJob, { params: { id } }) })
        if (out.kind === 'ok') toast({ level: 'success', text: t('system.updateDone') })
        else if (out.kind === 'not_kept') toast({ level: 'error', text: out.message ?? t('system.updateNotKept', { version: out.version, current: out.current }) })
        else toast({ level: 'info', text: t('system.updateStillRestarting') })
        o.onDone()
      },
    )
  }
  const dialog = ask && (
    <ReauthDialog
      title={ask === 'update' ? t('system.installUpdate') : t('system.rollback', { version: o.previous ?? '' })}
      body={running > 0 ? <>{t('system.updateNote')} <span className="mt-2 block font-medium text-ink" data-testid="update-running">{t('system.updateRunning', { count: running })}</span></> : t('system.updateNote')}
      confirm={running > 0 ? t('system.updateWait') : t('common.continue')}
      alt={running > 0 ? { label: t('system.updateAnyway'), testId: 'update-anyway', onConfirm: (password) => start(password, true) } : undefined}
      onClose={() => setAsk(null)}
      onConfirm={(password) => start(password, false)}
    />
  )
  return { jobId: runner.jobId, ask: setAsk, dialog }
}
