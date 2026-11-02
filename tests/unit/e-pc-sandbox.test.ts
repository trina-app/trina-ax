// Component E: the macOS jail of the PC runner, under the real sandbox-exec (docs/DECISIONS.md "PC runner"): what a command
// can use (the dev tools), and what it cannot reach. A test here is a real attempt to get out, so each one looks at the
// effect: the file that was not read, the file that was not written. macOS only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandEnv } from '../../desktop/src/common/pc-run'
import { ancestors, sandboxProfile, sbString, secretFileRegex, toolFolders, type PcGrants } from '../../desktop/src/common/pc-sandbox'

// Nearly every test here starts several real tools. git and python3 can go through the xcrun shims of macOS, which can take
// seconds on a busy machine, and open, osascript and launchctl wait for services the jail refuses.
setDefaultTimeout(30_000)
const mac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const NO: PcGrants = { login: false, secretFiles: false }
/** a path as one word of a bash command (the test folder has a " in its name, for the profile's quoting) */
const q = (p: string) => `'${p}'`

describe('the profile', () => {
  test('ancestors', () => {
    expect(ancestors('/a/b/c')).toEqual(['/a/b', '/a', '/'])
    expect(ancestors('/a')).toEqual(['/'])
  })
  test('quotes in a path cannot leave the string', () => {
    expect(sbString('/a"b\\c')).toBe('"/a\\"b\\\\c"')
    const p = sandboxProfile({ work: '/w/"))(allow default)', sandboxHome: '/s', home: '/h', pathDirs: [] }, NO)
    expect(p).toContain('\\"))(allow default)')
    expect(p.split('\n').some((l) => l.trim() === '(allow default)')).toBe(false)
  })
  test('regular expression characters of a path are literal', () => {
    expect(secretFileRegex('/a.b+c')).toContain('/a\\.b\\+c/')
  })
  test('tool folders: the folder above a bin, never the home', () => {
    const f = toolFolders({ home: '/h', pathDirs: ['/h/.nvm/versions/node/v22/bin', '/h/bin', '/usr/bin', '/h/odd/place'] })
    expect(f).toContain('/h/.nvm/versions/node/v22')
    expect(f).toContain('/h/odd/place')
    expect(f).not.toContain('/h')
    expect(f).not.toContain('/usr/bin')
  })
  test('grants open only what they name', () => {
    const paths = { work: '/w', sandboxHome: '/s', home: '/h', pathDirs: [], sshAgentSocket: '/private/agent' }
    expect(sandboxProfile(paths, NO)).not.toContain('/h/.ssh')
    expect(sandboxProfile(paths, NO)).not.toContain('/private/agent')
    const login = sandboxProfile(paths, { login: true, secretFiles: false })
    expect(login).toContain('/h/.ssh')
    expect(login).toContain('/private/agent')
    expect(login).not.toContain('Application Support')
    expect(sandboxProfile(paths, { login: false, secretFiles: true })).not.toContain('deny file-read-data file-write* (regex')
  })
})

