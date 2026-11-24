// Apps on the person's computer on Windows (docs/decisions/20261124-windows-local-apps.md), on any computer: the command
// line a person pastes (backslashes are a path's), the program looked up with PATH and PATHEXT, npm's .cmd shims started
// as node and their script (no shell), any other batch file through cmd.exe only with arguments cmd cannot read as
// something else, a program that is not there said before any confirm (and the connection "needs attention" with the
// app's download page), the process tree ended by its PID, and ego lite opened from its Start Menu shortcut. Found in a
// real Windows 11 test of desktop 0.15.0 (QA TC-8410, 8411, 8413-8416, 8806, 8807).
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { LOCAL_APP_PRESETS, LocalResult, localCommandLines, presetOf, splitCommand, type LocalAppSpec, type LocalCall } from '@mycel/shared/api'
import { commandHash, defaultSearchPath, EGO_BUNDLE_ID, EGO_SHORTCUT, findStartMenuShortcut, LocalApps } from '../../desktop/src/common/local-apps'
import { cmdLaunch, launchFor, pathExts, readNpmShim, resolveProgram, type ProgramHost } from '../../desktop/src/common/programs'
import { LocalError, localTransport } from '../../server/src/integrations/connections/local'
import { reasonText } from '../../server/src/integrations/connections/text'

// ---------------------------------------------------------------- the command line a person types

describe('splitCommand, Windows', () => {
  const win = (l: string) => splitCommand(l, 'windows')
  test('a pasted path keeps its backslashes (it was C:TrinaQAbinfake-mcp.exe)', () => {
    expect(win('C:\\TrinaQA\\bin\\fake-mcp.exe')).toEqual(['C:\\TrinaQA\\bin\\fake-mcp.exe'])
    expect(win('C:\\TrinaQA\\bin\\fake-mcp.exe --port 3 C:\\data\\x.json')).toEqual(['C:\\TrinaQA\\bin\\fake-mcp.exe', '--port', '3', 'C:\\data\\x.json'])
    expect(win('\\\\server\\share\\tool.exe serve')).toEqual(['\\\\server\\share\\tool.exe', 'serve'])
  })
  test('quotes group, "" inside is one ", and \' is an ordinary character', () => {
    expect(win('"C:\\Program Files\\Aside\\aside.exe" mcp')).toEqual(['C:\\Program Files\\Aside\\aside.exe', 'mcp'])
    expect(win('tool "say ""hi""" C:\\Users\\O\'Brien\\x')).toEqual(['tool', 'say "hi"', 'C:\\Users\\O\'Brien\\x'])
    expect(win('C:\\"Program Files"\\x.exe')).toEqual(['C:\\Program Files\\x.exe'])
    expect(win('"C:\\dir\\" a')).toEqual(['C:\\dir\\', 'a'])
  })
  test('an unquoted path with spaces is one program, up to its .exe/.cmd/.bat/.com', () => {
    expect(win('C:\\Program Files\\Aside\\aside.exe mcp')).toEqual(['C:\\Program Files\\Aside\\aside.exe', 'mcp'])
    expect(win('C:\\Program Files (x86)\\Tool Co\\tool.cmd --flag "a b"')).toEqual(['C:\\Program Files (x86)\\Tool Co\\tool.cmd', '--flag', 'a b'])
    // the .exe of a later argument is not the program
    expect(win('C:\\tools\\mytool --in C:\\x\\y.exe')).toEqual(['C:\\tools\\mytool', '--in', 'C:\\x\\y.exe'])
    expect(win('C:\\tools\\mytool C:\\x y.exe')).toEqual(['C:\\tools\\mytool', 'C:\\x', 'y.exe'])
  })
  test('what cmd would read is refused outside quotes; ( ) and $ are ordinary', () => {
    for (const l of ['a | b', 'a & b', 'a && b', 'a > out', 'a < in', 'a ^& b', 'a;b', '%USERPROFILE%\\x.exe', 'a %PATH%', '"unclosed', 'C:\\Program Files\\a&b\\x.exe']) expect(win(l)).toBeNull()
    expect(win('npx @playwright/mcp@latest')).toEqual(['npx', '@playwright/mcp@latest'])
    expect(win('tool "a & b" "50%"')).toEqual(['tool', 'a & b', '50%'])
    expect(win('tool $HOME (x)')).toEqual(['tool', '$HOME', '(x)'])
    expect(win('   ')).toBeNull()
  })
  test('POSIX (macOS, Linux) unchanged', () => {
    expect(splitCommand('aside mcp')).toEqual(['aside', 'mcp'])
    expect(splitCommand('a\\ b \'c d\' "e\\"f"')).toEqual(['a b', 'c d', 'e"f'])
    expect(splitCommand('C:\\x\\y.exe')).toEqual(['C:xy.exe'])
    for (const l of ['a | b', 'a $(b)', 'a `b`', "'x"]) expect(splitCommand(l)).toBeNull()
  })
  test('the confirm and Settings show a Windows command Windows\' way', () => {
    const s: LocalAppSpec = { adapter: 'mcp', command: 'C:\\Program Files\\Aside\\aside.exe', args: ['mcp', 'a b', 'say "hi"'], env: [] }
    expect(localCommandLines(s)).toEqual(['"C:\\Program Files\\Aside\\aside.exe" mcp "a b" "say ""hi"""'])
    expect(localCommandLines({ ...s, command: 'aside', args: ['mcp'] }, 'windows')).toEqual(['aside mcp'])
    expect(localCommandLines({ ...s, command: 'C:\\x\\fake-mcp.exe', args: [] })).toEqual(['C:\\x\\fake-mcp.exe'])
    // what it shows reads back as the same command
    expect(splitCommand(localCommandLines(s)[0]!, 'windows')).toEqual([s.command, ...s.args])
  })
})

