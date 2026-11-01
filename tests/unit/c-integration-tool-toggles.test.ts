// A tool of an MCP connection turned off (docs/DECISIONS.md "Turn single tools of a connection off") through a real
// chat turn: the engine is not offered it, the model proxy's list of names for the turn (proxy_tokens.tools.team) does
// not have it, so a model request that names it anyway stops the answer (checkToolNames), and the tool that is on is
// in both. The same turn list goes to sub-agents (chat/turn.ts turnTools).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { checkToolNames, toolPolicyOf } from '../../server/src/proxy/model-proxy'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'c-tool-toggles' })
  alice = await h.ws('alice', { windowId: 'win-tool-toggles' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h?.close() })

const tool = (name: string, readOnly: boolean) => ({ name, title: null, description: `${name} pages`, readOnly, inputSchema: { type: 'object', properties: {} } })

describe('a turned-off tool through a chat turn', () => {
  test('not offered to the engine, not in the model proxy\'s names for the turn; a request naming it is refused', async () => {
    const id = uuidv7(), now = new Date().toISOString()
    h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, write_policy, status, tools_json, tools_updated_at, created_at, updated_at, disabled_tools)
      VALUES (?, 'personal', 'alice', 'alice', 'mcp', 'Notes', 'notes', 'https://notes.example/mcp', 'none', 'ask', 'connected', ?, ?, ?, ?, ?)`)
      .run(id, JSON.stringify([tool('search', true), tool('delete_page', false)]), now, now, now, JSON.stringify(['delete_page']))
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }))
    const offered = r.done.content.split(',')
    expect(offered).toContain('my_notes__search')
    expect(offered).not.toContain('my_notes__delete_page')
    const rows = h.ctx.db.query('SELECT tools FROM proxy_tokens WHERE turn_id = ?').all(r.started.turnId) as { tools: string | null }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const policy = toolPolicyOf(row)
      expect(policy.team).toContain('my_notes__search')
      expect(policy.team).not.toContain('my_notes__delete_page')
      const req = (...names: string[]) => ({ model: 'x', messages: [], tools: names.map((name) => ({ name, input_schema: { type: 'object' } })) })
      expect(checkToolNames(req('mcp__team__read', 'mcp__team__my_notes__search'), policy)).toBeNull()
      expect(checkToolNames(req('mcp__team__my_notes__delete_page'), policy)).toContain('tools outside the lockdown: mcp__team__my_notes__delete_page')
    }
    // on again (as the switch does): the next turn has it, in both lists
    h.ctx.db.query("UPDATE integrations SET disabled_tools = '[]', version = version + 1 WHERE id = ?").run(id)
    const again = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }))
    expect(again.done.content.split(',')).toContain('my_notes__delete_page')
    const policy = toolPolicyOf(h.ctx.db.query('SELECT tools FROM proxy_tokens WHERE turn_id = ? LIMIT 1').get(again.started.turnId) as { tools: string | null })
    expect(policy.team).toContain('my_notes__delete_page')
  })
})
