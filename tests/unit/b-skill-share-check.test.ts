// 내 스킬 가져오기 (docs/DECISIONS.md "K"; server/src/skills/share-check.ts): the deterministic checks of a share
// proposal, without a server: names made valid and unique, the header made valid (anchors, aliases, tags and huge
// headers refused), secrets in any file or a secret file name (the content dropped), scripts the SKILL.md needs (or
// left out and counted), plugin, size, not a skill, paths that leave the folder, personal paths, a team skill of the same
// name, commands, images, CLAUDE.md lines with secrets, remote MCP addresses, and what the strict schema refuses.
import { describe, expect, test } from 'bun:test'
import { CreateSkillShare, SKILL_SHARE_LIMITS, type CreateSkillShare as Body } from '@mycel/shared/api'
import { checkSkill, parseSkill } from '../../server/src/chat/skills'
import {
  checkShare, cleanRuleInput, cleanRuleOutput, cleanTools, commandSkillMd, freeName, imageBytes, needsScripts, personalPathIn,
  readHeader, renamedSkillMd, secretFileKind, validSkillName, type TeamSkillRef,
} from '../../server/src/skills/share-check'

const SLACK = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')
const md = (name: string, description = 'Write the weekly report from the notes', body = '# Weekly report\n1. Read the notes.\n2. Write the report.\n') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
const skill = (name: string, files: { path: string; text?: string; base64?: string }[], o: Partial<Body['skills'][number]> = {}) => ({ name, origin: 'user' as const, files, ...o })
const share = (skills: Body['skills'], o: Partial<Body> = {}): Body => CreateSkillShare.parse({ source: 'browser', skills, ...o })
const one = (s: Body['skills'][number], team: TeamSkillRef[] = []) => {
  const r = checkShare(share([s]), team)
  return { c: r.candidates[0]!, files: r.files.get(r.candidates[0]!.name) ?? null, r }
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d8a3c1f40000000049454e44ae426082', 'hex')

describe('names', () => {
  test('a valid name stays; anything else becomes a valid folder name; empty, "..", reserved, hidden characters', () => {
    expect(validSkillName('weekly-report')).toBe('weekly-report')
    expect(validSkillName('주간 업무 보고')).toBe('jugan-eopmu-bogo')
    expect(validSkillName('Weekly_Report v2!')).toBe('weekly-report-v2')
    expect(validSkillName('..')).toBe('skill')
    expect(validSkillName('')).toBe('skill')
    expect(validSkillName('skills')).toBe('skills')
    expect(validSkillName('CON')).toBe('con-skill')
    expect(validSkillName('nul')).toBe('nul-skill')
    expect(validSkillName('we\u200bekly\u202e-report\u2066')).toBe('weekly-report')
    expect(validSkillName('Résumé')).toBe('resume')
    expect(validSkillName('a'.repeat(80))).toHaveLength(64)
    for (const n of ['주간 업무 보고', '..', 'CON', 'x'.repeat(100), '\u0000\u0001', '../../etc/passwd'])
      expect(checkSkill(md(validSkillName(n)), `skills/${validSkillName(n)}/SKILL.md`).ok, n).toBe(true)
    expect(freeName('weekly', (n) => ['weekly', 'weekly-2'].includes(n))).toBe('weekly-3')
    expect(freeName('x'.repeat(64), (n) => n === 'x'.repeat(64))).toBe(`${'x'.repeat(62)}-2`)
  })

  test('duplicate candidate names get "-2", "-3"; the excluded names too', () => {
    const r = checkShare(share([skill('weekly', [{ path: 'SKILL.md', text: md('weekly') }]), skill('Weekly', [{ path: 'SKILL.md', text: md('x') }]), skill('weekly', [])].slice(0, 2), {
      excluded: [{ name: 'weekly', reason: 'plugin' }, { name: 'slack', reason: 'secret', kind: 'slack' }, { name: 'odd', reason: 'secret', kind: 'a<b>' }],
    }), [])
    expect(r.candidates.map((c) => c.name)).toEqual(['weekly', 'weekly-2', 'weekly-3', 'slack', 'odd'])
    expect(r.candidates.slice(2).map((c) => [c.group, c.reason, c.detail])).toEqual([['excluded', 'plugin', null], ['excluded', 'secret', 'slack'], ['excluded', 'secret', null]])
  })
})

describe('the header', () => {
  test('made valid: the name is the folder\'s, lists and booleans become text, metadata kept, the title replaced', () => {
    const text = `---\nname: Weekly Report\ndescription: "Make it: weekly"\nallowed-tools: [Read, Grep]\ndisable-model-invocation: true\nhooks:\n  pre: x\nmetadata:\n  version: 2\n  title: Old\n---\n# Body\n`
    const out = renamedSkillMd(text, { name: 'weekly-report', title: '주간 보고' })!
    expect(parseSkill(out, 'skills/weekly-report/SKILL.md')).toMatchObject({ name: 'weekly-report', description: 'Make it: weekly', title: '주간 보고', body: '# Body\n' })
    expect(out).toContain('allowed-tools: "Read, Grep"')
    expect(out).toContain('disable-model-invocation: "true"')
    expect(out).not.toContain('hooks')
    expect(renamedSkillMd(text, { name: 'other' })).toContain('title: "Old"')
  })

  test('refused: anchors, aliases, tags, a header over 8 KB, broken YAML, no header', () => {
    expect(readHeader('---\nname: &a x\ndescription: *a\n---\nbody')).toBeNull()
    expect(readHeader('---\nname: x\ndescription: !!str y\n---\nbody')).toBeNull()
    expect(readHeader('---\nbase: &b\n  k: v\nname: x\ndescription: y\nmetadata: *b\n---\n')).toBeNull()
    expect(readHeader(`---\nname: x\ndescription: ${'y'.repeat(9000)}\n---\n`)).toBeNull()
    expect(readHeader('---\nname: [x\ndescription: y\n---\n')).toBeNull()
    expect(readHeader('# no header')).toBeNull()
    for (const text of ['---\nname: &a x\ndescription: *a\n---\nbody', `---\nname: x\ndescription: ${'y'.repeat(9000)}\n---\n`])
      expect(one(skill('x', [{ path: 'SKILL.md', text }])).c).toMatchObject({ group: 'excluded', reason: 'not_skill', files: [] })
  })
})

describe('secrets', () => {
  test('a secret anywhere (SKILL.md, a nested template, a script\'s text) excludes the skill and keeps none of it', () => {
    for (const files of [
      [{ path: 'SKILL.md', text: md('notify', 'Post to Slack', `Use token ${SLACK} to post.`) }],
      [{ path: 'SKILL.md', text: md('notify') }, { path: 'templates/deep/x.md', text: `header\nauth: ${SLACK}\n` }],
      [{ path: 'SKILL.md', text: md('notify') }, { path: 'scripts/post.py', text: `TOKEN = "${SLACK}"` }],
    ]) {
      const { c, files: kept, r } = one(skill('notify', files))
      expect(c).toMatchObject({ group: 'excluded', reason: 'secret', detail: 'slack', files: [], description: '' })
      expect(kept).toBeNull()
      expect(JSON.stringify(r)).not.toContain(SLACK)
    }
  })

  test('a name, a project, a place or a tool name that is itself a key is never kept', () => {
    const r = checkShare(share([skill(SLACK, [{ path: 'SKILL.md', text: md('x') }], { origin: 'project', project: `/Users/alex/${SLACK}` })], {
      source: 'claude_code', where: SLACK, excluded: [{ name: SLACK, reason: 'secret' }], tools: [{ name: SLACK, url: 'https://mcp.example/mcp', auth: 'oauth' }],
    }), [])
    expect(r.candidates.map((c) => [c.name, c.project])).toEqual([['skill', null], ['skill-2', null]])
    expect(r.where).toBeNull()
    expect(r.tools).toEqual([])
    expect(JSON.stringify({ ...r, files: [...r.files.entries()] }).toLowerCase()).not.toContain(SLACK.toLowerCase())
  })

  test('a secret file name, at any depth, excludes the skill with its kind', () => {
    for (const [p, kind] of [['.env', 'env'], ['config/.env.local', 'env'], ['keys/server.pem', 'private-key'], ['id_ed25519', 'private-key'], ['id_rsa.pub', 'private-key'],
      ['.npmrc', 'npm'], ['.netrc', 'netrc'], ['credentials.json', 'credentials'], ['x/.credentials.json', 'credentials'], ['cert.p12', 'private-key'], ['.aws/config', 'credentials']] as const) {
      expect(secretFileKind(p), p).toBe(kind)
    }
    expect(secretFileKind('templates/env-guide.md')).toBeNull()
    expect(one(skill('s', [{ path: 'SKILL.md', text: md('s') }, { path: 'deploy/.env', text: 'A=1' }])).c).toMatchObject({ group: 'excluded', reason: 'secret', detail: 'env' })
  })

  test('CLAUDE.md: every line touched by a secret is dropped before anyone reads it, and counted', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA7bq8Xk2Lw9Qz3Rm5Vt1Yp4Hs6Jd8Fg0Kc2Nb4Ma6Lz9Pe1Wr', '-----END RSA PRIVATE KEY-----'].join('\n')
    const r = cleanRuleInput(`# Team\n- 존댓말로 써요\n- slack: ${SLACK}\n- 비밀번호: hunter2-Secret9\n${pem}\n- 표는 마크다운으로\n`)!
    expect(r.text).toContain('존댓말로 써요')
    expect(r.text).toContain('표는 마크다운으로')
    expect(r.text).not.toContain('xoxb')
    expect(r.text).not.toContain('hunter2')
    expect(r.text).not.toContain('MIIE')
    expect(r.dropped).toBeGreaterThanOrEqual(4)
    expect(cleanRuleInput(`token: ${SLACK}`)).toBeNull()
    expect(cleanRuleInput('x'.repeat(40_000))!.text.length).toBe(16_000)
  })
})

