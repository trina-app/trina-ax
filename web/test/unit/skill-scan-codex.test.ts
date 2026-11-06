// 내 스킬 가져오기 with Codex (web/src/lib/skillScan.ts, web/src/lib/codexToml.ts; docs/DECISIONS.md "W5"):
// - a picked .codex: skills/*/ like Claude's (.system, Codex's own built-in skills, never read), prompts/*.md like
//   commands, AGENTS.override.md before AGENTS.md as the rule (secret lines cut), config.toml's remote https MCP
//   servers as tools with no key, header value, token variable name or env value anywhere in the body; stdio, http
//   and ?token= addresses left out; only the known names opened, the folder itself never listed;
// - a project folder holding .codex; a .agents folder; the body says app "codex" and passes the contract;
// - hostile TOML never throws or hangs and gives only safe tools.
import { describe, expect, test } from 'bun:test'
import { CreateSkillShare, SKILL_SHARE_LIMITS } from '@mycel/shared/api'
import { fromHandle, scanFolder, type DirectoryHandleLike } from '../../src/lib/skillScan'
import { CODEX_TOML_MAX_BYTES, codexTools, shareableUrl } from '../../src/lib/codexToml'

type Node = { [name: string]: Node | string }
const isDir = (v: Node[string]): v is Node => typeof v === 'object'
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' })

/** A fake FileSystemDirectoryHandle; every call goes into `log` ("list a", "dir a/b", "file a/b", "read a/b"). */
function handle(name: string, tree: Node, log: string[], at = name): DirectoryHandleLike {
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(n) {
      log.push(`dir ${at}/${n}`)
      const v = tree[n]
      if (v !== undefined && isDir(v)) return handle(n, v, log, `${at}/${n}`)
      throw notFound()
    },
    async getFileHandle(n) {
      log.push(`file ${at}/${n}`)
      const v = tree[n]
      if (v === undefined || isDir(v)) throw notFound()
      return { name: n, getFile: async () => { log.push(`read ${at}/${n}`); return new File([v], n) } }
    },
    async *entries() {
      log.push(`list ${at}`)
      for (const [k, v] of Object.entries(tree)) yield [k, { kind: isDir(v) ? 'directory' : 'file' }] as [string, { kind: 'file' | 'directory' }]
    },
  }
}

const skillMd = (name: string, body = '회의록을 읽고 할 일을 정리해요.') => `---\nname: ${name}\ndescription: ${name} — ${body}\n---\n# ${name}\n${body}\n`
// fake keys, obviously not real, that still match shared/src/secrets.ts
const SLACK = 'xoxb-0000000000-FAKE-NOT-REAL'
const OPENAI = 'sk-FAKE0000notreal0000KEY1234'
// values in config.toml that must never leave the browser
const HEADER_VALUE = 'hv-SECRET-header-value-123'
const ENV_VALUE = 'ev-SECRET-env-value-456'
const TOKEN_VAR = 'ACME_MCP_TOKEN_VAR'

const CONFIG = [
  'model = "gpt-5"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.acme-docs]',
  'url = "https://mcp.acme.example/mcp"',
  `bearer_token_env_var = "${TOKEN_VAR}"`,
  'startup_timeout_sec = 20',
  `http_headers = { "X-Team" = "${HEADER_VALUE}" }`,
  '',
  '[mcp_servers."crm tools"]',
  'url = \'https://crm.example.com/mcp\'',
  '[mcp_servers."crm tools".env_http_headers]',
  'X-Api-Key = "CRM_KEY"',
  '',
  '[mcp_servers.notes]',
  'url = "https://notes.example.com/mcp"  # OAuth by default',
  'enabled_tools = ["search", "read"]',
  '',
  '[mcp_servers.local-files]',
  'command = "npx"',
  'args = ["-y", "@acme/files-mcp"]',
  `env = { FILES_TOKEN = "${ENV_VALUE}" }`,
  '',
  '[mcp_servers.plain-http]',
  'url = "http://insecure.example.com/mcp"',
  '',
  '[mcp_servers.query-key]',
  `url = "https://q.example.com/mcp?token=${ENV_VALUE}"`,
  '',
  '[mcp_servers.off]',
  'url = "https://off.example.com/mcp"',
  'enabled = false',
  '',
  '[profiles.work]',
  'model = "o3"',
  '',
].join('\n')

