// A file of Find work files whose content is in the cloud only: the run says "Getting plan.pdf from iCloud…" while the
// desktop app downloads it, apart from "Uploading", and a download over the read's minute says so plainly.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkCloudProvider } from '@mycel/shared'
import { translate } from '../../src/i18n'
import { FromCloudLine } from '../../src/components/FromCloud'
import { failedReason } from '../../src/components/onboarding/FindWorkFiles'
import { WorkFileReadError } from '../../src/lib/workFiles'

const render = (active: { name: string; cloud?: WorkCloudProvider }[]) => renderToStaticMarkup(<FromCloudLine active={active} />)

describe('getting a file from its cloud', () => {
  test('the first file being downloaded, by its name and its cloud\'s', () => {
    expect(render([{ name: 'From this computer/Documents/a.pdf' }, { name: 'From this computer/Documents/Plans/plan.pdf', cloud: 'icloud' }])).toContain('Getting plan.pdf from iCloud…')
    expect(render([{ name: 'x/b.docx', cloud: 'onedrive' }])).toContain('Getting b.docx from OneDrive…')
    expect(render([{ name: 'x/c.xlsx', cloud: 'googleDrive' }])).toContain('Getting c.xlsx from Google Drive…')
    // the app could not tell which cloud
    expect(render([{ name: 'x/d.pdf', cloud: 'cloud' }])).toContain('Getting d.pdf from the cloud…')
  })

  test('nothing while no file is being downloaded (uploading says so itself)', () => {
    expect(render([{ name: 'x/a.pdf' }])).toBe('')
    expect(render([])).toBe('')
  })

  test('a download over the minute: the reason names the cloud and the way out', () => {
    const t = ((k: string, p?: Record<string, unknown>) => translate('en', k as never, p as never)) as Parameters<typeof failedReason>[1]
    const why = failedReason({ local: 'unreadable', error: new WorkFileReadError('cloudTimeout', 'icloud') }, t, 'en')
    expect(why).toBe('Did not download from iCloud within a minute. Open it once on this computer, then add it again')
    expect(failedReason({ local: 'unreadable', error: new WorkFileReadError('cloudTimeout') }, t, 'en')).toContain('from the cloud')
    // the other reasons stay as they were
    expect(failedReason({ local: 'unreadable', error: new WorkFileReadError('changed') }, t, 'en')).toBe(translate('en', 'files.findWork.why.changed'))
  })

  test('every language has the words, with the name and the cloud in them', () => {
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
      expect(translate(l, 'files.findWork.fromCloud', { name: 'plan.pdf', provider: 'iCloud' })).toContain('plan.pdf')
      expect(translate(l, 'files.findWork.fromCloud', { name: 'plan.pdf', provider: 'iCloud' })).toContain('iCloud')
      expect(translate(l, 'files.findWork.why.cloudTimeout', { provider: 'OneDrive' })).toContain('OneDrive')
    }
  })
})
