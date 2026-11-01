// Office mode automatic updates in the web app: who sees the "new version" banner and when, and how the update card
// tells that the run it watched has ended (src/lib/officeUpdate.ts).
import { describe, expect, test } from 'bun:test'
import type { Me, OfficeUpdateStatus } from '@mycel/shared/api'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DICTS } from '../../src/i18n'
import { notesSummary, ReleaseNotes } from '../../src/components/ReleaseNotes'
import { bannerFor, finishedRun, onOfficeStatus, shareOfficeStatus } from '../../src/lib/officeUpdate'

const me = (role: 'owner' | 'admin' | 'member') => ({ user: { role } }) as unknown as Me
const at = '2026-10-21T09:00:00.000Z'
const st = (o: Partial<OfficeUpdateStatus> = {}): OfficeUpdateStatus => ({
  current: '0.2.0', channel: 'stable', paused: false, time: '03:00', nextWindowAt: at, lastCheckAt: at, last: { kind: 'available', at, version: '0.2.1', message: null },
  available: { version: '0.2.1', channel: 'stable', notes: '', publishedAt: at }, lastUpdate: null, running: null, requested: false, agentInstalled: true, desktop: null, ...o,
})

describe('new version banner', () => {
  test('owners and admins see it with the nightly time; members never', () => {
    expect(bannerFor(me('owner'), st(), null)).toEqual({ version: '0.2.1', nightly: '03:00' })
    expect(bannerFor(me('admin'), st(), null)).toEqual({ version: '0.2.1', nightly: '03:00' })
    expect(bannerFor(me('member'), st(), null)).toBeNull()
    expect(bannerFor(null, st(), null)).toBeNull()
  })
  test('not while installing, not without a newer version, gone once dismissed for that version (back for the next one)', () => {
    expect(bannerFor(me('owner'), st({ running: { since: at, step: 'download', phase: 'x', target: '0.2.1' } }), null)).toBeNull()
    expect(bannerFor(me('owner'), st({ requested: true }), null)).toBeNull()
    expect(bannerFor(me('owner'), st({ available: null }), null)).toBeNull()
    expect(bannerFor(me('owner'), null, null)).toBeNull()
    expect(bannerFor(me('owner'), st(), '0.2.1')).toBeNull()
    expect(bannerFor(me('owner'), st({ available: { version: '0.2.2', channel: 'stable', notes: '', publishedAt: at } }), '0.2.1')?.version).toBe('0.2.2')
  })
  test('gone once the server answers with a new version (this status is from before the update); the time is the status\'s', () => {
    expect(bannerFor(me('owner'), st(), null, true)).toBeNull()
    expect(bannerFor(me('owner'), st({ time: '22:51' }), null, false)).toEqual({ version: '0.2.1', nightly: '22:51' })
  })
  test('what the update card loads reaches the banner at once (a pause, another time)', () => {
    const was = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = new EventTarget()
    try {
      const got: OfficeUpdateStatus[] = []
      const off = onOfficeStatus((s) => got.push(s))
      shareOfficeStatus(st({ paused: true }))
      off()
      shareOfficeStatus(st())
      expect(got.map((s) => s.paused)).toEqual([true])
    } finally { (globalThis as Record<string, unknown>).window = was }
    expect(() => shareOfficeStatus(st())).not.toThrow() // no window: nothing happens
  })
  test('automatic updates off: no "tonight" part', () => {
    expect(bannerFor(me('owner'), st({ paused: true }), null)).toEqual({ version: '0.2.1', nightly: null })
  })
  test('strings in every language', () => {
    for (const d of Object.values(DICTS)) {
      expect(d['officeUpdate.banner']).toContain('{version}')
      expect(d['officeUpdate.bannerNightly']).toContain('{time}')
    }
  })
})

describe('the end of a watched run', () => {
  const running = st({ running: { since: at, step: 'install', phase: 'x', target: '0.2.1' } })
  test('updated / rolled back / failed, once', () => {
    const done = st({ current: '0.2.1', available: null, last: { kind: 'updated', at: '2026-10-21T09:05:00.000Z', version: '0.2.1', message: null } })
    expect(finishedRun(running, done)).toBe('updated')
    expect(finishedRun(done, done)).toBeNull()
    expect(finishedRun(null, done)).toBeNull()
    expect(finishedRun(st({ requested: true }), st({ last: { kind: 'rolled-back', at: '2026-10-21T09:06:00.000Z', version: '0.2.1', message: 'x' } }))).toBe('rolled-back')
    expect(finishedRun(running, st({ last: { kind: 'failed', at: '2026-10-21T09:06:00.000Z', version: null, message: 'x' } }))).toBe('failed')
    expect(finishedRun(running, running)).toBeNull()
  })
})

describe('release notes on the update cards', () => {
  const notes = 'Trina AX 0.2.18: the AI reads the web with far fewer questions\n\n## Who benefits / 누구에게 도움이 되나요?\n\n- one\n- two\n'
  test('the first paragraph, not the headings; "more" when there is more', () => {
    expect(notesSummary(notes)).toEqual({ summary: 'Trina AX 0.2.18: the AI reads the web with far fewer questions', more: true })
    expect(notesSummary('Only one line.')).toEqual({ summary: 'Only one line.', more: false })
    expect(notesSummary('## Heading\n\nThe text.')).toEqual({ summary: 'The text.', more: true })
    expect(notesSummary('')).toEqual({ summary: '', more: false })
    const long = notesSummary('word '.repeat(200))
    expect(long.summary.length).toBeLessThanOrEqual(401)
    expect(long.summary.endsWith('…')).toBe(true)
    expect(long.more).toBe(true)
  })
  test('rendered as Markdown, closed to the summary: no raw ## or bullets on the card', () => {
    const html = renderToStaticMarkup(createElement(ReleaseNotes, { notes }))
    expect(html).toContain('the AI reads the web')
    expect(html).not.toContain('##')
    expect(html).not.toContain('Who benefits')
    expect(html).toContain(`aria-expanded="false"`)
    expect(html).toContain(DICTS.en['update.notesMore'])
    expect(renderToStaticMarkup(createElement(ReleaseNotes, { notes: '' }))).toBe('')
    for (const d of Object.values(DICTS)) expect(d['update.notesMore'] && d['update.notesLess']).toBeTruthy()
  })
})