const codexFolder = (): Node => ({
  'auth.json': `{"OPENAI_API_KEY":"${OPENAI}"}`,
  'history.jsonl': '{"never":"read"}\n',
  sessions: { '2026': { 'rollout.jsonl': '{"never":"read"}' } },
  log: { 'codex-tui.log': 'never' },
  'config.toml': CONFIG,
  'AGENTS.md': '- the plain one, never used when an override is there\n',
  'AGENTS.override.md': `# 일하는 방식\n- 결론부터 써요\nSLACK_TOKEN=${SLACK}\n- 표로 정리해요\n`,
  skills: {
    '.system': { 'skill-creator': { 'SKILL.md': skillMd('skill-creator') }, 'skill-installer': { 'SKILL.md': skillMd('skill-installer') } },
    'meeting-notes': { 'SKILL.md': skillMd('meeting-notes'), references: { '양식.md': '# 양식\n' }, agents: { 'openai.yaml': 'display_name: Meeting notes\n' }, scripts: { 'run.py': 'print("never read")' } },
    'deploy-helper': { 'SKILL.md': skillMd('deploy-helper'), refs: { 'env.md': `OPENAI_API_KEY=${OPENAI}\n` } },
  },
  prompts: { 'standup.md': '---\ndescription: 스탠드업\n---\n어제 한 일, 오늘 할 일', 'leaky.md': `curl -H "Authorization: Bearer ${OPENAI}"`, nested: { 'x.md': 'not read' } },
})

const NEVER = ['auth.json', 'history.jsonl', 'sessions', '/log', '.system', 'nested']