describe('scripts, plugin, size, not a skill', () => {
  test('a SKILL.md that runs code is excluded; otherwise the scripts are left out (never their content) and counted', () => {
    const scripts = [{ path: 'scripts/extract.py', text: 'print("hi")' }, { path: 'run.sh', text: '' }]
    for (const body of ['Run `python scripts/extract.py notes.md` first.', 'Then `bash run.sh`.', 'Call extract.py on the file.', '```bash\nls\n```', 'npx prettier --write .', 'uv run x', '스크립트를 실행해요'])
      expect(one(skill('ex', [{ path: 'SKILL.md', text: md('ex', 'Extract', body) }, ...scripts])).c, body).toMatchObject({ group: 'excluded', reason: 'scripts', files: [] })
    const { c, files } = one(skill('ex', [{ path: 'SKILL.md', text: md('ex') }, ...scripts, { path: 'templates/a.md', text: 'tmpl' }]))
    expect(c).toMatchObject({ group: 'other', reason: 'unjudged', scriptsDropped: 2, files: [{ path: 'SKILL.md' }, { path: 'templates/a.md', bytes: 4 }] })
    expect(files!.map((f) => f.path)).toEqual(['SKILL.md', 'templates/a.md'])
    expect(files!.some((f) => f.data.toString().includes('print'))).toBe(false)
    expect(needsScripts('Write the report. The node of the tree is …', [])).toBe(false)
    expect(needsScripts('Python developers like it.', [])).toBe(false)
    expect(needsScripts('Run the script past the client before the shoot.', [])).toBe(false)
  })

  test('plugin: excluded without looking; too big: a file over 128 KB (in bytes) or over 1 MB in all', () => {
    expect(one(skill('p', [{ path: 'SKILL.md', text: md('p') }], { origin: 'plugin' })).c).toMatchObject({ group: 'excluded', reason: 'plugin', files: [] })
    // 129 KB of Korean is under the schema's character limit, over the byte limit
    const big = '가'.repeat(Math.ceil(129 * 1024 / 3))
    expect(big.length).toBeLessThan(SKILL_SHARE_LIMITS.fileBytes)
    expect(one(skill('b', [{ path: 'SKILL.md', text: md('b') }, { path: 'big.md', text: big }])).c).toMatchObject({ group: 'excluded', reason: 'too_big' })
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `t/${i}.md`, text: 'a'.repeat(120 * 1024) }))
    expect(one(skill('b', [{ path: 'SKILL.md', text: md('b') }, ...files])).c).toMatchObject({ group: 'excluded', reason: 'too_big' })
  })

  test('not a skill: no SKILL.md, a header the reader cannot take, NUL in SKILL.md; NUL elsewhere drops that file', () => {
    expect(one(skill('n', [{ path: 'README.md', text: 'hi' }])).c).toMatchObject({ group: 'excluded', reason: 'not_skill' })
    expect(one(skill('n', [{ path: 'SKILL.md', text: '---\nname: n\n---\nno description' }])).c).toMatchObject({ group: 'excluded', reason: 'not_skill' })
    expect(one(skill('n', [{ path: 'SKILL.md', text: md('n') + '\u0000' }])).c).toMatchObject({ group: 'excluded', reason: 'not_skill' })
    const { c } = one(skill('n', [{ path: 'SKILL.md', text: md('n') }, { path: 'a.md', text: 'x\u0000y' }]))
    expect(c.files.map((f) => f.path)).toEqual(['SKILL.md'])
    // lower-case skill.md is the same entry point
    expect(one(skill('n', [{ path: 'skill.md', text: md('n') }])).c.group).toBe('other')
  })
})

