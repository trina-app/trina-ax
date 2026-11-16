// scripts/ci/dmg-check.ts (the desktop workflow's dmg check): what it expects comes from the electron-builder settings
// and version, never from values written into the check.
import { describe, expect, test } from 'bun:test'
import { backgroundExtension, defaultFilesystem, dsStoreIcons, expectedDmg, filesystemType } from '../../scripts/ci/dmg-check'

const o = { productFilename: 'Trina AX', version: '0.5.9', builderVersion: '26.0.12', buildResources: '/nowhere/build-resources', builderTemplates: '/dmg-builder/templates' }

describe('dmg check expectations', () => {
  test('the file system follows electron-builder: APFS up to 26.0.17 (hdiutil -fs APFS), HFS+ from 26.0.18 (dmgbuild), dmg.filesystem over both', () => {
    expect(defaultFilesystem('26.0.12')).toBe('APFS')
    expect(defaultFilesystem('26.0.17')).toBe('APFS')
    expect(defaultFilesystem('26.0.18')).toBe('HFS+')
    expect(defaultFilesystem('26.13.0')).toBe('HFS+')
    expect(defaultFilesystem('26.15.3')).toBe('HFS+')
    expect(defaultFilesystem('27.0.0-alpha.1')).toBe('HFS+')
    expect(expectedDmg({}, { ...o, builderVersion: '26.15.3' }).filesystem).toBe('HFS+')
    expect(expectedDmg({ filesystem: 'APFS' }, { ...o, builderVersion: '26.15.3' }).filesystem).toBe('APFS')
    expect(filesystemType('HFS+')).toBe('hfs')
    expect(filesystemType('APFS')).toBe('apfs')
    expect(() => filesystemType('FAT32')).toThrow()
  })

  test("no dmg settings: dmg-builder's defaults (its own background, the app and Applications at 130/410, 80 px icons)", () => {
    expect(expectedDmg({}, o)).toEqual({
      volume: 'Trina AX 0.5.9', format: 'UDZO', filesystem: 'APFS',
      entries: [{ name: 'Trina AX.app', x: 130, y: 220, link: null }, { name: 'Applications', x: 410, y: 220, link: '/Applications' }],
      background: '/dmg-builder/templates/background.tiff', iconSize: 80, textSize: 12,
    })
  })

  test('settings like PR #985 move the expectation with them', () => {
    const want = expectedDmg({
      title: '${productName} ${version}', background: 'build-resources/background.png', iconSize: 144, iconTextSize: 13,
      contents: [{ x: 170, y: 210, type: 'file' }, { x: 490, y: 210, type: 'link', path: '/Applications' }],
    }, o)
    expect(want.background).toMatch(/desktop\/build-resources\/background\.png$/)
    expect(want.entries).toEqual([{ name: 'Trina AX.app', x: 170, y: 210, link: null }, { name: 'Applications', x: 490, y: 210, link: '/Applications' }])
    expect([want.iconSize, want.textSize]).toEqual([144, 13])
    // background.png with a background@2x.png beside it ships as one TIFF; a lone PNG stays PNG
    expect(backgroundExtension('/r/background.png', (p) => p === '/r/background@2x.png')).toBe('.tiff')
    expect(backgroundExtension('/r/background.png', () => false)).toBe('.png')
    expect(backgroundExtension('/t/background.tiff', () => false)).toBe('.tiff')
    expect(expectedDmg({ compression: 'maximum' }, o).format).toBe('UDBZ')
    expect(expectedDmg({ compression: 'store', format: 'ULFO' }, o).format).toBe('ULFO')
    // a colour instead of a picture: no background file is expected
    expect(expectedDmg({ backgroundColor: '#ffffff' }, o).background).toBeNull()
  })

  test('icon positions are read from .DS_Store records', () => {
    const rec = (name: string, x: number, y: number) => {
      const head = Buffer.alloc(4)
      head.writeUInt32BE(name.length)
      const pos = Buffer.alloc(16)
      pos.writeUInt32BE(16, 0)
      pos.writeUInt32BE(x, 4)
      pos.writeUInt32BE(y, 8)
      return Buffer.concat([head, Buffer.from(name, 'utf16le').swap16(), Buffer.from('Ilocblob'), pos])
    }
    const buf = Buffer.concat([Buffer.from('Bud1junk'), rec('Trina AX.app', 170, 210), rec('Applications', 490, 210)])
    expect(dsStoreIcons(buf, ['Trina AX.app', 'Applications', 'missing'])).toEqual({ 'Trina AX.app': { x: 170, y: 210 }, Applications: { x: 490, y: 210 }, missing: null })
  })
})