describe('a picked .codex folder', () => {
  test('skills, prompts as commands, AGENTS.override.md as the rule, remote servers as tools; app codex; the contract', async () => {
    const log: string[] = []
    const r = await scanFolder(fromHandle(handle('.codex', codexFolder(), log)), 'browser')
    expect(r.kind).toBe('codex')
    const body = CreateSkillShare.parse(r.body)
    expect(body.source).toBe('browser')
    expect(body.app).toBe('codex')
    expect(body.where).toBe('.codex')
    expect(body.skills.map((s) => [s.name, s.origin])).toEqual([['meeting-notes', 'user'], ['standup', 'command']])
    const notes = body.skills[0]!
    expect(notes.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'agents/openai.yaml', 'references/양식.md', 'scripts/run.py'])
    expect(notes.files.find((f) => f.path === 'scripts/run.py')).toEqual({ path: 'scripts/run.py', text: '' })
    expect(body.excluded).toEqual([
      { name: 'deploy-helper', origin: 'user', reason: 'secret', kind: 'named-key' },
      { name: 'leaky', origin: 'command', reason: 'secret', kind: 'bearer' },
    ].map((e) => expect.objectContaining({ name: e.name, origin: e.origin, reason: e.reason })))
    expect(body.rule).toEqual({ text: '# 일하는 방식\n- 결론부터 써요\n- 표로 정리해요\n' })
    expect(body.tools).toEqual([
      { name: 'acme-docs', url: 'https://mcp.acme.example/mcp', auth: 'bearer' },
      { name: 'crm tools', url: 'https://crm.example.com/mcp', auth: 'header', header: 'X-Api-Key' },
      { name: 'notes', url: 'https://notes.example.com/mcp', auth: 'oauth' },
    ])
  })

  test('nothing of a secret goes up: no key, header value, token variable name or env value', async () => {
    const r = await scanFolder(fromHandle(handle('.codex', codexFolder(), [])), 'browser')
    const sent = JSON.stringify(r.body)
    for (const v of [SLACK, OPENAI, HEADER_VALUE, ENV_VALUE, TOKEN_VAR, 'CRM_KEY', 'X-Team', 'insecure.example.com', 'q.example.com', 'off.example.com', 'local-files', 'npx', 'skill-creator', 'never read']) {
      expect({ v, in: sent.includes(v) }).toEqual({ v, in: false })
    }
  })

  test('only the known names are opened; the folder itself, .system, sessions, auth.json and history are never touched', async () => {
    const log: string[] = []
    await scanFolder(fromHandle(handle('.codex', codexFolder(), log)), 'desktop')
    expect(log).not.toContain('list .codex')
    for (const n of NEVER) expect({ n, touched: log.filter((l) => l.includes(n)) }).toEqual({ n, touched: [] })
    expect(log.filter((l) => l.startsWith('read')).sort()).toEqual([
      'read .codex/AGENTS.override.md', 'read .codex/config.toml', 'read .codex/prompts/leaky.md', 'read .codex/prompts/standup.md',
      'read .codex/skills/deploy-helper/SKILL.md', 'read .codex/skills/deploy-helper/refs/env.md',
      'read .codex/skills/meeting-notes/SKILL.md', 'read .codex/skills/meeting-notes/agents/openai.yaml', 'read .codex/skills/meeting-notes/references/양식.md',
    ])
  })

  test('AGENTS.md when there is no override; a .codex with only a config.toml still sends its tools', async () => {
    const plain = await scanFolder(fromHandle(handle('.codex', { 'AGENTS.md': '- 결론부터\n' }, [])), 'browser')
    expect(plain.body).toEqual({ source: 'browser', app: 'codex', where: '.codex', skills: [], rule: { text: '- 결론부터\n' } })
    const onlyTools = await scanFolder(fromHandle(handle('.codex', { 'config.toml': '[mcp_servers.a]\nurl = "https://a.example.com/mcp"\n' }, [])), 'browser')
    expect(onlyTools.body?.tools).toEqual([{ name: 'a', url: 'https://a.example.com/mcp', auth: 'oauth' }])
    const empty = await scanFolder(fromHandle(handle('.codex', { 'config.toml': 'model = "x"\n', sessions: {} }, [])), 'browser')
    expect(empty).toEqual({ kind: 'codex', body: null, cut: 0 })
  })

  test('a project folder holding .codex and .agents (no .claude): both, as Codex', async () => {
    const r = await scanFolder(fromHandle(handle('acme-web', {
      src: { 'a.ts': 'never' },
      'AGENTS.md': '- the repo root file is not read from a picked project folder\n',
      '.codex': { skills: { review: { 'SKILL.md': skillMd('review') } } },
      '.agents': { skills: { triage: { 'SKILL.md': skillMd('triage') } } },
    }, [])), 'browser')
    expect(r.kind).toBe('codex')
    expect(r.body!.app).toBe('codex')
    expect(r.body!.skills.map((s) => s.name)).toEqual(['review', 'triage'])
    expect(r.body!.rule).toBeUndefined()
    // a project folder with .claude stays Claude's
    const claude = await scanFolder(fromHandle(handle('acme-web', { '.claude': { skills: { x: { 'SKILL.md': skillMd('x') } } }, '.codex': { skills: { y: { 'SKILL.md': skillMd('y') } } } }, [])), 'browser')
    expect(claude.kind).toBe('claude')
    expect(claude.body!.app).toBeUndefined()
    expect(claude.body!.skills.map((s) => s.name)).toEqual(['x'])
  })

  test('a picked .agents folder: its skills (a hidden folder in it left alone)', async () => {
    const log: string[] = []
    const r = await scanFolder(fromHandle(handle('.agents', { skills: { 'weekly-report': { 'SKILL.md': skillMd('weekly-report') }, '.cache': { 'x': { 'SKILL.md': 'never' } } }, 'notes.md': 'never' }, log)), 'browser')
    expect(r.kind).toBe('agents')
    expect(CreateSkillShare.parse(r.body)).toEqual({ source: 'browser', app: 'codex', where: '.agents', skills: [{ name: 'weekly-report', origin: 'user', files: [{ path: 'SKILL.md', text: skillMd('weekly-report') }] }] })
    expect(log.filter((l) => l.includes('.cache') || l.includes('notes.md'))).toEqual([])
  })
})

