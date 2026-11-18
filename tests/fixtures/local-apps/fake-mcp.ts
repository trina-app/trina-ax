// A small MCP server over stdio for the tests of apps on the person's computer (tests/unit/e-local-apps.test.ts,
// c-local-apps-e2e.test.ts): newline-delimited JSON-RPC, like `aside mcp`. Its tools tell the test what it got: its
// argument list, a setting from its environment, how many times it was initialized; ask_ping asks the client a ping.
import { createInterface } from 'node:readline'

let inits = 0
const pending = new Map<string, (m: any) => void>()
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n')
const text = (id: unknown, t: string) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } })
const TOOLS = [
  { name: 'echo', description: 'Say it back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'argv', description: 'The program\'s arguments', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'env', description: 'A setting', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'inits', description: 'How many initialize', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'slow', description: 'Takes 30 s', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_ping', description: 'Pings the client', inputSchema: { type: 'object', properties: {} } },
]
process.stderr.write('fake mcp started\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m: any
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && !m.method) { pending.get(String(m.id))?.(m); return }
  if (m.method === 'initialize') { inits++; send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }); return }
  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } }); return }
  if (m.method !== 'tools/call') { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }); return }
  const a = m.params?.arguments ?? {}
  switch (m.params?.name) {
    case 'echo': return text(m.id, `echo: ${a.text ?? ''}`)
    case 'argv': return text(m.id, JSON.stringify(process.argv.slice(2)))
    case 'env': return text(m.id, `value: ${process.env[String(a.name)] ?? '(none)'}`)
    case 'inits': return text(m.id, String(inits))
    case 'slow': setTimeout(() => text(m.id, 'slow done'), 30_000); return
    case 'ask_ping': {
      const id = 'srv-' + Math.random().toString(36).slice(2)
      pending.set(id, (r) => text(m.id, r.result ? 'pong ok' : 'pong failed'))
      send({ jsonrpc: '2.0', id, method: 'ping' })
      return
    }
    default: send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } })
  }
})
