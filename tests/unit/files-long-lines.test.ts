// QA TC-4901: the AI reads and searches very long lines to the end (a one-line JSON thread export, JSONL posts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { exactJson, numberedLines, READ_TEXT_CHARS, READ_TEXT_TOKENS } from '../../server/src/files/read-lines'
import { bufferSource, longLineText, longRecordOf, type LongSource } from '../../server/src/files/search'
import { toolContent } from '../../server/src/engine/api-agent'

const env = makeEnv('unit-files-long-lines')
const T = env.fx.team
const put = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(T, p)), { recursive: true }); fs.writeFileSync(path.join(T, p), s) }

/** an HN-shaped thread: one story with many comments, all on one line (made-up text) */
function thread(id: number, comments: number, lastText: string) {
  const kids = Array.from({ length: comments }, (_, i) => ({ id: id * 1000 + i, by: `user${i}`, type: 'comment', time: 1763000000 + i,
    text: i === comments - 1 ? lastText : `Comment ${i}: ` + 'lorem ipsum dolor sit amet, '.repeat(8) + `end of comment ${i}.` }))
  return JSON.stringify({ id, type: 'story', by: 'poster', title: 'A made-up thread', kids })
}

/** the read calls an AI would make: follow every "read again with offset=… char_offset=…" until none is left */
async function readAll(file: string, first: Record<string, unknown> = {}) {
  const c = env.ctx('alice')
  const outs: string[] = []
  let args: Record<string, unknown> = { file_path: file, ...first }
  for (let i = 0; i < 100; i++) {
    const r = await env.files.call('read', args, c)
    expect(r.isError).toBeFalsy()
    outs.push(r.text)
    const m = /read again with offset=(\d+)(?: char_offset=(\d+))?( pretty=true)?/i.exec(r.text)
    if (!m) return outs
    args = { file_path: file, offset: Number(m[1]), ...(m[2] ? { char_offset: Number(m[2]) } : {}), ...(m[3] ? { pretty: true } : {}) }
  }
  throw new Error('read did not end')
}

/** the line text of a read result, the pieces of one line joined (line numbers and piece labels taken out) */
const textOf = (outs: string[]) => outs.map((o) => o.split('\n').filter((l) => /^\s*\d+\t/.test(l))
  .map((l) => l.replace(/^\s*\d+\t(\[characters [\d,]+–[\d,]+ of [\d,]+\] )?/, '')).join('\n')).join('')