describe.skipIf(!mac)('a command in the jail', () => {
  let base = ''
  let work = ''
  let sandboxHome = ''
  let fakeHome = ''
  const run = (command: string, g: PcGrants = NO, env: Record<string, string> = {}) => {
    const profile = sandboxProfile({ work, sandboxHome, home: fakeHome, pathDirs: PATH.split(':').filter(existsSync).map((d) => realpathSync(d)) }, g)
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', command], { cwd: work, env: { PATH, HOME: sandboxHome, TMPDIR: join(sandboxHome, 'tmp'), LANG: 'en_US.UTF-8', ...env }, encoding: 'utf8', timeout: 60_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }
  }
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pc jail "테스트"-')))
    work = join(base, '작업 폴더')
    sandboxHome = join(base, 'sandbox')
    fakeHome = join(base, 'home')
    for (const d of [work, join(sandboxHome, 'tmp'), join(fakeHome, '.ssh'), join(fakeHome, 'Documents'), join(fakeHome, 'Library/Keychains'), join(fakeHome, 'Library/Application Support/Google/Chrome'), join(base, 'other')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(fakeHome, '.ssh/id_ed25519'), 'PRIVATE KEY')
    writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n')
    writeFileSync(join(fakeHome, 'Documents/tax.pdf'), 'TAX')
    writeFileSync(join(fakeHome, 'Library/Keychains/login.keychain-db'), 'KEYCHAIN')
    writeFileSync(join(fakeHome, 'Library/Application Support/Google/Chrome/Cookies'), 'COOKIES')
    writeFileSync(join(base, 'other/x.txt'), 'OTHER')
    writeFileSync(join(work, '.env'), 'TOKEN=hunter2\n')
    writeFileSync(join(work, 'server.pem'), 'PEM\n')
    writeFileSync(join(work, '.env.example'), 'TOKEN=\n')
    writeFileSync(join(work, 'ok.txt'), 'hello\n')
  })
  afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }) })

  test('works in the workspace, with spaces and Korean in the path', () => {
    const r = run('echo made > new.txt && cat new.txt ok.txt && mkdir -p a/b && echo x > a/b/c && ls a/b')
    expect(r).toEqual({ code: 0, out: 'made\nhello\nc' })
  })
  test('git works, node works, the network works', () => {
    expect(run('git init -q 2>/dev/null; git --version').code).toBe(0)
    expect(run('command -v node >/dev/null && node -e "console.log(require(\'os\').homedir())"').code).toBe(0)
    // listens and connects inside the jail: no outside network in the test
    expect(run(`/usr/bin/python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); socket.create_connection(s.getsockname()); print('connected')"`).out).toBe('connected')
  })
  test('the person\'s home is closed: keys, documents, keychains, browsers', () => {
    for (const f of ['.ssh/id_ed25519', 'Documents/tax.pdf', 'Library/Keychains/login.keychain-db', 'Library/Application Support/Google/Chrome/Cookies']) {
      const r = run(`cat ${q(join(fakeHome, f))}`)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('not permitted')
    }
    expect(run(`ls ${q(join(fakeHome, 'Documents'))}`).out).toContain('not permitted')
  })
  test('other folders are closed, reading and writing', () => {
    expect(run(`cat ${q(join(base, 'other/x.txt'))}`).out).toContain('not permitted')
    expect(run(`echo x > ${q(join(base, 'other/new'))}`).code).not.toBe(0)
    expect(existsSync(join(base, 'other/new'))).toBe(false)
    expect(run(`echo x > ${q(join(fakeHome, 'dropped'))}`).code).not.toBe(0)
    expect(existsSync(join(fakeHome, 'dropped'))).toBe(false)
    const tmp = `/tmp/pc-jail-test-${process.pid}`
    expect(run(`echo x > ${tmp}`).code).not.toBe(0)
    expect(existsSync(tmp)).toBe(false)
  })
  test('a link in the workspace reaches nothing outside', () => {
    expect(run(`ln -s ${q(join(fakeHome, '.ssh/id_ed25519'))} soft.txt; cat soft.txt`).out).not.toContain('PRIVATE KEY')
    expect(run(`ln ${q(join(fakeHome, '.ssh/id_ed25519'))} hard.txt; cat hard.txt`).out).not.toContain('PRIVATE KEY')
    expect(existsSync(join(work, 'hard.txt'))).toBe(false)
  })
  test('secret files stay closed under another name', () => {
    for (const c of ['cat .env', 'cat server.pem', 'cp .env copy.txt; cat copy.txt', 'mv .env moved.txt; cat moved.txt', 'ln .env hardlink.txt; cat hardlink.txt', 'ln -s .env soft2.txt; cat soft2.txt', 'mkdir -p node_modules/x; mv .env node_modules/x/.env; cat node_modules/x/.env', 'tar cf t.tar .env; cat t.tar']) {
      expect(run(c).out).not.toContain('hunter2')
    }
    expect(existsSync(join(work, '.env'))).toBe(true)
  })
  test('secret files open with the grant; the template of .env needs none', () => {
    expect(run('cat .env.example').out).toBe('TOKEN=')
    expect(run('cat .env', { login: false, secretFiles: true }).out).toBe('TOKEN=hunter2')
  })
  describe('git', () => {
    const LOGIN: PcGrants = { login: true, secretFiles: false }
    const profile = (g: PcGrants) => sandboxProfile({ work, sandboxHome, home: fakeHome, pathDirs: PATH.split(':').filter(existsSync).map((d) => realpathSync(d)) }, g)
    const who = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    /** the environment the app gives a login command */
    const loginEnv = () => ({ ...commandEnv({ path: PATH, home: fakeHome, sandboxHome, user: 'dana' }, LOGIN), ...who })
    /** run in a folder of the workspace, as the app does with cwd */
    const inDir = (dir: string, command: string, g: PcGrants = NO, env: Record<string, string> = {}) => {
      const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile(g), '/bin/bash', '-c', command], { cwd: join(work, dir), env: { PATH, HOME: sandboxHome, TMPDIR: join(sandboxHome, 'tmp'), ...who, ...env }, encoding: 'utf8', timeout: 60_000 })
      return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }
    }
    const repo = (name: string) => {
      mkdirSync(join(work, name))
      expect(inDir(name, 'git init -q -b main && git commit -q --allow-empty -m first', LOGIN).code).toBe(0)
    }

    test('everything plain git does works in the jail, without the login', () => {
      repo('plain')
      const steps = [
        'echo one > a.txt && git add a.txt && git commit -q -m one',
        'git status --short && git log --oneline | wc -l && git diff HEAD~1 --stat',
        'git checkout -q -b feature && echo two >> a.txt && git commit -qam two',
        'git checkout -q main && git merge -q --no-ff -m merged feature',
        'echo three >> a.txt && git stash -q && git stash pop -q && git checkout -q -- a.txt',
        'git tag v1 && git tag -a v2 -m two && git branch old && git branch -d old',
        'echo four > b.txt && git add b.txt && git commit -qm four b.txt',
        'git checkout -q -b r HEAD~1 && echo five > c.txt && git add c.txt && git commit -qm five && git rebase -q main',
        'git checkout -q main && git cherry-pick r && git revert --no-edit HEAD && git reset -q --hard HEAD~1',
        'git rm -q c.txt && git commit -qm gone && git mv b.txt d.txt && git commit -qm moved',
        'git gc -q && git pack-refs --all && git log --oneline | wc -l',
      ]
      for (const s of steps) {
        const r = inDir('plain', s)
        expect({ s, ...r }).toMatchObject({ s, code: 0 })
      }
    })

    test('a plain command writes none of what git takes instructions from', () => {
      repo('closed')
      mkdirSync(join(work, 'closed/.git/modules/sub/hooks'), { recursive: true })
      writeFileSync(join(work, 'closed/.git/modules/sub/config'), '[core]\n')
      for (const f of ['config', 'config.worktree', 'commondir', 'gitdir', 'hooks/pre-push', 'hooks/post-checkout', 'info/attributes', 'info/exclude', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'worktrees/x/commondir', 'modules/sub/config', 'modules/sub/hooks/pre-push', 'modules/sub/commondir', 'branches/x', 'description']) {
        const r = inDir('closed', `mkdir -p "$(dirname .git/${f})" 2>/dev/null; echo evil >> .git/${f}`)
        expect({ f, code: r.code }).toEqual({ f, code: 1 })
        const inside = existsSync(join(work, 'closed/.git', f)) ? readFileSync(join(work, 'closed/.git', f), 'utf8') : ''
        expect({ f, inside: inside.includes('evil') }).toEqual({ f, inside: false })
      }
    })

    test('another spelling, a link or a rename of .git gets no further', () => {
      repo('walk')
      for (const c of [
        'echo evil >> .GIT/config', 'echo evil > .Git/commondir',
        'mv .git g2; echo evil >> g2/config; mv g2 .git',
        'ln -s .git link; echo evil >> link/config', 'ln -s .git/commondir c; echo evil > c',
        'ln .git/config hard; echo evil >> hard',
        'echo "gitdir: /tmp/evil" > y; mv y .git',
        'rm -f .git/commondir; mkdir -p .git/commondir',
      ]) inDir('walk', c)
      expect(readFileSync(join(work, 'walk/.git/config'), 'utf8')).not.toContain('evil')
      expect(existsSync(join(work, 'walk/.git/commondir'))).toBe(false)
      expect(existsSync(join(work, 'walk/g2'))).toBe(false)
      expect(inDir('walk', 'mkdir -p x/.git/hooks').code).not.toBe(0)
      expect(inDir('walk', 'git status --short').code).toBe(0)
    })

    test('the attack that found this: a config planted by commondir does not run under the next push', () => {
      repo('planted')
      const plant = inDir('planted', `
        mkdir -p .cache/objects .cache/refs
        printf '[core]\\n\\tsshCommand = ./pwn.sh\\n\\tfsmonitor = ./pwn.sh\\n' > .cache/config
        printf '#!/bin/bash\\ntouch pwn.proof\\n' > pwn.sh; chmod +x pwn.sh
        printf '../.cache' > .git/commondir`)
      expect(plant.code).not.toBe(0)
      expect(existsSync(join(work, 'planted/.git/commondir'))).toBe(false)
      inDir('planted', 'git remote add origin ssh://git@example.invalid/x.git; git push origin main 2>&1; git status', LOGIN, loginEnv())
      expect(existsSync(join(work, 'planted/pwn.proof'))).toBe(false)
    })

    test('with the login, git runs nothing that a plain command could have laid out', () => {
      repo('r')
      expect(inDir('.', 'mkdir up.git && git -C up.git init -q --bare', LOGIN).code).toBe(0)
      // a hook, as if planted: core.hooksPath in the environment wins over the repository
      writeFileSync(join(work, 'r/.git/hooks/pre-push'), `#!/bin/sh\ntouch ${q(join(work, 'hook-ran'))}\n`, { mode: 0o755 })
      expect(inDir('r', 'git remote add origin ../up.git', LOGIN).code).toBe(0)
      const push = inDir('r', 'git -c protocol.file.allow=always push -q origin HEAD:refs/heads/main', LOGIN, { ...loginEnv(), GIT_ALLOW_PROTOCOL: 'file' })
      expect(push).toEqual({ code: 0, out: '' })
      expect(existsSync(join(work, 'hook-ran'))).toBe(false)
      // a bare repository laid out in a folder is not picked up by looking around
      expect(run('mkdir -p b/objects b/refs && echo "ref: refs/heads/main" > b/HEAD && printf "[core]\\n\\trepositoryformatversion = 0\\n\\tbare = true\\n" > b/config').code).toBe(0)
      const bare = inDir('b', 'git rev-parse --git-dir', LOGIN, { ...loginEnv(), GIT_CEILING_DIRECTORIES: work })
      expect(bare.code).not.toBe(0)
      expect(bare.out).toContain('safe.bareRepository')
      // the ext transport runs a program
      expect(inDir('r', "git ls-remote 'ext::sh -c id' 2>&1", LOGIN, loginEnv()).out).toContain('not allowed')
    })

    test('the login grant can do what a login command needs in .git', () => {
      repo('setup')
      expect(inDir('setup', 'git remote add origin ssh://x/y.git && git config user.name z', LOGIN).code).toBe(0)
    })
  })
  test('the data of installed services is closed, their programs are not', () => {
    if (existsSync('/opt/homebrew/var')) expect(run('ls /opt/homebrew/var').out).toContain('not permitted')
    if (existsSync('/opt/homebrew/bin')) expect(run('ls /opt/homebrew/bin | head -1').code).toBe(0)
  })
  test('no way out through the system: LaunchServices, AppleEvents, launchd', () => {
    // a plain path: the job would run outside the jail, so the check is that this file stays absent
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-marker-')))
    const marker = join(dir, 'launchd-ran')
    try {
      expect(run('/usr/bin/open -a Terminal . 2>&1').out).toContain('Unable to find application')
      expect(run(`/usr/bin/osascript -e 'tell application "System Events" to get name of first process' 2>&1`).code).not.toBe(0)
      run(`/bin/launchctl submit -l com.mycel.pctest.${process.pid} -- /bin/sh -c 'echo x > ${marker}' 2>&1; sleep 1`)
      spawnSync('/bin/launchctl', ['remove', `com.mycel.pctest.${process.pid}`])
      expect(existsSync(marker)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('no unix sockets: a daemon\'s socket is out of reach', () => {
    const sock = `/tmp/pc-${process.pid}.sock` // a socket path has a length limit; this one is short on purpose
    const srv = Bun.listen({ unix: sock, socket: { data() {} } })
    const connect = `import socket
s = socket.socket(socket.AF_UNIX)
try:
    s.connect('${sock}'); print('CONNECTED')
except Exception as e:
    print('refused', e)
`
    try {
      writeFileSync(join(work, 'connect.py'), connect)
      // the same script outside the jail connects: the refusal below is the jail's, not a bad path
      expect(spawnSync('/usr/bin/python3', [join(work, 'connect.py')], { encoding: 'utf8', env: { PATH } }).stdout).toContain('CONNECTED')
      const r = run('/usr/bin/python3 connect.py 2>&1 | tail -1')
      expect(r.out).toContain('not permitted')
    } finally { srv.stop(true); rmSync(sock, { force: true }) }
  })
  test('the login grant opens the login and nothing else of the home', () => {
    const g = { login: true, secretFiles: false }
    expect(run(`cat ${q(join(fakeHome, '.ssh/id_ed25519'))}`, g).out).toBe('PRIVATE KEY')
    expect(run(`cat ${q(join(fakeHome, 'Documents/tax.pdf'))}`, g).out).toContain('not permitted')
    expect(run(`cat ${q(join(fakeHome, 'Library/Application Support/Google/Chrome/Cookies'))}`, g).out).toContain('not permitted')
    expect(run(`echo x >> ${q(join(fakeHome, '.ssh/id_ed25519'))}`, g).code).not.toBe(0)
    expect(run('cat .env', g).out).not.toContain('hunter2')
  })
})
