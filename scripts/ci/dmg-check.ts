// The Mac dmg as people open it (docs/RELEASE-CI.md "데스크톱 검사"), after an unsigned `bun run --cwd desktop dist:mac`:
//
//   bun scripts/ci/dmg-check.ts [desktop/release]
//
// Every expected value is read from desktop/electron-builder.config.ts and the installed electron-builder, never
// written here, so a change to the dmg settings (PR #985: background, icon size, positions) or to electron-builder
// (PR #1036: 26.15.3 makes HFS+ instead of APFS) moves the check with it. For each *.dmg in the folder:
//
//   1. the image: hdiutil imageinfo reads it; its format is dmg.format (electron-builder's default: UDZO)
//   2. it mounts read-only (hdiutil attach -readonly) under the volume name dmg.title
//   3. the volume's file system is dmg.filesystem, else the installed electron-builder's default (APFS before 26.0.18,
//      which passed -fs APFS to hdiutil; from 26.0.18 dmgbuild makes the image, HFS+ unless dmg.filesystem says otherwise)
//   4. every dmg.contents entry (default: the app and an Applications link) is there: the app with its Info.plist,
//      version and executable, each link pointing where the config says
//   5. the background: the picture the config names (dmg.background, else build-resources/background.tiff|png, else
//      electron-builder's own) is on the volume (.background/<name> up to 26.0.17, /.background.<ext> from 26.0.18; a
//      picture with an @2x file next to it becomes one TIFF), .DS_Store names that file, and the window shows a picture
//      (backgroundType 2)
//   6. .DS_Store places each entry at its x/y and has the icon and label size of the config
//
// The volume is detached whatever happens. Exits non-zero on the first failed check; a summary goes to
// $GITHUB_STEP_SUMMARY when it is set.
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const DESKTOP = join(ROOT, 'desktop')

type Entry = { x: number; y: number; type?: 'link' | 'file' | 'dir'; name?: string; path?: string }
type DmgOptions = { title?: string; format?: string; compression?: string; filesystem?: string; background?: string | null; backgroundColor?: string | null; contents?: Entry[]; iconSize?: number; iconTextSize?: number }

/** Up to dmg-builder 26.0.17 every dmg was made with `hdiutil create -fs APFS`; from 26.0.18 dmgbuild makes it, whose
 * default is HFS+ (dmg.filesystem, read from 26.13.0, can change it). dmg-builder and electron-builder share versions. */
export function defaultFilesystem(builderVersion: string): 'HFS+' | 'APFS' {
  const [maj = 0, min = 0, patch = 0] = builderVersion.split(/[.-]/).map(Number)
  return maj > 26 || (maj === 26 && (min > 0 || patch >= 18)) ? 'HFS+' : 'APFS'
}

/** The background's file on the volume, by the name dmg-builder gives it: one TIFF when an @2x picture sits next to it. */
export function backgroundExtension(source: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(source).toLowerCase()
  const retina = join(source, '..', `${basename(source, extname(source))}@2x${extname(source)}`)
  return ext === '.tif' || ext === '.tiff' || exists(retina) ? '.tiff' : ext
}

/** diskutil's FilesystemType for each name dmg.filesystem takes. */
export function filesystemType(name: string): string {
  const n = name.toUpperCase().replace(/\s+/g, '')
  if (n === 'HFS+' || n === 'HFS' || n === 'JHFS+') return 'hfs'
  if (n === 'APFS') return 'apfs'
  throw new Error(`unknown dmg.filesystem ${name}`)
}

/** dmg-builder's defaults (DmgTarget.computeDmgOptions, customizeDmg). */
export function expectedDmg(dmg: DmgOptions & { compression?: string }, o: { productFilename: string; version: string; builderVersion: string; buildResources: string; builderTemplates: string }) {
  const contents = dmg.contents ?? [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }]
  let background: string | null = null
  if (dmg.backgroundColor == null) {
    if (dmg.background) background = resolve(DESKTOP, dmg.background)
    else if (existsSync(join(o.buildResources, 'background.tiff'))) background = join(o.buildResources, 'background.tiff')
    else if (existsSync(join(o.buildResources, 'background.png'))) background = join(o.buildResources, 'background.png')
    else background = join(o.builderTemplates, 'background.tiff')
  }
  const textSize = dmg.iconTextSize && dmg.iconTextSize >= 10 && dmg.iconTextSize <= 16 ? dmg.iconTextSize : 12
  return {
    volume: (dmg.title ?? '${productName} ${version}').replace('${productName}', o.productFilename).replace('${version}', o.version),
    // DmgTarget.computeDmgOptions: the packager's compression picks the format when dmg.format is not set
    format: dmg.format ?? (dmg.compression === 'store' ? 'UDRO' : dmg.compression === 'maximum' ? 'UDBZ' : 'UDZO'),
    filesystem: dmg.filesystem ?? defaultFilesystem(o.builderVersion),
    entries: contents.map((c) => {
      const p = c.path ?? `${o.productFilename}.app`
      return { name: c.name ?? basename(p), x: c.x, y: c.y, link: c.type === 'link' ? `/${p.replace(/^\//, '')}` : null }
    }),
    background,
    iconSize: dmg.iconSize ?? 80,
    textSize,
  }
}

