import { afterEach, describe, expect, test } from 'bun:test'
import { addFileUpload, dropFileUpload, forgetFileUploads, patchFileUpload, useFileUploads } from '../../src/lib/fileUploads'

const items = () => useFileUploads.getState().items
afterEach(() => useFileUploads.setState({ items: [] }))

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

  test('sign-out: no name stays for the next person in this tab, and nothing goes on uploading', () => {
    const running = addFileUpload('private.pdf', 'users/me')
    const finished = addFileUpload('done.pdf', 'users/me')
    patchFileUpload(finished.id, { status: 'done' })
    forgetFileUploads()
    expect(items()).toEqual([])
    expect(running.abort.signal.aborted).toBe(true)
  })
})
