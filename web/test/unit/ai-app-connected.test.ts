// Which AI app rows show "✓ Connected" (components/integrations/AiAppConnect.tsx connectedTo; QA TC-094): a named app by
// its client name in any case, the generic row every other app, each name once.
import { expect, test } from 'bun:test'
import { connectedTo } from '../../src/components/integrations/AiAppConnect'
import { AI_APPS } from '../../src/lib/connectors'

const app = (id: string) => AI_APPS.find((a) => a.id === id)!
const items = (...names: string[]) => names.map((clientName) => ({ clientName }))

test('a named app by its client name, any case; others go to the generic row', () => {
  const mine = items('Claude', 'claude code', 'Codex', 'Cursor')
  expect(connectedTo(app('claude'), mine)).toEqual(['Claude'])
  expect(connectedTo(app('claude-code'), mine)).toEqual(['claude code'])
  expect(connectedTo(app('other'), mine)).toEqual(['Codex', 'Cursor'])
})

test('nothing connected: no row is marked; one app connected twice counts once', () => {
  expect(connectedTo(app('claude'), [])).toEqual([])
  expect(connectedTo(app('other'), items('Claude'))).toEqual([])
  expect(connectedTo(app('other'), items('Codex', 'codex', ' '))).toEqual(['Codex'])
})