/** Icon positions in a .DS_Store: each record is <name length><UTF-16BE name>'Iloc''blob'<16><x><y>… */
export function dsStoreIcons(buf: Buffer, names: string[]): Record<string, { x: number; y: number } | null> {
  const out: Record<string, { x: number; y: number } | null> = {}
  for (const name of names) {
    out[name] = null
    const key = Buffer.concat([Buffer.alloc(4), Buffer.from(name, 'utf16le').swap16(), Buffer.from('Ilocblob')])
    key.writeUInt32BE(name.length, 0)
    const at = buf.indexOf(key)
    if (at >= 0 && at + key.length + 12 <= buf.length) out[name] = { x: buf.readUInt32BE(at + key.length + 4), y: buf.readUInt32BE(at + key.length + 8) }
  }
  return out
}

/** The 'icvp' (icon view options) binary plist of the volume's own record ('.'), as a file for plutil. */
function icvp(buf: Buffer, dir: string): string | null {
  const key = Buffer.from([0, 0, 0, 1, 0, 0x2e, ...Buffer.from('icvpblob')])
  const at = buf.indexOf(key)
  if (at < 0) return null
  const len = buf.readUInt32BE(at + key.length)
  const f = join(dir, 'icvp.plist')
  writeFileSync(f, buf.subarray(at + key.length + 4, at + key.length + 4 + len))
  return f
}

