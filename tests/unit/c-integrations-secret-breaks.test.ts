// QA TC-3096: a stored key the AI wrote in base64 was not hidden when a tool call fell inside it. Both engines put a
// blank line around a tool call (engine/claude-parse.ts, engine/codex-parse.ts), so the answer held the base64 in two
// parts with "\n\n" between them, and hide.ts's patterns needed its characters side by side. Encoded forms (base64,
// and the value with every character %-, JSON- or HTML-escaped) now match across white space and JSON-escaped breaks;
// the value as written and ordinary text do not.
import { describe, expect, test } from 'bun:test'
import { HIDDEN, secretHider } from '../../server/src/integrations/connections/hide'
import { formCarryLength, RedactingText, redactorOf } from '../../server/src/integrations/connections/redact'

const KEY = 'sk-RK3096-FAKE-0b1e'
const OTHER = 'pk-ZZ9999-FAKE-77aa'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const b64url = (s: string) => Buffer.from(s).toString('base64url')
const hide = secretHider([KEY])
/** `text` cut at `at` with `sep` between the parts */
const split = (text: string, at: number, sep: string) => text.slice(0, at) + sep + text.slice(at)

describe('an encoded key split by line breaks or white space is hidden (hide.ts)', () => {
  test('base64 (standard, URL-safe, Basic user:key) split by a tool call\'s blank line, at every place', () => {
    for (const form of [b64(KEY), b64url(KEY), b64(KEY).replace(/=+$/, '')]) {
      for (let at = 1; at < form.length; at++) {
        const text = `Here it is: ${split(form, at, '\n\n')} — done.`
        const out = hide(text)
        expect(out, `${form} cut at ${at}`).toBe(`Here it is: ${HIDDEN} — done.`)
      }
    }
    // Basic auth's "alice:<key>": the part made of the key's bytes goes, wherever the cut is in it
    const basic = b64(`alice:${KEY}`)
    for (let at = 8; at < basic.length; at++) {
      const out = hide(`Authorization: Basic ${split(basic, at, '\n\n')}`)
      expect(out, `cut at ${at}`).toContain(HIDDEN)
      expect(out.replace(/\s/g, ''), `cut at ${at}`).not.toContain(basic.slice(-12))
      expect(out.replace(/\s/g, ''), `cut at ${at}`).not.toContain(basic.slice(8, 20))
    }
  })

  test('wrapped base64 (every 4 or 76 characters, \\r\\n), spaces, tabs and JSON-escaped breaks', () => {
    const long = `${KEY}${KEY}${KEY}${KEY}${KEY}`
    const hideLong = secretHider([long])
    const wrap = (s: string, n: number, sep: string) => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join(sep)
    expect(hide(`x ${wrap(b64(KEY), 4, '\n')} y`)).toBe(`x ${HIDDEN} y`)
    expect(hideLong(`x\n${wrap(b64(long), 76, '\r\n')}\ny`)).toBe(`x\n${HIDDEN}\ny`)
    expect(hide(`x ${wrap(b64(KEY), 8, ' ')} y`)).toBe(`x ${HIDDEN} y`)
    expect(hide(`x ${split(b64(KEY), 9, '\t \n  ')} y`)).toBe(`x ${HIDDEN} y`)
    // the answer as JSON (a saved step, a message API body): the blank line is "\n\n" as written
    expect(hide(JSON.stringify({ text: `k ${split(b64(KEY), 7, '\n\n')} k` }))).toBe(JSON.stringify({ text: `k ${HIDDEN} k` }))
  })

  test('the key with every character %-escaped, JSON \\u-escaped or as an HTML entity, split by line breaks', () => {
    // each form as its escapes, cut between two of them at every place
    const pct = [...Buffer.from(KEY)].map((b) => '%' + b.toString(16).padStart(2, '0').toUpperCase())
    const uni = [...KEY].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    const dec = [...KEY].map((c) => `&#${c.charCodeAt(0)};`)
    const hx = [...KEY].map((c) => `&#x${c.charCodeAt(0).toString(16)};`)
    for (const parts of [pct, pct.map((p) => p.toLowerCase()), uni, dec, hx]) {
      expect(hide(`a ${parts.join('')} b`)).toBe(`a ${HIDDEN} b`)
      for (let at = 1; at < parts.length; at++) {
        const text = `a ${parts.slice(0, at).join('')}\n\n${parts.slice(at).join('')} b`
        expect(hide(text), text).toBe(`a ${HIDDEN} b`)
      }
    }
  })

  test('the saved answer of a turn whose tool call fell inside the base64 has it hidden', () => {
    const r = redactorOf([KEY])
    const form = b64(KEY)
    // what the engine's text pieces are around a tool call: the first part, the blank line, the rest
    const pieces = [`The key in base64: ${form.slice(0, 11)}`, '\n\n', `${form.slice(11)}. Saved.`]
    expect(r.hide(pieces.join(''))).toBe(`The key in base64: ${HIDDEN}. Saved.`)
    // pieces with a line break inside one text (no tool call): no piece lets out a part that the next completes
    const s = new RedactingText(() => r)
    const out = [s.push('Wrapped:\n'), s.push(form.slice(0, 12)), s.push('\n'), s.push(form.slice(12)), s.push('\nEnd of it'), s.flush()]
    expect(out.join('')).toBe(`Wrapped:\n${HIDDEN}\nEnd of it`)
    for (const p of out) expect(p.includes(form.slice(0, 10)) || p.includes(form.slice(-10)), JSON.stringify(p)).toBe(false)
  })
})

