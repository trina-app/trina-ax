// A project is a folder with instructions (docs/DECISIONS.md "Projects: a folder with instructions"):
// - Files: a folder that is a project the person can see offers "Open project"; a folder they can write offers "Make it
//   a project", which opens the project dialog with that folder chosen and its name filled in (lib/projectFolders.ts,
//   components/ProjectForm.tsx);
// - the project dialog: an empty name on a chosen folder is the folder's own name;
// - the chat header names the chat's project, linked to its page, on phones too; a dialog moves the chat into a project
//   or out of it (components/chat/ChatProject.tsx).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Project } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { folderName, folderProjectAction, projectName, projectsByFolder } from '../../src/lib/projectFolders'
import { ProjectForm } from '../../src/components/ProjectForm'
import { ChatProjectLink, ProjectChoices } from '../../src/components/chat/ChatProject'

const project = (id: string, name: string, folderPath: string): Project =>
  ({ id, name, folderPath, instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true })
const entry = (path: string, access: FileEntry['access'], type: FileEntry['type'] = 'folder') =>
  ({ path, access, type }) as Pick<FileEntry, 'type' | 'path' | 'access'>
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const inRouter = (node: React.ReactNode) => decode(renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>))
const saveButton = (html: string) => /<button[^>]*data-testid="project-save"[^>]*>/.exec(html)?.[0] ?? ''
const input = (html: string, id: string) => new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? ''

describe('a folder and its project', () => {
  const launch = project('p1', 'Acme launch', 'shared/acme-launch')
  const byFolder = projectsByFolder([launch, project('p2', 'Acme notes', 'users/u1/notes')])

  test('a folder that is a project opens it, whatever the person may do there', () => {
    expect(folderProjectAction(entry('shared/acme-launch', 'write'), byFolder)).toEqual({ kind: 'open', project: launch })
    expect(folderProjectAction(entry('shared/acme-launch', 'read'), byFolder)).toEqual({ kind: 'open', project: launch })
    // the same folder name in another Unicode form is the same folder
    const nfd = project('p3', 'Café', 'shared/café')
    expect(folderProjectAction(entry('shared/café', 'write'), projectsByFolder([nfd]))?.kind).toBe('open')
  })

  test('a folder the person can write becomes a project; a read-only folder, a file or a navigation-only folder offers nothing', () => {
    expect(folderProjectAction(entry('shared/acme-plans', 'write'), byFolder)).toEqual({ kind: 'make' })
    expect(folderProjectAction(entry('shared/acme-plans', 'read'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-plans', 'none'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-launch/plan.md', 'write', 'file'), byFolder)).toBeNull()
  })

  test('the project\'s name: what was typed, else the folder\'s own name, at most 100 characters', () => {
    expect(folderName('shared/acme-launch')).toBe('acme-launch')
    expect(folderName('')).toBe('')
    expect(projectName('  Launch  ', 'shared/acme-launch')).toBe('Launch')
    expect(projectName('   ', 'shared/acme-launch')).toBe('acme-launch')
    expect(projectName('', '')).toBe('')
    expect(Array.from(projectName('', `shared/${'가'.repeat(120)}`)).length).toBe(100)
  })
})

describe('the project dialog opened from a folder', () => {
  test('the folder is chosen and its name filled in; Save is ready', () => {
    const html = inRouter(<ProjectForm initialFolder="shared/acme-launch" initialName="acme-launch" onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-name')).toContain('value="acme-launch"')
    expect(input(html, 'project-folder')).toContain('value="shared/acme-launch"')
    expect(input(html, 'project-kind-existing')).toContain('checked=""')
    expect(saveButton(html)).not.toContain('disabled=""')
  })

  test('an empty name on a chosen folder is the folder\'s name: shown as the placeholder, said in the hint, and Save works', () => {
    const html = inRouter(<ProjectForm initialFolder="shared/acme-launch" onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-name')).toContain('placeholder="acme-launch"')
    expect(html).toContain(translate('en', 'projects.nameHint'))
    expect(saveButton(html)).not.toContain('disabled=""')
  })

  test('with no folder to name it after (the team root) a name is still needed', () => {
    const html = inRouter(<ProjectForm onClose={() => {}} onSaved={() => {}} />)
    expect(saveButton(html)).toContain('disabled=""')
    expect(html).not.toContain(translate('en', 'projects.nameHint'))
  })

  test('editing a project keeps its own name rule', () => {
    const html = inRouter(<ProjectForm project={project('p1', 'Acme launch', 'shared/acme-launch')} onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-name')).toContain('value="Acme launch"')
    expect(input(html, 'project-name')).not.toContain('placeholder="')
  })
})

describe('the chat and its project', () => {
  test('the header names the project and links to it, on phones too', () => {
    const html = inRouter(<ChatProjectLink project={{ id: 'p1', name: 'Acme launch' }} />)
    const link = /<a[^>]*data-testid="chat-project"[^>]*>/.exec(html)?.[0] ?? ''
    expect(link).toContain('href="/projects/p1"')
    expect(link).toContain(`title="${translate('en', 'chat.project.open', { name: 'Acme launch' })}"`)
    // never hidden on a narrow screen (the old link was "hidden … sm:inline-flex")
    expect(link).not.toMatch(/class="[^"]*\bhidden\b/)
    expect(html).toContain('Acme launch')
    expect(html).not.toContain(`>${translate('en', 'sidebar.projects')}<`)
  })

  test('the move dialog lists no project and every project the person sees, with the current one chosen', () => {
    const list = [project('p1', 'Acme launch', 'shared/acme-launch'), project('p2', 'Acme notes', '')]
    const radios = (html: string) => [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0])
    const inP1 = inRouter(<ProjectChoices projects={list} selected="p1" onSelect={() => {}} />)
    expect(radios(inP1).map((r) => r.includes('checked=""'))).toEqual([false, true, false])
    expect(inP1).toContain(translate('en', 'chat.project.none'))
    expect(inP1).toContain('shared/acme-launch')
    expect(inP1).toContain(translate('en', 'files.root'))
    const none = inRouter(<ProjectChoices projects={list} selected={null} onSelect={() => {}} />)
    expect(radios(none).map((r) => r.includes('checked=""'))).toEqual([true, false, false])
  })

  test('the new texts exist in every language', () => {
    const keys = ['files.makeProject', 'files.openProject', 'files.isProject', 'projects.nameHint', 'chat.project.open', 'chat.project.add', 'chat.project.change', 'chat.project.title', 'chat.project.none', 'chat.project.hint', 'chat.project.empty', 'chat.project.moved', 'chat.project.removed'] as const
    for (const locale of ['en', 'ko', 'ja', 'es', 'id'] as const)
      for (const key of keys) expect(translate(locale, key)).not.toBe(key)
  })

  test('who can see a new team project folder: the owner and admins too, in every language', () => {
    expect(translate('ko', 'projects.participantsHint')).not.toContain('관리자 제외')
    expect(translate('ko', 'projects.participantsHint')).toContain('관리자')
    expect(translate('en', 'projects.participantsHint')).toContain('admins')
  })
})