function run(argv: string[]): string {
  const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${argv.join(' ')} failed (${p.exitCode}): ${p.stderr.toString().trim().slice(0, 2000)}`)
  return p.stdout.toString()
}
const plist = (xml: string) => JSON.parse(Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', '-'], { stdin: Buffer.from(xml), stdout: 'pipe' }).stdout.toString())
const plistValue = (file: string, key: string) => Bun.spawnSync(['plutil', '-extract', key, 'raw', '-o', '-', file], { stdout: 'pipe' }).stdout.toString().trim()

const failures: string[] = []
const lines: string[] = []
function check(ok: boolean, what: string) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

async function main() {
  const dir = resolve(process.argv[2] ?? join(DESKTOP, 'release'))
  const config = (await import(join(DESKTOP, 'electron-builder.config.ts'))).default as { productName: string; compression?: string; dmg?: DmgOptions; directories?: { buildResources?: string }; mac?: { extraFiles?: { to: string }[] } }
  /** what mac.extraFiles puts in the app's Contents (the meeting notes' sound helper) */
  const macExtraFiles = (config.mac?.extraFiles ?? []).map((f) => f.to)
  const req = createRequire(join(DESKTOP, 'package.json'))
  const builderVersion = (req('electron-builder/package.json') as { version: string }).version
  const dmgBuilder = resolve(createRequire(req.resolve('electron-builder/package.json')).resolve('dmg-builder/package.json'), '..')
  const version = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { version: string }).version
  const dmgs = readdirSync(dir).filter((f) => f.endsWith('.dmg'))
  if (dmgs.length === 0) throw new Error(`no .dmg in ${dir}`)
  console.log(`electron-builder ${builderVersion}, dmg-builder at ${dmgBuilder}`)

  for (const file of dmgs) {
    const dmg = join(dir, file)
    // the version written into the dmg (a CI build may pass -c.extraMetadata.version): from the file name
    const v = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-mac-/.exec(file)?.[1] ?? version
    const want = expectedDmg({ compression: config.compression, ...config.dmg }, {
      productFilename: config.productName, version: v, builderVersion,
      buildResources: join(DESKTOP, config.directories?.buildResources ?? 'build'), builderTemplates: join(dmgBuilder, 'templates'),
    })
    lines.push(`### ${file} (${(statSync(dmg).size / 1e6).toFixed(1)} MB)`)
    console.log(`\n${file}: expecting ${JSON.stringify(want)}`)

    const info = plist(run(['hdiutil', 'imageinfo', '-plist', dmg]))
    check(info.Format === want.format, `image format ${info.Format} (expected ${want.format})`)

    const mnt = mkdtempSync(join(tmpdir(), 'dmg-check-'))
    let dev: string | null = null
    try {
      const attached = plist(run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mnt, '-plist', dmg]))
      const entities = attached['system-entities'] as { 'dev-entry': string; 'mount-point'?: string }[]
      dev = entities.map((e) => e['dev-entry']).sort((a, b) => a.length - b.length)[0] ?? null
      check(entities.some((e) => e['mount-point'] === mnt || e['mount-point'] === `/private${mnt}`), `mounts read-only (${dev})`)

      const disk = plist(run(['diskutil', 'info', '-plist', mnt]))
      check(disk.VolumeName === want.volume, `volume name "${disk.VolumeName}" (expected "${want.volume}")`)
      check(disk.FilesystemType === filesystemType(want.filesystem), `file system ${disk.FilesystemType} / ${disk.FilesystemName} (expected ${want.filesystem})`)
      check(disk.WritableVolume === false, 'the volume is read-only')

      for (const e of want.entries) {
        const p = join(mnt, e.name)
        const st = existsSync(p) || isLink(p) ? lstatSync(p) : null
        if (e.link) {
          check(!!st?.isSymbolicLink() && readlinkSync(p) === e.link, `"${e.name}" is a link to ${e.link}${st?.isSymbolicLink() ? ` (${readlinkSync(p)})` : ''}`)
        } else if (e.name.endsWith('.app')) {
          const plistFile = join(p, 'Contents', 'Info.plist')
          const ok = !!st?.isDirectory() && existsSync(plistFile)
          check(ok, `"${e.name}" is an app bundle`)
          if (ok) {
            const exe = plistValue(plistFile, 'CFBundleExecutable')
            check(!!exe && existsSync(join(p, 'Contents', 'MacOS', exe)), `its executable Contents/MacOS/${exe}`)
            const short = plistValue(plistFile, 'CFBundleShortVersionString')
            check(short === v, `its version ${short} (expected ${v})`)
            check(existsSync(join(p, 'Contents', 'Resources', 'app.asar')), 'its Resources/app.asar')
            // the mac.extraFiles of the config (the meeting notes' sound helper): there, and both Mac architectures
            for (const f of macExtraFiles) {
              const file = join(p, 'Contents', f)
              check(existsSync(file), `its Contents/${f}`)
              const archs = existsSync(file) ? Bun.spawnSync(['lipo', '-archs', file], { stdout: 'pipe' }).stdout.toString().trim().split(/\s+/).sort().join(' ') : ''
              check(archs === 'arm64 x86_64', `Contents/${f} is universal (${archs || 'missing'})`)
            }
          }
        } else {
          check(!!st, `"${e.name}" is there`)
        }
      }

      // dmgbuild's places for the picture: .background/<file> (the old app-builder) or /.background.<ext> (dmgbuild)
      const bgDir = join(mnt, '.background')
      const isPicture = (f: string) => /\.(tiff?|png|jpe?g)$/i.test(f)
      const pictures = [
        ...(existsSync(bgDir) ? readdirSync(bgDir).filter(isPicture).map((f) => `.background/${f}`) : []),
        ...readdirSync(mnt).filter((f) => f.startsWith('.background.') && isPicture(f)),
      ].filter((f) => statSync(join(mnt, f)).size > 0)
      if (want.background) {
        check(existsSync(want.background), `the background picture ${want.background.replace(ROOT + '/', '')} exists`)
        const ext = backgroundExtension(want.background)
        const pic = pictures.find((f) => extname(f).toLowerCase() === ext)
        check(!!pic, `the volume holds the background as ${ext} (${pictures.join(', ') || 'no picture'})`)
        // the window's alias and bookmark name the file: the picture on the volume is the one Finder shows
        const ds = join(mnt, '.DS_Store')
        if (pic && existsSync(ds)) check(readFileSync(ds).includes(Buffer.from(basename(pic))), `.DS_Store names ${basename(pic)}`)
      } else {
        check(true, `no background picture configured (backgroundColor ${config.dmg?.backgroundColor})`)
      }

      const ds = join(mnt, '.DS_Store')
      check(existsSync(ds) && statSync(ds).size > 0, `.DS_Store is there (${existsSync(ds) ? statSync(ds).size : 0} bytes)`)
      if (existsSync(ds)) {
        const buf = readFileSync(ds)
        const icons = dsStoreIcons(buf, want.entries.map((e) => e.name))
        for (const e of want.entries) {
          const got = icons[e.name]
          check(!!got && got.x === e.x && got.y === e.y, `.DS_Store places "${e.name}" at ${e.x},${e.y}${got ? ` (${got.x},${got.y})` : ' (no record)'}`)
        }
        const tmp = mkdtempSync(join(tmpdir(), 'dmg-icvp-'))
        try {
          const f = icvp(buf, tmp)
          check(!!f, '.DS_Store has the window\'s icon view options')
          if (f) {
            const type = plistValue(f, 'backgroundType')
            check(type === (want.background ? '2' : '1'), `window background type ${type} (expected ${want.background ? '2 = picture' : '1 = colour'})`)
            const size = plistValue(f, 'iconSize')
            check(Number(size) === want.iconSize, `icon size ${size} (expected ${want.iconSize})`)
            const text = plistValue(f, 'textSize')
            check(Number(text) === want.textSize, `label size ${text} (expected ${want.textSize})`)
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      }
    } finally {
      for (let i = 0; i < 5 && dev; i++) {
        const p = Bun.spawnSync(['hdiutil', 'detach', dev, ...(i > 1 ? ['-force'] : [])], { stdout: 'pipe', stderr: 'pipe' })
        if (p.exitCode === 0) { dev = null; break }
        await Bun.sleep(2000)
      }
      if (dev) console.error(`could not detach ${dev}`)
      rmSync(mnt, { recursive: true, force: true })
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## dmg check\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
  if (failures.length) {
    console.error(`\n${failures.length} dmg check(s) failed:\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\nevery dmg check passed')
}

function isLink(p: string) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

if (import.meta.main) await main()
