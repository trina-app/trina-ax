// The team logo's AI help (docs/decisions/20261128-team-icon-ai-assist.md; web/src/lib/teamIconSiteRun.ts): the
// pressing window asks for its run until it ends: one callback for the end it saw, onEnd once, nothing after a stop.
import { afterEach, describe, expect, test } from 'bun:test'
import { watchSiteRun } from '../../src/lib/teamIconSiteRun'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real })
/** the server's answers to GET …/team-icon/from-site, one per ask (the last repeats) */
function serve(answers: unknown[]) {
  let asked = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/api/admin/team-icon/from-site')) return new Response('{}', { status: 404 })
    const a = answers[Math.min(asked++, answers.length - 1)]
    return new Response(JSON.stringify(a), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return () => asked
}
const settle = () => new Promise((r) => setTimeout(r, 60))

describe('watchSiteRun', () => {
  test('running, then set: onSet once with the version, then onEnd once', async () => {
    const asked = serve([{ status: 'running' }, { status: 'running' }, { status: 'set', version: '0123456789abcdef', ai: 'picked' }])
    const got: string[] = []
    watchSiteRun({ pollMs: 5, onSet: (v) => got.push(`set ${v}`), onNone: (m) => got.push(`none ${m}`), onEnd: () => got.push('end') })
    await settle()
    expect(got).toEqual(['set 0123456789abcdef', 'end'])
    expect(asked()).toBe(3)
  })

  test('none says the server\'s words; idle (a lost run) and the time limit just end', async () => {
    serve([{ status: 'none', message: '홈페이지에서 쓸 만한 아이콘을 찾지 못했어요.' }])
    const a: string[] = []
    watchSiteRun({ pollMs: 5, onSet: () => a.push('set'), onNone: (m) => a.push(m), onEnd: () => a.push('end') })
    await settle()
    expect(a).toEqual(['홈페이지에서 쓸 만한 아이콘을 찾지 못했어요.', 'end'])
    serve([{ status: 'idle' }])
    const b: string[] = []
    watchSiteRun({ pollMs: 5, onSet: () => b.push('set'), onEnd: () => b.push('end') })
    await settle()
    expect(b).toEqual(['end'])
    serve([{ status: 'running' }])
    const c: string[] = []
    watchSiteRun({ pollMs: 5, maxMs: 20, onSet: () => c.push('set'), onEnd: () => c.push('end') })
    await new Promise((r) => setTimeout(r, 120))
    expect(c).toEqual(['end'])
  })

  test('stopped (the screen closed): nothing more is asked or said', async () => {
    const asked = serve([{ status: 'running' }, { status: 'set', version: '0123456789abcdef', ai: 'checked' }])
    const got: string[] = []
    const stop = watchSiteRun({ pollMs: 20, onSet: () => got.push('set'), onEnd: () => got.push('end') })
    stop()
    await settle()
    expect(got).toEqual([])
    expect(asked()).toBe(0)
  })
})
