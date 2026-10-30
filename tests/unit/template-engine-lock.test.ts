import { expect, test } from 'bun:test'
import { buildClaudeLaunch } from '../../server/src/engine/claude'
import { buildCodexLaunch } from '../../server/src/engine/codex'
const common = { turnId: 'synthetic-turn', chatDir: '/synthetic/chat', token: 'synthetic', systemPrompt: 's', message: 'm', timeoutMs: 1000 }
test('templates disable built-in web search while normal CLI launch defaults remain unchanged', () => {
  const conf = { bin: '/synthetic/claude', authMode: 'managed' as const, agentHome: '/synthetic/home', modelProxy: { baseUrl: 'http://127.0.0.1:9' } }
  const input = { ...common, sessionId: 'synthetic-session', resume: false, stash: null, maxTurns: 1 }
  const normal = buildClaudeLaunch(input, conf), template = buildClaudeLaunch({ ...input, webSearch: false }, conf)
  expect(normal.args[normal.args.indexOf('--tools') + 1]).toBe('WebSearch')
  expect(template.args[template.args.indexOf('--tools') + 1]).toBe('')
  expect(template.args[template.args.indexOf('--allowedTools') + 1]).not.toContain('WebSearch')
  const codex = { bin: '/synthetic/codex', codexHome: '/synthetic/codex-home', agentHome: '/synthetic/home', catalog: '/synthetic/catalog', model: 'synthetic', auth: 'dev-owner-symlink' as const }
  // Codex searches its cached index only, never live page loads (docs/DECISIONS.md "Outbound web channels")
  expect(buildCodexLaunch(common,codex).args).toContain('web_search="cached"')
  expect(buildCodexLaunch(common,codex).args).not.toContain('web_search="live"')
  expect(buildCodexLaunch({ ...common, webSearch: false },codex).args).toContain('web_search="disabled"')
})
