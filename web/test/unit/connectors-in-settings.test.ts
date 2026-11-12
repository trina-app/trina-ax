// Connectors is Settings › Connectors since 2026-11-12 (QA TC-400, lib/connectors.ts): every link goes there, and its old
// addresses lead to the same place with their query and hash; an outside app's consent page keeps its own address.
import { describe, expect, test } from 'bun:test'
import { connectionHref, connectorHref, CONNECTORS_HOME, isOldConnectorsPath, oldConnectorsTarget } from '../../src/lib/connectors'

describe('Settings › Connectors addresses', () => {
  test('the list and its pages', () => {
    expect(CONNECTORS_HOME).toBe('/settings/connectors')
    expect(connectorHref('google-drive')).toBe('/settings/connectors/google-drive')
    expect(connectionHref('a b')).toBe('/settings/connectors/mcp/a%20b')
  })
  test('the old addresses are Settings now, the consent page is not', () => {
    for (const p of ['/connectors', '/connectors/gmail', '/connectors/mcp/x1']) expect(isOldConnectorsPath(p)).toBe(true)
    for (const p of ['/connectors/authorize', '/connectors/authorize/x', '/connectorsx', '/settings/connectors', '/admin/connectors']) expect(isOldConnectorsPath(p)).toBe(false)
  })
  test('an old address leads to the same place in Settings, with its query and hash', () => {
    expect(oldConnectorsTarget('/connectors')).toBe('/settings/connectors')
    expect(oldConnectorsTarget('/connectors', '?add=1')).toBe('/settings/connectors?add=1')
    expect(oldConnectorsTarget('/connectors/mcp/x1', '?request=r', '#top')).toBe('/settings/connectors/mcp/x1?request=r#top')
    expect(oldConnectorsTarget('/connectors', '?slack=linked')).toBe('/settings/connectors?slack=linked')
  })
})
