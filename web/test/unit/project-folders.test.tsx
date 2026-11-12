// A project is a folder with instructions (docs/DECISIONS.md "Projects: a folder with instructions", "Projects live only
// in projects/"):
// - Files: a folder that is a project the person can see offers "Open project"; nothing makes a project there any more
//   (new ones are made on the Projects page, in a new projects/<name>; lib/projectFolders.ts);
// - the project dialog: no folder to choose for a new project (components/ProjectForm.tsx; the clicks are in
//   project-form.test.tsx);
// - a dialog moves a chat into a project or out of it (components/chat/ChatProject.tsx; the chat header's name of the
//   project is in project-folders-dom.test.tsx).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Project } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { folderName, folderProjectAction, projectsByFolder } from '../../src/lib/projectFolders'
import { ProjectForm } from '../../src/components/ProjectForm'
import { ProjectChoices } from '../../src/components/chat/ChatProject'
import { ProjectTrashNote } from '../../src/components/ProjectTrashNote'

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

  test('any other folder offers nothing, one the person can write too; a file neither', () => {
    expect(folderProjectAction(entry('shared/acme-plans', 'write'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-plans', 'read'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-plans', 'none'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-launch/plan.md', 'write', 'file'), byFolder)).toBeNull()
    expect(folderName('shared/acme-launch')).toBe('acme-launch')
    expect(folderName('')).toBe('')
  })
})

describe('the project dialog', () => {
  test('a new project: no folder to choose, Save waits for a name', () => {
    const html = inRouter(<ProjectForm onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-folder')).toBe('')
    expect(saveButton(html)).toContain('disabled=""')
    expect(html).not.toContain('project-kind-existing')
  })

  test('editing a project keeps its name; a project in place has no folder to choose', () => {
    const html = inRouter(<ProjectForm project={project('p1', 'Acme launch', 'projects/acme-launch')} onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-name')).toContain('value="Acme launch"')
    expect(saveButton(html)).not.toContain('disabled=""')
    expect(input(html, 'project-folder')).toBe('')
  })
})

describe('the chat and its project', () => {
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

  test('an admin\'s project page says when its folder is in the trash; nothing otherwise', () => {
    const html = inRouter(<ProjectTrashNote project={{ inTrash: true }} />)
    expect(html).toContain('data-testid="project-in-trash"')
    expect(html).toContain(translate('en', 'projects.inTrash'))
    expect(inRouter(<ProjectTrashNote project={{ inTrash: false }} />)).toBe('')
    expect(inRouter(<ProjectTrashNote project={{}} />)).toBe('')
  })

  test('the new texts exist in every language', () => {
    const keys = ['files.openProject', 'files.isProject', 'projects.whoMembers', 'projects.membersCount', 'projects.membersByCreator', 'projects.membersByAdmins', 'projects.whoGroup', 'projects.widenBody', 'projects.legacyNote', 'projects.inTrash', 'projects.inTrashEdit', 'chat.project.inTrash', 'chat.project.hidden', 'chat.project.open', 'chat.project.add', 'chat.project.change', 'chat.project.title', 'chat.project.none', 'chat.project.hint', 'chat.project.empty', 'chat.project.moved', 'chat.project.removed'] as const
    for (const locale of ['en', 'ko', 'ja', 'es', 'id'] as const)
      for (const key of keys) expect(translate(locale, key)).not.toBe(key)
  })

  test('a project whose folder is in the trash (only admins list it) cannot be chosen, and says why', () => {
    const list = [project('p1', 'Acme launch', 'shared/acme-launch'), { ...project('p2', 'Acme old', 'shared/acme-old'), inTrash: true }]
    const html = inRouter(<ProjectChoices projects={list} selected={null} onSelect={() => {}} />)
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0])
    expect(radios.map((r) => r.includes('disabled=""'))).toEqual([false, false, true])
    expect(html).toContain(translate('en', 'chat.project.inTrash'))
    expect(html).not.toContain('shared/acme-old')
  })

  test('who can see a team project: its members (docs/DECISIONS.md "Project contents only for members"), and groups are 부서 in Korean', () => {
    expect(translate('ko', 'projects.whoMembers', { n: 9 })).toBe('멤버 9명')
    expect(translate('en', 'projects.whoMembers', { n: 9 })).not.toContain('admins')
    expect(translate('ko', 'projects.whoGroup', { name: '영업' })).toBe('영업 부서')
  })
})
