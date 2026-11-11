// Admin › Team settings › File list (pages/admin/FileList.tsx; server/src/file-list/): one switch and a short status.
// What the status says in each case: counts, the last and next run, whose team AI account the runs use (they count
// against its limit), why it cannot run, and Run now only while on.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileListStatus } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { FileListStatusLines, FileListToggle } from '../../src/pages/admin/FileList'

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
  })
  test('a run going: says so instead of Run now', () => {
    const html = lines({ running: true })
    expect(html).toContain('data-testid="file-list-running"')
    expect(html).not.toContain('data-testid="file-list-run"')
  })
  test('off, and forced off by the host: no counts and no Run now; the switch shows it, and is locked when forced', () => {
    const off = lines({ enabled: false, nextRunAt: null })
    expect(text(off)).toContain('Off. The AI finds files by their names and text only.')
    expect(off).not.toContain('file-list-run')
    const forced = lines({ forcedOff: true })
    expect(text(forced)).toContain('Turned off on this server by its host.')
    expect(forced).not.toContain('file-list-run')
    expect(renderToStaticMarkup(<FileListToggle d={status()} onData={noop} />)).toContain('checked=""')
    const locked = renderToStaticMarkup(<FileListToggle d={status({ forcedOff: true })} onData={noop} />)
    expect(locked).not.toContain('checked=""')
    expect(locked).toContain('disabled=""')
  })
  test('in Korean, plainly', () => {
    expect(translate('ko', 'fileList.countsWaiting', { listed: '1,240', waiting: '18' })).toBe('목록에 있는 파일 1,240개 · 읽기를 기다리는 파일 18개')
    expect(translate('ko', 'fileList.account.teamBy', { label: 'Team Claude', name: 'Dana' })).toBe('팀 AI 계정 “Team Claude” (Dana 님이 로그인)')
  })
})
