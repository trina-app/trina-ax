// Projects on screen, rendered and clicked (docs/DECISIONS.md "Projects: a folder with instructions"):
// - the chat header's "Project /" before the title: the project's own name, linked, never the generic "Projects"; it
//   follows a rename saved in this window, is asked again when the window comes back, and goes for a project the person
//   cannot see;
// - the move dialog says when the chat's project is one the person can no longer see;
// - a 409 that names the project already on a folder offers to open it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ChatProjectCrumb, MoveToProjectDialog } from '../../src/components/chat/ChatProject'
import { ChatTitleMenu } from '../../src/components/chat/ChatTitleMenu'
import { ProjectForm } from '../../src/components/ProjectForm'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const P1 = '01900000-0000-7000-8000-000000000001', GONE = '01900000-0000-7000-8000-000000000002', C1 = '01900000-0000-7000-8000-000000000003'
const project = (id: string, name: string, folderPath: string): Project =>
  ({ id, name, folderPath, instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true })
const chat = (projectId: string | null): Chat =>
  ({ id: C1, projectId, title: 'Acme board summary', engine: 'claude-code', model: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null, runState: 'idle' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** answers by "METHOD path" (the query left out); anything else is a loud 500 */
let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}
const calls: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push(key)
    return routes[key]?.(init) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

describe('the chat header and its project', () => {
  test('the name follows a rename saved in this window, and is asked again when the window comes back', async () => {
    let name = 'Acme launch'
    routes = { [`GET /api/projects/${P1}`]: () => json(200, project(P1, name, 'shared/acme-launch')) }
    const m = await mount(<MemoryRouter><ChatProjectCrumb projectId={P1} /></MemoryRouter>)
    await m.until(() => m.find('chat-project')?.textContent?.includes('Acme launch'), 'the project name', 2000)
    const link = m.get('chat-project')
    expect(link.getAttribute('href')).toBe(`/projects/${P1}`)
    expect(link.getAttribute('title')).toBe(translate('en', 'chat.project.open', { name: 'Acme launch' }))
    expect(m.html()).not.toContain(`>${translate('en', 'sidebar.projects')}<`)
    // saved in the project dialog or on the Projects page of this window
    useProjects.getState().put(project(P1, 'Acme launch 2027', 'shared/acme-launch'))
    await m.until(() => m.find('chat-project')?.textContent?.includes('Acme launch 2027'), 'the new name', 2000)
    // renamed on another device: asked again when the window gets the focus back
    name = 'Acme relaunch'
    await m.settle()
    window.dispatchEvent(new Event('focus'))
    await m.until(() => m.find('chat-project')?.textContent?.includes('Acme relaunch'), 'the name from the server', 2000)
    await m.unmount()
  })

  test('a project the person can no longer see: no name in the header, and the move dialog says so', async () => {
    useProjects.getState().put(project(GONE, 'Old plan', 'shared/old'))
    routes = {
      [`GET /api/projects/${GONE}`]: () => json(404, { error: { code: 'not_found', message: 'not found' } }),
      'GET /api/projects': () => json(200, { items: [project(P1, 'Acme launch', 'shared/acme-launch')] }),
    }
    const bar = await mount(<MemoryRouter><ChatProjectCrumb projectId={GONE} /></MemoryRouter>)
    await bar.until(() => !bar.find('chat-project'), 'the stale name to go', 2000)
    await bar.unmount()
    const m = await mount(<MemoryRouter><MoveToProjectDialog chat={chat(GONE)} onClose={() => {}} onMoved={() => {}} /></MemoryRouter>)
    const hidden = await m.until(() => m.find('chat-project-hidden'), 'the hidden project row', 2000)
    expect(hidden.textContent).toContain(translate('en', 'chat.project.hidden'))
    expect((hidden.querySelector('input') as unknown as { checked: boolean } | null)?.checked).toBe(true)
    expect(m.html()).not.toContain(translate('en', 'chat.project.empty'))
    await m.unmount()
  })
})

describe('the project dialog and the names elsewhere', () => {
  test('a rename saved in the dialog is what the rest of the window shows', async () => {
    useProjects.getState().put(project(P1, 'Acme launch', 'shared/acme-launch'))
    routes = { [`PATCH /api/projects/${P1}`]: () => json(200, project(P1, 'Acme launch 2027', 'shared/acme-launch')) }
    const m = await mount(<MemoryRouter><ProjectForm project={project(P1, 'Acme launch', 'shared/acme-launch')} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.type('project-name', 'Acme launch 2027')
    await m.click('project-save')
    await m.until(() => useProjects.getState().byId[P1]?.name === 'Acme launch 2027', 'the store to have the new name', 2000)
    await m.unmount()
  })
})

describe('a project whose folder is in the trash (an admin\'s view)', () => {
  test('the dialog says so; a save that only edits sends no folder; choosing a folder, also the old path, sends it', async () => {
    const sent: unknown[] = []
    routes = {
      [`PATCH /api/projects/${P1}`]: (init) => { sent.push(JSON.parse(String(init?.body))); return json(200, { ...project(P1, 'Acme launch', 'shared/acme-launch'), inTrash: false }) },
      'GET /api/files/tree': () => json(200, { path: 'shared/acme-launch', access: 'write', entries: [], nextCursor: null }),
    }
    const marked = { ...project(P1, 'Acme launch', 'shared/acme-launch'), inTrash: true }
    // an admin: only admins see such a project, and only they may choose its folder
    const before = useSession.getState().status
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'u-admin', role: 'admin' } } } } as never)
    const m = await mount(<MemoryRouter><ProjectForm project={marked} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    expect(m.get('project-form-in-trash').textContent).toBe(translate('en', 'projects.inTrashEdit'))
    await m.type('project-name', 'Acme launch 2027')
    await m.click('project-save')
    await m.until(() => sent.length, 'the save', 2000)
    expect(sent[0]).not.toHaveProperty('folderPath')
    await m.unmount()
    // the admin chooses the old path in the picker: that is pointing the project at the folder now there
    sent.length = 0
    const n = await mount(<MemoryRouter><ProjectForm project={marked} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await n.click('project-folder-choose')
    const pick = await n.until(() => { const b = n.find('folder-pick'); return b && !b.hasAttribute('disabled') ? b : null }, 'the picker', 2000)
    await n.click(pick)
    await n.click('project-save')
    await n.until(() => sent.length, 'the save', 2000)
    expect(sent[0]).toMatchObject({ folderPath: 'shared/acme-launch' })
    await n.unmount()
    useSession.setState({ status: before })
    // a project in place sends no folder when it did not change
    sent.length = 0
    const o = await mount(<MemoryRouter><ProjectForm project={project(P1, 'Acme launch', 'shared/acme-launch')} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    expect(o.find('project-form-in-trash')).toBeNull()
    await o.click('project-save')
    await o.until(() => sent.length, 'the save', 2000)
    expect(sent[0]).not.toHaveProperty('folderPath')
    await o.unmount()
  })

  test('the header says it after the name, for the admins who see it', async () => {
    routes = { [`GET /api/projects/${P1}`]: () => json(200, { ...project(P1, 'Acme launch', 'shared/acme-launch'), inTrash: true }) }
    const m = await mount(<MemoryRouter><ChatProjectCrumb projectId={P1} /></MemoryRouter>)
    const marker = await m.until(() => m.find('chat-project-in-trash'), 'the trash marker', 2000)
    expect(marker.textContent).toBe(translate('en', 'chat.project.inTrash'))
    await m.unmount()
  })
})

