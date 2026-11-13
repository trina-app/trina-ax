// Admin › Team settings › File list (#file-list; server/src/file-list/, docs/DECISIONS.md "File list"): every night the
// team's AI reads new and changed files and the server keeps one line per file; the AI's file tools show them as a
// _FILES.md in each folder, which the in-app AI greps first. Always on, no switch (docs/DECISIONS.md "File list: always
// on"); a short status: files listed and waiting, the last and next run, whose team AI account the runs use (they count
// against its limit), and why it cannot run. "Run now" starts a capped run at once. Lean: no list of folders, no
// per-file view. While a run goes, the status is read again every few seconds. A Run now from a screen that is out of
// date (the host turned it off since) says so plainly and reads the status again, so the button goes away. On a phone (below 768 px; QA TC-382) Run now is a list row across the screen under the status.
import { Loader2, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileListSignIn, FileListStatus, Locale } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatDateTime, formatNumber } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, useMediaQuery } from '../../components/ui'
import { PhoneListRow } from '../../components/phone/PhoneList'
import { Loadable, SettingsSection, useLoad } from './common'

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
  return (
    <SettingsSection id="file-list" title={t('fileList.title')} desc={t('fileList.desc')} testId="file-list">
      <Loadable state={state} lines={2}>
        {(data) => <FileListStatusLines d={data} onData={state.setData} />}
      </Loadable>
    </SettingsSection>
  )
}

/** "Claude Haiku", "ChatGPT (gpt-x-mini)" */
function engineName(s: FileListSignIn): string {
  if (s.engine === 'claude-code') return s.model === 'haiku' || !s.model ? 'Claude Haiku' : `Claude (${s.model})`
  return s.model ? `ChatGPT (${s.model})` : 'ChatGPT'
}

/** The message for a refused Run now: the server's 409 says the host turned it off (`forced_off`); any other error keeps
 * its own text. `refused` tells the screen to read the status again. */
export function runNowError(e: unknown, locale: Locale, t: ReturnType<typeof useT>): { text: string; refused: boolean } {
  const reason = isApiError(e, 'conflict') ? e.body.params?.reason : undefined
  if (reason === 'forced_off') return { text: t('fileList.problem.forced_off'), refused: true }
  return { text: errorText(e, locale, t('error.network')), refused: false }
}

export function FileListStatusLines({ d, onData }: { d: FileListStatus; onData: (d: FileListStatus) => void }) {
  const t = useT()
  const locale = useLocale()
  const [starting, setStarting] = useState(false)
  const on = !d.forcedOff
  const phone = useMediaQuery('(max-width: 767.98px)')
  const runNow = async () => {
    setStarting(true)
    try {
      const r = await api.call(API.runFileList)
      toast({ level: 'success', text: t('fileList.runStarted') })
      onData(r)
    } catch (e) {
      const err = runNowError(e, locale, t)
      toast({ level: 'error', text: err.text })
      // the screen was out of date: show it as it is now (turned off by the host, so Run now goes away)
      if (err.refused) await api.call(API.fileListStatus).then(onData, () => {})
    } finally {
      setStarting(false)
    }
  }
  const account = (s: FileListSignIn) =>
    s.kind === 'server' ? t('fileList.account.server')
      : s.by ? t('fileList.account.teamBy', { label: s.label ?? '', name: s.by }) : t('fileList.account.team', { label: s.label ?? '' })
  const lines: { key: string; text: string; tone?: 'warn' }[] = []
  if (d.forcedOff) lines.push({ key: 'forced', text: t('fileList.problem.forced_off'), tone: 'warn' })
  else {
    lines.push({ key: 'counts', text: d.waiting ? t('fileList.countsWaiting', { listed: formatNumber(d.listed, locale), waiting: formatNumber(d.waiting, locale) }) : t('fileList.counts', { listed: formatNumber(d.listed, locale) }) })
    const last = d.lastRun ? t('fileList.lastRun', { time: formatDateTime(d.lastRun.startedAt, locale), n: formatNumber(d.lastRun.read, locale) }) : t('fileList.never')
    lines.push({ key: 'runs', text: d.nextRunAt ? `${last} · ${t('fileList.nextRun', { time: formatDateTime(d.nextRunAt, locale) })}` : last })
    if (d.signIn) lines.push({ key: 'uses', text: t('fileList.uses', { engine: engineName(d.signIn), account: account(d.signIn) }) })
    if (d.problem && d.problem !== 'forced_off') lines.push({ key: 'problem', text: t(`fileList.problem.${d.problem}`), tone: 'warn' })
  }
  const status = (
    <ul id="file-list-status" className="min-w-0 space-y-1 text-sm text-muted" data-testid="file-list-status">
      {lines.map((l) => <li key={l.key} className={l.tone === 'warn' ? 'text-warn' : undefined} data-testid={`file-list-${l.key}`}>{l.text}</li>)}
    </ul>
  )
  const canRun = d.problem !== 'no_ai' && d.problem !== 'no_cheap_model'
  // a phone (QA TC-382): Run now is a list row across the screen under the status, as in Settings, not a small button;
  // while a run goes the row says so
  if (phone)
    return (
      <div className="mt-2">
        {status}
        {on && (
          <ul className="-mx-4 mt-3 border-y border-line" data-testid="file-list-run-row">
            {d.running
              ? <PhoneListRow icon={<Loader2 size={16} className="animate-spin" />} title={<span role="status" data-testid="file-list-running">{t('fileList.running')}</span>} />
              : <PhoneListRow icon={<Play size={16} />} title={t('fileList.runNow')} onClick={() => void runNow()} disabled={starting || !canRun} testId="file-list-run"
                  end={starting ? <Loader2 size={16} className="shrink-0 animate-spin text-muted" aria-hidden /> : undefined} />}
          </ul>
        )}
      </div>
    )
  return (
    <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
      {status}
      {on && (
        d.running
          ? <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted" role="status" data-testid="file-list-running"><Loader2 size={14} className="animate-spin" aria-hidden /> {t('fileList.running')}</span>
          : <Button size="sm" className="shrink-0 self-start sm:self-auto" busy={starting} disabled={!canRun} onClick={() => void runNow()} data-testid="file-list-run"><Play size={14} aria-hidden /> {t('fileList.runNow')}</Button>
      )}
    </div>
  )
}
