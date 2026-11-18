// QA TC-4901: the AI reads and searches very long lines to the end (a one-line JSON thread export, JSONL posts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { numberedLines, READ_TEXT_CHARS, READ_TEXT_TOKENS } from '../../server/src/files/read-lines'
import { longRecordOf } from '../../server/src/files/search'

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
