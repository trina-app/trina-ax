// 내 스킬 가져오기: the walker and its filter (web/src/lib/skillScan.ts), against fake folders that record every call.
// - in a picked .claude only the known paths are opened: projects/, todos/, history.jsonl, .credentials.json and
//   settings.json are there and never touched, and the folder itself is never listed;
// - a secret anywhere in a skill (a nested file, a key file's name) sends its name and kind only; CLAUDE.md goes
//   without its secret lines; a plugin's skill goes as its name; a script file as its path with no text; too many
//   files, a file over 128 KB or a skill over 1 MB: the name only (too_big);
// - a picked skills/ folder or one skill folder; the <input webkitdirectory> list (only the known paths read, "../"
//   paths dropped); a dropped folder; what goes up always passes the contract (CreateSkillShare).
import { describe, expect, test } from 'bun:test'
import { CreateSkillShare, SKILL_SHARE_LIMITS } from '@mycel/shared/api'
import { droppedFolder, fromFiles, fromHandle, ruleText, scanFolder, secretFileKind, type DirectoryEntryLike, type DirectoryHandleLike, type FileEntryLike } from '../../src/lib/skillScan'

type Node = { [name: string]: Node | string | Uint8Array<ArrayBuffer> }
const isDir = (v: Node[string]): v is Node => typeof v === 'object' && !(v instanceof Uint8Array)
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' })

/** A fake FileSystemDirectoryHandle over a tree; every call goes into `log` ("list a/b", "dir a/b", "file a/b",
 * "read a/b"). */
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

const skillMd = (name: string, body = '팀 노트를 읽고 정리해요.') => `---\nname: ${name}\ndescription: ${name} — ${body}\n---\n# ${name}\n${body}\n`
// fake keys, obviously not real, that still match shared/src/secrets.ts
const SLACK = 'xoxb-0000000000-FAKE-NOT-REAL'
const OPENAI = 'sk-FAKE0000notreal0000KEY1234'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const claudeFolder = (): Node => ({
  'CLAUDE.md': `# 일하는 방식\n- 보고서는 결론부터 써요\nOPENAI_API_KEY=${OPENAI}\n- 숫자는 표로 정리해요\n-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END OPENSSH PRIVATE KEY-----\n- 모르면 물어봐요\n`,
  '.credentials.json': '{"claudeAiOauth":{"accessToken":"never-read"}}',
  'history.jsonl': '{"display":"never read"}\n',
  'settings.json': '{"env":{}}',
  projects: { '-Users-x-work': { 'session.jsonl': '{"never":"read"}' } },
  todos: { 'a.json': '[]' },
  'shell-snapshots': { 'snap.sh': 'export X=1' },
  skills: {
    'weekly-report': {
      'SKILL.md': skillMd('weekly-report'),
      templates: { '보고 양식.md': '# 양식\n- 이번 주\n- 다음 주\n', deep: { a: { b: { 'too-deep.md': 'below three folders' } } } },
      scripts: { 'fetch.py': 'print("never read")' },
      'logo.png': PNG,
      'archive.zip': new Uint8Array([1, 2, 3]),
      '.DS_Store': 'x',
      node_modules: { left: { 'index.js': 'never' } },
    },
    'slack-notify': { 'SKILL.md': skillMd('slack-notify'), refs: { 'config.md': `token: ${SLACK}\n` } },
    'env-skill': { 'SKILL.md': skillMd('env-skill'), '.env': `KEY=${OPENAI}` },
    notes: { 'readme.md': 'no SKILL.md here' },
  },
  commands: { 'standup.md': '# 스탠드업\n어제 한 일, 오늘 할 일', 'secret.md': `curl -H "Authorization: Bearer ${OPENAI}"`, nested: { 'x.md': 'not read' } },
  plugins: {
    'installed_plugins.json': '{"never":"read"}',
    marketplaces: { acme: { plugins: { design: { skills: { 'frontend-design': { 'SKILL.md': 'never read', 'big.md': 'never read' } } } } } },
    cache: { acme: { design: { '1.0.0': { skills: { 'frontend-design': { 'SKILL.md': 'never read' }, 'brand-voice': { 'SKILL.md': 'never read' } } } } } },
  },
})

const NEVER = ['projects', 'todos', 'history.jsonl', '.credentials.json', 'settings.json', 'shell-snapshots', 'installed_plugins.json', 'node_modules', 'nested']

