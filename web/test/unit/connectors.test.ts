// "Discover" in External services (lib/connectors.ts): every listed service makes a connection the contract accepts,
// has its description in every language and a logo of its own that is safe to serve from this server, and shows as added
// whichever way its address was written.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { IntegrationInput } from '@mycel/shared/api'
import { connectorFor, CONNECTORS, isConnected } from '../../src/lib/connectors'
import { canonicalService, emptyForm, toInput, validate } from '../../src/lib/integrations'
import { DICTS } from '../../src/i18n'

describe('Discover', () => {
  test('every service is an MCP server with sign-in that the contract accepts, listed once', () => {
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length)
    expect(new Set(CONNECTORS.map((c) => canonicalService(c.url))).size).toBe(CONNECTORS.length)
    for (const c of CONNECTORS) {
      const f = { ...emptyForm('mcp'), name: c.name, url: c.url }
      expect(validate(f)).toEqual({})
      expect(toInput(f)).toMatchObject({ kind: 'mcp', auth: 'oauth', writePolicy: 'ask' })
      expect(IntegrationInput.safeParse(toInput(f)).success).toBe(true)
    }
  })

  test('every service says what it does in every language', () => {
    for (const dict of Object.values(DICTS)) {
      for (const c of CONNECTORS) expect((dict as Record<string, string>)[`integrations.catalog.${c.id}`]).toBeTruthy()
    }
  })

  test('every service has its logo, and a logo can run nothing and load nothing', () => {
    const dir = path.join(import.meta.dir, '../../public/icons/connectors')
    expect(fs.readdirSync(dir).sort()).toEqual(CONNECTORS.map((c) => c.logo).sort())
    for (const c of CONNECTORS) {
      const file = fs.readFileSync(path.join(dir, c.logo))
      if (c.logo.endsWith('.png')) {
        expect(file.subarray(1, 4).toString()).toBe('PNG')
        continue
      }
      const svg = file.toString('utf8')
      expect(svg).toMatch(/<svg[\s>]/i)
      // these are served from the team's own address, so a file opened directly must be harmless
      expect(svg).not.toMatch(/<\s*script|\son[a-z]+\s*=|<\s*foreignObject|javascript:|<\s*image\b|href\s*=\s*["'](?!#)|url\(\s*["']?https?:|<!ENTITY|<!DOCTYPE|@import/i)
    }
  })

  test('a connection added by hand is matched to its service for the logo', () => {
    expect(connectorFor('https://MCP.notion.com/mcp/')?.id).toBe('notion')
    expect(connectorFor('https://mcp.notion.com/other')).toBeUndefined()
  })

  test('already added: whatever the letter case or a trailing slash, and not a similar address', () => {
    const notion = CONNECTORS.find((c) => c.id === 'notion')!
    const stripe = CONNECTORS.find((c) => c.id === 'stripe')!
    expect(isConnected(notion, ['https://MCP.notion.com/mcp/'])).toBe(true)
    expect(isConnected(stripe, ['https://mcp.stripe.com'])).toBe(true)
    expect(isConnected(notion, ['https://mcp.notion.com/other'])).toBe(false)
    expect(isConnected(notion, ['https://example.com/mcp', 'not an address'])).toBe(false)
    expect(isConnected(notion, [])).toBe(false)
  })
})
