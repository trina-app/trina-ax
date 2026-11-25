// A small MCP server over stdio for the tests of apps on the person's computer (tests/unit/e-local-apps.test.ts,
// c-local-apps-e2e.test.ts): newline-delimited JSON-RPC, like `aside mcp`. Its tools tell the test what it got: its
// argument list, a setting from its environment, how many times it was initialized; ask_ping asks the client a ping.
// Like Aside with several accounts (not listed in tools/list): it starts with `--account uN` or u1; only the account in
// FAKE_ASIDE_GOOD has open profiles. Otherwise browser_profiles lists none and repl gives Aside's own error (which
// names the good account when there is one). `account list --json` prints FAKE_ASIDE_ACCOUNTS and exits.
// With FAKE_ASIDE_PROFILES ({"u0":[{profileId,label}],…}, current account FAKE_ASIDE_CURRENT) it is like Aside with
// several accounts that each have profiles: browser_profiles lists only the started account's, repl and exec refuse a
// profile_id or session of another account, and `host profiles --account uN --json` prints that account's profiles.
// FAKE_ASIDE_NO_LIST_JSON: like an older Aside CLI, `account list --json` fails and `account list` prints plain lines
// (accounts in FAKE_ASIDE_SIGNED_IN, comma-separated, are signed in; else the current one).
// `guide` prints the file FAKE_ASIDE_GUIDE_FILE (a file, so the test's setting values never hold its words; fails without it, like an Aside CLI that has no guide). With FAKE_ASIDE_EXEC_SIGN_IN,
// exec in an account that is not signed in answers Aside's "Sign in again before using built-in Aside models."
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

