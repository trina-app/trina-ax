// The template's connect dialog (components/integrations/AnswerDialog.tsx OwnKeyDialog), QA retest 2026-11-12 (BUG5):
// its last line talks about a stored key only for a key service; for a sign-in service it says you sign in on the
// service's own page and the app keeps the sign-in, never your password.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { OwnKeyDialog, type OwnKeySource } from '../../src/components/integrations/AnswerDialog'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const src = (auth: OwnKeySource['auth']): OwnKeySource => ({ kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth, authHeader: null, notes: null })
const note = async (auth: OwnKeySource['auth']) => {
  const m = await mount(<OwnKeyDialog src={src(auth)} title="Connect Notion" intro="" submit={async () => { throw new Error('no') }} onClose={() => {}} onConnected={() => {}} />)
  try { return m.get('integration-answer-mine-note').textContent ?? '' } finally { await m.unmount() }
}

test('a sign-in service: you sign in on its own page, no word about a stored key', async () => {
  const text = await note('oauth')
  expect(text).toBe(translate('en', 'integrations.asked.mineNoteSignIn', { name: 'Notion' }))
  expect(text).not.toContain('key')
})

test('a key service keeps the key words', async () => {
  expect(await note('bearer')).toBe(translate('en', 'integrations.asked.mineNote'))
})
