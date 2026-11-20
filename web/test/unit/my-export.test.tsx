// Settings › Export (QA AP-038, components/settings/MyExport.tsx): every member, not guests; the button, the progress
// while the job runs, and the ready line with its Download button once the ZIP is there.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MyExportView, myExportOf } from '../../src/components/settings/MyExport'
import { translate } from '../../src/i18n'
import { settingsTabs } from '../../src/pages/settingsTabs'

const noop = () => {}
const ready = { download: '/api/me/export/0190f0b2-0000-7000-8000-000000000001/download', size: 2048, chats: 3 }

describe('Settings › Export', () => {
  test('a section for members, under Memory; not for guests', () => {
    const member = settingsTabs(false).map((x) => x.id)
    expect(member.slice(member.indexOf('memory'), member.indexOf('memory') + 2)).toEqual(['memory', 'export'])
    expect(settingsTabs(false, false, false, true).map((x) => x.id)).not.toContain('export')
  })

  test('before an export: the start button only', () => {
    const html = renderToStaticMarkup(<MyExportView running={null} result={null} onStart={noop} onDownload={noop} />)
    expect(html).toContain('data-testid="my-export-start"')
    expect(html).toContain(translate('en', 'myExport.start'))
    expect(html).not.toContain('my-export-ready')
  })

  test('while it runs: the button is off and the progress shows; when done: how many chats, the size and Download', () => {
    const running = renderToStaticMarkup(<MyExportView running="0190f0b2-0000-7000-8000-000000000009" result={null} onStart={noop} onDownload={noop} />)
    expect(running).toMatch(/<button[^>]*disabled[^>]*data-testid="my-export-start"|<button[^>]*data-testid="my-export-start"[^>]*disabled/)
    expect(running).toContain('role="status"')
    const done = renderToStaticMarkup(<MyExportView running={null} result={ready} onStart={noop} onDownload={noop} />)
    expect(done).toContain('data-testid="my-export-download"')
    expect(done).toContain('Chats: 3')
    expect(done).toContain('24 hours')
  })

  test("a job's result is an export only in its own shape", () => {
    expect(myExportOf({ result: ready })).toEqual(ready)
    expect(myExportOf({ result: { path: 'users/x/exports/a.tar.zst', size: 1 } })).toBeNull()
    expect(myExportOf({ result: { ...ready, download: 'https://evil.example/x' } })).toBeNull()
    expect(myExportOf({ result: null })).toBeNull()
  })
})