describe('paths, personal paths, same name, commands, images', () => {
  test('the schema refuses paths that leave the folder; hidden, invisible and too deep names are left out', () => {
    for (const p of ['../x.md', '/etc/passwd', 'a/../b.md', 'a\\b.md', 'a\u0000b.md', './x.md', 'a//b.md'])
      expect(CreateSkillShare.safeParse({ source: 'browser', skills: [skill('x', [{ path: p, text: 'x' }])] }).success, p).toBe(false)
    const { c } = one(skill('x', [{ path: 'SKILL.md', text: md('x') }, { path: '.DS_Store', text: 'x' }, { path: 'a\u202eb.md', text: 'x' }, { path: 'a/b/c/d/e.md', text: 'x' }, { path: 'a/b/c/d.md', text: 'ok' }, { path: 'notes.pdf', text: 'x' }]))
    expect(c.files.map((f) => f.path)).toEqual(['SKILL.md', 'a/b/c/d.md'])
  })

  test('a path on the computer: personal_path under 그 밖에, unticked', () => {
    for (const [t, yes] of [['/Users/alex/notes.md', true], ['/home/alex/x', true], ['C:\\Users\\alex\\x.txt', true], ['read ~/Documents/q.xlsx', true], ['$HOME/x', true], ['%USERPROFILE%\\x', true],
      ['~/.claude/skills/quote/form.md', false], ['https://acme.example/Users/x/', false], ['the template next to this file', false]] as const)
      expect(personalPathIn(t, 'quote'), t).toBe(yes)
    const { c } = one(skill('quote', [{ path: 'SKILL.md', text: md('quote', 'Quotes', 'Open /Users/alex/Desktop/price.xlsx') }]))
    expect(c).toMatchObject({ group: 'other', reason: 'personal_path', personalPath: true })
  })

  test('a team skill of the same name: merged by default', () => {
    const team = [{ name: 'weekly-report', path: 'skills/general/weekly-report/SKILL.md', title: '주간 보고' }]
    expect(one(skill('Weekly Report', [{ path: 'SKILL.md', text: md('x') }]), team).c).toMatchObject({ name: 'weekly-report', sameName: { path: team[0]!.path, title: '주간 보고' }, action: 'merge' })
  })

  test('a command becomes a skill with a generated header; one that runs a shell line is excluded', () => {
    expect(commandSkillMd('# Review the PR\nCheck it.', 'review')).toStartWith('---\nname: review\ndescription: "Review the PR"\n---\n')
    expect(commandSkillMd('---\ndescription: Summarize a doc\nargument-hint: [file]\n---\nSummarize $ARGUMENTS', 'sum')).toContain('description: "Summarize a doc"')
    const { c, files } = one(skill('daily', [{ path: 'daily.md', text: 'Write my daily standup from my notes.' }], { origin: 'command' }))
    expect(c).toMatchObject({ name: 'daily', group: 'other', reason: 'command', files: [{ path: 'SKILL.md' }] })
    expect(parseSkill(files![0]!.data.toString(), 'skills/daily/SKILL.md')).toMatchObject({ name: 'daily', description: 'Write my daily standup from my notes.' })
    expect(one(skill('st', [{ path: 'st.md', text: 'Status: !`git status`' }], { origin: 'command' })).c).toMatchObject({ group: 'excluded', reason: 'scripts' })
  })

  test('images: a real one is kept; base64 that is not an image (or not its kind) is left out', () => {
    expect(imageBytes(PNG.toString('base64'), 'png')).toEqual(PNG)
    expect(imageBytes(PNG.toString('base64'), 'jpg')).toBeNull()
    expect(imageBytes(Buffer.from('#!/bin/sh\nrm -rf /').toString('base64'), 'png')).toBeNull()
    expect(imageBytes('not base64!!', 'png')).toBeNull()
    const { c, files } = one(skill('img', [{ path: 'SKILL.md', text: md('img') }, { path: 'logo.png', base64: PNG.toString('base64') }, { path: 'evil.png', base64: Buffer.from('MZ\u0090\u0000').toString('base64') }, { path: 'x.md', base64: 'aGk=' }]))
    expect(c.files.map((f) => f.path)).toEqual(['SKILL.md', 'logo.png'])
    expect(files![1]!.data).toEqual(PNG)
  })
})

