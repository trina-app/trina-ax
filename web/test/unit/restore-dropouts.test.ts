// A team file's restore confirm names the people whose later versions drop out of the latest (lib/restoreDropouts.ts,
// QA TC-7246): v1 Junho, v2 Jiwoo, v3 Junho (current); Doyoon restores v1.
import { describe, expect, test } from 'bun:test'
import type { FileVersion, UserRef } from '@mycel/shared/api'
import { nameList, restoreDropouts } from '../../src/lib/restoreDropouts'
import { en } from '../../src/i18n/en'

const junho: UserRef = { id: '01900000-0000-7000-8000-00000000000a', name: 'Junho' }
const jiwoo: UserRef = { id: '01900000-0000-7000-8000-00000000000b', name: 'Jiwoo' }
const doyoon: UserRef = { id: '01900000-0000-7000-8000-00000000000c', name: 'Doyoon' }
const version = (n: number, savedBy: UserRef | null | undefined, author: UserRef | null): FileVersion => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, path: 'projects/quote/quote.pdf', version: n, sha256: `s${n}`, size: 1,
  author, turnId: null, kind: 'edit', conflictPath: null, createdAt: '2026-11-22T00:00:00.000Z', ...(savedBy !== undefined ? { savedBy } : {}),
})
// v1 by Junho (replaced by Jiwoo), v2 by Jiwoo (replaced by Junho); v3, the current content, by Junho
const items = [version(2, jiwoo, junho), version(1, junho, jiwoo)]
const current = { author: junho }

describe('restoreDropouts', () => {
  test('restoring v1 names everyone else who made v2 or v3, newest first, each once', () => {
    expect(restoreDropouts(items, current, 1, doyoon.id)).toEqual([junho, jiwoo])
  })
  test('restoring v2 names only the maker of v3', () => {
    expect(restoreDropouts(items, current, 2, doyoon.id)).toEqual([junho])
  })
  test('never me: Junho restoring v1 is told only about Jiwoo', () => {
    expect(restoreDropouts(items, current, 1, junho.id)).toEqual([jiwoo])
  })
  test('only my own later versions: nobody (the usual words stay)', () => {
    expect(restoreDropouts(items, current, 2, junho.id)).toEqual([])
  })
  test('versions stored before savedBy was recorded: the replacing author of the version before still names them', () => {
    const old = [version(2, undefined, junho), version(1, undefined, jiwoo)]
    expect(restoreDropouts(old, { author: null }, 1, doyoon.id)).toEqual([junho, jiwoo])
  })
  test('unknown makers are left out', () => {
    expect(restoreDropouts([version(1, junho, null)], { author: null }, 1, doyoon.id)).toEqual([])
  })
})

describe('the confirm words', () => {
  test('names in the English list form, in the new body', () => {
    const names = nameList('en', [junho, jiwoo])
    expect(names).toBe('Junho and Jiwoo')
    expect(en['files.restoreBodyNames'].replace('{names}', names)).toBe("Junho and Jiwoo's changes will no longer be in the latest version. They stay in the history.")
  })
})
