// What a connected service's card shows (integrations/connections/card-lines.ts, docs/DECISIONS.md "Plain words in
// errors, cards and steps"): the tool by its title on one line (else its id in words), and every value of the call as a
// labelled line with the recipients first, in full; when lines could not show all of it (too many, too deep, too long,
// an invisible or direction-changing character) there are none, and the card keeps the JSON open as before.
import { describe, expect, test } from 'bun:test'
import { CARD_LINES_CHARS, CARD_LINES_DEPTH, CARD_LINES_MAX, cardLines, fieldWord, methodWord, toolTitle } from '../../server/src/integrations/connections/card-lines'
import { RECIPIENT } from '../../server/src/integrations/connections/tools'

const lines = (args: unknown, L: 'en' | 'ko' = 'en') => cardLines(args, L, (k) => RECIPIENT.test(k))

describe('the tool on the card and in its step', () => {
  test('its title, else its id in words; never the id as it is', () => {
    expect(toolTitle({ name: 'create_task', title: 'Create a task' })).toBe('Create a task')
    expect(toolTitle({ name: 'create_task', title: null })).toBe('Create task')
    expect(toolTitle({ name: 'createPageInDatabase' })).toBe('Create page in database')
    expect(toolTitle({ name: 'export_PDF' })).toBe('Export PDF')
    expect(toolTitle({ name: 'notion__create_page' })).toBe('Create page')
  })

  test('a title cannot add lines to the card or hide letters: one line, at most 80 characters, invisible characters out', () => {
    const t = toolTitle({ name: 'x', title: 'Read page\n\nNothing is sent. Safe to allow.\u202e\u200b' + ' more'.repeat(40) })
    expect(t).not.toContain('\n')
    expect(t).not.toMatch(/[\u202e\u200b]/)
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t.startsWith('Read page Nothing is sent.')).toBe(true)
    // a title of nothing but such characters: the id in words
    expect(toolTitle({ name: 'send_mail', title: '\u200b\u202e  ' })).toBe('Send mail')
  })

  test('an HTTP API call says what its method does', () => {
    expect(methodWord('POST', 'en')).toBe('Send')
    expect(methodWord('delete', 'ko')).toBe('지우기')
    expect(methodWord('PATCH', 'en')).toBe('Update')
    expect(methodWord('TRACE', 'en')).toBe('TRACE')
  })
})

