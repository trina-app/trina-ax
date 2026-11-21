// A chat's file edited in place, with versions (web/src/lib/chatFileVersions.ts): which names the panel edits as text,
// and the "Updated by" line of the tile and the panel ("Updated by Trina for <name>" for the AI's), in every language.
import { describe, expect, test } from 'bun:test'
import type { ChatFileVersion } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { chatTextEditable, headUpdated, tileUpdated, updatedLine, versionBy } from '../../src/lib/chatFileVersions'

const tr = (l: 'en' | 'ko' | 'ja' | 'zh' | 'es' | 'id') => (key: MessageKey, p?: Params) => translate(l, key, p)
const NOW = Date.parse('2026-11-21T12:00:00Z')
const v = (version: number, o: Partial<ChatFileVersion> = {}): ChatFileVersion => ({ id: `01a1fe0a-b31f-7749-bc54-bb000eb2740${version}`, version, name: 'notes.md', size: 10, mime: 'text/markdown', createdAt: '2026-11-21T11:57:00Z', by: 'olga', byName: 'Olga', ...o })

describe('chat file versions', () => {
  test('text names only: binary files have no pencil', () => {
    for (const n of ['a.md', 'b.TXT', 'c.csv', 'd.html', 'e.htm', 'f.json', 'g.markdown']) expect(chatTextEditable(n)).toBe(true)
    for (const n of ['a.pdf', 'b.png', 'c.docx', 'd.xlsx', 'e.svg', 'md', '', null]) expect(chatTextEditable(n)).toBe(false)
  })

  test('the tile line: only a chat file changed since it was sent', () => {
    expect(tileUpdated({ source: 'chat' })).toBeNull()
    expect(tileUpdated({ source: 'chat', updated: { by: 'olga', byName: 'Olga', at: '2026-11-21T11:57:00Z', version: 1 } })).toBeNull()
    expect(tileUpdated({ source: 'team', updated: { by: 'olga', byName: 'Olga', at: '2026-11-21T11:57:00Z', version: 2 } })).toBeNull()
    const w = tileUpdated({ source: 'chat', updated: { by: 'olga', byName: 'Olga', at: '2026-11-21T11:57:00Z', version: 3, ai: true } })!
    expect(updatedLine(tr('en'), 'en', w, NOW)).toBe('Updated by Trina for Olga · 3 minutes ago')
    expect(updatedLine(tr('ko'), 'ko', w, NOW)).toBe('트리나가 Olga님 대신 수정 · 3분 전')
  })

  test('the panel line follows the head, never the first file', () => {
    expect(headUpdated([v(1, { head: true })])).toBeNull()
    expect(headUpdated([])).toBeNull()
    const w = headUpdated([v(1), v(2, { byName: 'Bob', head: true })])!
    expect(updatedLine(tr('en'), 'en', w, NOW)).toBe('Updated by Bob · 3 minutes ago')
    expect(updatedLine(tr('ko'), 'ko', w, NOW)).toBe('Bob님이 수정 · 3분 전')
    for (const l of ['ja', 'zh', 'es', 'id'] as const) expect(updatedLine(tr(l), l, w, NOW)).toContain('Bob')
  })

  test('who saved a version', () => {
    expect(versionBy(tr('en'), v(2))).toBe('Olga')
    expect(versionBy(tr('en'), v(2, { ai: true }))).toBe('Trina for Olga')
  })
})
