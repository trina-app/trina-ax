// Find work files, part 5 (docs/DECISIONS.md "Find work files, part 5"): the wide look in the real Electron, in a made-up
// home with Full Disk Access (a made-up privacy database the probe can open), a cloud drive's folder with thousands of
// files, a work folder named like the company, a messenger's downloads inside Downloads, a recent-documents list (a real
// binary property list made with plutil) that points at a note in the home folder and at a made-up Mail file, and app
// data that must never be listed. Nothing of this computer's home is touched (fixtures/work-files-wide-main.ts checks).
// macOS only (plutil, the CloudStorage layout). Run by hand: `bunx playwright test -c e2e/rtc-native.config.ts`.
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixtureResult } from './fixture-run'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** A macOS bookmark (Apple's layout: header, the path's parts, a TOC with entry 0x1004). */
function bookmark(path: string): Buffer {
  const body: number[] = [0, 0, 0, 0]
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  const offs: number[] = []
  for (const p of path.split('/').filter(Boolean)) {
    offs.push(body.length)
    const b = [...Buffer.from(p, 'utf8')]
    u32(body, b.length); u32(body, 0x0101); body.push(...b)
    while (body.length % 4) body.push(0)
  }
  const arr = body.length
  u32(body, offs.length * 4); u32(body, 0x0601); for (const o of offs) u32(body, o)
  const toc = body.length
  u32(body, 0); u32(body, 0xfffffffe); u32(body, 1); u32(body, 0); u32(body, 1); u32(body, 0x1004); u32(body, arr); u32(body, 0)
  body[0] = toc & 0xff; body[1] = (toc >> 8) & 0xff
  const head: number[] = [0x62, 0x6f, 0x6f, 0x6b]
  u32(head, 64 + body.length); u32(head, 0x10050000); u32(head, 64)
  while (head.length < 64) head.push(0)
  return Buffer.from([...head, ...body])
}

const doc = (p: string, bytes = 2048) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'W'.repeat(bytes)) }

async function fakeHome(dir: string): Promise<string> {
  const home = join(dir, 'home')
  doc(join(home, 'Documents', 'Plan.docx'))
  doc(join(home, 'Desktop', 'Notes.txt'))
  doc(join(home, 'Downloads', 'Quote.pdf'))
  doc(join(home, 'Downloads', 'KakaoTalk', 'Acme 견적서.pdf'))
  doc(join(home, 'Acme', 'Proposal.pptx'))
  doc(join(home, 'Projects', 'Roadmap.xlsx'))
  doc(join(home, 'Notes', 'Ideas.md'))
  doc(join(home, 'Pictures', 'scan.pdf'))
  // a cloud drive's folder: 60 folders of 50 documents, 3,000 in all, and a hidden one
  const od = join(home, 'Library', 'CloudStorage', 'OneDrive-Acme')
  for (let i = 0; i < 60; i++) for (let j = 0; j < 50; j++) doc(join(od, `Team ${i}`, `Report ${j}.docx`))
  doc(join(od, '.hidden', 'x.pdf'))
  // a provider that is not a cloud drive's, and app data: never listed
  doc(join(home, 'Library', 'CloudStorage', 'Other-Provider', 'x.pdf'))
  doc(join(home, 'Library', 'Mail', 'V10', 'MAIL-ONLY.pdf'))
  doc(join(home, 'Library', 'Containers', 'com.apple.mail', 'Data', 'MAIL-ONLY-2.pdf'))
  // many other files the walk passes: 6,000 in Documents and Downloads
  for (let i = 0; i < 3000; i++) { doc(join(home, 'Documents', 'Archive', `a${i % 30}`, `old ${i}.txt`), 10); doc(join(home, 'Downloads', 'bulk', `b${i % 30}`, `file ${i}.csv`), 10) }
  // an old note in Projects: not recent
  doc(join(home, 'Projects', 'Old.docx'))
  const old = new Date(Date.now() - 400 * 86_400_000)
  utimesSync(join(home, 'Projects', 'Old.docx'), old, old)
  // the recent-documents list: the note in home, and the made-up Mail file
  const sfl = join(home, 'Library', 'Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments')
  mkdirSync(sfl, { recursive: true })
  const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>$objects</key><array>${[join(home, 'Notes', 'Ideas.md'), join(home, 'Library', 'Mail', 'V10', 'MAIL-ONLY.pdf')].map((p) => `<data>${bookmark(p).toString('base64')}</data>`).join('')}</array></dict></plist>`
  writeFileSync(join(sfl, 'com.example.editor.sfl4'), xml)
  await exec('/usr/bin/plutil', ['-convert', 'binary1', join(sfl, 'com.example.editor.sfl4')])
  // Full Disk Access: the probe opens this made-up privacy database (nothing is read)
  doc(join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 16)
  return home
}

test('the wide look: places, recent files in home, never app data; fast on thousands of files', async () => {
  test.skip(process.platform !== 'darwin', 'macOS layout')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'work-files-wide-'))
  try {
    const home = await fakeHome(dir)
    const output = join(dir, 'main.cjs')
    await exec('bun', ['build', join(import.meta.dirname, 'fixtures/work-files-wide-main.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${output}`])
    const electron = createRequire(import.meta.url)('electron') as string
    const env = { ...process.env, HOME: home, FOLDER_TEST_HOME: home, FOLDER_TEST_PROFILE: join(dir, 'profile') }
    // the result line is enough: the app is stopped once it is printed (on a busy Mac, Electron's own exit can take
    // minutes, which said nothing about the look)
    const { out, asked } = await fixtureResult(electron, [output], env, 'WIDE_RESULT', 100_000)
    console.log('wide look', JSON.stringify({ ms: out.ms, steps: out.steps, count: out.count, byRoot: out.byRoot }))
    expect(out.fullDisk).toBe('granted')
    // a page that does not ask for the wide look gets the three folders only
    expect(out.narrow).toEqual(['desktop', 'documents', 'downloads'])
    // the dialog lists every place before anything is looked at
    expect(asked[1].yes).toBe('Find work files')
    const names = asked[1].places.map((p: { name: string; note?: string }) => (p.note ? `${p.name} (${p.note})` : p.name))
    for (const p of ['KakaoTalk downloads', 'Acme', 'Projects', 'OneDrive – Acme', 'Recently opened files (anywhere in your home folder)']) expect(names).toContain(p)
    expect(asked[1].fine).toContain('Mail, Messages, Photos, Safari')
    expect(out.roots).toEqual(expect.arrayContaining(['messenger:KakaoTalk:ok', 'folder:Acme:ok', 'folder:Projects:ok', 'cloud:OneDrive – Acme:ok', 'documents::ok', 'desktop::ok', 'downloads::ok']))
    expect(out.names).toEqual(expect.arrayContaining(['messenger:KakaoTalk:Acme 견적서.pdf', 'folder:Acme:Proposal.pptx', 'folder:Projects:Roadmap.xlsx', 'home::Notes/Ideas.md']))
    // never listed: Pictures, app data, another provider, a hidden folder (an old file of a walked place is listed, for
    // the search; the page shows only recent ones)
    expect(JSON.stringify(out.names)).not.toMatch(/scan\.pdf|Other-Provider|\.hidden/)
    expect(out.mail).toBe(false)
    expect(out.leaksPath).toBe(false)
    expect(out.byRoot['cloud:OneDrive – Acme']).toBeGreaterThan(0)
    expect(out.readNote).toBe('WWWWW')
    // speed (the walk path: a made-up home in a temporary folder has no Spotlight)
    expect(out.ms).toBeLessThan(15_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
