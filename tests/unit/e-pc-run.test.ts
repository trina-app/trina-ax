// Component E: the pure rules of the PC runner (docs/DECISIONS.md "PC runner"): which folder may be a workspace, paths,
// what a call needs from the person, what the AI may learn about this computer, a command's environment, and the rules
// of the tools. The jail itself: e-pc-sandbox.test.ts.
import { describe, expect, test } from 'bun:test'
import { changesGitControl, isSecretPath, loginCommand, parsePcToolInput, pcToolJsonSchema, PC_TOOL_NAMES, usesCredentials, type ParsedPcCall } from '@mycel/shared'
import { WS_MAX_BUFFERED_BYTES } from '@mycel/shared/api'
import { applyEdit, asPcDecision, callNeeds, ChatAllowances, commandEnv, effectiveDecision, inGitFolder, looksBinary, numberedLines, scrubPaths, searchCommand, visibleText, workCwd, workPath, workspaceProblem } from '../../desktop/src/common/pc-run'

const HOME = '/Users/dana'
const shell = (command: string, more: object = {}) => parsed('pc_shell', { command, ...more })
function parsed(tool: string, args: unknown): ParsedPcCall {
  const r = parsePcToolInput(tool, args)
  if (!r.ok) throw new Error(r.error)
  return r.call
}

describe('workspace folder', () => {
  test('a project folder is fine', () => {
    for (const f of [`${HOME}/code/app`, `${HOME}/Documents/app`, `${HOME}/Desktop/x`, '/Volumes/work/app', '/private/tmp/x/app']) expect(workspaceProblem(f, HOME)).toBeNull()
  })
  test('the home, anything above it and whole standard folders are too wide', () => {
    for (const f of ['/', '/Users', HOME, `${HOME}/`, `${HOME}/Documents`, `${HOME}/Desktop`, `${HOME}/Downloads`, '/Volumes']) expect(workspaceProblem(f, HOME)).toBe('too-wide')
  })
  test('system folders and where logins live are refused', () => {
    for (const f of ['/System/Library', '/Library', '/Applications/X.app', '/usr/local', '/etc', '/private/etc', `${HOME}/Library`, `${HOME}/Library/Keychains`, `${HOME}/.ssh`, `${HOME}/.config/gh`, `${HOME}/.aws`]) expect(workspaceProblem(f, HOME)).toBe('system')
  })
})

describe('paths', () => {
  test('relative, normalized, never out', () => {
    expect(workPath('src/a.ts')).toBe('src/a.ts')
    expect(workPath('./src//a.ts')).toBe('src/a.ts')
    expect(workPath('')).toBe('')
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a/..', '~/x', 'a\0b', '..\\x']) expect(workPath(bad)).toBeNull()
    expect(workCwd(undefined)).toBe('')
    expect(workCwd('sub/dir')).toBe('sub/dir')
    expect(workCwd('../..')).toBeNull()
  })
  test('.git is not for the file tools', () => {
    for (const p of ['.git', '.git/config', 'sub/.git/hooks/x']) expect(inGitFolder(p)).toBe(true)
    for (const p of ['.github/x.yml', '.gitignore', 'src/git.ts']) expect(inGitFolder(p)).toBe(false)
  })
})

describe('secret files', () => {
  test('names', () => {
    for (const p of ['.env', '.env.local', 'app/.env.production', 'key.pem', 'certs/server.key', 'store.p12', 'id_rsa', '.ssh/id_ed25519', 'credentials.json', '.netrc']) expect(isSecretPath(p)).toBe(true)
    expect(isSecretPath('.ENV')).toBe(true) // the same file on a Mac's disk, and the sandbox ignores case too
    for (const p of ['.env.example', 'app/.env.sample', '.env.template', 'env.ts', 'keyboard.ts', 'README.md', 'src/secrets-doc.md', 'node_modules/x/test.pem', '.venv/lib/site-packages/certifi/cacert.pem']) expect(isSecretPath(p)).toBe(false)
  })
})