// ---------------------------------------------------------------- finding the program

/** a Windows computer with these files (paths compared without case, as Windows does) */
function winHost(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): Partial<ProgramHost> {
  const at = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    platform: 'win32', home: 'C:\\Users\\qa', env: { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1', SystemRoot: 'C:\\Windows', ...env },
    isFile: (p) => at.has(p.toLowerCase()), isExecutable: () => true,
    readText: (p) => at.get(p.toLowerCase()) ?? null,
  }
}

describe('resolveProgram, Windows (PATH + PATHEXT)', () => {
  const dirs = ['C:\\Users\\qa\\AppData\\Roaming\\npm', 'C:\\Program Files\\nodejs']
  test('PATHEXT order, never a bare file without an ending (npm\'s sh script beside its .cmd)', () => {
    const h = winHost({ 'C:\\Users\\qa\\AppData\\Roaming\\npm\\aside': '#!/bin/sh', 'C:\\Users\\qa\\AppData\\Roaming\\npm\\aside.cmd': '', 'C:\\Users\\qa\\AppData\\Roaming\\npm\\aside.ps1': '' })
    expect(resolveProgram('aside', dirs, h)).toBe('C:\\Users\\qa\\AppData\\Roaming\\npm\\aside.cmd')
    const both = winHost({ 'C:\\Program Files\\nodejs\\tool.exe': '', 'C:\\Program Files\\nodejs\\tool.cmd': '' })
    expect(resolveProgram('tool', dirs, both)).toBe('C:\\Program Files\\nodejs\\tool.exe')
    // the person's PATHEXT order counts
    expect(resolveProgram('tool', dirs, { ...both, env: { PATHEXT: '.CMD;.EXE' } })).toBe('C:\\Program Files\\nodejs\\tool.cmd')
    // the first folder in PATH that has it
    expect(resolveProgram('tool', ['C:\\a', 'C:\\b'], winHost({ 'C:\\b\\tool.exe': '', 'C:\\a\\tool.bat': '' }))).toBe('C:\\a\\tool.bat')
  })
  test('a name with its ending, a full path (spaces, forward slashes, ~\\), never a relative path', () => {
    const h = winHost({ 'C:\\Program Files\\nodejs\\npx.cmd': '', 'C:\\Program Files\\Aside\\aside.exe': '', 'C:\\Users\\qa\\bin\\x.exe': '' })
    expect(resolveProgram('npx.cmd', dirs, h)).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(resolveProgram('npx', dirs, h)).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(resolveProgram('C:\\Program Files\\Aside\\aside.exe', [], h)).toBe('C:\\Program Files\\Aside\\aside.exe')
    expect(resolveProgram('C:\\Program Files\\Aside\\aside', [], h)).toBe('C:\\Program Files\\Aside\\aside.exe')
    expect(resolveProgram('C:/Program Files/Aside/aside.exe', [], h)).toBe('C:\\Program Files\\Aside\\aside.exe')
    expect(resolveProgram('~\\bin\\x.exe', [], h)).toBe('C:\\Users\\qa\\bin\\x.exe')
    expect(resolveProgram('bin\\x.exe', ['C:\\Users\\qa'], h)).toBeNull()
    expect(resolveProgram('x', ['bin', '.'], winHost({ 'bin\\x.exe': '', '.\\x.exe': '' }))).toBeNull()
    expect(resolveProgram('aside', dirs, winHost())).toBeNull()
    // a file with an ending PATHEXT does not list: found as it is (then refused as a kind Windows does not start)
    const ps = winHost({ 'C:\\t\\tool.ps1': '' }, { PATHEXT: '.COM;.EXE;.BAT;.CMD' })
    expect(resolveProgram('C:\\t\\tool.ps1', [], ps)).toBe('C:\\t\\tool.ps1')
    expect(resolveProgram('tool.ps1', ['C:\\t'], ps)).toBe('C:\\t\\tool.ps1')
    expect(resolveProgram('tool', ['C:\\t'], ps)).toBeNull()
  })
  test('PATHEXT: the person\'s endings, Windows\' own when unset; PATH split on ; for Windows', () => {
    expect(pathExts({ PATHEXT: '.EXE;;.CMD;bad;.exe' })).toEqual(['.exe', '.cmd'])
    expect(pathExts({})).toEqual(['.com', '.exe', '.bat', '.cmd'])
    expect(defaultSearchPath({ PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }, 'C:\\Users\\qa', 'win32')).toEqual(['C:\\Windows\\System32', 'C:\\Program Files\\nodejs'])
  })
})