let inits = 0
const PROFILES = process.env.FAKE_ASIDE_PROFILES ? JSON.parse(process.env.FAKE_ASIDE_PROFILES) as Record<string, { profileId: string; label: string }[]> : null
const CURRENT = process.env.FAKE_ASIDE_CURRENT ?? 'u1'
const at = process.argv.indexOf('--account')
const account = at > 0 ? process.argv[at + 1]! : PROFILES ? CURRENT : 'u1'
const isSignedIn = (u: string) => (process.env.FAKE_ASIDE_SIGNED_IN ? process.env.FAKE_ASIDE_SIGNED_IN.split(',').includes(u) : u === CURRENT)
if (process.argv[2] === 'guide') {
  if (!process.env.FAKE_ASIDE_GUIDE_FILE) { process.stderr.write("error: unknown command 'guide'\n"); process.exit(1) }
  process.stdout.write(readFileSync(process.env.FAKE_ASIDE_GUIDE_FILE, 'utf8') + '\n')
  process.exit(0)
}
if (process.argv[2] === 'account' && process.argv[3] === 'list' && process.env.FAKE_ASIDE_NO_LIST_JSON) {
  // like Aside CLI 1.26.1023: no --json on `account list`, only its plain lines
  if (process.argv.includes('--json')) { process.stderr.write("error: unknown option '--json'\n"); process.exit(1) }
  for (const [u, ps] of Object.entries(PROFILES ?? {})) {
    const signedIn = process.env.FAKE_ASIDE_SIGNED_IN?.split(',').includes(u)
    process.stdout.write(`${u === CURRENT ? '*' : ' '} ${u}  ${signedIn ? `${u}@example.com` : 'Local Account'}  ${signedIn ? 'signed in' : 'signed out'}  profiles: ${ps.length ? ps.map((p) => p.label).join(', ') : 'none'}\n`)
    if (signedIn) process.stdout.write('  provider: google\n')
  }
  process.exit(0)
}
if (process.argv[2] === 'account' && process.argv[3] === 'list') {
  const generated = PROFILES && { currentAccountId: Number(CURRENT.slice(1)), accounts: Object.entries(PROFILES).map(([u, ps]) => ({ id: Number(u.slice(1)), hasSession: isSignedIn(u), profileBindings: ps.map((p) => ({ profileId: p.profileId })) })) }
  process.stdout.write(process.env.FAKE_ASIDE_ACCOUNTS ?? JSON.stringify(generated ?? { accounts: [] }))
  process.exit(0)
}
if (process.argv[2] === 'host' && process.argv[3] === 'profiles') {
  if (process.env.FAKE_ASIDE_OLD_CLI || !PROFILES?.[account]) { process.stderr.write(`Error: Account not found: ${account}\n`); process.exit(1) }
  process.stdout.write(JSON.stringify({ host: 'local', profiles: PROFILES[account]!.map((p) => ({ ...p, connected: true })) }))
  process.exit(0)
}
const good = process.env.FAKE_ASIDE_GOOD
const signedIn = PROFILES ? !!PROFILES[account]?.length : !!good && account === good
let sessions = 0
const otherProfile = (id: unknown, pid: string) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Browser profile "${pid}" is not available for account ${account}. Run 'aside host profiles' (with the same --host) to see profile ids.` }], isError: true } })
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
// like Aside 1.26: repl and exec take an optional profile_id with Aside's own words
const PROFILE_ID = { type: 'string', minLength: 1, description: 'Browser profile ID from browser_profiles. Omit to reuse the selected profile or --profile default.' }
const PROFILE_TOOLS = [
  { name: 'repl', description: 'Run Playwright-style JavaScript in Aside Browser.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, code: { type: 'string' }, profile_id: PROFILE_ID }, required: ['title', 'code'] } },
  { name: 'exec', description: 'Run the browser agent on logged-in sites.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, session_id: { type: 'string' }, profile_id: PROFILE_ID }, required: ['prompt'] } },
]
process.stderr.write('fake mcp started\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m: any
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && !m.method) { pending.get(String(m.id))?.(m); return }
  if (m.method === 'initialize') { inits++; send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }); return }
  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: PROFILES ? [...TOOLS, { name: 'browser_profiles', description: "List browser profile IDs, labels, and connection status for this MCP server's host and account.", inputSchema: { type: 'object', properties: {} } }, ...PROFILE_TOOLS] : TOOLS } }); return }
  if (m.method !== 'tools/call') { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }); return }
  const a = m.params?.arguments ?? {}
  switch (m.params?.name) {
    case 'echo': return text(m.id, `echo: ${a.text ?? ''}`)
    case 'argv': return text(m.id, JSON.stringify(process.argv.slice(2)))
    case 'env': return text(m.id, `value: ${process.env[String(a.name)] ?? '(none)'}`)
    case 'inits': return text(m.id, String(inits))
    case 'browser_profiles': return text(m.id, JSON.stringify({ profiles: PROFILES ? (PROFILES[account] ?? []).map((p) => ({ ...p, connected: true })) : signedIn ? [{ profileId: 'p1', label: 'Work', connected: true }] : [] }))
    case 'exec': {
      if (a.session_id) return String(a.session_id).startsWith(`s-${account}-`) ? text(m.id, `continued ${a.session_id} as ${account}`) : send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Session ${a.session_id} not found` }], isError: true } })
      if (a.profile_id && PROFILES && !PROFILES[account]?.some((p) => p.profileId === a.profile_id)) return otherProfile(m.id, String(a.profile_id))
      if (process.env.FAKE_ASIDE_EXEC_SIGN_IN && !isSignedIn(account)) return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Sign in again before using built-in Aside models.' }], isError: true } })
      return text(m.id, JSON.stringify({ session_id: `s-${account}-${++sessions}`, status: 'done' }))
    }
    case 'repl':
      if (a.profile_id && PROFILES && !PROFILES[account]?.some((p) => p.profileId === a.profile_id)) return otherProfile(m.id, String(a.profile_id))
      return signedIn ? text(m.id, `ok as ${account}${a.profile_id ? ` in ${a.profile_id}` : ''}`) : send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Aside Browser is running, but none of its profiles use account ${account}.${good ? ` Rerun with --account ${good}.` : ''}` }], isError: true } })
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
