// File links whose path the AI typed wrong (server/src/chat/file-link-repair.ts). AI flow check 2026-11-17 on dev
// 30a54f4e2: the model writes the percent-encoding of a Korean path itself and slipped. FL-01 linked
// "단가표-2026.xlsx" with the path of "단기표-2026.xlsx"; FL-28 linked "2026-11-15-일요일-회의록.md" with the path
// "…-일요일-을요일-회의록.md". The labels were right; the links opened nothing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { FileLinkRepair, fileLinkResolver, linkPath, repairFileLinks, withLinkPath } from '../../server/src/chat/file-link-repair'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const link = (rel: string, rest = '') => `/files/view?path=${encodeURIComponent(rel)}${rest}`

// the two links exactly as the answers had them
const FL01 = '[단가표-2026.xlsx](/files/view?path=groups%2F%EC%98%81%EC%97%85%2F%EB%8B%A8%EA%B8%B0%ED%91%9C-2026.xlsx&sheet=%EB%8B%A8%EA%B0%80%ED%91%9C)'
const FL28 = '[2026-11-15-일요일-회의록.md](/files/view?path=users%2Fsora%2F2026-11-15-%EC%9D%BC%EC%9A%94%EC%9D%BC-%EC%9D%84%EC%9A%94%EC%9D%BC-%ED%9A%8C%EC%9D%98%EB%A1%9D.md)'

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-file-link-repair', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  socks.alice = await h.ws('alice', { windowId: 'win-flr-alice' }); await socks.alice.next('hello')
})
afterAll(async () => { socks.alice?.close(); await h?.close() })
const put = (rel: string, s = 'x\n') => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

describe('the link and its path', () => {
  test('the garbled paths decode to another name than the label', () => {
    expect(linkPath(FL01.slice(FL01.indexOf('(') + 1, -1))).toBe('groups/영업/단기표-2026.xlsx')
    expect(linkPath(FL28.slice(FL28.indexOf('(') + 1, -1))).toBe('users/sora/2026-11-15-일요일-을요일-회의록.md')
    // half a character: not UTF-8, no path to go by (the label still is)
    expect(linkPath('/files/view?path=shared%2F%EB%8B')).toBe('')
    expect(linkPath('/files/view?path=%E0%A4%A')).toBe('')
    expect(linkPath('https://example.com/files/view?path=a')).toBeNull()
    expect(linkPath('/files/other?path=a')).toBeNull()
    expect(linkPath('/api/files/download?path=shared%2Fa.pdf')).toBe('shared/a.pdf')
  })

  test('only the path is replaced: the sheet, page and # stay', () => {
    expect(withLinkPath('/files/view?path=x&sheet=%EB%8B%A8#top', '그룹/단가표 (최종).xlsx'))
      .toBe(`/files/view?path=${encodeURIComponent('그룹/단가표 (최종).xlsx')}&sheet=%EB%8B%A8#top`)
  })

  test('repairFileLinks re-points only what the resolver names; images, web links and good links stay', () => {
    const resolve = (p: string, label: string) => p.endsWith('단기표-2026.xlsx') && label === '단가표-2026.xlsx' ? 'groups/영업/단가표-2026.xlsx' : null
    const text = `가격은 ${FL01} 기준이에요. ![x](/files/view?path=a.png) [web](https://example.com/files/view?path=a) [ok](${link('shared/a.md')})`
    const out = repairFileLinks(text, resolve)
    expect(out).toContain(`[단가표-2026.xlsx](${link('groups/영업/단가표-2026.xlsx')}&sheet=%EB%8B%A8%EA%B0%80%ED%91%9C)`)
    expect(out).toContain('![x](/files/view?path=a.png)')
    expect(out).toContain('[web](https://example.com/files/view?path=a)')
    expect(out).toContain(`[ok](${link('shared/a.md')})`)
  })

  test('streaming: a link cut anywhere is held until it is complete, then repaired once', () => {
    const resolve = (p: string) => p === 'users/sora/2026-11-15-일요일-을요일-회의록.md' ? 'users/sora/2026-11-15-일요일-회의록.md' : null
    const whole = `저장했어요: ${FL28}. 끝.`
    for (let cut = 1; cut < whole.length; cut += 7) {
      const r = new FileLinkRepair(resolve)
      const out = r.push(whole.slice(0, cut)) + r.push(whole.slice(cut)) + r.flush()
      expect(out).toBe(`저장했어요: [2026-11-15-일요일-회의록.md](${link('users/sora/2026-11-15-일요일-회의록.md')}). 끝.`)
    }
    // plain text with a '[' that never becomes a link goes out at the end
    const r = new FileLinkRepair(resolve)
    expect(r.push('see [note')).toBe('see ')
    expect(r.held).toBe('[note')
    expect(r.push(' here] no link\n')).toBe('[note here] no link\n')
  })
})

