// QA TC-4950: the pretty view of a long one-line JSON is worked out once, not for every piece the AI reads; UTF-16 text
// is read as text, and grep says when it could not search a UTF-16 file.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { exactJson, numberedLines, prettyJsonView, ReadViews, READ_TEXT_CHARS, type TextMemo } from '../../server/src/files/read-lines'
import { utf16Kind, utf16Text } from '../../server/src/files/extract'

const env = makeEnv('unit-files-json-tidy-utf16')
const T = env.fx.team
const put = (p: string, s: string | Uint8Array) => { fs.mkdirSync(path.dirname(path.join(T, p)), { recursive: true }); fs.writeFileSync(path.join(T, p), s) }
const le = (s: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])
const be = (s: string) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]) }

/** made-up records, Python-style one line ("a": 1, "b": 2): spaces everywhere, as the slow case was */
function bigJson(chars: number) {
  const kids: unknown[] = []
  for (let i = 0, s = 0; s < chars; i++, s += 100) kids.push({ id: i, a: i % 7, b: [1, 2, 3, i], c: { d: true, e: null, f: 'text ' + i } })
  return JSON.stringify({ id: 1, kids }).replace(/,"/g, ', "').replace(/":/g, '": ')
}

/** counts JSON.parse calls on texts over 1 MB while `f` runs */
async function bigParses(f: () => Promise<unknown>) {
  const orig = JSON.parse
  let n = 0
  JSON.parse = ((t: string, r?: any) => { if (typeof t === 'string' && t.length > 1_000_000) n++; return orig(t, r) }) as typeof JSON.parse
  try { await f() } finally { JSON.parse = orig }
  return n
}

afterEach(() => env.files.readViews.clear())

describe('read: a long JSON file is reformatted once, then read piece by piece', () => {
  test('the next pieces of a 4 MB one-line JSON do not parse it again; the pieces join to the whole view', async () => {
    const json = bigJson(4_000_000)
    put('shared/tidy/big.json', json)
    const c = env.ctx('alice')
    let first: any
    expect(await bigParses(async () => { first = await env.files.call('read', { file_path: 'shared/tidy/big.json' }, c) })).toBe(1)
    expect(first.text).toContain('shown pretty-printed as')
    const lines = JSON.stringify(JSON.parse(json), null, 2).split('\n')
    const got: string[] = []
    let next = 1
    const parses = await bigParses(async () => {
      for (let i = 0; i < 6; i++) {
        const r = await env.files.call('read', { file_path: 'shared/tidy/big.json', pretty: true, offset: next }, c)
        const shown = r.text.split('\n').filter((l) => /^\s*\d+\t/.test(l))
        got.push(...shown.map((l) => l.replace(/^\s*\d+\t/, '')))
        const m = /read again with offset=(\d+) pretty=true/i.exec(r.text)
        next = Number(m![1])
      }
    })
    // before (QA TC-4950) every piece parsed, checked and reformatted the whole file again: 6 parses here
    expect(parses).toBe(0)
    expect(got).toEqual(lines.slice(0, got.length))
    expect(env.files.readViews.size).toBe(1)
  })

  test('a changed file is read fresh; the raw view and a jsonl view come from the same kept text', async () => {
    const c = env.ctx('alice')
    put('shared/tidy/c.json', JSON.stringify({ v: 'OLD-4950', pad: 'x'.repeat(40_000) }))
    expect((await env.files.call('read', { file_path: 'shared/tidy/c.json' }, c)).text).toContain('OLD-4950')
    put('shared/tidy/c.json', JSON.stringify({ v: 'NEW-4950', pad: 'y'.repeat(40_000) }))
    const r = await env.files.call('read', { file_path: 'shared/tidy/c.json' }, c)
    expect(r.text).toContain('NEW-4950')
    expect(r.text).not.toContain('OLD-4950')
    const raw = await env.files.call('read', { file_path: 'shared/tidy/c.json', pretty: false }, c)
    expect(raw.text).toContain('[characters 0–')
    put('shared/tidy/p.jsonl', Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, t: 'record ' + i + ' ' + 'z'.repeat(100) })).join('\n') + '\n')
    const a = await env.files.call('read', { file_path: 'shared/tidy/p.jsonl', pretty: true, limit: 8 }, c)
    const b = await env.files.call('read', { file_path: 'shared/tidy/p.jsonl', pretty: true, limit: 8 }, c)
    expect(a.text).toBe(b.text)
    expect(a.text).toContain('// line 1 of the file')
    const plain = await env.files.call('read', { file_path: 'shared/tidy/p.jsonl', limit: 2 }, c)
    expect(plain.text).toContain('     1\t{"i":0,')
  })

  test('the views are the same as before: exact check, head, raw fallback', () => {
    // exactJson without building a copy: spaces between tokens only, the text in strings exactly
    expect(exactJson('{ "a": [1, 2], "b": "x y" }')).toEqual({ a: [1, 2], b: 'x y' })
    expect(exactJson('{"a":"x\\u0041"}')).toBeUndefined()
    expect(exactJson('{"a":"x\\"y"}')).toEqual({ a: 'x"y' })
    expect(exactJson('{"a":1.0}')).toBeUndefined()
    expect(exactJson('{"a":1}x')).toBeUndefined()
    expect(exactJson('﻿{"a":1}')).toEqual({ a: 1 })
    const long = JSON.stringify({ k: 'v'.repeat(3_000) })
    const memo: TextMemo = {}
    const v = prettyJsonView('a.json', long, {}, memo)!
    expect(v.view.head).toContain('on one line, shown pretty-printed as 3 lines')
    expect(numberedLines('a.json', v.text, {}, v.view).text).toContain('     2\t  "k": "vvv')
    // the kept lines are never changed by a read
    expect(memo.json!.lines.length).toBe(3)
    numberedLines('a.json', memo.json!.lines, { offset: 3 }, v.view)
    expect(memo.json!.lines.length).toBe(3)
    // an offset without pretty: the raw text
    expect(prettyJsonView('a.json', long, { offset: 1 }, memo)).toBeNull()
    const bad = '{"n":12345678901234567890,"p":"' + 'q'.repeat(3_000) + '"}\r\n'
    expect(prettyJsonView('b.json', bad, {})).toBeNull()
    expect(prettyJsonView('b.json', bad, { pretty: true })!.view.head).toContain('is shown as raw text')
  })
})

