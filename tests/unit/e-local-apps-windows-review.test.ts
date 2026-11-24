// Security review of #515 (command parsing and cmd.exe on Windows): adversarial cases for the cmd.exe fallback (each
// value is refused or reaches cmd only inside quotes; a 20 000-case fuzz), program lookup (no current folder, no
// relative PATH entries, no network shares or device paths: not even a file check, which would send this computer's
// sign-in to that server), and npm shims that try to route through a shell.
import { describe, expect, test } from 'bun:test'
import { cmdLaunch, launchFor, readNpmShim, resolveProgram, SHARE_REFUSED, windowsShare, type ProgramHost } from '../../desktop/src/common/programs'
import { splitCommand } from '../../shared/src/api/local-apps'
import { programName } from '../../server/src/integrations/connections/local'

const host = (files: Record<string, string> = {}, env: Record<string, string> = {}): ProgramHost => ({
  platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env }, home: 'C:\\Users\\u',
  isFile: (p) => Object.keys(files).some((f) => f.toLowerCase() === p.toLowerCase()),
  isExecutable: () => true,
  readText: (p) => { const k = Object.keys(files).find((f) => f.toLowerCase() === p.toLowerCase()); return k ? files[k]! : null },
})

// cmd.exe /s /c "<line>": strip first and last quote, then walk quote state; return chars cmd would treat as operators
function cmdOperatorsOutsideQuotes(verbatimLast: string): string[] {
  expect(verbatimLast.startsWith('"') && verbatimLast.endsWith('"')).toBe(true)
  const line = verbatimLast.slice(1, -1)
  const bad: string[] = []
  let q = false
  for (const ch of line) {
    if (ch === '"') { q = !q; continue }
    if ('%!'.includes(ch)) bad.push(ch) // expanded even in quotes
    if (!q && '&|<>()^,;='.includes(ch) ) bad.push(ch)
    if (ch === '\n' || ch === '\r') bad.push('NL')
  }
  if (q) bad.push('unbalanced')
  return bad
}

const payloads = [
  'a&calc', 'a|calc', 'a>x', 'a<x', '(calc)', 'a^&calc', '%PATH%', '!PATH!', '"&calc', 'a"&calc&"', 'x\\"&calc',
  'a b\\', 'a\\', '\\\\', 'a\nb', 'a\rcalc', '\u001acalc', '', ' ', '&', '"', '""', 'a,b', 'a;b', 'a=b', '/?', '@calc',
  'C:\\dir\\', 'x\u2028y', '＂&calc', 'a\tb', '%%', '%~dp0', 'x%', 'x!', '^', 'a&&calc', '||calc',
]

describe('cmdLaunch adversarial', () => {
  test('each payload is refused or reaches cmd only inside quotes', () => {
    const h = host()
    for (const p of payloads) {
      for (const args of [[p], ['ok', p], [p, 'x y'], ['a b\\', p]]) {
        const l = cmdLaunch('C:\\T&x\\tool.cmd', args, h)
        if ('refused' in l) continue
        expect(l.file).toBe('C:\\Windows\\System32\\cmd.exe')
        const bad = cmdOperatorsOutsideQuotes(l.args.at(-1)!)
        if (bad.length) throw new Error(`payload ${JSON.stringify(args)} → ${l.args.at(-1)} bad ${bad}`)
      }
    }
  })
  test('program path with % or ! refused', () => {
    expect('refused' in cmdLaunch('C:\\%x%\\t.cmd', [], host())).toBe(true)
    expect('refused' in cmdLaunch('C:\\a!b\\t.cmd', [], host())).toBe(true)
  })
  test('random fuzz', () => {
    const alpha = 'a b"&|<>()^%!\\,;=\t\n/:@-_.~+*?\'`$'
    let seed = 7
    const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 20000; i++) {
      const n = Math.floor(r() * 3) + 1
      const args = Array.from({ length: n }, () => Array.from({ length: Math.floor(r() * 8) }, () => alpha[Math.floor(r() * alpha.length)]).join(''))
      const l = cmdLaunch('C:\\T\\tool.cmd', args, host())
      if ('refused' in l) continue
      const bad = cmdOperatorsOutsideQuotes(l.args.at(-1)!)
      if (bad.length) throw new Error(`${JSON.stringify(args)} → ${l.args.at(-1)} ${bad}`)
    }
  })
})

