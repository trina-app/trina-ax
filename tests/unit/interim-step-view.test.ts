// An interim step's text (Step.interim: what the AI wrote to the chat between two calls, shown at its place) reaches
// everyone who sees the answer, as the answer's own text does; a thinking block's text stays the runner's
// (docs/decisions/20261125-interim-text-inline.md).
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { ChatStore, type StoredStep } from '../../server/src/chat/store'

const at = new Date().toISOString()
const steps: StoredStep[] = [
  { id: 'n1', kind: 'thinking', label: 'Thinking', status: 'ok', startedAt: at, endedAt: at, detail: '범위를 넓혀 볼게요.', interim: true },
  { id: 't1', kind: 'thinking', label: 'Thinking', status: 'ok', startedAt: at, endedAt: at, detail: 'private reasoning' },
]

test('another viewer of a shared chat sees an interim step\'s text, not a thinking block\'s', () => {
  const store = new ChatStore(new Database(':memory:'))
  const view = { viewer: 'bob', canList: () => true, canRead: () => true, failed: '', runner: false }
  const seen = store.viewSteps({ chat_id: 'c1' }, steps, view)
  expect(seen.find((s) => s.id === 'n1')?.detail).toBe('범위를 넓혀 볼게요.')
  expect(seen.find((s) => s.id === 't1')?.detail).toBeUndefined()
  // the runner sees both
  expect(store.viewSteps({ chat_id: 'c1' }, steps, { ...view, viewer: 'alice', runner: true }).map((s) => s.detail)).toEqual(['범위를 넓혀 볼게요.', 'private reasoning'])
})