describe('the resolver (the person\'s own access)', () => {
  test('the two cases: the label names the file in the folder the link names', () => {
    put('shared/영업/단가표-2026.xlsx')
    put('users/alice/2026-11-15-일요일-회의록.md')
    const resolve = fileLinkResolver(h.ctx.files, () => h.ctx.files.principal('alice'))
    expect(resolve('shared/영업/단기표-2026.xlsx', '단가표-2026.xlsx')).toBe('shared/영업/단가표-2026.xlsx')
    expect(resolve('users/alice/2026-11-15-일요일-을요일-회의록.md', '2026-11-15-일요일-회의록.md')).toBe('users/alice/2026-11-15-일요일-회의록.md')
    // a link that opens: left alone, whatever its label
    expect(resolve('shared/영업/단가표-2026.xlsx', 'price list')).toBeNull()
    // nothing of that name: left alone
    expect(resolve('shared/영업/없는-파일.xlsx', '없는-파일.xlsx')).toBeNull()
  })

  test('a name stored decomposed (NFD, a Mac upload) matches the label written composed', () => {
    const nfd = '회의록-NFD.md'.normalize('NFD')
    put(`shared/${nfd}`)
    const resolve = fileLinkResolver(h.ctx.files, () => h.ctx.files.principal('alice'))
    const fixed = resolve('shared/회의록-NFD-틀림.md', '회의록-NFD.md')
    expect(fixed?.normalize('NFC')).toBe('shared/회의록-NFD.md')
  })

  test('the folder part garbled too: this turn\'s own file of that name, only when there is exactly one', () => {
    put('shared/a/보고서.md'); put('shared/b/보고서.md'); put('shared/c/요약.md')
    const one = fileLinkResolver(h.ctx.files, () => h.ctx.files.principal('alice'), () => ['shared/c/요약.md'])
    expect(one('shared/\uFFFD/요약.md', '요약.md')).toBe('shared/c/요약.md')
    const two = fileLinkResolver(h.ctx.files, () => h.ctx.files.principal('alice'), () => ['shared/a/보고서.md', 'shared/b/보고서.md'])
    expect(two('shared/x/보고서.md', '보고서.md')).toBeNull()
  })

  test('never a path the person may not read', () => {
    put('users/dana/비밀.md')
    const resolve = fileLinkResolver(h.ctx.files, () => h.ctx.files.principal('alice'), () => ['users/dana/비밀.md'])
    expect(resolve('users/dana/비밀-틀림.md', '비밀.md')).toBeNull()
    expect(resolve('users/alice/비밀.md', '비밀.md')).toBeNull()
  })
})

describe('in a chat turn', () => {
  test('the answer that reaches the person and the saved message have the right link', async () => {
    put('shared/영업/단가표-2026.xlsx')
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const garbled = '[단가표-2026.xlsx](/files/view?path=shared%2F%EC%98%81%EC%97%85%2F%EB%8B%A8%EA%B8%B0%ED%91%9C-2026.xlsx)'
    const r = await ask(h, socks.alice!, 'alice', c, fake({ say: `모니터 받침대는 ${garbled.slice(0, 40)}` }, { say: `${garbled.slice(40)} 기준 23,000원이에요.` }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toContain(`[단가표-2026.xlsx](${link('shared/영업/단가표-2026.xlsx')}) 기준 23,000원이에요.`)
    expect(r.done.content).not.toContain('%EB%8B%A8%EA%B8%B0')
    const saved = await h.api('alice').call(API.getChat, { params: { id: c } }).catch(() => null)
    if (saved && Array.isArray((saved as { messages?: unknown[] }).messages)) {
      expect(JSON.stringify(saved)).not.toContain('%EB%8B%A8%EA%B8%B0')
    }
  })
})
