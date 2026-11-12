// A listed service's page before it is connected (QA TC-132, lib/connectors.ts CONNECTOR_DOCS): only values checked on
// the service's own pages. At least the popular seven have their links; a tool list always comes with the page it is
// from; every link is https on the service's own domain or its docs domain.
import { expect, test } from 'bun:test'
import { CONNECTOR_DOCS, CONNECTORS } from '../../src/lib/connectors'

test('the popular services have their privacy, terms and help pages', () => {
  for (const id of ['notion', 'linear', 'atlassian', 'figma', 'canva', 'stripe', 'supabase'] as const) {
    const d = CONNECTOR_DOCS[id]
    expect({ id, has: !!d }).toEqual({ id, has: true })
    for (const u of [d!.privacy, d!.terms, d!.docs]) expect(new URL(u).protocol).toBe('https:')
  }
})

test('a tool list is the service\'s own: names only, with the page that lists them, on the service\'s domain', () => {
  const own: Record<string, RegExp> = { notion: /notion\.com$/, figma: /figma\.com$/, stripe: /stripe\.com$/, supabase: /supabase\.com$/ }
  for (const [id, d] of Object.entries(CONNECTOR_DOCS)) {
    expect(CONNECTORS.some((c) => c.id === id)).toBe(true)
    if (!d?.tools) continue
    expect(d.toolsUrl).toBeTruthy()
    expect(new URL(d.toolsUrl!).hostname).toMatch(own[id]!)
    for (const name of d.tools) expect(name).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect(new Set(d.tools).size).toBe(d.tools.length)
  }
})