describe('ReadViews: bounded, by content', () => {
  test('a text is made once per content hash; a small text is not kept', async () => {
    const rv = new ReadViews(1_000_000, 60_000)
    let made = 0
    const big = 'b'.repeat(READ_TEXT_CHARS + 1)
    for (let i = 0; i < 3; i++) { const g = await rv.get('a.txt', 'h1', async () => { made++; return big }); g.done() }
    expect(made).toBe(1)
    await rv.get('a.txt', 'h2', async () => { made++; return big }).then((g) => g.done())
    expect(made).toBe(2)
    // the same bytes under another name are another entry (the text depends on the kind of file)
    await rv.get('a.md', 'h1', async () => { made++; return big }).then((g) => g.done())
    expect(made).toBe(3)
    await rv.get('s.txt', 'h3', async () => 'small').then((g) => g.done())
    expect(rv.size).toBe(3)
  })

  test('over the budget the least recently read goes first; a text alone over it is not kept', async () => {
    const rv = new ReadViews(100_000, 60_000)
    const t = (c: string) => c.repeat(40_000)
    for (const k of ['a', 'b']) await rv.get(k + '.txt', k, async () => t(k)).then((g) => g.done())
    // 'a' is read again, so 'b' is the least recent
    await rv.get('a.txt', 'a', async () => { throw new Error('kept') }).then((g) => g.done())
    await rv.get('c.txt', 'c', async () => t('c')).then((g) => g.done())
    expect(rv.size).toBe(2)
    let made = 0
    await rv.get('b.txt', 'b', async () => { made++; return t('b') }).then((g) => g.done())
    expect(made).toBe(1)
    const huge = new ReadViews(50_000, 60_000)
    await huge.get('h.txt', 'h', async () => 'h'.repeat(60_000)).then((g) => g.done())
    expect(huge.size).toBe(0)
  })

  test('a text not read for the idle time is let go', async () => {
    let now = 0
    const rv = new ReadViews(1_000_000, 1_000, () => now)
    await rv.get('a.txt', 'a', async () => 'a'.repeat(30_000)).then((g) => g.done())
    now = 999
    let made = 0
    await rv.get('a.txt', 'a', async () => { made++; return 'x' }).then((g) => g.done())
    expect(made).toBe(0)
    now = 2_000
    await rv.get('z.txt', 'z', async () => 'z')
    expect(rv.size).toBe(0)
    rv.clear()
  })
})

