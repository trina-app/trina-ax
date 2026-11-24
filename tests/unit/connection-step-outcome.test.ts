// What a connection's call came back with, beside its step (server/src/integrations/connections/step-outcome.ts;
// docs/decisions/20261124-step-key-input.md): a count only when the answer is a list of results, never another list.
import { describe, expect, test } from 'bun:test'
import { answerCount, endOfKind, errorLine } from '../../server/src/integrations/connections/step-outcome'

describe('answerCount', () => {
  test('a JSON list, or one list named like results', () => {
    expect(answerCount(undefined, JSON.stringify([1, 2, 3]))).toBe(3)
    expect(answerCount(undefined, JSON.stringify({ organic: [1, 2], next: null }))).toBe(2)
    expect(answerCount({ results: [1] }, 'ignored')).toBe(1)
    expect(answerCount(undefined, JSON.stringify({ items: [] }))).toBe(0)
  })
  test('a write\'s answer with a list that is no results: no count (review of #513)', () => {
    expect(answerCount(undefined, JSON.stringify({ id: 't1', labels: ['a', 'b'] }))).toBeUndefined()
    expect(answerCount(undefined, JSON.stringify({ warnings: [] }))).toBeUndefined()
    expect(answerCount(undefined, JSON.stringify({ results: [1], items: [2] }))).toBeUndefined()
    expect(answerCount(undefined, 'created task "x"')).toBeUndefined()
    expect(answerCount(undefined, '{not json')).toBeUndefined()
  })
})

test('endOfKind and errorLine', () => {
  expect(endOfKind('not allowed by the user')).toBe('declined')
  expect(endOfKind('no answer in time')).toBe('unanswered')
  expect(endOfKind('not fetched (shared chat)')).toBe('skipped')
  expect(endOfKind('refused (sub-agent)')).toBe('refused')
  expect(endOfKind('stopped')).toBeUndefined()
  expect(endOfKind('service down')).toBe('failed')
  expect(errorLine('Error: rate limited, try again\nmore')).toBe('rate limited, try again')
  expect(errorLine('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected')).not.toContain('ghp_')
})
