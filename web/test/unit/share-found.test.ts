// Find work files' share step (docs/decisions/20261116-find-files-share-step.md; lib/shareFound.ts): which
// added files get the "Good to share" hint (the AI's reason first, else the name; only the kinds teams keep together),
// the hinted ones listed first, and the share itself: one Share dialog call per ticked file, a 429 waits the server's
// time and tries again, any other refusal is that file's, and a closed dialog stops.
import { describe, expect, test } from 'bun:test'
import { ApiError } from '@mycel/shared/api'
import { hintedFirst, shareEach, shareHint } from '../../src/lib/shareFound'

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

describe('the share', () => {
  const sales = [{ subjectType: 'group' as const, subjectId: 'g-sales' }]
  test('one call per file with the same people and groups', async () => {
    const calls: [string, unknown][] = []
    const steps: number[] = []
    const r = await shareEach(['a', 'b'], sales, { put: async (p, add) => { calls.push([p, add]) }, onStep: (k) => steps.push(k) })
    expect(calls).toEqual([['a', sales], ['b', sales]])
    expect(r).toEqual({ shared: ['a', 'b'], failed: [] })
    expect(steps).toEqual([1, 2])
  })
  test('a 429 waits what the server says and tries the same file again; another refusal is that file\'s', async () => {
    const waits: number[] = []
    let tries = 0
    const off = new ApiError(403, { code: 'forbidden', message: 'Your team turned off sharing files one by one for members.' } as never)
    const r = await shareEach(['a', 'b', 'c'], sales, {
      put: async (p) => {
        if (p === 'a' && tries++ === 0) throw new ApiError(429, { code: 'rate_limited', message: 'slow down', retryAfter: 2 } as never)
        if (p === 'b') throw off
      },
      wait: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([2000])
    expect(r.shared).toEqual(['a', 'c'])
    expect(r.failed).toEqual([{ path: 'b', error: off }])
  })
  test('a 429 that never ends gives up on that file after three waits', async () => {
    const waits: number[] = []
    const r = await shareEach(['a'], sales, { put: async () => { throw new ApiError(429, { code: 'rate_limited', message: 'x' } as never) }, wait: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([1000, 1000, 1000])
    expect(r.failed.map((f) => f.path)).toEqual(['a'])
  })
  test('a closed dialog stops; what went stays', async () => {
    let open = true
    const r = await shareEach(['a', 'b'], sales, { put: async () => { open = false }, live: () => open })
    expect(r).toEqual({ shared: ['a'], failed: [] })
  })
})
