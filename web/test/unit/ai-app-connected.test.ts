// Which AI app rows show "✓ Connected" (components/integrations/AiAppConnect.tsx connectedTo; QA TC-094): a named app by
// its client name in any case, also with " (…)" after it (Claude Code registers as "Claude Code (<server name>)"), the
// generic row every other app, each name once.
import { expect, test } from 'bun:test'
import { appIdFor, connectedTo } from '../../src/components/integrations/AiAppConnect'
import { AI_APPS } from '../../src/lib/connectors'

const app = (id: string) => AI_APPS.find((a) => a.id === id)!
const items = (...names: string[]) => names.map((clientName) => ({ clientName }))

test('a named app by its client name, any case; others go to the generic row', () => {
  const mine = items('Claude', 'claude code', 'Codex', 'Cursor')
  expect(connectedTo(app('claude'), mine)).toEqual(['Claude'])
  expect(connectedTo(app('claude-code'), mine)).toEqual(['claude code'])
  expect(connectedTo(app('codex'), mine)).toEqual(['Codex'])
  expect(connectedTo(app('other'), mine)).toEqual(['Cursor'])
})

test('nothing connected: no row is marked; one app connected twice counts once', () => {
  expect(connectedTo(app('claude'), [])).toEqual([])
  expect(connectedTo(app('other'), items('Claude'))).toEqual([])
  expect(connectedTo(app('codex'), items('Codex', 'codex', ' '))).toEqual(['Codex'])
})

test('"<app> (…)" is that app: Claude Code names itself after the server; a longer name is not', () => {
  const mine = items('Claude Code (trina-ax)', 'Claude', 'Claude Desktop', 'Codex (work)', 'Codexify')
  expect(connectedTo(app('claude-code'), mine)).toEqual(['Claude Code (trina-ax)'])
  expect(connectedTo(app('claude'), mine)).toEqual(['Claude'])
  expect(connectedTo(app('codex'), mine)).toEqual(['Codex (work)'])
  expect(connectedTo(app('other'), mine)).toEqual(['Claude Desktop', 'Codexify'])
  expect(appIdFor('  CLAUDE CODE (x) ')).toBe('claude-code')
  expect(appIdFor('Cursor')).toBeUndefined()
})