describe('the rule and the tools', () => {
  test('the AI\'s rule again: no secret, no path, no header, cut at a line under the limit', () => {
    const r = cleanRuleOutput(`---\n- 존댓말로 써요\n- 파일은 /Users/alex/x 에\n- key: ${SLACK}\n- 표로 정리해요`)!
    expect(r).toEqual({ text: '- 존댓말로 써요\n- 표로 정리해요', lines: 2, removed: 2 })
    expect(cleanRuleOutput('---\n---')).toBeNull()
    const long = cleanRuleOutput(Array.from({ length: 400 }, (_, i) => `- line ${i} ${'x'.repeat(20)}`).join('\n'))!
    expect(long.text.length).toBeLessThanOrEqual(SKILL_SHARE_LIMITS.ruleChars)
    expect(long.text.endsWith('x')).toBe(true)
  })

  test('remote MCP servers: https only, no key, query or user in the address; header names only; Claude Code only', () => {
    const tools = cleanTools([
      { name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth' },
      { name: 'Linear', url: 'https://mcp.linear.example/sse', auth: 'header', header: 'X-API-Key' },
      { name: 'Leaky', url: 'https://mcp.example/mcp?api_key=sk-abcDEF1234567890abcdef12', auth: 'bearer' },
      { name: 'Query', url: 'https://mcp.example/mcp?x=1', auth: 'bearer' },
      { name: 'User', url: 'https://u:p@mcp.example/mcp', auth: 'bearer' },
      { name: 'Plain', url: 'http://mcp.example/mcp', auth: 'bearer' },
      { name: 'notion', url: 'https://other.example/mcp', auth: 'oauth' },
      { name: 'BadHeader', url: 'https://h.example/mcp', auth: 'header', header: 'X Key: v' },
    ])
    expect(tools).toEqual([
      { name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth', header: null, templateId: null, error: null },
      { name: 'Linear', url: 'https://mcp.linear.example/sse', auth: 'header', header: 'X-API-Key', templateId: null, error: null },
      { name: 'BadHeader', url: 'https://h.example/mcp', auth: 'header', header: null, templateId: null, error: null },
    ])
    const s = { name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth' as const }
    expect(checkShare(share([], { tools: [s], projects: 2 }), []).tools).toEqual([])
    expect(checkShare(share([], { source: 'claude_code', tools: [s], projects: 2 }), [])).toMatchObject({ tools: [{ name: 'Notion' }], projects: 2 })
  })
})

describe('the strict schema', () => {
  test('201 skills, 31 files, a key or token field anywhere, a file with text and base64, an unknown origin: refused', () => {
    const ok = skill('x', [{ path: 'SKILL.md', text: md('x') }])
    expect(CreateSkillShare.safeParse({ source: 'browser', skills: Array.from({ length: 200 }, () => ok) }).success).toBe(true)
    expect(CreateSkillShare.safeParse({ source: 'browser', skills: Array.from({ length: 201 }, () => ok) }).success).toBe(false)
    expect(CreateSkillShare.safeParse({ source: 'browser', skills: [skill('x', Array.from({ length: 31 }, (_, i) => ({ path: `${i}.md`, text: 'x' })))] }).success).toBe(false)
    for (const bad of [
      { source: 'browser', skills: [], key: 'sk-x' },
      { source: 'browser', skills: [], token: 'x' },
      { source: 'claude_code', skills: [], tools: [{ name: 'n', url: 'https://x.example', auth: 'bearer', token: 'secret' }] },
      { source: 'browser', skills: [{ ...ok, secret: 'x' }] },
      { source: 'browser', skills: [skill('x', [{ path: 'SKILL.md', text: 'a', base64: 'aGk=' }])] },
      { source: 'browser', skills: [{ ...ok, origin: 'system' }] },
      { source: 'browser', skills: [], excluded: [{ name: 'x', reason: 'secret', content: SLACK }] },
      { source: 'browser', skills: [], rule: { text: 'x', key: 'y' } },
    ]) expect(CreateSkillShare.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    // a 129 KB file of plain ASCII is over the schema's limit: the whole share is refused
    expect(CreateSkillShare.safeParse({ source: 'browser', skills: [skill('x', [{ path: 'SKILL.md', text: md('x') }, { path: 'a.md', text: 'a'.repeat(129 * 1024) }])] }).success).toBe(false)
  })
})
