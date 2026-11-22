// A page's versions in the panel (components/ArtifactPanel.tsx VersionStrip; scenario QA S-033): which version is shown
// and who asked for it, and on an earlier one [Restore this version] and [Back to newest], in the chat files' words.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ArtifactSummary } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { VersionStrip } from '../../src/components/ArtifactPanel'
import { aiName } from '../../src/lib/tabs'
import { installDom, mount, removeDom } from './dom-host'

const v = (version: number, extra: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: `01900000-0000-7000-8000-00000000000${version}`, chatId: '01900000-0000-7000-8000-0000000000c1', messageId: null, key: 'event',
  version, type: 'html', title: '연말 행사', language: null, createdAt: new Date().toISOString(), size: 10, ...extra,
})
const say = (k: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(useLocaleStore.getState().locale, k, vars)

beforeAll(() => { installDom() })
afterAll(() => removeDom())

describe('the version strip', () => {
  test('the newest: who asked, no restore', async () => {
    const m = await mount(<VersionStrip version={v(3, { byName: 'Junho', ai: true, messageId: '01900000-0000-7000-8000-0000000000d1' })} newest restoring={false} onRestore={() => {}} onNewest={() => {}} />)
    const t = (k: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => say(k, vars)
    expect(m.get('artifact-version-by').textContent).toContain(t('chatFile.byAi', { ai: aiName(t as never), name: 'Junho' }))
    expect(m.find('artifact-version-restore')).toBeNull()
    await m.unmount()
  })

  test('an earlier one: restore and back to the newest; a person\'s own restore by their name alone', async () => {
    let restored = 0, newest = 0
    const m = await mount(<VersionStrip version={v(1, { byName: 'Seoyeon' })} newest={false} restoring={false} onRestore={() => restored++} onNewest={() => newest++} />)
    expect(m.get('artifact-version-by').textContent).toContain('Seoyeon')
    expect(m.get('artifact-version-by').textContent).not.toContain('Trina')
    expect(m.get('artifact-version-restore').textContent).toContain(say('chatFile.restore'))
    await m.click('artifact-version-restore')
    await m.click('artifact-version-newest')
    expect([restored, newest]).toEqual([1, 1])
    await m.unmount()
  })

  test('a version from an older server, without who asked', async () => {
    const m = await mount(<VersionStrip version={v(2)} newest={false} restoring={false} onRestore={() => {}} onNewest={() => {}} />)
    expect(m.get('artifact-version-by').textContent).toContain(say('chatFile.versionN', { n: 2 }))
    await m.unmount()
  })
})