describe('read: long lines come back in pieces, never cut', () => {
  test('a 133 KB one-line JSON, raw, is read to the end through char_offset', async () => {
    const json = thread(46045987, 420, 'THE LAST COMMENT: the zebra crossing was painted blue.')
    while (json.length < 133_000) throw new Error('fixture too small: ' + json.length)
    put('shared/hn/item-46045987.json', json)
    const outs = await readAll('shared/hn/item-46045987.json', { pretty: false })
    expect(outs.length).toBeGreaterThan(4)
    expect(textOf(outs)).toBe(json)
    expect(outs[0]).toContain(`[characters 0–${(READ_TEXT_CHARS - 8).toLocaleString('en-US')} of ${json.length.toLocaleString('en-US')}]`)
    expect(outs[0]).toContain('Nothing is cut')
    expect(outs.at(-1)).toContain('the zebra crossing was painted blue')
    for (const o of outs) expect(o.length).toBeLessThan(READ_TEXT_CHARS + 1_000)
  })

  test('the same file read plainly is pretty-printed, and the last comment is reached', async () => {
    const outs = await readAll('shared/hn/item-46045987.json')
    expect(outs[0]).toContain('shown pretty-printed')
    expect(outs[0]).toMatch(/\n\s+1\t\{/)
    expect(outs.at(-1)).toContain('THE LAST COMMENT: the zebra crossing was painted blue.')
    for (const o of outs) expect(o.length).toBeLessThan(READ_TEXT_CHARS + 1_000)
  })

  test('a JSONL line of 50 KB is read whole, in pieces, then the next line', async () => {
    const big = JSON.stringify({ id: 2, type: 'story', text: 'word '.repeat(10_000) + 'TAIL-OF-LINE-2' })
    expect(big.length).toBeGreaterThan(50_000)
    const body = [JSON.stringify({ id: 1, text: 'short one' }), big, JSON.stringify({ id: 3, text: 'LINE-3-HERE' })].join('\n') + '\n'
    put('shared/hn/posts.jsonl', body)
    const outs = await readAll('shared/hn/posts.jsonl')
    expect(textOf(outs).replace(/\n/g, '')).toBe(body.replace(/\n/g, ''))
    expect(outs.join('\n')).toContain('TAIL-OF-LINE-2')
    expect(outs.at(-1)).toContain('LINE-3-HERE')
    // pretty=true shows each record pretty-printed under its line number
    const p = await env.files.call('read', { file_path: 'shared/hn/posts.jsonl', pretty: true, limit: 5 }, env.ctx('alice'))
    expect(p.text).toContain('// line 1 of the file')
    expect(p.text).toContain('"text": "short one"')
  })

  test('the output budget holds for many normal lines and for wide characters; char_offset past the line is refused', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `row ${i} ` + 'x'.repeat(70)).join('\n')
    const r = numberedLines('a.md', lines, {})
    expect(r.text.length).toBeLessThan(READ_TEXT_CHARS + 2_000)
    expect(r.text).toMatch(/Read again with offset=\d+ for the rest/)
    const ko = numberedLines('k.md', '가'.repeat(50_000), {})
    expect(ko.text).toContain(`[characters 0–${(READ_TEXT_TOKENS - 3).toLocaleString('en-US')} of 50,000]`)
    expect(ko.text).toContain(`char_offset=${READ_TEXT_TOKENS - 3}`)
    // a surrogate pair is never split between two pieces
    const emoji = numberedLines('e.md', '😀'.repeat(20_000), {})
    const at = Number(/char_offset=(\d+)/.exec(emoji.text)![1])
    expect(at % 2).toBe(0)
    expect(() => numberedLines('a.md', 'abc', { offset: 1, char_offset: 3 })).toThrow(/past the end of line 1/)
    // a short file reads as before
    expect(numberedLines('s.md', 'one\ntwo\n', {}).text).toBe('     1\tone\n     2\ttwo')
  })
})

describe('grep: a match deep inside a very long line is found', () => {
  test('a word at character 120,000 of one line: window, character position and the read call', async () => {
    const line = 'a'.repeat(120_000) + ' NEEDLE-4901 ' + 'b'.repeat(80_000)
    put('shared/hn-grep/one-line.json', line)
    put('shared/hn-grep/small.md', 'small NEEDLE-4901\n')
    const c = env.ctx('alice')
    const r = await env.files.call('grep', { pattern: 'NEEDLE-4901', path: 'shared/hn-grep', output_mode: 'content' }, c)
    expect(r.isError).toBeFalsy()
    const hit = r.text.split('\n').find((l) => l.startsWith('shared/hn-grep/one-line.json:1:'))!
    expect(hit).toBeDefined()
    expect(hit).toContain('match at character 120,001')
    expect(hit).toContain('read offset=1 char_offset=119801')
    expect(hit).toContain('NEEDLE-4901')
    expect(hit.length).toBeLessThan(1_000)
    expect(r.text).toContain('shared/hn-grep/small.md:1:small NEEDLE-4901')
    expect(r.text).not.toContain('could not be shown')
    // the read call it names shows the match
    const rd = await env.files.call('read', { file_path: 'shared/hn-grep/one-line.json', offset: 1, char_offset: 119801, pretty: false }, c)
    expect(rd.text).toContain('[characters 119,801–')
    expect(rd.text.slice(0, 400)).toContain('NEEDLE-4901')
  })

  test('a 3 MB line: the result stays small, Korean before the match counts in characters', async () => {
    const line = '가'.repeat(1000) + 'x'.repeat(3 * 1024 * 1024) + ' 바늘-4901 끝'
    put('shared/hn-grep2/big.txt', line)
    const r = await env.files.call('grep', { pattern: '바늘-4901', path: 'shared/hn-grep2', output_mode: 'content' }, env.ctx('alice'))
    expect(r.text.length).toBeLessThan(2_000)
    expect(r.text).toContain(`match at character ${(1000 + 3 * 1024 * 1024 + 1).toLocaleString('en-US')}`)
    expect(r.text).toContain('바늘-4901 끝')
  })

  test('context lines over the cap show their start; a record without its parts is skipped', async () => {
    put('shared/hn-grep3/ctx.txt', 'z'.repeat(100_000) + '\nmatch-ctx-4901 here\n')
    const r = await env.files.call('grep', { pattern: 'match-ctx-4901', path: 'shared/hn-grep3', output_mode: 'content', '-B': 1 }, env.ctx('alice'))
    expect(r.text).toContain('shared/hn-grep3/ctx.txt-1-[line of 100,000 characters, its start shown; read offset=1 char_offset=300 for the rest] zzz')
    expect(r.text).toContain('shared/hn-grep3/ctx.txt:2:match-ctx-4901 here')
    expect(longRecordOf('{"type":"match","data":{"path":{"text":"a"},"lines":{"text":"', null)).toBeNull()
    expect(longRecordOf('{"type":"match","data":{"path":{"text":"a\\"b"},"lines":{"text":"', '},"line_number":7,"absolute_offset":12,"submatches":[{"match":{"text":"x"},"start":3,"end":4}]}}'))
      .toEqual({ type: 'match', path: { text: 'a"b' }, line: 7, offset: 12, subs: [{ start: 3, end: 4 }] })
  })
})