describe('config.toml (lib/codexToml.ts)', () => {
  test('inline and sub-table headers, quoted names, literal strings, escapes, CRLF and a BOM', () => {
    const toml = '\ufeff# Codex\r\n[mcp_servers]\r\ninline = { url = "https://inline.example.com/mcp", http_headers = { "Authorization" = "Bearer x" } }\r\n'
      + '[mcp_servers.\'lit name\']\r\nurl = "https://lit.example.com/\\u006dcp"\r\n'
      + '[mcp_servers.dotted]\r\nurl = "https://dotted.example.com/mcp"\r\nhttp_headers.X-Org = "acme"\r\n'
      + '[mcp_servers.helper]\r\nurl = "https://helper.example.com/mcp"\r\nhttp_headers_helper = ["acme-auth", "--print"]\r\n'
    expect(codexTools(toml)).toEqual([
      { name: 'inline', url: 'https://inline.example.com/mcp', auth: 'bearer' },
      { name: 'lit name', url: 'https://lit.example.com/mcp', auth: 'oauth' },
      { name: 'dotted', url: 'https://dotted.example.com/mcp', auth: 'header', header: 'X-Org' },
      { name: 'helper', url: 'https://helper.example.com/mcp', auth: 'bearer' },
    ])
  })

  test('addresses that cannot be a template: http, a user, a query, a fragment, a key in it', () => {
    for (const u of ['http://a.example.com/mcp', 'https://user:pw@a.example.com/mcp', 'https://a.example.com/mcp?x=1', 'https://a.example.com/mcp?', 'https://a.example.com/mcp#x',
      `https://a.example.com/${OPENAI}/mcp`, 'ftp://a.example.com/', 'not a url', '']) expect({ u, ok: shareableUrl(u) }).toEqual({ u, ok: null })
    expect(shareableUrl(' https://A.example.com/mcp ')).toBe('https://a.example.com/mcp')
  })

  test('each name once, at most SKILL_SHARE_LIMITS.tools; a name holding a key or a line break is left out', () => {
    let toml = ''
    for (let i = 0; i < 40; i++) toml += `[mcp_servers.s${i}]\nurl = "https://s${i}.example.com/mcp"\n`
    toml += `[mcp_servers.S0]\nurl = "https://again.example.com/mcp"\n`
    expect(codexTools(toml)).toHaveLength(SKILL_SHARE_LIMITS.tools)
    expect(codexTools('[mcp_servers.a]\nurl = "https://a.example.com/mcp"\n[mcp_servers.A]\nurl = "https://b.example.com/mcp"\n').map((t) => t.url)).toEqual(['https://a.example.com/mcp'])
    expect(codexTools(`[mcp_servers."${OPENAI}"]\nurl = "https://k.example.com/mcp"\n[mcp_servers."two\\nlines"]\nurl = "https://l.example.com/mcp"\n`)).toEqual([])
  })

  describe('hostile input never throws or hangs and gives only safe tools', () => {
    const safe = (tools: ReturnType<typeof codexTools>) => {
      for (const t of tools) {
        expect(shareableUrl(t.url)).toBe(t.url)
        expect(Object.keys(t).every((k) => ['name', 'url', 'auth', 'header'].includes(k))).toBe(true)
      }
      return tools
    }
    test('an unterminated string drops its server; the next table is still read', () => {
      expect(safe(codexTools('[mcp_servers.a]\nurl = "https://a.example.com/mcp\n[mcp_servers.b]\nurl = "https://b.example.com/mcp"\n')).map((t) => t.name)).toEqual(['b'])
      expect(safe(codexTools("[mcp_servers.a]\nurl = 'https://a.example.com\n"))).toEqual([])
    })
    test('an unterminated multi-line string ends the reading: a table inside it is never taken', () => {
      const toml = '[mcp_servers.a]\nurl = "https://a.example.com/mcp"\nnote = """\n[mcp_servers.evil]\nurl = "https://evil.example.com/mcp"\n'
      expect(safe(codexTools(toml))).toEqual([])
      const closed = '[mcp_servers.a]\nurl = "https://a.example.com/mcp"\nnote = """\n[mcp_servers.evil]\nurl = "https://evil.example.com/mcp"\n"""\n'
      expect(safe(codexTools(closed)).map((t) => t.name)).toEqual(['a'])
    })
    test('ten thousand tables, a 1 MB line, deep brackets, unclosed brackets', () => {
      let many = ''
      for (let i = 0; i < 10_000; i++) many += `[mcp_servers.t${i}]\nurl = "https://t${i}.example.com/mcp"\n`
      const t0 = Date.now()
      expect(safe(codexTools(many))).toHaveLength(SKILL_SHARE_LIMITS.tools)
      expect(safe(codexTools(`x = "${'a'.repeat(1024 * 1024)}"\n[mcp_servers.after]\nurl = "https://after.example.com/mcp"\n`))).toEqual([])
      expect(safe(codexTools(`[mcp_servers.a]\nurl = "https://a.example.com/mcp"\nargs = ${'['.repeat(50_000)}\n[mcp_servers.b]\nurl = "https://b.example.com/mcp"\n`)).map((t) => t.name)).toEqual(['b'])
      expect(safe(codexTools(`${'['.repeat(60_000)}\n[mcp_servers.c]\nurl = "https://c.example.com/mcp"\n`)).map((t) => t.name)).toEqual(['c'])
      expect(safe(codexTools('[mcp_servers.d]\nurl = "https://d.example.com/mcp"\nheaders = { a = "b"\n[mcp_servers.e]\nurl = "https://e.example.com/mcp"\n')).map((t) => t.name)).toEqual(['e'])
      expect(Date.now() - t0).toBeLessThan(5000)
    })
    test('__proto__, constructor and prototype as names and keys pollute nothing', () => {
      const toml = '[mcp_servers.__proto__]\nurl = "https://p.example.com/mcp"\n[mcp_servers.constructor]\nurl = "https://c.example.com/mcp"\nhttp_headers = { __proto__ = "x", constructor = "y" }\n[__proto__.polluted]\nurl = "https://x.example.com/mcp"\n'
      const tools = safe(codexTools(toml))
      // a header name is only a name ("__proto__" is not one: no underscore in a header name)
      expect(tools.map((t) => [t.name, t.auth, t.header])).toEqual([['__proto__', 'oauth', undefined], ['constructor', 'header', 'constructor']])
      expect(({} as Record<string, unknown>).url).toBeUndefined()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
    test('a url that is not a string, a duplicated key, garbage after a value, nonsense bytes', () => {
      expect(safe(codexTools('[mcp_servers.a]\nurl = ["https://a.example.com/mcp"]\n[mcp_servers.b]\nurl = "https://b.example.com/mcp" "junk"\n[mcp_servers.c]\nurl = "https://c.example.com/mcp"\nurl = "https://d.example.com/mcp"\n')).map((t) => [t.name, t.url])).toEqual([['c', 'https://c.example.com/mcp']])
      const junk = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode((i * 7919) % 0x2fff)).join('')
      expect(() => safe(codexTools(junk))).not.toThrow()
      expect(() => codexTools('\u0000\uffff"""\'\'\'[[]]{}==\\\\')).not.toThrow()
    })
    test('only the first CODEX_TOML_MAX_BYTES are read', () => {
      const pad = `# ${'x'.repeat(CODEX_TOML_MAX_BYTES)}\n`
      expect(codexTools(`${pad}[mcp_servers.late]\nurl = "https://late.example.com/mcp"\n`)).toEqual([])
    })
  })
})