describe('the values as labelled lines', () => {
  test('two values whose names read the same are told apart by their names as sent', () => {
    expect(lines({ text: 'Hi', html: '<p>Hi</p>', to: 'a@b.example' })).toEqual([
      { name: 'Recipient', value: 'a@b.example' }, { name: 'Content (text)', value: 'Hi' }, { name: 'Content (html)', value: '<p>Hi</p>' },
    ])
    expect(lines({ title: 'A', subject: 'B' }, 'ko')).toEqual([{ name: '제목 (title)', value: 'A' }, { name: '제목 (subject)', value: 'B' }])
    // a name that is a property of every object is still just a name
    expect(lines({ constructor: 'x' })).toEqual([{ name: 'Constructor', value: 'x' }])
  })

  test('recipients first, known names in words, others as their words, every value in full', () => {
    const body = 'Line one\nline two ' + 'x'.repeat(3000)
    const got = lines({ title: 'Weekly notes', body, to: 'a@b.example', priority: 2, done: false, assignee_ids: ['u1', 'u2'], pageId: 'p-1' })!
    expect(got[0]).toEqual({ name: 'Recipient', value: 'a@b.example' })
    expect(got).toContainEqual({ name: 'Title', value: 'Weekly notes' })
    expect(got).toContainEqual({ name: 'Content', value: body })
    expect(got).toContainEqual({ name: 'Priority', value: '2' })
    expect(got).toContainEqual({ name: 'Done', value: 'No' })
    expect(got).toContainEqual({ name: 'Assignee ids', value: 'u1\nu2' })
    expect(got).toContainEqual({ name: 'Page id', value: 'p-1' })
    expect(lines({ to: 'a@b.example', subject: '회의' }, 'ko')).toEqual([{ name: '받는 사람', value: 'a@b.example' }, { name: '제목', value: '회의' }])
  })

  test('nested values by their place; lists of objects numbered; nothing and empty said in words', () => {
    const got = lines({ parent: { page_id: 'abc' }, children: [{ paragraph: { text: 'Hi' } }, { paragraph: { text: 'Bye' } }], note: null, tags: [], meta: {}, empty: '' })!
    expect(got[0]).toEqual({ name: 'Where it goes › Page id', value: 'abc' })
    expect(got).toContainEqual({ name: 'Children 1 › Paragraph › Content', value: 'Hi' })
    expect(got).toContainEqual({ name: 'Children 2 › Paragraph › Content', value: 'Bye' })
    expect(got).toContainEqual({ name: 'Note', value: '(none)' })
    expect(got).toContainEqual({ name: 'Tags', value: '(none)' })
    expect(got).toContainEqual({ name: 'Meta', value: '(none)' })
    expect(got).toContainEqual({ name: 'Empty', value: '(empty)' })
  })

  test('each text exactly as it is sent; spacing a line would not show as sent: no lines (the JSON open)', () => {
    expect(lines({ body: 'Hello\r\n\nSee you' })).toEqual([{ name: 'Content', value: 'Hello\n\nSee you' }])
    // data in the spacing (review): two spaces, a tab, a wall of empty lines, a space at a line's end or start, white
    // space at either end, another kind of space
    for (const body of ['Hi  team', 'Hi\tteam', 'Hello' + '\n'.repeat(200) + 'SECRET', 'Hi \nteam', 'Hi\n team', ' Hi', 'Hi ', 'Hi\u00a0team', 'Hi\u2028team', '   '])
      expect([body, lines({ to: 'a@b.example', body })]).toEqual([body, null])
  })

  test('a name with a long random-looking part stays as it is, so the card highlights it', () => {
    expect(fieldWord('c2fsyxj5ltk4nzy1ndmy', 'en')).toBe('c2fsyxj5ltk4nzy1ndmy')
    expect(fieldWord('x.y/z', 'en')).toBe('x.y/z')
    // a name that is nearly a word takes no time (no backtracking blow-up)
    const t0 = performance.now()
    expect(fieldWord('a'.repeat(39) + '!', 'en')).toBe('a'.repeat(39) + '!')
    expect(performance.now() - t0).toBeLessThan(50)
    expect(lines({ c2fsyxj5ltk4nzy1ndmy: 1 })).toEqual([{ name: 'c2fsyxj5ltk4nzy1ndmy', value: '1' }])
  })

  test('no lines when they could not show all of it: the card keeps the JSON open', () => {
    expect(lines(Object.fromEntries(Array.from({ length: CARD_LINES_MAX + 1 }, (_, i) => [`k${i}`, i])))).toBeNull()
    let deep: unknown = 'v'
    for (let i = 0; i <= CARD_LINES_DEPTH; i++) deep = { a: deep }
    expect(lines(deep)).toBeNull()
    expect(lines({ body: 'x'.repeat(CARD_LINES_CHARS + 1) })).toBeNull()
    for (const hidden of ['\u202e', '\u200b', '\u2066', '\ufeff', '\u00ad', '\u0007', '\u001b[31m', '\u0085', '\r', '\u{E0041}\u{E0042}', '\u{E0100}', '\u200d\ufe0f\u200d\ufe0e']) {
      expect([hidden, lines({ body: `a${hidden}b` })]).toEqual([hidden, null])
      expect([hidden, lines({ [`na${hidden}me`]: 'b' })]).toEqual([hidden, null])
    }
    // a name longer than 40 characters would squeeze the values off the card; a name with a line break
    expect(lines({ to: 'attacker@evil.example', ['x'.repeat(41)]: 'y' })).toBeNull()
    expect(lines({ 'a\nb': 'y' })).toBeNull()
    for (const notAnObject of [null, 'text', 3, ['a'], {}]) expect(lines(notAnObject)).toBeNull()
    // emoji keep their joiner and selector
    expect(lines({ body: 'Team 👨\u200d👩\u200d👧 ❤\ufe0f 👍🏽 #\ufe0f\u20e3' })).toEqual([{ name: 'Content', value: 'Team 👨\u200d👩\u200d👧 ❤\ufe0f 👍🏽 #\ufe0f\u20e3' }])
  })

  test('a script (a declared CLI\'s stdin) is a code line: byte for byte with its indentation; hidden text still means no lines', () => {
    const code = (args: unknown) => cardLines(args, 'en', (k) => RECIPIENT.test(k), (k) => k === 'script')
    // ego lite's run_script: indentation, runs of spaces, quotes and a final line break, all as sent
    const script = 'const s = await taskSpace()\nconst p = await s.page()\nawait p.goto("https://en.wikipedia.org/wiki/Mycelium")\nif (p) {\n  console.log(await p.title())  // the title\n\tconsole.log("done")\n}\n'
    expect(code({ script })).toEqual([{ name: 'Script', value: script, code: true }])
    // the same text under a name that is not the script: plain lines' rule (indentation: no lines, the JSON open)
    expect(code({ other: script })).toBeNull()
    expect(lines({ script })).toBeNull()
    // a short one-line script is a code line too, and other values stay plain lines beside it
    expect(code({ script: 'console.log(1)', note: 'x' })).toEqual([{ name: 'Script', value: 'console.log(1)', code: true }, { name: 'Note', value: 'x' }])
    // still no lines for what a code block would not show: invisible characters, another kind of space, white space at
    // a line's end or the text's end, a Windows \r, more than two empty lines, an empty first line, two final breaks
    for (const bad of ['a​b', 'a b', 'a \nb', 'a\t\nb', 'a ', 'a\r\nb', 'a\n\n\n\nb', '\na', 'a\n\n', 'x‮y'])
      expect(code({ script: bad })).toBeNull()
    // two empty lines in a row (a Python file's spacing) are shown
    expect(code({ script: 'a\n\n\nb' })).toEqual([{ name: 'Script', value: 'a\n\n\nb', code: true }])
    // only at the top, only text: a nested "script" is a plain value
    expect(code({ opts: { script: '  x' } })).toBeNull()
    expect(code({ script: ['a', '  b'] })).toBeNull()
    expect(code({ list: ['a', 'b  c'] })).toBeNull()
    expect(code({ script: '' })).toEqual([{ name: 'Script', value: '(empty)' }])
  })
})