describe('review fixes: exact views, pairs, budget, BOM, CRLF', () => {
  test('pretty view only when the JSON re-serialises exactly as written; the head says it is reformatted', async () => {
    const pad = 'p'.repeat(3000)
    const cases = [`{"id":12345678901234567890,"t":"${pad}"}`, `{"v":1.0,"t":"${pad}"}`, `{"t":"caf\\u00e9 ${pad}"}`, `{"a":1,"a":2,"t":"${pad}"}`, `{"v":1e3,"t":"${pad}"}`, `{"u":"a\\/b","t":"${pad}"}`]
    for (const [i, c] of cases.entries()) {
      expect(exactJson(c)).toBeUndefined()
      put(`shared/hn-exact/n${i}.json`, c)
      const r = await env.files.call('read', { file_path: `shared/hn-exact/n${i}.json` }, env.ctx('alice'))
      expect(r.text).not.toContain('pretty-printed')
      expect(textOf([r.text])).toBe(c)
    }
    // the raw form is kept exactly when pretty=true is asked for and cannot be honoured
    const asked = await env.files.call('read', { file_path: 'shared/hn-exact/n0.json', pretty: true }, env.ctx('alice'))
    expect(asked.text).toContain('shown as raw text')
    expect(asked.text).toContain('12345678901234567890')
    expect(exactJson('{ "a" : [1, 2.5, "x y"],\n "b": null }')).toEqual({ a: [1, 2.5, 'x y'], b: null })
    put('shared/hn-exact/ok.json', `{"id":46045987,"t":"${pad}"}`)
    const ok = await env.files.call('read', { file_path: 'shared/hn-exact/ok.json' }, env.ctx('alice'))
    expect(ok.text).toContain('This is a reformatted view')
    expect(ok.text).toContain('read it with pretty=false and copy old_string from the raw text')
  })

  test('an edit copied from the pretty view says to copy from the raw text', async () => {
    const c = env.ctx('alice', 'pretty-edit')
    put('shared/hn-exact/edit.json', `{"title":"old title","t":"${'q'.repeat(3000)}"}`)
    const r = await env.files.call('read', { file_path: 'shared/hn-exact/edit.json' }, c)
    expect(r.text).toContain('"title": "old title"')
    const e = await env.files.call('edit', { file_path: 'shared/hn-exact/edit.json', old_string: '"title": "old title"', new_string: '"title": "new title"' }, c)
    expect(e.isError).toBe(true)
    expect(e.text).toContain('read it again with pretty=false and copy old_string from the raw text')
    await env.files.call('read', { file_path: 'shared/hn-exact/edit.json', pretty: false }, c)
    const e2 = await env.files.call('edit', { file_path: 'shared/hn-exact/edit.json', old_string: '"title":"old title"', new_string: '"title":"new title"' }, c)
    expect(e2.isError).toBeFalsy()
    // a raw read since: a miss is a plain miss
    const e3 = await env.files.call('edit', { file_path: 'shared/hn-exact/edit.json', old_string: 'nothing like this', new_string: 'x' }, c)
    expect(e3.text).not.toContain('pretty=false')
  })

  test('a char_offset inside a surrogate pair starts at the pair; pieces never split one', () => {
    const line = 'a' + '😀'.repeat(10)
    const r = numberedLines('e.md', line, { offset: 1, char_offset: 2 })
    expect(r.text).toContain('[characters 1–21 of 21] ' + '😀'.repeat(10))
  })

  test('empty lines count against the budget', () => {
    const r = numberedLines('blank.md', '\n'.repeat(20_000) + 'end\n', { limit: 20_000 })
    expect(r.text.length).toBeLessThan(READ_TEXT_CHARS + 1_000)
    expect(r.text).toMatch(/Read again with offset=\d+ for the rest/)
  })

  test('CRLF lines: read and grep agree on line numbers and positions', async () => {
    const line2 = 'c'.repeat(90_000) + ' CRLF-4901 ' + 'd'.repeat(10)
    put('shared/hn-crlf/a.txt', 'first\r\n' + line2 + '\r\nthird\r\n')
    const c = env.ctx('alice')
    const g = await env.files.call('grep', { pattern: 'CRLF-4901', path: 'shared/hn-crlf', output_mode: 'content' }, c)
    expect(g.text).toContain('a.txt:2:[line of 90,021 characters; match at character 90,001; read offset=2 char_offset=89801')
    expect(g.text).not.toMatch(/\r/)
    const rd = await env.files.call('read', { file_path: 'shared/hn-crlf/a.txt', offset: 2, char_offset: 90_001, limit: 1 }, c)
    expect(rd.text).toContain('[characters 90,001–90,021 of 90,021] CRLF-4901 dddddddddd')
  })

  test('a UTF-8 BOM does not shift grep positions (read drops it too)', async () => {
    const line = 'b'.repeat(80_000) + ' BOM-4901 tail'
    put('shared/hn-bom/a.txt', '\uFEFF' + line + '\n')
    const c = env.ctx('alice')
    const g = await env.files.call('grep', { pattern: 'BOM-4901', path: 'shared/hn-bom', output_mode: 'content' }, c)
    expect(g.text).toContain('match at character 80,001;')
    const rd = await env.files.call('read', { file_path: 'shared/hn-bom/a.txt', offset: 1, char_offset: 80_001 }, c)
    expect(rd.text).toContain('] BOM-4901 tail')
  })

  test('grep windows and positions never split an emoji; the line is read in pieces, never whole', () => {
    const line = '😀'.repeat(40_000) + 'X-4901' + '😀'.repeat(300)
    const bytes = Buffer.from(line + '\n', 'utf8')
    let biggest = 0
    const inner = bufferSource(bytes)
    const src: LongSource = { size: inner.size, read: (p, n) => { biggest = Math.max(biggest, n); return inner.read(p, n) } }
    const start = Buffer.byteLength('😀'.repeat(40_000))
    const w = longLineText(src, { type: 'match', path: { text: 'x' }, line: 1, offset: 0, subs: [{ start, end: start + 6 }] })!
    expect(w.note).toContain('match at character 80,000;')
    const from = Number(/char_offset=(\d+)/.exec(w.note)![1])
    expect(from % 2).toBe(0)
    expect(w.text).not.toMatch(/^…?[\uDC00-\uDFFF]/)
    expect(w.text).not.toMatch(/[\uD800-\uDBFF]…?$/)
    expect(w.text).toContain('X-4901')
    expect(biggest).toBeLessThanOrEqual(1024 * 1024)
  })

  test('the API engine\'s cut says so and never splits an emoji', () => {
    const out = '😀'.repeat(20_000) + 'END'
    const t = toolContent(out, [])
    expect(t).toContain('characters of this result were left out')
    expect(t.endsWith('END')).toBe(true)
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(t).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})
