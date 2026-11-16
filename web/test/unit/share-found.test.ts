// Find work files' share step (docs/decisions/20261116-find-files-share-step.md; lib/shareFound.ts): which
// added files get the "Good to share" hint (the AI's reason first, else the name; only the kinds teams keep together),
// the hinted ones listed first, and the share itself: one batch call for the ticked files, a 429 waits the server's
// time and presses again, a file the server refused keeps its words.
import { describe, expect, test } from 'bun:test'
import { ApiError } from '@mycel/shared/api'
import { hintedFirst, shareBatch, shareHint } from '../../src/lib/shareFound'

const base = 'users/bob/From this computer/Documents'

describe('the hint', () => {
  test('the AI\'s reason for the path decides; a report or a proposal gets none', () => {
    const reasons = new Map([[`${base}/q.xlsx`, 'form' as const], [`${base}/Northwind.pptx`, 'proposal' as const]])
    expect(shareHint(`${base}/q.xlsx`, reasons)).toBe('form')
    expect(shareHint(`${base}/Northwind.pptx`, reasons)).toBeNull()
  })
  test('without the AI: the name rules (a template, a brand guide), never a plain name', () => {
    const none = new Map()
    expect(shareHint(`${base}/Quote template 2026.xlsx`, none)).toBe('form')
    expect(shareHint(`${base}/Brand guide v3.pdf`, none)).toBe('training')
    expect(shareHint(`${base}/Weekly report.docx`, none)).toBeNull()
    expect(shareHint(`${base}/notes.txt`, none)).toBeNull()
  })
  test('hinted files first, the rest in the order they were added', () => {
    const paths = [`${base}/a.txt`, `${base}/Quote template.xlsx`, `${base}/b.txt`, `${base}/Logo.png`]
    expect(hintedFirst(paths, new Map())).toEqual([`${base}/Quote template.xlsx`, `${base}/Logo.png`, `${base}/a.txt`, `${base}/b.txt`])
  })
})

describe('the share (one press: the batch call)', () => {
  const sales = [{ subjectType: 'group' as const, subjectId: 'g-sales' }]
  const words = (e: unknown) => (e instanceof Error ? e.message : 'failed')
  test('one call for every ticked file with the same people and groups; a file the server refused keeps its words', async () => {
    const calls: [string[], unknown][] = []
    const r = await shareBatch(['a', 'b', 'c'], sales, { post: async (paths, add) => { calls.push([paths, add]); return { shared: ['a', 'c'], failed: [{ path: 'b', message: 'Only the file\'s owner can share it.', reason: 'file_share_not_owner' }] } }, words })
    expect(calls).toEqual([[['a', 'b', 'c'], sales]])
    expect(r).toEqual({ shared: ['a', 'c'], failed: [{ path: 'b', message: 'Only the file\'s owner can share it.' }] })
  })
  test('a 429 waits what the server says and presses again; three waits at most', async () => {
    const waits: number[] = []
    let tries = 0
    const r = await shareBatch(['a'], sales, {
      post: async () => { if (tries++ === 0) throw new ApiError(429, { code: 'rate_limited', message: 'slow down', retryAfter: 2 } as never); return { shared: ['a'], failed: [] } },
      words, wait: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([2000])
    expect(r.shared).toEqual(['a'])
    const waits2: number[] = []
    const r2 = await shareBatch(['a', 'b'], sales, { post: async () => { throw new ApiError(429, { code: 'rate_limited', message: 'busy' } as never) }, words, wait: async (ms) => { waits2.push(ms) } })
    expect(waits2).toEqual([1000, 1000, 1000])
    expect(r2.failed).toEqual([{ path: 'a', message: 'busy' }, { path: 'b', message: 'busy' }])
  })
  test('a press refused as a whole: every file failed with those words', async () => {
    const r = await shareBatch(['a', 'b'], sales, { post: async () => { throw new Error('That person or group can\'t be added.') }, words })
    expect(r).toEqual({ shared: [], failed: [{ path: 'a', message: 'That person or group can\'t be added.' }, { path: 'b', message: 'That person or group can\'t be added.' }] })
  })
})
