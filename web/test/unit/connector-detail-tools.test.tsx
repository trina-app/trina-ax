// A listed service's page before it is connected (components/integrations/ConnectorsView.tsx ConnectorDetail, QA
// final): the first 12 tools the service lists, "Show all" shows the rest in place (Figma's weave_* tools), and the
// link to the service's own page stays.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { ConnectorDetail } from '../../src/components/integrations/ConnectorsView'
import { CONNECTOR_DOCS } from '../../src/lib/connectors'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

test('Figma: 12 tools, then all of them in place, Weave included; the service\'s page stays linked', async () => {
  const docs = CONNECTOR_DOCS.figma!
  expect(docs.tools!.length).toBeGreaterThan(12)
  const m = await mount(<ConnectorDetail testId="connector-detail" logo="/x.svg" name="Figma" line="" description="" docs={docs} onBack={() => {}} />)
  try {
    const items = () => [...m.get('connector-tools-listed').querySelectorAll('li')].map((li) => li.textContent)
    expect(items()).toHaveLength(12)
    expect(m.get('connector-tools-more').textContent).toBe(translate('en', 'connectors.toolsShowAll', { count: docs.tools!.length }))
    await m.click('connector-tools-more')
    expect(items()).toEqual([...docs.tools!])
    expect(items()).toContain('weave_run_model')
    expect(m.get('connector-tools-more').getAttribute('aria-expanded')).toBe('true')
    expect(m.find('connector-tools-link')).not.toBeNull()
  } finally { await m.unmount() }
})
