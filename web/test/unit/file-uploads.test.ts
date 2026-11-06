import { afterEach, describe, expect, test } from 'bun:test'
import { addFileUpload, dropFileUpload, forgetFileUploads, patchFileUpload, useFileUploads } from '../../src/lib/fileUploads'
import { folderGeneration, forgetFolderUploads, useRuns, type Run } from '../../src/lib/folderRuns'
import { SIGNED_OUT } from '../../src/lib/localData'
import { forgetTeamAttach, readStash, writeStash } from '../../src/lib/teamAttach'
import { useSession } from '../../src/store/session'

const items = () => useFileUploads.getState().items
afterEach(() => {
  useFileUploads.setState({ items: [] })
  useRuns.setState({ runs: [] })
})

describe('the rows of the file screen', () => {
  test('a report changes its own row, and leaves the other rows as they are (they do not redraw)', () => {
    const a = addFileUpload('a.pdf', 'docs')
    const b = addFileUpload('b.pdf', 'docs')
    const other = items()[1]
    patchFileUpload(a.id, { progress: { phase: 'uploading', loaded: 5, total: 10 } })
    expect(items()[0]!.progress?.loaded).toBe(5)
    expect(items()[1]).toBe(other)
    dropFileUpload(a.id)
    expect(items().map((u) => u.id)).toEqual([b.id])
  })

  test('a late report of a row that is gone changes nothing', () => {
    const a = addFileUpload('a.pdf', 'docs')
    dropFileUpload(a.id)
    patchFileUpload(a.id, { status: 'failed', error: 'late' })
    expect(items()).toEqual([])
  })
})

describe('sign-out, or the end of a session', () => {
  test('file uploads: no name stays for the next person, and the reason tells it from a person\'s cancel', () => {
    const running = addFileUpload('private.pdf', 'users/me')
    const finished = addFileUpload('done.pdf', 'users/me')
    patchFileUpload(finished.id, { status: 'done' })
    forgetFileUploads()
    expect(items()).toEqual([])
    expect(running.abort.signal.aborted).toBe(true)
    expect(running.abort.signal.reason).toBe(SIGNED_OUT)
  })

  test('folder uploads: every run stops, and no row stays', () => {
    const reasons: unknown[] = []
    const run = (id: number) => ({ run: { id, stop: (r: unknown) => reasons.push(r) }, view: { status: 'running' } }) as unknown as Run // a view like a real run: FolderUploads' module-level guard reads it once that module is loaded
    useRuns.setState({ runs: [run(1), run(2)] })
    forgetFolderUploads()
    expect(reasons).toEqual([SIGNED_OUT, SIGNED_OUT])
    expect(useRuns.getState().runs).toEqual([])
  })

  test('a dropped folder that is still being read can tell the person changed: the generation moves on', () => {
    const before = folderGeneration()
    forgetFolderUploads()
    expect(folderGeneration()).toBe(before + 1)
  })

  test('chips: one that is on its way, or waiting for its turn, stops (it would start with the next person\'s session)', () => {
    const running = { id: 'a', abort: new AbortController() }
    writeStash('u1', 'chat', [running])
    forgetTeamAttach()
    expect(running.abort.signal.reason).toBe(SIGNED_OUT)
    expect(readStash('u1', 'chat')).toEqual([])
  })

  test('the session store does all of it', () => {
    const file = addFileUpload('private.pdf', 'users/me')
    const reasons: unknown[] = []
    useRuns.setState({ runs: [{ run: { id: 3, stop: (r: unknown) => reasons.push(r) }, view: { status: 'running' } } as unknown as Run] })
    useSession.getState().signedOut('expired')
    expect(file.abort.signal.reason).toBe(SIGNED_OUT)
    expect(reasons).toEqual([SIGNED_OUT])
    expect(items()).toEqual([])
    expect(useRuns.getState().runs).toEqual([])
  })
})
