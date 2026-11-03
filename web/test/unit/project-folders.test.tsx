// A project is a folder with instructions (docs/DECISIONS.md "Projects: a folder with instructions"):
// - Files: a folder that is a project the person can see offers "Open project"; a folder they can write offers "Make it
//   a project", which opens the project dialog with that folder chosen and its name filled in (lib/projectFolders.ts,
//   components/ProjectForm.tsx);
// - the project dialog: an empty name on a chosen folder is the folder's own name;
// - a dialog moves a chat into a project or out of it (components/chat/ChatProject.tsx; the chat header's name of the
//   project is in project-folders-dom.test.tsx).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Project } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { folderName, folderProjectAction, projectName, projectsByFolder } from '../../src/lib/projectFolders'
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

  test('a folder the person can write becomes a project; a read-only folder, a file or a navigation-only folder offers nothing', () => {
    expect(folderProjectAction(entry('shared/acme-plans', 'write'), byFolder)).toEqual({ kind: 'make' })
    expect(folderProjectAction(entry('shared/acme-plans', 'read'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-plans', 'none'), byFolder)).toBeNull()
    expect(folderProjectAction(entry('shared/acme-launch/plan.md', 'write', 'file'), byFolder)).toBeNull()
  })

  test('the project\'s name: what was typed, else the folder\'s own name, at most 100 units as the server counts them', () => {
    expect(folderName('shared/acme-launch')).toBe('acme-launch')
    expect(folderName('')).toBe('')
    expect(projectName('  Launch  ', 'shared/acme-launch')).toBe('Launch')
    expect(projectName('   ', 'shared/acme-launch')).toBe('acme-launch')
    expect(projectName('', '')).toBe('')
    expect(projectName('', `shared/${'가'.repeat(120)}`).length).toBe(100)
    // the server's max(100) counts UTF-16 units: an emoji is two, and is never cut in half
    expect(projectName('😀'.repeat(60), '')).toBe('😀'.repeat(50))
    expect(projectName('a' + '😀'.repeat(60), '')).toBe('a' + '😀'.repeat(49))
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

  test('no folder chosen yet: Save stays off, even with a name, and the dialog asks for a folder (never the team root)', () => {
    for (const html of [inRouter(<ProjectForm onClose={() => {}} onSaved={() => {}} />), inRouter(<ProjectForm initialName="Acme launch" onClose={() => {}} onSaved={() => {}} />)]) {
      expect(saveButton(html)).toContain('disabled=""')
      expect(input(html, 'project-folder')).toContain(`placeholder="${translate('en', 'projects.folderNone')}"`)
      expect(input(html, 'project-folder')).toContain('value=""')
      expect(html).toContain(translate('en', 'projects.folderPick'))
      expect(html).not.toContain(translate('en', 'projects.nameHint'))
    }
  })

  test('editing a project on the team root (made before) still saves; its folder reads "Team folder"', () => {
    const html = inRouter(<ProjectForm project={project('p0', 'Acme all', '')} onClose={() => {}} onSaved={() => {}} />)
    expect(saveButton(html)).not.toContain('disabled=""')
    expect(input(html, 'project-folder')).toContain(`value="${translate('en', 'files.root')}"`)
  })

  test('editing a project keeps its own name rule', () => {
    const html = inRouter(<ProjectForm project={project('p1', 'Acme launch', 'shared/acme-launch')} onClose={() => {}} onSaved={() => {}} />)
    expect(input(html, 'project-name')).toContain('value="Acme launch"')
    expect(input(html, 'project-name')).not.toContain('placeholder="')
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
    const keys = ['files.makeProject', 'files.openProject', 'files.isProject', 'projects.nameHint', 'projects.folderNone', 'projects.folderPick', 'projects.inTrash', 'projects.inTrashEdit', 'chat.project.inTrash', 'chat.project.hidden', 'chat.project.open', 'chat.project.add', 'chat.project.change', 'chat.project.title', 'chat.project.none', 'chat.project.hint', 'chat.project.empty', 'chat.project.moved', 'chat.project.removed'] as const
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

  test('who can see a new team project folder: the owner and admins too, in every language', () => {
    expect(translate('ko', 'projects.participantsHint')).not.toContain('관리자 제외')
    expect(translate('ko', 'projects.participantsHint')).toContain('관리자')
    expect(translate('en', 'projects.participantsHint')).toContain('admins')
  })
})
