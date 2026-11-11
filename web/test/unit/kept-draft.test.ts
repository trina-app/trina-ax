// A phone's unsaved changes kept when it leaves a page (lib/keptDraft.ts): they come back once, only for the person and
// session that made them, and never undo a value saved since they were made.
import { beforeEach, describe, expect, test } from 'bun:test'
import { changesOf, forgetKeptDrafts, keepChanges, keepDraft, takeChanges, takeDraft } from '../../src/lib/keptDraft'

beforeEach(() => forgetKeptDrafts())

const saved = { teamName: 'Acme', trashRetentionDays: 30, aiVision: true }

describe('a form (Team settings): the changed fields, over what is saved now', () => {
  test('only the changed fields are kept, and laid over the fresh settings once', () => {
    expect(changesOf({ ...saved, teamName: 'Acme Labs' }, saved)).toEqual({ teamName: 'Acme Labs' })
    keepChanges('ts', 'u1:s1', saved, { ...saved, teamName: 'Acme Labs' })
    // someone else changed the trash period since: that stays, the kept name goes over it
    const fresh = { ...saved, trashRetentionDays: 14 }
    expect(takeChanges('ts', 'u1:s1', fresh)).toEqual({ teamName: 'Acme Labs', trashRetentionDays: 14, aiVision: true })
    expect(takeChanges('ts', 'u1:s1', fresh)).toBeNull()
  })
  test('another person or session gets nothing (and it is gone)', () => {
    keepChanges('ts', 'u1:s1', saved, { ...saved, aiVision: false })
    expect(takeChanges('ts', 'u2:s9', saved)).toBeNull()
    expect(takeChanges('ts', 'u1:s1', saved)).toBeNull()
  })
  test('nothing changed: what was kept before is forgotten', () => {
    keepChanges('ts', 'u1:s1', saved, { ...saved, aiVision: false })
    keepChanges('ts', 'u1:s1', saved, saved)
    expect(takeChanges('ts', 'u1:s1', saved)).toBeNull()
  })
})

describe('a part that saves on its own (AI defaults): the whole draft, over the same saved value only', () => {
  const ai = { defaultEngine: 'claude-code', defaultModel: null, concurrency: 2 }
  test('put back once when nothing was saved since', () => {
    keepDraft('ai', 'u1:s1', ai, { ...ai, concurrency: 3 })
    expect(takeDraft<typeof ai>('ai', 'u1:s1', ai)).toEqual({ ...ai, concurrency: 3 })
    expect(takeDraft('ai', 'u1:s1', ai)).toBeNull()
  })
  test('a value saved since (here or elsewhere), another person or session: dropped', () => {
    keepDraft('ai', 'u1:s1', ai, { ...ai, concurrency: 3 })
    expect(takeDraft('ai', 'u1:s1', { ...ai, defaultModel: 'opus' })).toBeNull()
    keepDraft('ai', 'u1:s1', ai, { ...ai, concurrency: 3 })
    expect(takeDraft('ai', 'u1:s2', ai)).toBeNull()
  })
  test('a draft that is the saved value is not kept', () => {
    keepDraft('ai', 'u1:s1', ai, { ...ai })
    expect(takeDraft('ai', 'u1:s1', ai)).toBeNull()
  })
})
