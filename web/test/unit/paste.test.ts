// The files a paste carries into a message box (src/lib/paste.ts): the clipboard's files, else its file items; text
// items are no files.
import { describe, expect, test } from 'bun:test'
import { pastedFiles } from '../../src/lib/paste'

const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
const item = (kind: 'file' | 'string', file: File | null = null) => ({ kind, type: file?.type ?? 'text/html', getAsFile: () => file }) as unknown as DataTransferItem
const data = (files: File[], items: DataTransferItem[]) => ({ files: files as unknown as FileList, items: items as unknown as DataTransferItemList })

describe('pasted files', () => {
  test("a screenshot, and a picture copied from a web page (its HTML beside it): the clipboard's files", () => {
    const shot = png()
    expect(pastedFiles(data([shot], [item('file', shot)]))).toEqual([shot])
    expect(pastedFiles(data([shot], [item('string'), item('file', shot)]))).toEqual([shot])
  })

  test('files empty: the file items give them; text alone, nothing or no clipboard is no file', () => {
    const shot = png()
    const doc = new File(['acme'], 'acme.txt', { type: 'text/plain' })
    expect(pastedFiles(data([], [item('string'), item('file', shot), item('file', doc)]))).toEqual([shot, doc])
    // an item the browser cannot give as a file
    expect(pastedFiles(data([], [item('file', null)]))).toEqual([])
    expect(pastedFiles(data([], [item('string')]))).toEqual([])
    expect(pastedFiles(data([], []))).toEqual([])
    expect(pastedFiles(null)).toEqual([])
    expect(pastedFiles(undefined)).toEqual([])
  })
})
