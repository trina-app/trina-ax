// Add custom connector in the desktop app (IntegrationDialog.tsx `local`, docs/decisions/20261118-local-app-connectors.md
// "Aside and ego lite as their own connectors"): a program on this computer is one more choice next to a server's
// address; a member, who adds no server by its address, gets only the program form; elsewhere nothing changes.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { IntegrationDialog } from '../../src/components/integrations/IntegrationDialog'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'ada', username: 'ada', name: 'Ada', role: 'admin', prefs: {} }, team: { name: 'Acme', defaultLocale: 'en' }, groups: [], session: { id: 's', client: 'web' }, server: { version: '0', dev: true } } as unknown as Me } })
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })

test('"On this computer" is a choice next to the address form, and shows the command field', async () => {
  const m = await mount(<MemoryRouter><IntegrationDialog scope="personal" local="choice" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => m.find('integration-source-local'), 'the choice')
    expect(m.find('integration-url')).not.toBeNull()
    expect(m.find('local-app-command')).toBeNull()
    expect(m.html()).toContain(translate('en', 'connectorsPage.addCustom'))
    // a browser checks a radio before its click handlers run (React reads the change there); the fake DOM does not
    const radio = m.get('integration-source-local')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(radio), 'checked')!.set!.call(radio, true)
    await m.click(radio)
    await m.until(() => m.find('local-app-command'), 'the command field')
    expect(m.find('integration-url')).toBeNull()
    expect(m.find('integration-source-internet')).not.toBeNull()
    expect(m.find('local-app-address-ask-admin')).toBeNull()
  } finally { await m.unmount() }
})

test('a member gets only the program form, with where to ask for a server by its address', async () => {
  const m = await mount(<MemoryRouter><IntegrationDialog scope="personal" local="only" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => m.find('local-app-command'), 'the command field')
    expect(m.find('integration-source-local')).toBeNull()
    expect(m.find('integration-url')).toBeNull()
    expect(m.get('local-app-address-ask-admin').textContent).toBe(translate('en', 'localApps.addressAskAdmin'))
  } finally { await m.unmount() }
})

test('without the desktop app (no `local`) the dialog is the address form only', async () => {
  const m = await mount(<MemoryRouter><IntegrationDialog scope="personal" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => m.find('integration-url'), 'the address field')
    expect(m.find('integration-source-local')).toBeNull()
    expect(m.find('local-app-command')).toBeNull()
  } finally { await m.unmount() }
})
