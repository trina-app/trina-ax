// The page render's LibreOffice profile and its seccomp step (files/office-profile.ts, tools/isolate.ts;
// docs/decisions/20261124-documents-mode.md): one font table and macros off on every install, the kit's fonts linked
// in where they are not system fonts, and the product's seccomp filter inside bwrap where the server has the helper.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FONT_REPLACEMENTS, kitFontsDir, profileXcu, writeOfficeProfile } from '../../server/src/files/office-profile'
import { isolatedCommand, sandboxHelper } from '../../server/src/tools/isolate'

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-profile-')))

describe('the render profile', () => {
  test('one table: Office fonts to the kit\'s, every Asian Office font to Noto CJK; macros off', () => {
    const map = new Map(FONT_REPLACEMENTS)
    expect(map.get('Calibri')).toBe('Carlito')
    expect(map.get('Cambria')).toBe('Caladea')
    expect(map.get('Malgun Gothic')).toBe('Noto Sans CJK KR')
    expect(map.get('MS Mincho')).toBe('Noto Serif CJK JP')
    expect(map.get('Microsoft YaHei')).toBe('Noto Sans CJK SC')
    for (const [, to] of FONT_REPLACEMENTS) expect(to).toMatch(/^(Carlito|Caladea|Liberation (Sans|Serif|Mono)|Noto (Sans|Serif) CJK (KR|JP|SC|TC))$/)
    const x = profileXcu()
    expect(x).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>')
    expect(x).toContain('<prop oor:name="ReplaceFont" oor:op="fuse"><value>맑은 고딕</value></prop>')
    expect(x.match(/oor:name="_\d+"/g)!.length).toBe(FONT_REPLACEMENTS.length)
  })

  test('the profile is made in the work folder; the kit\'s font files are linked in, nothing else', () => {
    const w = tmp(), fonts = tmp()
    fs.writeFileSync(path.join(fonts, 'NotoSansCJKkr-Regular.otf'), 'x')
    fs.writeFileSync(path.join(fonts, 'notes.txt'), 'x')
    const url = writeOfficeProfile(path.join(w, 'profile'), fonts)
    expect(url).toBe(`file://${w}/profile`)
    expect(fs.readFileSync(path.join(w, 'profile/user/registrymodifications.xcu'), 'utf8')).toBe(profileXcu())
    expect(fs.readdirSync(path.join(w, 'profile/user/fonts'))).toEqual(['NotoSansCJKkr-Regular.otf'])
    expect(fs.readlinkSync(path.join(w, 'profile/user/fonts/NotoSansCJKkr-Regular.otf'))).toBe(path.join(fonts, 'NotoSansCJKkr-Regular.otf'))
    writeOfficeProfile(path.join(w, 'p2'), null)
    expect(fs.existsSync(path.join(w, 'p2/user/fonts'))).toBe(false)
    expect(kitFontsDir({ MYCEL_KIT_FONTS_DIR: fonts })).toBe(fonts)
    expect(kitFontsDir({ MYCEL_KIT_FONTS_DIR: 'relative' })).toBeNull()
    expect(kitFontsDir({})).toBeNull()
  })
})

describe.if(process.platform === 'linux')('the seccomp step inside bwrap', () => {
  test('with the helper: bwrap starts it, it loads the filter and execs the converter; without: the converter alone', () => {
    const w = tmp(), helper = path.join(tmp(), 'mycel-sandbox')
    fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o755 })
    const before = process.env.MYCEL_SANDBOX_HELPER
    try {
      process.env.MYCEL_SANDBOX_HELPER = helper
      expect(sandboxHelper()).toBe(helper)
      const a = isolatedCommand({ cmd: '/bin/true', args: ['x'], workDir: w, timeoutMs: 1000, background: false, seccomp: 'listen' }).argv
      if (a.some((s) => s.endsWith('bwrap'))) {
        expect(a.join(' ')).toContain(`--ro-bind ${helper} /.sbx/mycel-sandbox`)
        expect(a.slice(a.lastIndexOf('/.sbx/mycel-sandbox'))).toEqual(['/.sbx/mycel-sandbox', 'exec', '--landlock', 'off', '--allow-listen', '--', fs.realpathSync('/bin/true'), 'x'])
      }
      delete process.env.MYCEL_SANDBOX_HELPER
      const b = isolatedCommand({ cmd: '/bin/true', args: ['x'], workDir: w, timeoutMs: 1000, background: false, seccomp: 'listen' }).argv
      expect(b.join(' ')).not.toContain('mycel-sandbox')
    } finally { if (before === undefined) delete process.env.MYCEL_SANDBOX_HELPER; else process.env.MYCEL_SANDBOX_HELPER = before }
  })
})

describe('sandboxHelper', () => {
  test('only an absolute path that is there', () => {
    expect(sandboxHelper({ MYCEL_SANDBOX_HELPER: 'mycel-sandbox' })).toBeNull()
    expect(sandboxHelper({ MYCEL_SANDBOX_HELPER: '/nonexistent/mycel-sandbox' })).toBeNull()
    expect(sandboxHelper({})).toBeNull()
  })
})