describe('UTF-16 text: read shows it, grep finds it or says why not', () => {
  test('a UTF-16 file with a byte-order mark: grep\'s long-line read call shows the match (before: "binary file")', async () => {
    const line = '가나다 '.repeat(20_000) + 'WIDE-4950 끝'
    put('shared/u16/notes.txt', le('first line\r\n' + line + '\r\nlast\r\n'))
    const c = env.ctx('alice')
    const g = await env.files.call('grep', { pattern: 'WIDE-4950', path: 'shared/u16', output_mode: 'content' }, c)
    expect(g.isError).toBeFalsy()
    const m = /notes\.txt:2:\[line of [\d,]+ characters; match at character ([\d,]+); read offset=2 char_offset=(\d+)/.exec(g.text)
    expect(m).not.toBeNull()
    expect(Number(m![1]!.replace(/,/g, ''))).toBe(80_000)
    const rd = await env.files.call('read', { file_path: 'shared/u16/notes.txt', offset: 2, char_offset: Number(m![2]) }, c)
    expect(rd.isError).toBeFalsy()
    expect(rd.text.slice(0, 600)).toContain('WIDE-4950 끝')
    const all = await env.files.call('read', { file_path: 'shared/u16/notes.txt', limit: 1 }, c)
    expect(all.text).toContain('     1\tfirst line')
    put('shared/u16/be.txt', be('big endian 한글\n'))
    expect((await env.files.call('read', { file_path: 'shared/u16/be.txt' }, c)).text).toBe('     1\tbig endian 한글')
  })

  test('UTF-16 without a byte-order mark: read shows it, grep on the file says it could not search it', async () => {
    put('shared/u16b/plain.txt', le('Windows export\r\nname,amount\r\nNOBOM-4950,12\r\n', false))
    const c = env.ctx('alice')
    const g = await env.files.call('grep', { pattern: 'NOBOM-4950', path: 'shared/u16b/plain.txt', output_mode: 'content' }, c)
    expect(g.text).toContain("'shared/u16b/plain.txt' is UTF-16 text without a byte-order mark, which grep cannot search. Read it with read")
    const rd = await env.files.call('read', { file_path: 'shared/u16b/plain.txt' }, c)
    expect(rd.text).toContain('     3\tNOBOM-4950,12')
    // a plain UTF-8 file with no match stays "No matches"
    put('shared/u16b/u8.txt', 'nothing here\n')
    expect((await env.files.call('grep', { pattern: 'NOBOM-4950', path: 'shared/u16b/u8.txt', output_mode: 'content' }, c)).text).toBe('No matches')
  })

  test('binary files stay binary; edit and write refuse UTF-16 instead of saving it as UTF-8', async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(utf16Kind(bin)).toBeNull()
    expect(utf16Kind(Buffer.from('plain text'))).toBeNull()
    expect(utf16Kind(le('abc', false))).toBe('le')
    expect(utf16Kind(le('a\u0001bc', false))).toBeNull()
    expect(utf16Text(le('abc'))).toBe('abc')
    // an odd byte count is not valid UTF-16
    expect(utf16Text(Buffer.concat([le('abc'), Buffer.from([0x41])]))).toBeNull()
    put('shared/u16c/x.bin.txt', bin)
    const c = env.ctx('alice')
    expect((await env.files.call('read', { file_path: 'shared/u16c/x.bin.txt' }, c)).text).toContain('binary file')
    put('shared/u16c/w.txt', le('hello wide\n'))
    expect((await env.files.call('read', { file_path: 'shared/u16c/w.txt' }, c)).text).toContain('hello wide')
    const e = await env.files.call('edit', { file_path: 'shared/u16c/w.txt', old_string: 'hello', new_string: 'bye' }, c)
    expect(e.isError).toBe(true)
    expect(e.text).toContain('is UTF-16 text')
    const w = await env.files.call('write', { file_path: 'shared/u16c/w.txt', content: 'bye' }, c)
    expect(w.isError).toBe(true)
    expect(w.text).toContain('is UTF-16 text')
    expect(fs.readFileSync(path.join(T, 'shared/u16c/w.txt')).equals(le('hello wide\n'))).toBe(true)
  })
})