describe('resolution', () => {
  test('never CWD / relative PATH entries; no bare extensionless file', () => {
    const h = host({ 'tool': '', '.\\tool.exe': '', 'C:\\bin\\tool': '#!/bin/sh', 'C:\\bin\\tool.cmd': '' })
    expect(resolveProgram('tool', ['.', '', 'bin', 'C:\\bin'], h)).toBe('C:\\bin\\tool.cmd')
    expect(resolveProgram('.\\tool.exe', ['C:\\bin'], h)).toBeNull()
    expect(resolveProgram('..\\tool.exe', ['C:\\bin'], h)).toBeNull()
  })
  test('PATHEXT with odd values', () => {
    const h = host({ 'C:\\bin\\tool.js': '', 'C:\\bin\\tool.cmd': '' }, { PATHEXT: '.JS;.CMD' })
    const p = resolveProgram('tool', ['C:\\bin'], h)
    expect(p).toBe('C:\\bin\\tool.js')
    expect('refused' in launchFor(p!, [], h)).toBe(true)
    const h2 = host({ 'C:\\bin\\tool.exe': '' }, { PATHEXT: ';;..;.e x e;' })
    expect(resolveProgram('tool', ['C:\\bin'], h2)).toBe('C:\\bin\\tool.exe')
  })
  test('network shares and device paths: refused before any file check (no NTLM leak), as a program or a PATH folder', () => {
    const seen: string[] = []
    const h = { ...host({ '\\\\evil.example\\s\\t.exe': '' }), isFile: (p: string) => { seen.push(p); return false } }
    for (const c of ['\\\\evil.example\\s\\t.exe', '\\\\evil.example\\s\\t', '\\\\?\\UNC\\evil.example\\s\\t.exe', '\\\\.\\pipe\\x', '//evil.example/s/t.exe', ' \\\\evil.example\\s\\t.exe']) {
      expect(resolveProgram(c, [], h)).toBeNull()
      expect(windowsShare(c)).toBe(true)
    }
    expect(resolveProgram('tool', ['\\\\evil.example\\bin', '//evil.example/bin'], h)).toBeNull()
    expect(seen).toEqual([])
    expect(SHARE_REFUSED('\\\\evil.example\\s\\t.exe')).toContain('Only programs on this computer')
  })
})

describe('npm shim', () => {
  test('shim cannot route to cmd.exe beside it with %* (flag-only rule)', () => {
    const files = { 'C:\\n\\x.cmd': '@ECHO off\r\n"%dp0%\\..\\Windows\\System32\\cmd.exe" /c %*\r\n', 'C:\\Windows\\System32\\cmd.exe': '' }
    expect(readNpmShim('C:\\n\\x.cmd', host(files))).toBeNull()
  })
  test('shim naming a powershell.exe beside it with a -Command flag', () => {
    const files = { 'C:\\n\\x.cmd': '"%dp0%\\powershell.exe" -Command %*\r\n', 'C:\\n\\powershell.exe': '' }
    // an .exe beside the shim with a plain flag is allowed (the person installed both); never cmd.exe through %*
    expect(readNpmShim('C:\\n\\x.cmd', host(files))).toEqual({ file: 'C:\\n\\powershell.exe', args: ['-Command'] })
  })
  test('real cmd-shim', () => {
    const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\aside\\bin\\cli.js" %*\r\n'
    const files = { 'C:\\n\\aside.cmd': shim, 'C:\\n\\node_modules\\aside\\bin\\cli.js': '', 'C:\\nodejs\\node.exe': '' }
    expect(readNpmShim('C:\\n\\aside.cmd', host(files, { PATH: 'C:\\nodejs' }))).toEqual({ file: 'C:\\nodejs\\node.exe', args: ['C:\\n\\node_modules\\aside\\bin\\cli.js'] })
    // a .\ relative PATH entry with node.exe planted: must not be used
    const files2 = { ...files, '.\\node.exe': '' }
    expect(readNpmShim('C:\\n\\aside.cmd', host(files2, { PATH: '.;C:\\nodejs' }))?.file).toBe('C:\\nodejs\\node.exe')
    // node.exe on a share in PATH: skipped
    expect(readNpmShim('C:\\n\\aside.cmd', host({ ...files, '\\\\evil\\s\\node.exe': '' }, { PATH: '\\\\evil\\s;C:\\nodejs' }))?.file).toBe('C:\\nodejs\\node.exe')
  })
})

describe('split windows', () => {
  test('cases', () => {
    // quoted text is literal; outside quotes & and ^ are refused; % and ! are ordinary unless a %NAME% pair
    const out = Object.fromEntries(['C:\\Program Files\\x.exe "%PATH%"', 'tool "a&calc"', 'tool "a"&calc', 'tool a"&"calc', 'tool "a""&calc"', 'tool %x', 'tool 100%', 'tool !x!', 'tool "x" ^', 'C:\\a b\\x.exe&calc.exe'].map((l) => [l, splitCommand(l, 'windows')]))
    expect(out).toEqual({
      'C:\\Program Files\\x.exe "%PATH%"': ['C:\\Program Files\\x.exe', '%PATH%'],
      'tool "a&calc"': ['tool', 'a&calc'],
      'tool "a"&calc': null,
      'tool a"&"calc': ['tool', 'a&calc'],
      'tool "a""&calc"': ['tool', 'a"&calc'],
      'tool %x': ['tool', '%x'],
      'tool 100%': ['tool', '100%'],
      'tool !x!': ['tool', '!x!'],
      'tool "x" ^': null,
      'C:\\a b\\x.exe&calc.exe': null,
    })
  })
})

describe('review fixes', () => {
  test('cmd.exe launches never look in the current folder first (NoDefaultCurrentDirectoryInExePath)', () => {
    const l = cmdLaunch('C:\\T\\tool.cmd', ['x'], host())
    expect('env' in l && l.env).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' })
    expect('env' in launchFor('C:\\T\\a.exe', [], host()) && (launchFor('C:\\T\\a.exe', [], host()) as { env?: unknown }).env).toBeFalsy()
  })
  test('the AI\'s "not installed" words carry the program\'s name, never its saved folder', () => {
    expect(programName('C:\\Users\\qa\\secret-folder\\tool.exe')).toBe('tool.exe')
    expect(programName('/Users/qa/bin/aside')).toBe('aside')
    expect(programName('aside')).toBe('aside')
  })
})