describe('a picked .claude folder', () => {
  test('only the known paths are opened; the folder itself is never listed; what goes up passes the contract', async () => {
    const log: string[] = []
    const r = await scanFolder(fromHandle(handle('.claude', claudeFolder(), log)), 'browser')
    expect(r.kind).toBe('claude')
    const body = CreateSkillShare.parse(r.body)
    expect(body.source).toBe('browser')
    expect(body.where).toBe('.claude')
    // never opened, read or listed
    for (const n of NEVER) expect({ n, touched: log.filter((l) => l.includes(n)) }).toEqual({ n, touched: [] })
    expect(log).not.toContain('list .claude')
    // plugins: folders listed to find skills/, nothing in them read
    expect(log.filter((l) => l.startsWith('read') && l.includes('/plugins/'))).toEqual([])
    expect(log.filter((l) => l.startsWith('read')).sort()).toEqual([
      'read .claude/CLAUDE.md', 'read .claude/commands/secret.md', 'read .claude/commands/standup.md',
      'read .claude/skills/slack-notify/SKILL.md', 'read .claude/skills/slack-notify/refs/config.md',
      'read .claude/skills/weekly-report/SKILL.md', 'read .claude/skills/weekly-report/logo.png', 'read .claude/skills/weekly-report/templates/보고 양식.md',
    ])
  })

  test('the files of a skill: text as text, an image as base64, a script as its path with no text, the rest left out', async () => {
    const r = await scanFolder(fromHandle(handle('.claude', claudeFolder(), [])), 'browser')
    const weekly = r.body!.skills.find((s) => s.name === 'weekly-report')!
    expect(weekly.origin).toBe('user')
    const files = Object.fromEntries(weekly.files.map((f) => [f.path, f]))
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'logo.png', 'scripts/fetch.py', 'templates/보고 양식.md'])
    expect(files['SKILL.md']!.text).toContain('name: weekly-report')
    expect(files['scripts/fetch.py']).toEqual({ path: 'scripts/fetch.py', text: '' })
    expect(Buffer.from(files['logo.png']!.base64!, 'base64')).toEqual(Buffer.from(PNG))
  })

  test('a secret in a nested file or a key file\'s name: only the name and the kind go; a folder without SKILL.md: not_skill', async () => {
    const r = await scanFolder(fromHandle(handle('.claude', claudeFolder(), [])), 'browser')
    const body = r.body!
    expect(body.skills.map((s) => s.name).sort()).toEqual(['standup', 'weekly-report'])
    const ex = Object.fromEntries((body.excluded ?? []).map((e) => [e.name, e]))
    expect(ex['slack-notify']).toEqual({ name: 'slack-notify', origin: 'user', reason: 'secret', kind: 'slack' })
    expect(ex['env-skill']).toEqual({ name: 'env-skill', origin: 'user', reason: 'secret', kind: 'env' })
    expect(ex.notes).toEqual({ name: 'notes', reason: 'not_skill' })
    expect(ex.secret).toEqual({ name: 'secret', origin: 'command', reason: 'secret', kind: 'bearer' })
    // nothing of a secret goes anywhere in the body
    const sent = JSON.stringify(body)
    expect(sent).not.toContain(SLACK)
    expect(sent).not.toContain(OPENAI)
    expect(sent).not.toContain('FAKEFAKEFAKE')
  })

  test('plugin skills: the name once, as excluded plugin; a command: its own file, origin command', async () => {
    const r = await scanFolder(fromHandle(handle('.claude', claudeFolder(), [])), 'browser')
    expect((r.body!.excluded ?? []).filter((e) => e.reason === 'plugin')).toEqual([
      { name: 'frontend-design', origin: 'plugin', reason: 'plugin' },
      { name: 'brand-voice', origin: 'plugin', reason: 'plugin' },
    ])
    expect(r.body!.skills.find((s) => s.name === 'standup')).toEqual({ name: 'standup', origin: 'command', files: [{ path: 'standup.md', text: '# 스탠드업\n어제 한 일, 오늘 할 일' }] })
  })

  test('CLAUDE.md goes without every line a secret touches (a key block over several lines too)', async () => {
    const r = await scanFolder(fromHandle(handle('.claude', claudeFolder(), [])), 'browser')
    expect(r.body!.rule).toEqual({ text: '# 일하는 방식\n- 보고서는 결론부터 써요\n- 숫자는 표로 정리해요\n- 모르면 물어봐요\n' })
    expect(await ruleText(new Blob([`API_KEY=${OPENAI}\n`]))).toBeNull()
  })

  test('too big: more than 30 files, a file over 128 KB, a skill over 1 MB: the name only', async () => {
    const many: Node = { 'SKILL.md': skillMd('many') }
    for (let i = 0; i < SKILL_SHARE_LIMITS.skillFiles; i++) many[`note-${i}.md`] = `note ${i}`
    const heavy: Node = { 'SKILL.md': skillMd('heavy') }
    for (let i = 0; i < 9; i++) heavy[`part-${i}.md`] = 'a '.repeat(60 * 1024)
    const log: string[] = []
    const r = await scanFolder(fromHandle(handle('.claude', {
      skills: {
        many,
        big: { 'SKILL.md': skillMd('big'), 'data.csv': 'x'.repeat(129 * 1024), 'after.md': 'not read' },
        heavy,
        fine: { 'SKILL.md': skillMd('fine'), 'notes.md': 'x'.repeat(100 * 1024) },
      },
    }, log)), 'browser')
    expect(r.body!.skills.map((s) => s.name)).toEqual(['fine'])
    expect(r.body!.excluded).toEqual([
      { name: 'many', origin: 'user', reason: 'too_big' },
      { name: 'big', origin: 'user', reason: 'too_big' },
      { name: 'heavy', origin: 'user', reason: 'too_big' },
    ])
    // the big file's size is known without reading it
    expect(log.filter((l) => l.startsWith('read .claude/skills/big/data.csv'))).toEqual(['read .claude/skills/big/data.csv'])
    expect(JSON.stringify(r.body)).not.toContain('x'.repeat(129 * 1024))
  })

  test('at most 200 skills from a folder; the rest are counted, not read', async () => {
    const skills: Node = {}
    for (let i = 0; i <= SKILL_SHARE_LIMITS.skills; i++) skills[`s-${String(i).padStart(3, '0')}`] = { 'SKILL.md': skillMd(`s-${i}`) }
    const r = await scanFolder(fromHandle(handle('.claude', { skills }, [])), 'desktop')
    expect(r.body!.skills).toHaveLength(SKILL_SHARE_LIMITS.skills)
    expect(r.body!.source).toBe('desktop')
    expect(r.cut).toBe(1)
  })
})

