// A running job in Admin: its progress line, the runner that starts one and waits for it, and the update install shared
// by Admin > System ("업데이트 설치" / roll back) and Admin > Home ("지금 설치") so both ask the same question and show
// the same progress.
import { useState } from 'react'
import type { Job } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useJobs, waitForJob } from '../../store/jobs'
import { toast } from '../../store/ui'
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
  const run = async (start: () => Promise<{ jobId: string } | undefined>, done: (j: Job) => void) => {
    const r = await start()
    if (!r) return
    setJobId(r.jobId)
    try {
      const j = await waitForJob(r.jobId)
      if (j.status === 'done') done(j)
      else toast({ level: 'error', text: j.error?.message ?? t('system.jobFailed') })
    } finally {
      setJobId(null)
    }
  }
  return { jobId, run }
}

/** Install the available version (or go back to `previous`): the password dialog, the job and its toast. `ask('update')`
 * / `ask('rollback')` opens the dialog; render `dialog` once and `jobId` with JobLine. */
export function useUpdateInstall(o: { version?: string; previous?: string | null; onDone: () => void }) {
  const t = useT()
  const reauth = useReauthCall()
  const runner = useJobRunner()
  const [ask, setAsk] = useState<'update' | 'rollback' | null>(null)
  const dialog = ask && (
    <ReauthDialog
      title={ask === 'update' ? t('system.installUpdate') : t('system.rollback', { version: o.previous ?? '' })}
      body={t('system.updateNote')}
      confirm={t('common.continue')}
      onClose={() => setAsk(null)}
      onConfirm={async (password) => {
        // a wrong password stays in the dialog, under the field (QA TC-221); it closes once the install started
        const r = await reauth(() => api.call(API.startUpdate, { body: ask === 'rollback' ? { password, rollback: true } : { password, version: o.version } }))
        if (r && 'refused' in r) return r.refused
        setAsk(null)
        if (!r) return
        await runner.run(
          async () => r.value,
          () => {
            toast({ level: 'success', text: t('system.updateDone') })
            o.onDone()
          },
        )
      }}
    />
  )
  return { jobId: runner.jobId, ask: setAsk, dialog }
}
