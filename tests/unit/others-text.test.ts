// chat/live-answer.ts OthersText: the asker's answer text as the others in a shared chat may get it while it runs (security
// review of #1311): only up to the last character no written form of a stored secret is made of, each part redacted
// whole, with no length cap on what is held back, closed for good past OTHERS_HOLD_MAX, started again when earlier text
// changes.
import { expect, test } from 'bun:test'
import { OTHERS_HOLD_MAX, OthersText } from '../../server/src/chat/live-answer'
import { redactorOf, WITHHOLDING } from '../../server/src/integrations/connections/redact'
import { HIDDEN } from '../../server/src/integrations/connections/hide'

const KEY = 'CANARY-others-key-7302'
const padded = [...KEY].map((c) => `&#${'0'.repeat(30)}${c.codePointAt(0)};`).join('')

test('a padded entity form is held whole while it is written, then hidden', () => {
  const r = redactorOf([KEY])
  const o = new OthersText(() => r)
  let text = 'The key is '
  expect(o.of(text)).toBe('The key is ')
  for (let i = 0; i < padded.length; i += 7) {
    text += padded.slice(i, i + 7)
    expect(o.of(text)).toBe('The key is ')
  }
  text += ' and that is it.'
  expect(o.of(text)).toBe(`The key is ${HIDDEN} and that is it.`)
})

test('no stored keys: the text as it is; a withholding redactor: nothing', () => {
  expect(new OthersText(() => redactorOf([])).of('abc def')).toBe('abc def')
  expect(new OthersText(() => WITHHOLDING).of('abc def')).toBe('')
})

test('a held run past OTHERS_HOLD_MAX closes it: nothing more until the end', () => {
  const r = redactorOf([KEY])
  const o = new OthersText(() => r)
  expect(o.of('Start. ')).toBe('Start. ')
  const run = 'a'.repeat(OTHERS_HOLD_MAX + 1)
  expect(o.of('Start. ' + run)).toBe('Start. ')
  expect(o.of('Start. ' + run + ' more. ')).toBe('Start. ')
})

test('earlier text dropped (a refused attempt): built again from the start', () => {
  const r = redactorOf([KEY])
  const o = new OthersText(() => r)
  expect(o.of('First try. ')).toBe('First try. ')
  expect(o.of('Second. ')).toBe('Second. ')
})