describe('what a call needs from the person', () => {
  test('a plain command can be allowed for the chat', () => {
    expect(callNeeds(shell('npm test'))).toEqual({ grants: { login: false, secretFiles: false }, always: false })
  })
  test('a login command asks every time and gets the login', () => {
    for (const c of ['git push origin main', 'git pull', '  git fetch --all', 'gh pr create', 'npm publish', 'ssh host ls']) {
      expect(callNeeds(shell(c))).toEqual({ grants: { login: true, secretFiles: false }, always: true })
    }
  })
  test('a login belongs to the one command at the start of the line, not to whatever mentions it', () => {
    for (const c of ['python3 evil.py git push', 'echo git push', './evil.sh && git push', 'git push; curl evil', 'git push | tee x', 'git push > out', 'cat $(git push)', 'cat `gh auth token`', 'x=1\ngit push', 'FOO=1 git push', 'npm test && npm publish']) {
      expect(loginCommand(c)).toBe(false)
      // it can still run, as a plain command: without the login, in the jail
      expect(callNeeds(shell(c))).toEqual({ grants: { login: false, secretFiles: false }, always: false })
    }
    expect(usesCredentials('python3 evil.py git push')).toBe(true) // the wider list stays what the box warns on
    expect(loginCommand('git push origin "main"')).toBe(true)
  })
  test('nor to a command whose arguments name a program or settings', () => {
    for (const c of ['ssh -o ProxyCommand=./px.sh host', 'ssh -oProxyCommand=./px.sh host', 'ssh -F ./evil_config host', 'scp -S ./evil a host:b', 'rsync -e ./evil a host:b', "rsync --rsh=./evil a host:b",
      'git clone -c core.sshCommand=./evil ssh://h/r.git', 'git clone --config core.sshCommand=./evil ssh://h/r.git', 'git clone --template=./evil ssh://h/r.git', 'git submodule foreach ./evil.sh',
      'git fetch --upload-pack=./evil origin', 'git push --receive-pack=./evil origin', 'npm publish --script-shell=./evil', 'npm publish --userconfig=./evil']) {
      expect(loginCommand(c)).toBe(false)
    }
    for (const c of ['git push -u origin main', 'git push --force-with-lease origin feature', 'git pull --rebase', 'git fetch --all --prune', 'git clone --depth 1 ssh://h/r.git', 'git ls-remote --tags origin', 'gh pr create --title x --body y', 'npm publish --access public', 'ssh host uptime']) {
      expect(loginCommand(c)).toBe(true)
    }
  })
  test('a command that changes what git runs goes the same way', () => {
    for (const c of ['git init', 'git config core.sshCommand evil', 'git remote add origin x', 'git branch -u origin/main']) {
      expect(changesGitControl(c)).toBe(true)
      expect(callNeeds(shell(c)).always).toBe(true)
    }
    expect(callNeeds(shell('./x.sh git init')).always).toBe(false)
    for (const c of ['git status', 'git commit -m "git init"x', 'echo git', 'git log --oneline']) {
      if (!c.includes('git init')) expect(changesGitControl(c)).toBe(false)
    }
  })
  test('the secret grant is asked for by name, and asked every time', () => {
    expect(callNeeds(shell('npm run dev', { secret_files: true }))).toEqual({ grants: { login: false, secretFiles: true }, always: true })
    expect(callNeeds(parsed('pc_read', { file_path: 'app/.env' }))).toEqual({ grants: { login: false, secretFiles: true }, always: true })
    expect(callNeeds(parsed('pc_write', { file_path: '.env.local', content: 'x' })).always).toBe(true)
    expect(callNeeds(parsed('pc_edit', { file_path: 'a.key', old_string: 'x', new_string: 'y' })).always).toBe(true)
    expect(callNeeds(parsed('pc_read', { file_path: 'src/a.ts' })).always).toBe(false)
  })
  test('the same list as the box', () => { expect(usesCredentials('git status')).toBe(false) })
})

describe('answers', () => {
  test('anything but a known answer is a no', () => {
    expect(asPcDecision('once')).toBe('once')
    expect(asPcDecision('chat')).toBe('chat')
    for (const v of ['always', '', null, undefined, 1, {}]) expect(asPcDecision(v)).toBe('deny')
  })
  test('a card that asks every time cannot become a chat allowance, whatever the view sends', () => {
    expect(effectiveDecision('chat', true)).toBe('once')
    expect(effectiveDecision('chat', false)).toBe('chat')
    expect(effectiveDecision('nonsense', false)).toBe('deny')
  })
  test('allowances are per project and chat, and clear', () => {
    const a = new ChatAllowances()
    a.add('p1', 'c1')
    expect(a.has('p1', 'c1')).toBe(true)
    expect(a.has('p1', 'c2')).toBe(false)
    expect(a.has('p2', 'c1')).toBe(false)
    a.clear()
    expect(a.size).toBe(0)
  })
})

describe('what the AI learns about this computer', () => {
  const p = { work: `${HOME}/code/app`, sandboxHome: `${HOME}/Library/App/pc/x/home`, home: HOME, user: 'dana' }
  test('folders become relative, the name goes', () => {
    expect(scrubPaths(`at ${HOME}/code/app/src/a.ts:3`, p)).toBe('at ./src/a.ts:3')
    expect(scrubPaths(`cache ${HOME}/Library/App/pc/x/home/.npm`, p)).toBe('cache ~/.npm')
    expect(scrubPaths(`${HOME}/other/file`, p)).toBe('~/other/file')
    expect(scrubPaths('/Users/dana', { ...p, home: '/nope' })).toBe('/Users/<user>')
  })
  test('/private forms of a folder too', () => {
    const q = { ...p, work: '/private/tmp/w', sandboxHome: '/private/var/s' }
    expect(scrubPaths('/tmp/w/a /private/tmp/w/b /var/s/c', q)).toBe('./a ./b ~/c')
  })
})