describe('no false positives on ordinary text', () => {
  test('prose, code, Korean and Japanese, base64 of other values, the parts of the key\'s base64 apart', () => {
    const form = b64(KEY)
    const texts = [
      'The quarterly report is ready.\n\nI saved it in your folder.\n\nAnything else?',
      'sk RK3096 FAKE 0b1e is not the key; sk-RK3096 FAKE-0b1e neither.',
      's k - R K 3 0 9 6 - F A K E - 0 b 1 e',
      '```js\nconst a = "c2st" + "\\n" + "UksN"\n```',
      '보고서를 저장했어요.\n\n다음 단계는 무엇인가요?', '保存しました。\n\n次は何をしますか？',
      `Another key: ${b64(OTHER)}\n\n${split(b64(OTHER), 6, '\n\n')}`,
      // the key's base64 cut in two with words between, or the parts the other way round
      `${form.slice(0, 10)} and then some words ${form.slice(10)}`, `${form.slice(10)}\n\n${form.slice(0, 10)}`,
      'aGVsbG8gd29ybGQ=\nZm9vYmFy\nYmF6', '%E3%81%82 %E3%81%84\n%41%42',
      `${KEY.slice(0, 9)}\n\n${KEY.slice(9)}`, // the value as written, split: ordinary text by this rule
    ]
    for (const t of texts) expect(hide(t), t).toBe(t)
  })

  test('the live answer: a base64 key split by a space does not let its first part out while it streams', () => {
    const r = redactorOf([KEY])
    const form = b64(KEY)
    for (const at of [8, 11, 16]) {
      const s = new RedactingText(() => r)
      const out = [s.push('Here: '), s.push(form.slice(0, at)), s.push(' '), s.push(form.slice(at)), s.push(' — done'), s.flush()]
      expect(out.join(''), `cut at ${at}`).toBe(`Here: ${HIDDEN} — done`)
      for (const p of out) expect(p.includes(form.slice(0, 8)), `cut at ${at}: ${JSON.stringify(p)}`).toBe(false)
    }
    // prose with long words still flows: only the last word waits
    expect(formCarryLength('Everything is something wonderful', [KEY])).toBe('wonderful'.length)
    expect(formCarryLength('Saved c2stUksxMTE1 ', [KEY])).toBe('c2stUksxMTE1 '.length)
  })

  test('the live answer: a line break in prose waits for at most the word after it; Korean text flows', () => {
    expect(formCarryLength('Done.\n', [KEY])).toBe(1)
    expect(formCarryLength('Saved it.\n\nNext', [KEY])).toBe(6)
    expect(formCarryLength('저장했어요.\n\n', [KEY])).toBe(2)
    expect(formCarryLength('hello wor', [KEY])).toBe(3)
  })

  // CI runs Bun 1.3.12, where a hider with white space inside its one big pattern took 8 s here (QA TC-3096 review):
  // the split forms are found on a copy of the stretches that need it, never by a larger pattern
  test('quick with a long token (the CI check): 1 MB of text with + / = & and digits, wrapped base64, prose', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'.repeat(30) + '.c2lnbmF0dXJl_-x'
    const hideLong = secretHider([jwt, 'CANARY/echo+key=7731&x', 'CANARY-client-secret-8086', KEY])
    const lines = (b64('lorem ipsum dolor sit amet, consectetur ').repeat(4) + '\n\n').repeat(4_000)
    for (const [what, big] of [
      ['the CI text', 'lorem ipsum, dolor/sit+amet=1&b; '.repeat(32_000) + jwt],
      ['base64-like lines', lines + split(b64(KEY), 10, '\n\n')],
      ['prose', 'The Q3 report is ready: revenue +12% on 2026 plans.\n\n'.repeat(20_000) + split(b64(KEY), 10, '\n\n')],
    ] as const) {
      expect(big.length, what).toBeGreaterThan(900_000)
      const t0 = performance.now()
      expect(hideLong(big).endsWith(HIDDEN), what).toBe(true)
      expect(performance.now() - t0, what).toBeLessThan(1000)
    }
  })
})
