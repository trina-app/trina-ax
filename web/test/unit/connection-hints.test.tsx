// Hints on the connection forms (QA TC-2312, TC-2313, TC-2315): the API engine form says where each provider's key is
// made, as Add account and Voice input do; a listed app that signs in is never described as "one shared key"; the "Who
// connects" choices are short enough for their select in every language.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LOCALES, translate, useLocaleStore } from '../../src/i18n'
import { API_PRESETS, ApiKeyHint } from '../../src/pages/admin/Engines'
import { CONNECTORS, connectorAuth, teamAboutKey } from '../../src/lib/connectors'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => installDom())
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

describe('API engine form: where to get the key (TC-2312)', () => {
  const hint = async (preset: string) => {
    useLocaleStore.setState({ locale: 'en' })
    const m = await mount(<ApiKeyHint preset={preset} />)
    try { return { text: m.container.textContent ?? '', html: m.html() } } finally { await m.unmount() }
  }
  const links: Record<string, string> = {
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://platform.claude.com/settings/keys',
    gemini: 'https://aistudio.google.com/apikey',
    openrouter: 'https://openrouter.ai/keys',
  }
  for (const [id, href] of Object.entries(links)) {
    test(`${id}: a link to its key page that opens in a new tab`, async () => {
      const { text, html } = await hint(id)
      expect(html).toContain(`href="${href}"`)
      expect(html).toContain('target="_blank"')
      expect(text).toContain(translate('en', 'engines.api.getKeyAt', { site: href.replace('https://', '') }))
    })
  }
  test('Ollama: no link, it needs no key', async () => {
    const { text, html } = await hint('ollama')
    expect(html).not.toContain('href=')
    expect(text).toBe(translate('en', 'engines.api.noKeyLocal'))
  })
  test('Custom: nothing', async () => {
    expect((await hint('custom')).html).not.toContain('api-engine-key-hint')
  })
  test('every preset is covered', () => {
    expect(API_PRESETS.map((p): string => p.id).sort()).toEqual([...Object.keys(links), 'ollama'].sort())
  })
})

describe('a listed app connected for the team: its description follows how it signs in (TC-2313)', () => {
  test('every listed app signs in, so none says "one shared key"', () => {
    for (const c of CONNECTORS) {
      expect(connectorAuth(c)).toBe('oauth')
      expect(teamAboutKey(c)).toBe('connectors.mcp.aboutForTeam.signIn')
      expect(translate('en', teamAboutKey(c), { name: c.name })).not.toMatch(/\bkey\b/i)
    }
  })
})

describe('"Who connects" fits its select (TC-2315)', () => {
  // the select is 256 px wide on a computer (md:w-64) and the full width on a phone; a CJK letter is about twice as wide
  const width = (s: string) => [...s].reduce((n, ch) => n + (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  for (const { id: l } of LOCALES) {
    test(l, () => {
      for (const k of ['integrations.who.team', 'integrations.who.template'] as const) expect(width(translate(l, k))).toBeLessThanOrEqual(24)
    })
  }
})
