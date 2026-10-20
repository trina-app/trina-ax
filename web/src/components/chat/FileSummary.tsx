// "파일 3개 저장 · 1개 충돌 사본 · 1개 권한 없음" under an answer (turn file_events). Open it to see each file;
// a click previews it. Rejected writes explain why and offer to ask the AI to save into the person's own folder.
import { ChevronDown, ChevronRight, FileCheck2, FileWarning, Ban } from 'lucide-react'
import { useState } from 'react'
import type { FileChangeSummary } from '@mycel/shared/api'
import { openTeamFile } from '../../lib/sidePanel'
import { useT } from '../../i18n'
import { Button } from '../ui'

export function summaryCounts(f: FileChangeSummary) {
  return { saved: f.saved.length, conflicts: f.conflicts.length, rejected: f.rejected.length }
}

export default function FileSummary({ files, onAskOwnFolder, disabled }: { files: FileChangeSummary; onAskOwnFolder: (path: string) => void; disabled?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const c = summaryCounts(files)
  if (!c.saved && !c.conflicts && !c.rejected) return null
  const parts = [c.saved && t('files.summary.saved', { n: c.saved }), c.conflicts && t('files.summary.conflicts', { n: c.conflicts }), c.rejected && t('files.summary.rejected', { n: c.rejected })].filter(Boolean)
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface text-sm" data-testid="file-summary">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover">
        {c.rejected || c.conflicts ? <FileWarning size={15} className="text-warn" aria-hidden /> : <FileCheck2 size={15} className="text-ok" aria-hidden />}
        <span className="flex-1">{parts.join(' · ')}</span>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      </button>
      {open && (
        <ul className="space-y-1 border-t border-line px-3 py-2">
          {files.saved.map((s) => (
            <li key={s.path} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-faint">{t(s.action === 'create' ? 'files.summary.created' : 'files.summary.updated')}</span>
              <button type="button" className="min-w-0 truncate text-left text-accent-text hover:underline" onClick={() => openTeamFile(s.path)}>
                {s.path}
              </button>
            </li>
          ))}
          {files.conflicts.map((x) => (
            <li key={x.copyPath} className="text-xs">
              <span className="text-warn">{t('files.summary.conflictLine')}</span>{' '}
              <button type="button" className="text-accent-text hover:underline" onClick={() => openTeamFile(x.copyPath)}>
                {x.copyPath}
              </button>{' '}
              <span className="text-faint">({t('files.summary.original')}: </span>
              <button type="button" className="text-accent-text hover:underline" onClick={() => openTeamFile(x.path)}>
                {x.path}
              </button>
              <span className="text-faint">)</span>
            </li>
          ))}
          {files.rejected.map((x, i) => (
            <li key={`${x.path}-${i}`} className="space-y-1 rounded-lg bg-danger-soft px-2 py-1.5 text-xs text-danger">
              <span className="flex items-start gap-1.5">
                <Ban size={13} className="mt-0.5 shrink-0" aria-hidden />
                <span>{x.path ? t('files.summary.rejectedLine', { path: x.path }) : t('files.summary.rejectedHidden')} {x.reason && <span className="text-muted">({x.reason})</span>}</span>
              </span>
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAskOwnFolder(x.path)}>
                {t('files.summary.askOwnFolder')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
