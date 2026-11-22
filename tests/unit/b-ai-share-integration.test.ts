// The joined AI-sharing packages (docs/decisions/20261116-ai-sharing-integration.md): the one "asked first" line a card
// leads with, and names joined the way the app writes a list in each language.
import { expect, test } from 'bun:test'
import { listWords } from '@mycel/shared'
import { whyFirst } from '../../server/src/chat/share-words'
import { tr } from '../../server/src/chat/i18n'

test('one "asked first" line: the screen target first, then rooms or a shared file read here (no line for other people\'s words: Always allow holds there, docs/decisions/20261122-always-allow-holds-everywhere.md)', () => {
  const seen = 'Messages from your conversations (other people\'s words) came in here, so changes are asked first.'
  expect(whyFirst('en', { fromLook: true, seenLine: seen })).toBe(tr('lookedWhy', 'en'))
  expect(whyFirst('en', { fromLook: false, seenLine: seen })).toBe(seen)
  expect(whyFirst('en', { fromLook: false, seenLine: '' })).toBe('')
  for (const L of ['ko', 'ja', 'zh', 'es', 'id'] as const) expect(whyFirst(L, { fromLook: true, seenLine: seen })).toBe(tr('lookedWhy', L))
})

test('names as one phrase: the language\'s own "and"; Korean with commas, as the app writes its Korean lists', () => {
  expect(listWords(['QA Owner', 'QA Admin'], 'en')).toBe('QA Owner and QA Admin')
  expect(listWords(['QA Owner', 'QA Admin', 'Mina Seo'], 'en')).toBe('QA Owner, QA Admin, and Mina Seo')
  expect(listWords(['QA Owner', 'QA Admin'], 'ko')).toBe('QA Owner, QA Admin')
  expect(listWords(['QA Owner', 'QA Admin'], 'es')).toBe('QA Owner y QA Admin')
  expect(listWords(['QA Owner'], 'en')).toBe('QA Owner')
  expect(listWords([], 'en')).toBe('')
})
