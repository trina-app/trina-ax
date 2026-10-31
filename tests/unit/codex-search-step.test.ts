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
    // an item of the other kind still takes what is left (its own ask, which Codex named differently): none stays behind
    expect(takeSearchAsk(asks, '')).toEqual(search())
    expect(unnamedSearchKind(search(), undefined)).toBe('webSearchPlain')
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
    // a find names "'pattern' in <address>": still the refusal of that address
    const f = [search(), { commands: ['find'], refused: ['https://attacker.example/page'] }]
    expect(takeSearchAsk(f, "'secret' in https://attacker.example/page", 'find')?.refused).toEqual(['https://attacker.example/page'])
    expect(f).toEqual([search()])
  })
  test('a find of a result names its pattern ("\'trixie\'"): it pairs with its own ask and leaves none behind', () => {
    // search, find in one of its results, then an address the proxy refused that the item does not echo (a click)
    const asks: SearchAsk[] = [search(), { commands: ['find'], refused: null }, { commands: ['click'], refused: ['attacker.example/x'] }]
    expect(takeSearchAsk(asks, 'debian 13')).toEqual(search())
    expect(takeSearchAsk(asks, "'trixie'", 'find')).toEqual({ commands: ['find'], refused: null })
    // the refusal goes with the refused item, not with a later open of a result
    expect(takeSearchAsk(asks, '')?.refused).toEqual(['attacker.example/x'])
    expect(asks).toEqual([])
  })
  test('an item of a kind no ask has takes the oldest one that was not refused, so none stays behind', () => {
    const asks: SearchAsk[] = [{ commands: ['weather'], refused: null }, { commands: ['click'], refused: ['attacker.example/x'] }]
    expect(takeSearchAsk(asks, 'weather in seoul')).toEqual({ commands: ['weather'], refused: null })
    expect(takeSearchAsk(asks, '')?.refused).toEqual(['attacker.example/x'])
    // only a refusal left: an item with a query that names none of it does not take it
    const r: SearchAsk[] = [{ commands: ['click'], refused: ['attacker.example/x'] }]
    expect(takeSearchAsk(r, 'weather in seoul')).toBeNull()
    expect(r).toHaveLength(1)
  })
  test('a short refused ref (a number) is never matched inside a query that went out', () => {
    const asks: SearchAsk[] = [{ commands: ['click'], refused: ['12'] }, search()]
    expect(takeSearchAsk(asks, 'debian 12')).toEqual(search())
    expect(takeSearchAsk(asks, '')?.refused).toEqual(['12'])
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
