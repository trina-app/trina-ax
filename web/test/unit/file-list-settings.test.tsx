// Admin › Team settings › File list (pages/admin/FileList.tsx; server/src/file-list/): always on, no switch, a short
// status. What the status says in each case: counts, the last and next run, whose team AI account the runs use (they
// count against its limit), why it cannot run, and Run now unless the host turned it off.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ERROR_MESSAGES, type FileListStatus } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { ApiError } from '../../src/lib/api'
import FileListSettings, { FileListStatusLines, runNowError } from '../../src/pages/admin/FileList'

const noop = () => {}
const status = (o: Partial<FileListStatus> = {}): FileListStatus => ({
  enabled: true, forcedOff: false, running: false, listed: 1240, waiting: 18,
  lastRun: { startedAt: '2026-11-11T03:12:00+09:00', endedAt: '2026-11-11T03:21:00+09:00', trigger: 'nightly', read: 96, stoppedBy: 'done' },
  nextRunAt: '2026-11-12T02:00:00+09:00', problem: null,
  signIn: { engine: 'claude-code', model: 'haiku', kind: 'team', label: 'Team Claude', by: 'Dana' }, ...o,
})
const lines = (o: Partial<FileListStatus> = {}) => renderToStaticMarkup(<FileListStatusLines d={status(o)} onData={noop} />)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('the file list status', () => {
  test('on: files listed and waiting, the last and the next run, the team AI account and who signed it in, Run now', () => {
    const html = lines()
    expect(text(html)).toContain('Files listed: 1,240 · waiting to be read: 18')
    expect(text(html)).toContain('Last run')
    expect(text(html)).toContain('files read: 96')
    expect(text(html)).toContain('next run')
    expect(text(html)).toContain('Uses Claude Haiku on the team AI account “Team Claude”, signed in by Dana. Each night\'s run counts against its limit.')
    expect(html).toContain('data-testid="file-list-run"')
    expect(html).not.toContain('data-testid="file-list-problem"')
  })
  test('the AI sign-in on the server\'s own computer; nothing waiting; no run yet', () => {
    const html = text(lines({ waiting: 0, lastRun: null, signIn: { engine: 'claude-code', model: 'haiku', kind: 'server', label: null, by: null } }))
    expect(html).toContain('Files listed: 1,240')
    expect(html).not.toContain('waiting')
    expect(html).toContain('No run yet')
    expect(html).toContain("the AI sign-in on the server's computer")
  })
  test('why it cannot run, and no Run now then', () => {
    for (const problem of ['no_ai', 'no_cheap_model'] as const) {
      const html = lines({ problem, signIn: null })
      expect(html).toContain('data-testid="file-list-problem"')
      expect(text(html)).toContain(translate('en', `fileList.problem.${problem}`))
      expect(html).toMatch(/data-testid="file-list-run"[^>]*disabled|disabled[^>]*data-testid="file-list-run"/)
    }
    expect(text(lines({ problem: 'limited' }))).toContain("The AI's usage limit stopped the last run.")
    const failed = lines({ problem: 'failed' })
    expect(text(failed)).toContain("The last file list run didn't finish. Trina will try again.")
    expect(failed).toContain('data-testid="file-list-problem"')
    // unlike no_ai, Run now still works: the next run may well go through
    expect(failed).toContain('data-testid="file-list-run"')
  })
  test('a run going: says so instead of Run now', () => {
    const html = lines({ running: true })
    expect(html).toContain('data-testid="file-list-running"')
    expect(html).not.toContain('data-testid="file-list-run"')
  })
  test('always on: no switch; only the host turns it off, and then no counts and no Run now', () => {
    expect(renderToStaticMarkup(<FileListSettings />)).not.toContain('role="switch"')
    expect(renderToStaticMarkup(<FileListSettings />)).not.toContain('file-list-enabled')
    // a status from an older server that still says "off" is shown as on: the team has no switch any more
    expect(lines({ enabled: false })).toContain('data-testid="file-list-run"')
    const forced = lines({ forcedOff: true, enabled: false })
    expect(text(forced)).toContain('Turned off on this server by its host.')
    expect(forced).not.toContain('file-list-run')
  })
  test('in Korean, plainly', () => {
    expect(translate('ko', 'fileList.countsWaiting', { listed: '1,240', waiting: '18' })).toBe('목록에 있는 파일 1,240개 · 읽기를 기다리는 파일 18개')
    expect(translate('ko', 'fileList.account.teamBy', { label: 'Team Claude', name: 'Dana' })).toBe('팀 AI 계정 “Team Claude” (Dana 님이 로그인)')
  })
  test('Run now refused because the host turned it off (a screen from before): a plain message, and the status is read again', () => {
    const en: Parameters<typeof runNowError>[2] = (k, p) => translate('en', k, p)
    const refused = (reason: string) => new ApiError(409, { code: 'conflict', message: ERROR_MESSAGES.conflict.en, params: { reason } })
    expect(runNowError(refused('forced_off'), 'en', en)).toEqual({ text: 'Turned off on this server by its host.', refused: true })
    // before: the generic "This conflicts with another change"
    expect(runNowError(refused('forced_off'), 'en', en).text).not.toBe(ERROR_MESSAGES.conflict.en)
    // any other error keeps its own text and does not read the status again
    expect(runNowError(new Error('boom'), 'en', en)).toEqual({ text: 'boom', refused: false })
  })
})
