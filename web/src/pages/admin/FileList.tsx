// Admin › Team settings › File list (#file-list; server/src/file-list/, docs/DECISIONS.md "File list"): every night the
// team's AI reads new and changed files and the server keeps one line per file; the AI's file tools show them as a
// _FILES.md in each folder, which the in-app AI greps first. One switch (on by default) and a short status: files
// listed and waiting, the last and next run, whose team AI account the runs use (they count against its limit), and why
// it cannot run. "Run now" starts a capped run at once. Lean: no list of folders, no per-file view. Saves at once, like
// the AI groups above. While a run goes, the status is read again every few seconds.
import { Loader2, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileListSignIn, FileListStatus } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatNumber } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button, confirmDialog, Switch } from '../../components/ui'
import { Loadable, SettingsSection, useAction, useLoad } from './common'

const POLL_MS = 4000

export default function FileListSettings() {
  const t = useT()
  const state = useLoad(() => api.call(API.fileListStatus))
  const running = !!state.data?.running
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void api.call(API.fileListStatus).then(state.setData, () => {}), POLL_MS)
    return () => clearInterval(id)
  }, [running, state.setData])
  const d = state.data
  return (
    <SettingsSection id="file-list" title={t('fileList.title')} desc={t('fileList.desc')} testId="file-list"
      actions={d ? <FileListToggle d={d} onData={state.setData} /> : undefined}>
      <Loadable state={state} lines={2}>
        {(data) => <FileListStatusLines d={data} onData={state.setData} />}
      </Loadable>
    </SettingsSection>
  )
}

export function FileListToggle({ d, onData }: { d: FileListStatus; onData: (d: FileListStatus) => void }) {
  const t = useT()
  const act = useAction()
  const [saving, setSaving] = useState(false)
  const toggle = async (on: boolean) => {
    if (!on && !(await confirmDialog({ title: t('fileList.offTitle'), body: t('fileList.offBody'), confirm: t('fileList.offConfirm'), danger: true }))) return
    setSaving(true)
    const r = await act(() => api.call(API.updateFileList, { body: { enabled: on } }), t(on ? 'fileList.onSaved' : 'fileList.offSaved'))
    setSaving(false)
    if (r) onData(r)
  }
  return (
    <Switch id="file-list-enabled" checked={d.enabled && !d.forcedOff} disabled={saving || d.forcedOff} onChange={(v) => void toggle(v)}
      label={t('fileList.title')} hideLabel describedBy="file-list-status" testId="file-list-enabled" />
  )
}

/** "Claude Haiku", "ChatGPT (gpt-x-mini)" */
function engineName(s: FileListSignIn): string {
  if (s.engine === 'claude-code') return s.model === 'haiku' || !s.model ? 'Claude Haiku' : `Claude (${s.model})`
  return s.model ? `ChatGPT (${s.model})` : 'ChatGPT'
}

export function FileListStatusLines({ d, onData }: { d: FileListStatus; onData: (d: FileListStatus) => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const [starting, setStarting] = useState(false)
  const on = d.enabled && !d.forcedOff
  const runNow = async () => {
    setStarting(true)
    const r = await act(() => api.call(API.runFileList), t('fileList.runStarted'))
    setStarting(false)
    if (r) onData(r)
  }
  const account = (s: FileListSignIn) =>
    s.kind === 'server' ? t('fileList.account.server')
      : s.by ? t('fileList.account.teamBy', { label: s.label ?? '', name: s.by }) : t('fileList.account.team', { label: s.label ?? '' })
  const lines: { key: string; text: string; tone?: 'warn' }[] = []
  if (d.forcedOff) lines.push({ key: 'forced', text: t('fileList.problem.forced_off'), tone: 'warn' })
  else if (!on) lines.push({ key: 'off', text: t('fileList.off') })
  else {
    lines.push({ key: 'counts', text: d.waiting ? t('fileList.countsWaiting', { listed: formatNumber(d.listed, locale), waiting: formatNumber(d.waiting, locale) }) : t('fileList.counts', { listed: formatNumber(d.listed, locale) }) })
    const last = d.lastRun ? t('fileList.lastRun', { time: formatDateTime(d.lastRun.startedAt, locale), n: formatNumber(d.lastRun.read, locale) }) : t('fileList.never')
    lines.push({ key: 'runs', text: d.nextRunAt ? `${last} · ${t('fileList.nextRun', { time: formatDateTime(d.nextRunAt, locale) })}` : last })
    if (d.signIn) lines.push({ key: 'uses', text: t('fileList.uses', { engine: engineName(d.signIn), account: account(d.signIn) }) })
    if (d.problem && d.problem !== 'forced_off') lines.push({ key: 'problem', text: t(`fileList.problem.${d.problem}`), tone: 'warn' })
  }
  return (
    <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
      <ul id="file-list-status" className="min-w-0 space-y-1 text-sm text-muted" data-testid="file-list-status">
        {lines.map((l) => <li key={l.key} className={l.tone === 'warn' ? 'text-warn' : undefined} data-testid={`file-list-${l.key}`}>{l.text}</li>)}
      </ul>
      {on && (
        d.running
          ? <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted" role="status" data-testid="file-list-running"><Loader2 size={14} className="animate-spin" aria-hidden /> {t('fileList.running')}</span>
          : <Button size="sm" className="shrink-0 self-start sm:self-auto" busy={starting} disabled={d.problem === 'no_ai' || d.problem === 'no_cheap_model'} onClick={() => void runNow()} data-testid="file-list-run"><Play size={14} aria-hidden /> {t('fileList.runNow')}</Button>
      )}
    </div>
  )
}