// ---------------------------------------------------------------- starting it

/** cmd-shim's shim, as npm writes it for a package's bin (npm 7+) */
const CMD_SHIM = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n')
/** npm's own npx.cmd beside node.exe */
const NPX_CMD = [
  ':: Created by npm, please don\'t edit manually.', '@ECHO OFF', '', 'SETLOCAL', '', 'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')', '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"', 'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (', '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ')', '', '"%NODE_EXE%" "%NPX_CLI_JS%" %*', '',
].join('\r\n')
const NPM = 'C:\\Users\\qa\\AppData\\Roaming\\npm'
const NODEJS = 'C:\\Program Files\\nodejs'

describe('npm shims run as node and their script, with no shell', () => {
  test('an npm-installed program (cmd-shim): node.exe from PATH and the package\'s script, then the arguments as they are', () => {
    const h = winHost({ [`${NPM}\\aside.cmd`]: CMD_SHIM('node_modules\\@aside\\cli\\bin\\aside.js'), [`${NPM}\\node_modules\\@aside\\cli\\bin\\aside.js`]: '', [`${NODEJS}\\node.exe`]: '' }, { PATH: `${NPM};${NODEJS}` })
    expect(readNpmShim(`${NPM}\\aside.cmd`, h)).toEqual({ file: `${NODEJS}\\node.exe`, args: [`${NPM}\\node_modules\\@aside\\cli\\bin\\aside.js`] })
    expect(launchFor(`${NPM}\\aside.cmd`, ['mcp', 'a&b', '"q"', '%PATH%'], h)).toEqual({ file: `${NODEJS}\\node.exe`, args: [`${NPM}\\node_modules\\@aside\\cli\\bin\\aside.js`, 'mcp', 'a&b', '"q"', '%PATH%'], via: 'npm' })
    // a node.exe beside the shim comes first
    const beside = winHost({ ...Object.fromEntries(Object.entries({ [`${NPM}\\t.cmd`]: CMD_SHIM('t.js'), [`${NPM}\\t.js`]: '', [`${NPM}\\node.exe`]: '', [`${NODEJS}\\node.exe`]: '' })) }, { PATH: NODEJS })
    expect(readNpmShim(`${NPM}\\t.cmd`, beside)?.file).toBe(`${NPM}\\node.exe`)
  })
  test('npx.cmd (npm\'s own): node.exe beside it and npx-cli.js', () => {
    const h = winHost({ [`${NODEJS}\\npx.cmd`]: NPX_CMD, [`${NODEJS}\\node.exe`]: '', [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`]: '' })
    expect(launchFor(`${NODEJS}\\npx.cmd`, ['-y', '@playwright/mcp@latest'], h)).toEqual({ file: `${NODEJS}\\node.exe`, args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, '-y', '@playwright/mcp@latest'], via: 'npm' })
  })
  test('not a shim it can read: null (no node, a script that is not there, another runtime, a hand-written batch)', () => {
    expect(readNpmShim(`${NPM}\\a.cmd`, winHost({ [`${NPM}\\a.cmd`]: CMD_SHIM('a.js'), [`${NPM}\\a.js`]: '' }, { PATH: 'C:\\none' }))).toBeNull()
    expect(readNpmShim(`${NPM}\\a.cmd`, winHost({ [`${NPM}\\a.cmd`]: CMD_SHIM('missing.js'), [`${NODEJS}\\node.exe`]: '' }, { PATH: NODEJS }))).toBeNull()
    const sh = CMD_SHIM('a').replace('SET "_prog=%dp0%\\node.exe"', 'SET "_prog=%dp0%\\sh.exe"').replace('SET "_prog=node"', 'SET "_prog=sh"')
    expect(readNpmShim(`${NPM}\\a.cmd`, winHost({ [`${NPM}\\a.cmd`]: sh, [`${NPM}\\a`]: '', [`${NPM}\\sh.exe`]: '' }))).toBeNull()
    expect(readNpmShim('C:\\t\\run.bat', winHost({ 'C:\\t\\run.bat': '@echo off\r\npython C:\\t\\run.py %*\r\n' }))).toBeNull()
    expect(readNpmShim('C:\\t\\evil.cmd', winHost({ 'C:\\t\\evil.cmd': '"%dp0%\\x.js" & calc %*', 'C:\\t\\x.js': '' }))).toBeNull()
  })
})

describe('any other .cmd/.bat: cmd.exe, only with arguments it cannot read as something else', () => {
  const h = winHost({ 'C:\\t\\run.bat': '@echo off\r\npython C:\\t\\run.py %*\r\n' }) as ProgramHost
  test('cmd.exe /d /s /v:off /c "…" from System32, the line as it is (verbatim), plain arguments bare, others in "…"', () => {
    expect(launchFor('C:\\t\\run.bat', ['serve', '--port=3', 'a b', 'x&y', '(z)', ''], h)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/v:off', '/c', '""C:\\t\\run.bat" serve "--port=3" "a b" "x&y" "(z)" """'], verbatim: true, via: 'cmd',
    })
  })
  test('refused, never escaped: " % ! ^ and line breaks, in an argument or the path', () => {
    for (const bad of ['"', 'a"&calc', '%PATH%', '50%', '!x!', 'a^b', 'a\nb', 'a\rb', 'tab\there']) {
      const l = cmdLaunch('C:\\t\\run.bat', ['ok', bad], h)
      expect('refused' in l && l.refused).toBe('unsafe_arg')
    }
    expect('refused' in cmdLaunch('C:\\t\\100%\\run.bat', [], h)).toBe(true)
  })
  test('.exe and .com start directly; .ps1, .js and the rest are not started; macOS and Linux as they are', () => {
    expect(launchFor('C:\\x\\a.exe', ['"q"'], h)).toEqual({ file: 'C:\\x\\a.exe', args: ['"q"'] })
    expect(launchFor('C:\\x\\a.com', [], h)).toEqual({ file: 'C:\\x\\a.com', args: [] })
    for (const f of ['C:\\x\\a.ps1', 'C:\\x\\a.js', 'C:\\x\\a.vbs']) expect(launchFor(f, [], h)).toMatchObject({ refused: 'unsupported' })
    expect(launchFor('/usr/local/bin/aside', ['mcp'], { platform: 'darwin' })).toEqual({ file: '/usr/local/bin/aside', args: ['mcp'] })
  })
})

// ---------------------------------------------------------------- the manager on Windows

/** a child process that answers what `answer` says to its stdin lines (an MCP server), or exits with `exit` */
function fakeChild(o: { stdout?: string; stderr?: string; exit?: number; mcp?: boolean }) {
  const c = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: (s?: string) => boolean; killed: string[] }
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 4242; c.killed = []
  c.kill = (s) => { c.killed.push(String(s ?? 'SIGTERM')); setTimeout(() => c.emit('exit', null, 'SIGTERM'), 1); return true }
  if (o.mcp) {
    let buf = ''
    c.stdin.on('data', (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        if (m.id === undefined) continue
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
      }
    })
  } else {
    setTimeout(() => { if (o.stdout) c.stdout.write(o.stdout); if (o.stderr) c.stderr.write(o.stderr); c.stdout.end(); c.stderr.end(); setTimeout(() => c.emit('exit', o.exit ?? 0, null), 1) }, 1)
  }
  return c
}

function winManager(files: Record<string, string>, o: { confirmed?: LocalAppSpec; child?: (file: string, args: readonly string[]) => ReturnType<typeof fakeChild>; openApp?: () => Promise<boolean> } = {}) {
  const asked: { id: string; lines: string[]; program: string }[] = []
  const spawned: { file: string; args: readonly string[]; opts: Record<string, unknown> }[] = []
  const killed: number[] = []
  const opened: string[] = []
  const apps = new LocalApps({
    confirm: async (c) => { asked.push(c); return true }, confirmed: () => (o.confirmed ? commandHash(o.confirmed) : null), setConfirmed: () => {}, settings: () => ({}), isRoot: () => false,
    platform: 'win32', programHost: winHost(files, { PATH: `${NPM};${NODEJS}` }), searchPath: () => [NPM, NODEJS, 'C:\\ego'], locale: () => 'en',
    spawn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => { spawned.push({ file, args, opts }); return (o.child ?? (() => fakeChild({ mcp: true })))(file, args) }) as never,
    killTree: (pid) => { killed.push(pid) },
    openApp: o.openApp ? async (id) => { opened.push(id); return o.openApp!() } : undefined,
    sleep: async () => {},
  })
  let n = 0
  const call = (spec: LocalAppSpec, message: Record<string, unknown>, c: Partial<LocalCall> = {}) => apps.call('team', { callId: `w-${++n}`, turnId: null, connectionId: 'conn-w', name: 'Aside', spec, message, deadline: Date.now() + 5000, ...c })
  return { apps, asked, spawned, killed, opened, call }
}
const INIT = { jsonrpc: '2.0', id: 'i1', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
const ASIDE = LOCAL_APP_PRESETS.find((p) => p.id === 'aside')!.spec
const EGO = LOCAL_APP_PRESETS.find((p) => p.id === 'ego-lite')!.spec

describe('the desktop app on Windows', () => {
  test('Aside not installed: no confirm, start_failed with cause not_found (never Connected); the same for ego lite\'s CLI', async () => {
    const w = winManager({})
    const r = await w.call(ASIDE, INIT)
    expect(r).toMatchObject({ ok: false, failure: 'start_failed', cause: 'not_found' })
    expect(r.error).toContain('aside was not found')
    expect(w.asked).toHaveLength(0)
    expect(w.spawned).toHaveLength(0)
    // a declared CLI answers initialize itself: it still says the program is not there
    expect(await w.call(EGO, INIT)).toMatchObject({ ok: false, cause: 'not_found' })
    expect(LocalResult.parse(r).cause).toBe('not_found')
  })
  test('a .ps1: not started, cause unsupported, no confirm', async () => {
    const w = winManager({ [`${NPM}\\tool.ps1`]: '' })
    const r = await w.call({ adapter: 'mcp', command: 'tool.ps1', args: [], env: [] }, INIT)
    expect(r).toMatchObject({ ok: false, failure: 'start_failed', cause: 'unsupported' })
    expect(w.asked).toHaveLength(0)
  })
  test('npm-installed Aside (aside.cmd): the confirm shows the command Windows\' way and the .cmd; it runs as node + script, no shell', async () => {
    const w = winManager({ [`${NPM}\\aside.cmd`]: CMD_SHIM('node_modules\\aside\\cli.js'), [`${NPM}\\node_modules\\aside\\cli.js`]: '', [`${NODEJS}\\node.exe`]: '' })
    const r = await w.call(ASIDE, INIT)
    expect(r.ok).toBe(true)
    expect(w.asked).toEqual([expect.objectContaining({ id: 'conn-w', lines: ['aside mcp'], program: `${NPM}\\aside.cmd` })])
    expect(w.spawned).toHaveLength(1)
    expect(w.spawned[0]).toMatchObject({ file: `${NODEJS}\\node.exe`, args: [`${NPM}\\node_modules\\aside\\cli.js`, 'mcp'] })
    expect(w.spawned[0]!.opts).toMatchObject({ shell: false, windowsHide: true, detached: false })
    expect(w.spawned[0]!.opts.windowsVerbatimArguments).toBeUndefined()
    // Stop: the tree under the PID it started (taskkill /T /F), never by name
    w.apps.stop('team', 'conn-w')
    expect(w.killed).toEqual([4242])
  })
  test('a pasted path with spaces to a hand-written .bat: cmd.exe /d /s /v:off /c, verbatim', async () => {
    const bat = 'C:\\Program Files\\Tool Co\\serve.bat'
    const argv = splitCommand(`${bat} --stdio`, 'windows')!
    expect(argv).toEqual([bat, '--stdio'])
    const w = winManager({ [bat]: '@echo off\r\nC:\\tool\\srv.exe %*\r\n' })
    const r = await w.call({ adapter: 'mcp', command: argv[0]!, args: argv.slice(1), env: [] }, INIT)
    expect(r.ok).toBe(true)
    expect(w.spawned[0]).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/v:off', '/c', `""${bat}" --stdio"`] })
    expect(w.spawned[0]!.opts).toMatchObject({ shell: false, windowsVerbatimArguments: true })
  })
  test('a CLI tool through a batch file: an AI value cmd would read is refused as that call\'s error, nothing runs, the connection stays', async () => {
    const spec: LocalAppSpec = { adapter: 'cli', command: 'runner', env: [], tools: [{ name: 'run', description: 'r', args: ['go', { slot: 'q' }], slots: [{ name: 'q', description: 'q', type: 'string', required: true }], readOnly: false }] }
    const w = winManager({ [`${NPM}\\runner.bat`]: '@echo off\r\nC:\\r\\r.exe %*\r\n' }, { child: () => fakeChild({ stdout: 'done' }) })
    const bad = await w.call(spec, { jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'run', arguments: { q: '"&calc&"' } } })
    expect(bad.ok).toBe(true)
    const res = bad.message!.result as { isError: boolean; content: { text: string }[] }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('cmd.exe would read')
    expect(w.spawned).toHaveLength(0)
    const good = await w.call(spec, { jsonrpc: '2.0', id: 'c2', method: 'tools/call', params: { name: 'run', arguments: { q: 'a & b' } } })
    expect((good.message!.result as { isError: boolean }).isError).toBe(false)
    expect(w.spawned[0]!.args.at(-1)).toBe(`""${NPM}\\runner.bat" go "a & b""`)
  })
  test('ego lite closed: opened (Start Menu shortcut on Windows), then the call once more', async () => {
    const BOOT = 'Failed to connect to ego_cli bootstrap'
    let up = false
    const w = winManager({ 'C:\\ego\\ego-browser.exe': '' }, { confirmed: EGO, openApp: async () => { up = true; return true }, child: () => (up ? fakeChild({ stdout: 'ran' }) : fakeChild({ stderr: BOOT, exit: 5 })) })
    const r = await w.call(EGO, { jsonrpc: '2.0', id: 'e1', method: 'tools/call', params: { name: 'run_script', arguments: { script: 'console.log(1)' } } })
    expect(w.opened).toEqual([EGO_BUNDLE_ID])
    expect(w.spawned.map((s) => s.file)).toEqual(['C:\\ego\\ego-browser.exe', 'C:\\ego\\ego-browser.exe'])
    expect((r.message!.result as { content: { text: string }[] }).content[0]!.text).toBe('ran')
    // no shortcut: the plain words to open it
    const none = winManager({ 'C:\\ego\\ego-browser.exe': '' }, { confirmed: EGO, openApp: async () => false, child: () => fakeChild({ stderr: BOOT, exit: 5 }) })
    const r2 = await none.call(EGO, { jsonrpc: '2.0', id: 'e2', method: 'tools/call', params: { name: 'run_script', arguments: { script: 'x' } } })
    expect(JSON.stringify(r2.message)).toContain("ego lite isn't open")
  })
  test('the Start Menu shortcut: the person\'s own first, then everyone\'s, two folders deep', () => {
    const tree: Record<string, { name: string; dir: boolean }[]> = {
      'C:\\Users\\qa\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs': [{ name: 'Tools', dir: true }, { name: 'Other.lnk', dir: false }],
      'C:\\Users\\qa\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Tools': [{ name: 'ego lite.lnk', dir: false }],
    }
    const env = { APPDATA: 'C:\\Users\\qa\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' }
    expect(findStartMenuShortcut(EGO_SHORTCUT, { env, list: (d) => tree[d] ?? [] })).toBe('C:\\Users\\qa\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Tools\\ego lite.lnk')
    expect(findStartMenuShortcut(EGO_SHORTCUT, { env, list: () => [] })).toBeNull()
  })
})

// ---------------------------------------------------------------- the server's words and the connection's state

describe('the server: a program that is not there needs attention, with where to get it', () => {
  const relay = (r: Partial<LocalResult>) => ({ windowAlive: () => true, call: async () => ({ callId: 'x', ok: false, ...r }) }) as never
  const send = (spec: LocalAppSpec, r: Partial<LocalResult>) => localTransport({ relay: relay(r), userId: 'u', via: { windowId: 'w', turnId: null }, row: { id: 'c', name: spec.command === 'aside' ? 'Aside' : 'Tool' }, spec })('https://local-app.invalid/c', { method: 'POST', headers: [], body: Buffer.from(JSON.stringify(INIT)) } as never)
  test('not_found: reason local_missing, the AI gets plain words and, for a listed app, its download page', async () => {
    const e = await send(ASIDE, { failure: 'start_failed', cause: 'not_found', error: 'aside was not found on this computer' }).catch((x) => x)
    expect(e).toBeInstanceOf(LocalError)
    expect(e.reason).toBe('local_missing')
    expect(e.message).toContain('https://aside.com/download')
    expect(e.message).toContain('not installed')
    const typed = await send({ adapter: 'mcp', command: 'C:\\x\\tool.exe', args: [], env: [] }, { failure: 'start_failed', cause: 'not_found' }).catch((x) => x)
    expect(typed.reason).toBe('local_missing')
    expect(typed.message).not.toContain('download')
    // without a cause (an older desktop app): as before
    expect((await send(ASIDE, { failure: 'start_failed', error: 'spawn EINVAL' }).catch((x) => x)).reason).toBe('local_failed')
  })
  test('the words Settings shows, in each language, and the listed apps\' download pages', () => {
    expect(reasonText('local_missing', 'en', undefined, 'Aside')).toBe('Aside isn’t installed on this computer. Install it, then press Check again.')
    expect(reasonText('local_missing', 'ko', undefined, 'Aside')).toContain('이 컴퓨터에 설치되어 있지 않아요')
    for (const L of ['id', 'ja', 'es', 'zh'] as const) expect(reasonText('local_missing', L, undefined, 'Aside')).toContain('Aside')
    expect(presetOf(ASIDE)?.download).toBe('https://aside.com/download')
    expect(presetOf(EGO)?.download).toBe('https://lite.ego.app/download')
    expect(presetOf({ adapter: 'mcp', command: 'aside', args: ['mcp', '--x'], env: [] })).toBeNull()
  })
})
