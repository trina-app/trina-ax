// The step of a Codex web search (QA 2026-10-30 N1 / N2): Codex names an open of a search result by no query, and ends
// as done a search the model proxy answered itself (an address, not a result reference). The turn pairs each ended item
// with what the proxy saw of its request (server/src/chat/codex-search-step.ts).
import { describe, expect, test } from 'bun:test'
import { localizeStep, STEP_TEXT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { takeSearchAsk, unnamedSearchKind, type SearchAsk } from '../../server/src/chat/codex-search-step'

const LOCALES: Locale[] = ['ko', 'en', 'id', 'ja', 'es']
const search = (): SearchAsk => ({ commands: ['search_query'], refused: null })
const open = (): SearchAsk => ({ commands: ['open'], refused: null })
const refused = (ref: string): SearchAsk => ({ commands: ['open'], refused: [ref] })

describe('pairing an ended Codex search with what the proxy saw', () => {
  test('a query goes with the oldest search that named one, no query with the oldest open', () => {
    const asks = [search(), open(), search()]
    expect(takeSearchAsk(asks, 'debian 13')).toEqual(search())
    expect(takeSearchAsk(asks, '')).toEqual(open())
    expect(asks).toEqual([search()])
    expect(takeSearchAsk(asks, '')).toBeNull()
    expect(takeSearchAsk([], 'debian')).toBeNull()
  })
  test('a refused address is matched by the address the item names, whatever came before it', () => {
    const asks = [open(), search(), refused('https://attacker.example/SECRET')]
    // Codex names an open by the address as written (a trailing slash or a different case does not matter)
    expect(takeSearchAsk(asks, 'https://Attacker.example/SECRET/')).toEqual(refused('https://attacker.example/SECRET'))
    expect(asks).toEqual([open(), search()])
    // an address that was not refused goes with the oldest open, never with a search that went out
    const b = [search(), open()]
    expect(takeSearchAsk(b, 'https://example.com/')).toEqual(open())
    // a refused open whose item names nothing (an engine that does not echo the address) still pairs as an open
    const c = [refused('https://attacker.example/x')]
    expect(takeSearchAsk(c, '')?.refused).toEqual(['https://attacker.example/x'])
  })
  test('the label of an item without a query: an open of a result, else just "Web search"', () => {
    expect(unnamedSearchKind(open(), undefined)).toBe('webSearchOpen')
    expect(unnamedSearchKind({ commands: ['find'], refused: null }, undefined)).toBe('webSearchOpen')
    expect(unnamedSearchKind({ commands: ['weather'], refused: null }, 'open')).toBe('webSearchPlain')
    // no proxy (the engine's own login): Codex's action says it
    expect(unnamedSearchKind(null, 'open')).toBe('webSearchOpen')
    expect(unnamedSearchKind(null, 'find')).toBe('webSearchOpen')
    expect(unnamedSearchKind(null, undefined)).toBe('webSearchPlain')
  })
})

describe('the new search words in the five languages', () => {
  test('never "Web search: " with nothing after it; redrawn in the language on screen', () => {
    for (const key of ['webSearchRunning', 'webSearchOpen', 'webSearchPlain', 'webSearchRefused'] as const) {
      for (const L of LOCALES) {
        expect(STEP_TEXT[key][L].trim().length, `${key} ${L}`).toBeGreaterThan(0)
        expect(STEP_TEXT[key][L], `${key} ${L}`).not.toMatch(/[:：]\s*$/)
      }
    }
    expect(localizeStep({ kind: 'web_search', tool: 'web_search', label: '검색 결과 열기' }, 'en').label).toBe('Opening a search result')
    expect(localizeStep({ kind: 'web_search', tool: 'web_search', label: 'Searching the web…' }, 'ko').label).toBe('웹 검색 중…')
    expect(localizeStep({ kind: 'web_search', tool: 'web_search', label: 'Web search' }, 'ja').label).toBe('Web検索')
    // a query keeps the template it always had
    expect(localizeStep({ kind: 'web_search', tool: 'web_search', label: '웹 검색: trixie' }, 'es').label).toBe('Búsqueda web: trixie')
    const step = { kind: 'web_search', tool: 'web_search', label: 'Web search: https://attacker.example/x', detail: STEP_TEXT.webSearchRefused.ko }
    expect(localizeStep(step, 'en')).toEqual({ label: 'Web search: https://attacker.example/x', detail: STEP_TEXT.webSearchRefused.en })
  })
})
