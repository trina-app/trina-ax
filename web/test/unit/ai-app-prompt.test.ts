// The prompt each agent app's Connect dialog copies (components/integrations/AiAppConnect.tsx connectPrompt): it holds the
// same command the steps show (connectorCommands) with this server's own address and the server name, says how to finish
// sign-in, and ends with a check that lists the team folder. Claude (web, desktop, phone) gets no prompt, only a first ask.
import { expect, test } from 'bun:test'
import { CONNECTOR_NAME, connectPrompt, connectorCommands, tryPrompt } from '../../src/components/integrations/AiAppConnect'
import { AI_APPS } from '../../src/lib/connectors'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { PRODUCT } from '@mycel/shared'

const URL = 'https://acme.example.com/mcp'
const app = (id: string) => AI_APPS.find((a) => a.id === id)!
const tr = (locale: 'en' | 'ko' | 'id' | 'ja' | 'es' | 'zh') => (key: MessageKey, params?: Params) => translate(locale, key, params)

test('the commands are the ones the steps show, with the server name and this address', () => {
  expect(CONNECTOR_NAME).toBe(PRODUCT.artifactBase.toLowerCase())
  expect(connectorCommands(URL)).toEqual({
    claudeCode: `claude mcp add --transport http ${CONNECTOR_NAME} ${URL}`,
    codex: `codex mcp add ${CONNECTOR_NAME} --url ${URL}`,
    codexLogin: `codex mcp login ${CONNECTOR_NAME}`,
  })
})

test('Claude Code: the add command, a new session, /mcp with the server name, and the folder check', () => {
  const p = connectPrompt(app('claude-code'), URL, tr('en'))!
  expect(p).toContain(`claude mcp add --transport http ${CONNECTOR_NAME} ${URL}`)
  expect(p).toContain('start it again')
  expect(p).toContain(`/mcp, pick ${CONNECTOR_NAME}`)
  expect(p).toContain(`List my team folder in ${CONNECTOR_NAME}`)
  expect(p).toContain(PRODUCT.displayName)
  expect(p).not.toContain('codex')
})

test('Codex: the add command, the login command if no browser opens, and the folder check', () => {
  const p = connectPrompt(app('codex'), URL, tr('en'))!
  expect(p).toContain(`codex mcp add ${CONNECTOR_NAME} --url ${URL}`)
  expect(p).toContain(`codex mcp login ${CONNECTOR_NAME}`)
  expect(p).toContain(`List my team folder in ${CONNECTOR_NAME}`)
  expect(p).not.toContain('claude mcp')
})

test('Other apps: name, address, Streamable HTTP and OAuth, and the folder check', () => {
  const p = connectPrompt(app('other'), URL, tr('en'))!
  expect(p).toContain(`Name: ${CONNECTOR_NAME}`)
  expect(p).toContain(`Address: ${URL}`)
  expect(p).toContain('Streamable HTTP')
  expect(p).toContain('OAuth')
  expect(p).toContain('listing my team folder')
})

test('Claude has no prompt (it cannot add a connector); its first ask names the product', () => {
  expect(connectPrompt(app('claude'), URL, tr('en'))).toBeNull()
  expect(tryPrompt(tr('en'))).toBe(`Using ${PRODUCT.displayName}, list my team folder and summarize what's in it.`)
})

test('every language keeps the real commands, address and server name, with no placeholder left', () => {
  for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
    const c = connectorCommands(URL)
    const cc = connectPrompt(app('claude-code'), URL, tr(l))!, cx = connectPrompt(app('codex'), URL, tr(l))!, o = connectPrompt(app('other'), URL, tr(l))!
    expect(cc).toContain(c.claudeCode)
    expect(cc).toContain('/mcp')
    expect(cx).toContain(c.codex)
    expect(cx).toContain(c.codexLogin)
    expect(o).toContain(URL)
    for (const p of [cc, cx, o, tryPrompt(tr(l))]) {
      expect(p).not.toMatch(/\{\w+\}/)
      expect(p).toContain(PRODUCT.displayName)
    }
  }
})

test('Korean: particles read right after the product and server names', () => {
  const p = connectPrompt(app('claude-code'), URL, tr('ko'))!
  expect(p).not.toContain('을(를)')
  expect(p).toContain(`${CONNECTOR_NAME}`)
})
