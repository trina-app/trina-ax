// QA TC-5349: while a run lives (a background command, a dev server) srt's protected names (.bashrc, .mcp.json, .vscode,
// .claude/commands, an empty skills folder ...) exist as empty files and folders in the folder it runs in, because
// bwrap binds over a path that has to be there (devenv/srt/placeholders.ts). People must never see them: not in the
// Files tree, not in the AI's list, not in a folder search, and not as "files changed" of the command or of the
// background (devenv snapshots, which become the change notices to the other people of a shared project).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { findFiles } from '../../server/src/team-files/find'
import { diffSnapshots, takeSnapshot } from '../../server/src/devenv/snapshot'
import { holdPlaceholders, holdSkillFolders, isRunPlaceholder, SRT_DENY_DIRS, SRT_DENY_FILES } from '../../server/src/devenv/srt/placeholders'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('dev-env-placeholders-hidden') })
afterAll(async () => { await A.close() })

const files = () => componentC(A.ctx).files
const componentTree = (): string[] => files().tree('alice', 'shared/ph', undefined).entries.map((e) => e.name)
const abs = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, s = '') => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), s) }
/** everything on the disk under a folder, with sizes: what "unchanged" is measured by */
function disk(rel: string): string[] {
  const out: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(path.join(A.team, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; out.push(e.isDirectory() ? `${r}/` : r); if (e.isDirectory()) walk(r) } }
  walk(rel)
  return out.sort()
}
const names = (text: string) => text.split('\n').map((l) => l.replace(/\/$/, '').split(/\s+\(/)[0]!.trim())

describe('the names made for a run are on the disk only, never shown', () => {
  test('a long run in a project folder: no tree, list, search or snapshot shows them, and nothing is left after it', async () => {
    put('shared/ph/readme.md', 'hello\n')
    const folder = 'shared/ph'
    const before = disk(folder)
    const snap0 = takeSnapshot(A.team, folder, null)

    const release = holdPlaceholders(abs(folder))
    const releaseSkills = holdSkillFolders(A.team, [`${folder}/skills`])
    // they are on the disk now: that is how bwrap gets its mount points
    const onDisk = disk(folder)
    for (const f of SRT_DENY_FILES) expect(onDisk).toContain(`${folder}/${f}`)
    for (const d of SRT_DENY_DIRS) expect(onDisk).toContain(`${folder}/${d}/`)
    expect(onDisk).toContain(`${folder}/skills/`)
    for (const rel of onDisk.filter((r) => !before.includes(r))) expect(isRunPlaceholder(abs(rel.replace(/\/$/, ''))), rel).toBe(true)

    // the Files tree
    expect(componentTree()).toEqual(['readme.md'])
    // the AI's list
    const l = await A.ctx.files.call('list', { path: folder }, A.toolCtx('alice'))
    expect(names(l.text).filter(Boolean)).toEqual(['readme.md'])
    // what a command or the background changed: nothing
    expect(diffSnapshots(snap0, takeSnapshot(A.team, folder, snap0))).toEqual([])
    // a search by name, folders too
    for (const q of ['bashrc', 'mcp', 'vscode', 'idea', 'skills', 'claude']) expect((await findFiles(files(), 'alice', q, folder, 50, { folders: true })).items, q).toEqual([])

    // a person writes a real file into one of them: from then on it is real (listed, a change), and release keeps it
    put(`${folder}/.vscode/settings.json`, '{}\n')
    expect(isRunPlaceholder(abs(`${folder}/.vscode`))).toBe(false)
    expect(componentTree()).toContain('.vscode')
    expect(diffSnapshots(snap0, takeSnapshot(A.team, folder, snap0)).map((c) => c.path)).toEqual([`${folder}/.vscode/settings.json`])

    release(); releaseSkills()
    // the run is over: the empty ones are gone, the person's file stays with the folders it needs
    expect(disk(folder)).toEqual([...before, `${folder}/.vscode/`, `${folder}/.vscode/settings.json`].sort())
    expect(isRunPlaceholder(abs(`${folder}/.vscode`))).toBe(false)
  })

  test('a name the person had there already is not a placeholder', () => {
    put('shared/ph2/.bashrc', 'mine\n')
    fs.mkdirSync(abs('shared/ph2/.idea'))
    const release = holdPlaceholders(abs('shared/ph2'))
    expect(isRunPlaceholder(abs('shared/ph2/.bashrc'))).toBe(false)
    expect(isRunPlaceholder(abs('shared/ph2/.idea'))).toBe(false)
    expect(isRunPlaceholder(abs('shared/ph2/.zshrc'))).toBe(true)
    release()
    expect(disk('shared/ph2')).toEqual(['shared/ph2/.bashrc', 'shared/ph2/.idea/'])
  })
})

