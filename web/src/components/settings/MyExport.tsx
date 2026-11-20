// Settings › Export (QA AP-038, docs/decisions/20261120-export-my-chats.md): every member downloads a ZIP of the AI
// chats they made. The server builds it (POST /api/me/export, a job) and keeps it 24 hours for its maker only; the
// owner's full export stays in Admin › System.
import { useState } from 'react'
import { Download, FileArchive } from 'lucide-react'
import { MyExportResult, type Job } from '@mycel/shared/api'
import { api, API, startDownload } from '../../lib/api'
import { formatSize } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button } from '../ui'
import { JobLine, useJobRunner } from '../../pages/admin/jobs'
import { useAction } from '../../pages/admin/common'

/** The finished export of a job, or null when the job's result is not one. */
export function myExportOf(job: Pick<Job, 'result'>): MyExportResult | null {
  const r = MyExportResult.safeParse(job.result)
  return r.success ? r.data : null
}

export function MyExportView({ running, result, onStart, onDownload }: { running: string | null; result: MyExportResult | null; onStart: () => void; onDownload: (r: MyExportResult) => void }) {
  const t = useT()
  const locale = useLocale()
  return (
    <div data-testid="my-export">
      <Button disabled={!!running} onClick={onStart} data-testid="my-export-start">
        <FileArchive size={14} aria-hidden /> {t('myExport.start')}
      </Button>
      {running && <JobLine jobId={running} />}
      {result && !running && (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="my-export-ready">
          <p className="text-sm text-ok">{t('myExport.ready', { count: String(result.chats), size: formatSize(result.size, locale) })}</p>
          <Button onClick={() => onDownload(result)} data-testid="my-export-download">
            <Download size={14} aria-hidden /> {t('myExport.download')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function MyExport() {
  const act = useAction()
  const runner = useJobRunner()
  const [result, setResult] = useState<MyExportResult | null>(null)
  return (
    <MyExportView
      running={runner.jobId}
      result={result}
      onStart={() => {
        setResult(null)
        void runner.run(
          () => act(() => api.call(API.startMyExport, {})),
          (j) => setResult(myExportOf(j)),
        )
      }}
      onDownload={(r) => startDownload(r.download)}
    />
  )
}