describe('other folders', () => {
  test('a picked skills/ folder: each skill folder in it', async () => {
    const log: string[] = []
    const r = await scanFolder(fromHandle(handle('skills', { a: { 'SKILL.md': skillMd('a') }, b: { 'SKILL.md': skillMd('b') }, 'loose.md': 'not a skill' }, log)), 'browser')
    expect(r.kind).toBe('skills')
    expect(r.body!.where).toBe('.claude/skills')
    expect(r.body!.skills.map((s) => s.name)).toEqual(['a', 'b'])
    expect(log).not.toContain('read skills/loose.md')
  })

  test('one skill folder: that one, named after it', async () => {
    const r = await scanFolder(fromHandle(handle('quote-draft', { 'SKILL.md': skillMd('quote-draft'), 'form.md': '양식' }, [])), 'browser')
    expect(r.kind).toBe('skill')
    expect(r.body).toEqual({ source: 'browser', where: 'quote-draft', skills: [{ name: 'quote-draft', origin: 'user', files: [{ path: 'SKILL.md', text: skillMd('quote-draft') }, { path: 'form.md', text: '양식' }] }] })
  })

  test('a folder with no skills: nothing to send, the wrong folder; a project folder with its .claude in it works', async () => {
    const empty = await scanFolder(fromHandle(handle('Documents', { 'a.md': 'x', photos: { 'b.png': PNG } }, [])), 'browser')
    expect(empty).toEqual({ kind: 'none', body: null, cut: 0 })
    const project = await scanFolder(fromHandle(handle('acme-web', { '.claude': { skills: { x: { 'SKILL.md': skillMd('x') } } }, src: { 'a.ts': 'x' } }, [])), 'browser')
    expect(project.kind).toBe('claude')
    expect(project.body!.skills.map((s) => s.name)).toEqual(['x'])
  })

  test('names with "..", a slash or a backslash are never part of a path', async () => {
    const r = await scanFolder(fromHandle(handle('skills', { ok: { 'SKILL.md': skillMd('ok'), '..': { 'x.md': 'escape' }, 'a\\b.md': 'back', '.': { 'y.md': 'dot' } } }, [])), 'browser')
    expect(r.body!.skills[0]!.files.map((f) => f.path)).toEqual(['SKILL.md'])
    expect(() => CreateSkillShare.parse(r.body)).not.toThrow()
  })

  test('secret file names', () => {
    for (const n of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.netrc', 'credentials.json', '.credentials.json', 'cert.p12']) expect({ n, k: secretFileKind(n) !== null }).toEqual({ n, k: true })
    for (const n of ['SKILL.md', 'environment.md', 'keynote.md', 'notes.txt']) expect({ n, k: secretFileKind(n) }).toEqual({ n, k: null })
  })
})

describe('the <input webkitdirectory> list (Safari, Firefox, the desktop app)', () => {
  /** a File as the picker gives it, with its path, recording every read */
  const picked = (path: string, content: string | Uint8Array<ArrayBuffer>, reads: string[]) => {
    const f = new File([content], path.split('/').pop()!)
    Object.defineProperty(f, 'webkitRelativePath', { value: path })
    for (const m of ['text', 'arrayBuffer', 'slice', 'stream', 'bytes'] as const) {
      const orig = (f as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(f)
      Object.defineProperty(f, m, { value: (...a: unknown[]) => { reads.push(path); return orig(...a) } })
    }
    return f
  }
  test('every file of .claude is listed by the browser; only the known paths are read; ".." paths are dropped', async () => {
    const reads: string[] = []
    const files = [
      picked('.claude/.credentials.json', '{"accessToken":"never-read"}', reads),
      picked('.claude/history.jsonl', 'never', reads),
      picked('.claude/projects/-Users-x/abc.jsonl', 'never', reads),
      picked('.claude/settings.json', '{}', reads),
      picked('.claude/CLAUDE.md', '- 결론부터 써요\n', reads),
      picked('.claude/skills/weekly/SKILL.md', skillMd('weekly'), reads),
      picked('.claude/skills/weekly/run.sh', 'echo never', reads),
      picked('.claude/skills/../escape/SKILL.md', skillMd('escape'), reads),
      picked('.claude/skills//empty/SKILL.md', skillMd('empty'), reads),
    ]
    const r = await scanFolder(fromFiles(files)!, 'desktop')
    expect(r.kind).toBe('claude')
    expect(CreateSkillShare.parse(r.body)).toEqual({ source: 'desktop', where: '.claude', skills: [{ name: 'weekly', origin: 'user', files: [{ path: 'SKILL.md', text: skillMd('weekly') }, { path: 'run.sh', text: '' }] }], rule: { text: '- 결론부터 써요\n' } })
    expect([...new Set(reads)].sort()).toEqual(['.claude/CLAUDE.md', '.claude/skills/weekly/SKILL.md'])
  })
  test('the .claude/skills folder (the Safari hint asks for it)', async () => {
    const r = await scanFolder(fromFiles([picked('skills/a/SKILL.md', skillMd('a'), []), picked('skills/b/SKILL.md', skillMd('b'), [])])!, 'browser')
    expect(r.kind).toBe('skills')
    expect(r.body!.where).toBe('.claude/skills')
    expect(r.body!.skills.map((s) => s.name)).toEqual(['a', 'b'])
    expect(fromFiles([])).toBeNull()
  })
})

describe('a dropped folder (webkitGetAsEntry)', () => {
  function entry(name: string, tree: Node, log: string[], at = name): DirectoryEntryLike {
    const fileEntry = (n: string, v: string | Uint8Array<ArrayBuffer>): FileEntryLike => ({ name: n, isFile: true, isDirectory: false, file: (ok) => { log.push(`read ${at}/${n}`); ok(new File([v], n)) } })
    return {
      name, isDirectory: true, isFile: false,
      getDirectory: (n, _o, ok, no) => { log.push(`dir ${at}/${n}`); const v = tree[n]; if (v !== undefined && isDir(v)) ok(entry(n, v, log, `${at}/${n}`)); else no(notFound()) },
      getFile: (n, _o, ok, no) => { log.push(`file ${at}/${n}`); const v = tree[n]; if (v !== undefined && !isDir(v)) ok(fileEntry(n, v)); else no(notFound()) },
      createReader: () => {
        let done = false
        return { readEntries: (ok) => { log.push(`list ${at}`); const batch = done ? [] : Object.entries(tree).map(([k, v]) => (isDir(v) ? entry(k, v, log, `${at}/${k}`) : fileEntry(k, v))); done = true; ok(batch) } }
      },
    }
  }
  test('the first folder of the drop, read lazily: the same walk, the same refusals', async () => {
    const log: string[] = []
    const dropped = entry('.claude', claudeFolder(), log)
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => dropped } as unknown as DataTransferItem] }
    const dir = droppedFolder(dt)!
    const r = await scanFolder(dir, 'browser')
    expect(r.body!.skills.map((s) => s.name).sort()).toEqual(['standup', 'weekly-report'])
    for (const n of NEVER) expect({ n, touched: log.filter((l) => l.includes(n)) }).toEqual({ n, touched: [] })
    // a dropped file is not a folder
    expect(droppedFolder({ items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) } as unknown as DataTransferItem] })).toBeNull()
  })
})