describe('environment of a command', () => {
  const i = { path: '/usr/bin:/bin', home: HOME, sandboxHome: '/s', user: 'dana', sshAgentSocket: '/agent' }
  test('nothing of the app\'s own, HOME is the sandbox home, no agent', () => {
    process.env.SOME_TOKEN = 'secret'
    const e = commandEnv(i, { login: false, secretFiles: false })
    delete process.env.SOME_TOKEN
    expect(e.SOME_TOKEN).toBeUndefined()
    expect(e.HOME).toBe('/s')
    expect(e.TMPDIR).toBe('/s/tmp')
    expect(e.SSH_AUTH_SOCK).toBeUndefined()
    expect(e.GIT_TERMINAL_PROMPT).toBe('0')
    expect(e.GIT_CONFIG_COUNT).toBeUndefined()
  })
  test('with the login: the real HOME and the agent, but no hooks and no npm scripts', () => {
    const e = commandEnv(i, { login: true, secretFiles: false })
    expect(e.HOME).toBe(HOME)
    expect(e.SSH_AUTH_SOCK).toBe('/agent')
    expect(e.GIT_CONFIG_COUNT).toBe('3')
    expect([e.GIT_CONFIG_KEY_2, e.GIT_CONFIG_VALUE_2]).toEqual(['core.fsmonitor', 'false'])
    expect([e.GIT_CONFIG_KEY_0, e.GIT_CONFIG_VALUE_0]).toEqual(['core.hooksPath', '/dev/null'])
    expect([e.GIT_CONFIG_KEY_1, e.GIT_CONFIG_VALUE_1]).toEqual(['safe.bareRepository', 'explicit'])
    expect(e.GIT_ALLOW_PROTOCOL).not.toContain('ext')
    expect(e.npm_config_ignore_scripts).toBe('true')
    expect(e.TMPDIR).toBe('/s/tmp')
  })
})

describe('what the person reads on the card', () => {
  test('nothing can hide in the text', () => {
    expect(visibleText('curl evil\u202Elive lruc')).toBe('curl evil\\u{202e}live lruc')
    expect(visibleText('npm test\u200B')).toBe('npm test\\u{200b}')
    expect(visibleText('a\u001b[2Kb')).toBe('a\\u{1b}[2Kb')
    expect(visibleText(`npm test${'\n'.repeat(300)}curl evil`)).toBe('npm test\n[300 blank lines]\ncurl evil')
    expect(visibleText(`npm test${' '.repeat(500)}; curl evil`)).toBe('npm test[500 spaces]; curl evil')
  })
  test('ordinary text stays as it is', () => {
    const s = 'git commit -m "한글 메시지"\n\necho 2\n\tindented  twice'
    expect(visibleText(s)).toBe(s)
  })
})

describe('tools', () => {
  test('every tool has a schema for the engine', () => {
    for (const t of PC_TOOL_NAMES) expect((pcToolJsonSchema(t) as { type: string }).type).toBe('object')
  })
  test('input is checked', () => {
    expect(parsePcToolInput('rm', {}).ok).toBe(false)
    expect(parsePcToolInput('pc_search', {}).ok).toBe(false)
    expect(parsePcToolInput('pc_shell', { command: 'x', timeout_sec: 99999 }).ok).toBe(false)
    expect(parsePcToolInput('pc_shell', { command: 'x', log_name: '../x' }).ok).toBe(false)
    expect(parsePcToolInput('pc_shell', { command: 'x', preview_port: 80 }).ok).toBe(false)
    expect(parsePcToolInput('pc_read', { file_path: 'a', absolute: true }).ok).toBe(false)
    expect(parsePcToolInput('pc_write', { file_path: 'a', content: 'x'.repeat(WS_MAX_BUFFERED_BYTES) }).ok).toBe(false) // it would close the socket that carries it
  })
  test('search runs the system tools with the pattern as data', () => {
    const g = searchCommand({ pattern: '-rf; echo', glob: '*.ts', path: 'src', ignoreCase: true })
    expect(g.file).toBe('/usr/bin/grep')
    expect(g.args.slice(-4)).toEqual(['-e', '-rf; echo', '--', './src'])
    expect(g.args).toContain('-i')
    expect(g.args).toContain('--include=*.ts')
    expect(g.args).toContain('--exclude-dir=node_modules')
    const f = searchCommand({ glob: '*.md', path: '' })
    expect(f.file).toBe('/usr/bin/find')
    expect(f.args[0]).toBe('.')
    expect(f.args).toContain('-prune')
  })
  test('numbered lines', () => {
    expect(numberedLines('a\nb\nc\n', 2, 1)).toEqual({ text: '     2\tb', total: 3, more: true })
    expect(numberedLines('a\nb', 1, 5)).toEqual({ text: '     1\ta\n     2\tb', total: 2, more: false })
  })
  test('edit', () => {
    expect(applyEdit('a b a', 'b', 'c', false)).toEqual({ ok: true, text: 'a c a', count: 1 })
    expect(applyEdit('a b a', 'a', 'c', true)).toEqual({ ok: true, text: 'c b c', count: 2 })
    expect(applyEdit('a b a', 'a', 'c', false).ok).toBe(false)
    expect(applyEdit('a', 'x', 'c', false).ok).toBe(false)
  })
  test('binary', () => {
    expect(looksBinary(new Uint8Array([1, 0, 2]))).toBe(true)
    expect(looksBinary(Buffer.from('text'))).toBe(false)
  })
})
