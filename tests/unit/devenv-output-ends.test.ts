// box_shell output (limits audit 1 #21): a long stdout or stderr keeps its end, where a build prints its error. Before,
// the runner read only the first 64 KiB of each and the tool showed the first 32 KiB, so the end was lost.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readEnds } from '../../server/src/devenv/srt/runner'
import { clip } from '../../server/src/devenv/tool'
import { WORK } from '../lib/env'

const dir = path.join(WORK, 'devenv-output-ends')
fs.mkdirSync(dir, { recursive: true })
const file = (name: string, body: string | Buffer) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p }

describe('readEnds: the runner keeps the first and the last part of a long output', () => {
  test('short output: all of it, not cut', () => {
    expect(readEnds(file('short.txt', 'line 1\nline 2\n'), 32, 32)).toEqual({ text: 'line 1\nline 2\n', cut: false })
    expect(readEnds(path.join(dir, 'missing.txt'), 32, 32)).toEqual({ text: '', cut: false })
  })

  test('a long build log: the start, a line that says how much was left out, and the error at its end', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `compiling module ${i}`)
    const body = lines.join('\n') + '\nERROR: build failed at the very end\n'
    const r = readEnds(file('build.log', body), 1024, 1024)
    expect(r.cut).toBe(true)
    expect(r.text.startsWith('compiling module 0\n')).toBe(true)
    expect(r.text.endsWith('ERROR: build failed at the very end\n')).toBe(true)
    const m = r.text.match(/\n… \(about (\d+) bytes in the middle of this output were left out; the end follows\) …\n/)
    expect(m).not.toBeNull()
    // the tail starts at a whole line, and the bytes said left out are exactly the ones not shown
    const [head, tail] = r.text.split(m![0]) as [string, string]
    expect(tail.startsWith('compiling module ')).toBe(true)
    expect(Number(m![1])).toBe(Buffer.byteLength(body) - Buffer.byteLength(head) - Buffer.byteLength(tail))
    // the old reader's 64 KiB start alone would not have had it
    expect(body.slice(0, 2048)).not.toContain('ERROR')
  })

  test('UTF-8 characters at both cuts are never broken (no replacement character)', () => {
    const body = '가'.repeat(2000) + '\n' + '나'.repeat(2000)
    const r = readEnds(file('korean.txt', body), 1001, 1001)
    expect(r.cut).toBe(true)
    expect(r.text).not.toContain('�')
    // a cut right after a whole character keeps it
    const exact = readEnds(file('korean-exact.txt', '가'.repeat(3000)), 999, 999)
    expect(exact.text.split('\n')[0]).toBe('가'.repeat(999))
  })
})

describe('the runner cuts once, clip keeps its line (review of #1321)', () => {
  test('10 MB of output: the count left out is the real one, not clip\'s second cut', () => {
    const line = 'x'.repeat(99) + '\n'
    const body = line.repeat(100_000) + 'FATAL: the end\n'
    const r = readEnds(file('ten-mb.log', body), 16 << 10, 16 << 10)
    const shown = clip(r.text)
    expect(shown).toBe(r.text)
    const left = Number(shown.match(/\(about (\d+) bytes in the middle of this output were left out/)![1])
    expect(left).toBeGreaterThan(9_900_000)
    expect(shown.endsWith('FATAL: the end\n')).toBe(true)
    expect(shown).not.toContain('characters in the middle left out')
  })

  test('both cuts land on line breaks: a token on one line is never split (so redaction still finds it whole)', () => {
    const token = 'sk-' + 'Q'.repeat(60)
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) lines.push(`step ${i} key=${token}`)
    const body = lines.join('\n') + '\n'
    for (const [h, t] of [[1000, 1000], [1033, 997], [4000, 3001]] as const) {
      const r = readEnds(file(`tokens-${h}.log`, body), h, t)
      const [head, tail] = r.text.split(/\n… \(about \d+ bytes[^\n]*\n/) as [string, string]
      for (const part of [head, tail]) for (const l of part.split('\n').filter(Boolean)) expect(l).toMatch(new RegExp(`^step \\d+ key=${token}$`))
    }
    const long = lines.join('\n').repeat(3)
    const c = clip(long)
    const [ch, ct] = c.split(/\n… \(\d+ characters[^\n]*\n/) as [string, string]
    for (const part of [ch, ct]) for (const l of part.split('\n').filter(Boolean)) expect(l.endsWith(token) || l.startsWith('step')).toBe(true)
    expect(ch.endsWith('\n')).toBe(true)
  })
})

describe('a stored secret across a cut (review of #1321)', () => {
  const key = 'sk_live_' + 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6'
  const redact = (s: string) => s.split(key).join('[hidden key]')
  test('on one long line across the head cut and across the tail cut: hidden whole, no part of it shown', () => {
    const head = 16 << 10
    for (const at of [head - 10, head - 1, head - key.length + 1]) {
      const body = 'a'.repeat(at) + key + 'b'.repeat(60_000) + key.slice(0, 0) + 'c'.repeat(10) + key + 'd'.repeat(20)
      const r = readEnds(file(`secret-${at}.log`, body), head, head, redact)
      expect(r.cut).toBe(true)
      for (let n = 6; n <= key.length; n++) {
        expect(r.text).not.toContain(key.slice(0, n))
        expect(r.text).not.toContain(key.slice(-n))
      }
    }
    // the tail cut inside the second key
    const body2 = 'a'.repeat(70_000) + key + 'e'.repeat((16 << 10) - 12)
    const r2 = readEnds(file('secret-tail.log', body2), head, head, redact)
    for (let n = 6; n <= key.length; n++) { expect(r2.text).not.toContain(key.slice(0, n)); expect(r2.text).not.toContain(key.slice(-n)) }
  })
})

describe('clip: what the AI gets of one stream', () => {
  test('up to 32 KiB unchanged; longer: the first and the last 16 KiB with a line between', () => {
    expect(clip('x'.repeat(32 << 10))).toBe('x'.repeat(32 << 10))
    const s = 'a'.repeat(20 << 10) + 'MIDDLE' + 'b'.repeat(20 << 10) + 'the error'
    const c = clip(s)
    expect(c.startsWith('a'.repeat(16 << 10) + '\n… (')).toBe(true)
    expect(c.endsWith('the error')).toBe(true)
    expect(c).not.toContain('MIDDLE')
    expect(c).toContain(`(${s.length - (32 << 10)} characters in the middle left out; the end follows)`)
  })

  test('an emoji at a cut is dropped whole, never half', () => {
    const s = 'a'.repeat((16 << 10) - 1) + '😀' + 'b'.repeat(40 << 10)
    expect(clip(s)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
