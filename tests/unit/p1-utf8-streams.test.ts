// Byte streams that arrive in arbitrary pieces must be decoded as one stream: engine stdout through the launcher
// (64 KB pipe reads) and tool calls through the gate (socket reads). A piece that ends inside a multi-byte UTF-8
// character (every Hangul syllable is three bytes) used to be decoded on its own and turned into U+FFFD.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { Utf8Lines, Utf8Text } from '../../server/src/engine/lines'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('Utf8Lines', () => {
  test('a character split between pieces stays whole; lines come out complete', () => {
    const bytes = Buffer.from('안녕하세요\n두 번째 줄\n끝')
    for (let cut = 1; cut < bytes.length; cut++) {
      const l = new Utf8Lines()
      const got = [...l.push(bytes.subarray(0, cut)), ...l.push(bytes.subarray(cut)), ...l.end()]
      expect(got).toEqual(['안녕하세요', '두 번째 줄', '끝'])
    }
  })

  test('one byte at a time', () => {
    const bytes = Buffer.from('{"t":"가나다"}\n{"t":"😀"}\n')
    const l = new Utf8Lines()
    const got: string[] = []
    for (const b of bytes) got.push(...l.push(Uint8Array.of(b)))
    got.push(...l.end())
    expect(got).toEqual(['{"t":"가나다"}', '{"t":"😀"}'])
  })

  test('Utf8Text keeps split characters and stops growing past its limit', () => {
    const t = new Utf8Text(10)
    const b = Buffer.from('가나다라마바사아자차카타파하')
    t.push(b.subarray(0, 4)); t.push(b.subarray(4, 20)); t.push(b.subarray(20))
    expect(t.text.startsWith('가나다라마바')).toBe(true)
    expect(t.text).not.toContain('�')
  })
})

describe('through the launcher and the gate', () => {
  let h: Harness
  let alice: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'p1-utf8', turnTimeoutMs: 60_000 })
    alice = await h.ws('alice', { windowId: 'win-p1-utf8' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h.close() })

  test('engine output cut inside a Hangul syllable reaches the answer intact', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ saySplit: '한국어 답변입니다.' }, { say: ' 끝.' }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('한국어 답변입니다. 끝.')
    expect(r.done.content).not.toContain('�')
  })

  test('a large Korean file written by a tool arrives byte for byte', async () => {
    // ~400 KB of three-byte characters: the gate hands it over in many socket reads, most of them ending mid-character
    const content = ('가나다라마바사아자차카타파하 ' + '한글 문서의 한 줄입니다.\n').repeat(5_000)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'write', args: { file_path: 'users/alice/한글.md', content } }, { say: 'ok' }))
    expect(r.done.steps.map((s) => [s.tool, s.status])).toEqual([['write', 'ok']])
    const saved = fs.readFileSync(path.join(h.team, 'users/alice/한글.md'), 'utf8')
    expect(saved.length).toBe(content.length)
    expect(saved).toBe(content)
  })
})