describe('the chat title menu', () => {
  const items = (m: { container: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null; textContent: string | null }> } }) =>
    Array.from(m.container.querySelectorAll('[role="menuitem"]')).map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
  test('Rename, Move to project…, Delete; "Change project…" for a chat in a project, also one the person cannot see', async () => {
    let moved = 0
    const m = await mount(<ChatTitleMenu chat={{ projectId: null }} title="Acme board summary" onRename={() => {}} onMove={() => moved++} onDelete={() => {}} />)
    await m.click('chat-menu')
    expect(items(m)).toEqual([['chat-rename', translate('en', 'chat.rename')], ['chat-project-move', translate('en', 'chat.project.add')], ['chat-delete', translate('en', 'common.delete')]])
    await m.click('chat-project-move')
    expect(moved).toBe(1)
    await m.unmount()
    const n = await mount(<ChatTitleMenu chat={{ projectId: GONE }} title="Acme board summary" onRename={() => {}} onMove={() => {}} onDelete={() => {}} />)
    await n.click('chat-menu')
    expect(items(n)[1]).toEqual(['chat-project-move', translate('en', 'chat.project.change')])
    await n.unmount()
  })
})

describe('signing out', () => {
  test('the projects one person saw are forgotten (App.tsx resets the store with the chats)', () => {
    useProjects.getState().put(project(P1, 'Acme launch', 'shared/acme-launch'))
    useProjects.getState().reset()
    expect(useProjects.getState().byId).toEqual({})
  })
})

describe('only the latest answer counts', () => {
  test('a slow 200 that arrives after a newer 404 does not bring the project\'s name back', async () => {
    useProjects.getState().drop(P1)
    let calls = 0
    routes = {
      [`GET /api/projects/${P1}`]: () => {
        calls++
        if (calls === 1) return new Promise<Response>((r) => setTimeout(() => r(json(200, project(P1, 'Acme launch', 'shared/acme-launch'))), 300))
        return json(404, { error: { code: 'not_found', message: 'not found' } })
      },
    }
    const m = await mount(<MemoryRouter><ChatProjectCrumb projectId={P1} /></MemoryRouter>)
    window.dispatchEvent(new Event('focus'))
    await m.settle(500)
    expect(calls).toBe(2)
    expect(m.find('chat-project')).toBeNull()
    expect(useProjects.getState().byId[P1]).toBeUndefined()
    await m.unmount()
  })
})

describe('the project dialog after a 409', () => {
  test('the project already on the folder can be opened from the message', async () => {
    routes = {
      'POST /api/projects': () => json(409, { error: { code: 'conflict', message: "This folder is already the project 'Acme launch'. Open that project, or pick another folder.", params: { reason: 'project_folder_taken', projectId: P1 } } }),
    }
    const m = await mount(<MemoryRouter><ProjectForm initialFolder="shared/acme-launch" initialName="acme-launch" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.click('project-save')
    const link = await m.until(() => m.find('project-taken-open'), 'the open-project link', 2000)
    expect(link.getAttribute('href')).toBe(`/projects/${P1}`)
    expect(link.textContent).toBe(translate('en', 'files.openProject'))
    await m.unmount()
  })

  test('a 409 that does not name the project (the caller cannot see it) offers no link', async () => {
    routes = { 'POST /api/projects': () => json(409, { error: { code: 'conflict', message: 'Another project already uses this folder. Pick another folder.', params: { reason: 'project_folder_taken' } } }) }
    const m = await mount(<MemoryRouter><ProjectForm initialFolder="shared/acme-launch" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.click('project-save')
    await m.until(() => m.html().includes('Another project already uses this folder'), 'the message', 2000)
    expect(m.find('project-taken-open')).toBeNull()
    await m.unmount()
  })
})
