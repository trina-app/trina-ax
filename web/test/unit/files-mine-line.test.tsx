// 파일 opens 내 파일 and an upload there says so (docs/decisions/20261125-upload-destination.md): the line after an upload
// into 내 파일, "내 파일에 올렸어요 · 나만 봐요 · 팀과 같이 보려면 [옮기기]"; 옮기기 hands the saved paths to the page's Move
// picker; a guest gets the line without 옮기기; an upload into any other folder keeps its own rows. Also 파일's start
// (lib/rail.ts railRoot) and the hand-off from 최근 파일's Upload.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import FileUploads from '../../src/components/FileUploads'
import { translate, useLocaleStore } from '../../src/i18n'
import { addFileUpload, handUploads, patchFileUpload, takeHandedUploads, useFileUploads } from '../../src/lib/fileUploads'
import { myFilesPath, railRoot, railTarget } from '../../src/lib/rail'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
})
afterAll(() => {
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})
afterEach(() => useFileUploads.setState({ items: [] }))

const landed = (name: string, folder = 'users/mina') => {
  const u = addFileUpload(name, folder)
  patchFileUpload(u.id, { status: 'done', saved: `${folder}/${name}` })
  return u
}

test('an upload into 내 파일: one line with 옮기기, which hands its saved paths to the Move picker and closes the line', async () => {
  landed('견적서.pdf')
  landed('단가표.xlsx')
  let moved: string[] | null = null
  const m = await mount(<FileUploads here="users/mina" mine={{ folder: 'users/mina', guest: false, onMove: (p) => (moved = p) }} />)
  try {
    const line = m.get('upload-mine-line')
    expect(line.textContent).toContain(ko('files.mineLanded'))
    expect(line.textContent).toContain(ko('files.mineShareHint'))
    expect(m.get('upload-mine-move').textContent).toBe(ko('files.mineMove'))
    // the two rows fold into the line
    expect(m.container.querySelectorAll('li[data-status="done"]')).toHaveLength(1)
    await m.click(m.get('upload-mine-move'))
    expect(moved!).toEqual(['users/mina/견적서.pdf', 'users/mina/단가표.xlsx'])
    expect(useFileUploads.getState().items).toHaveLength(0)
  } finally {
    await m.unmount()
  }
})

test('a guest: the line without 옮기기', async () => {
  landed('메모.txt')
  const m = await mount(<FileUploads here="users/mina" mine={{ folder: 'users/mina', guest: true, onMove: () => {} }} />)
  try {
    expect(m.get('upload-mine-line').textContent).toContain(ko('files.mineLanded'))
    expect(m.get('upload-mine-line').textContent).not.toContain(ko('files.mineShareHint'))
    expect(m.find('upload-mine-move')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('another folder, or 내 파일 while it is shared (no `mine`): the usual rows, no line', async () => {
  landed('a.pdf', 'shared')
  landed('b.pdf')
  const m = await mount(<FileUploads here="shared" mine={null} />)
  try {
    expect(m.find('upload-mine-line')).toBeNull()
    expect(m.container.querySelectorAll('li[data-status="done"]')).toHaveLength(2)
  } finally {
    await m.unmount()
  }
})

test("파일's start is the person's own folder; without a person, 최근 파일 as before", () => {
  expect(myFilesPath('mina')).toBe('/files?path=users%2Fmina')
  expect(railRoot('files', 'mina')).toBe('/files?path=users%2Fmina')
  expect(railRoot('files', null)).toBe('/files?view=recent')
  expect(railTarget('files', 'ai', {}, 'mina')).toBe('/files?path=users%2Fmina')
  // the place already lit goes to its start, what was open there otherwise
  expect(railTarget('files', 'files', { files: '/files?path=shared' }, 'mina')).toBe('/files?path=users%2Fmina')
  expect(railTarget('files', 'ai', { files: '/files?path=shared' }, 'mina')).toBe('/files?path=shared')
  expect(railRoot('chats', 'mina')).toBe('/rooms')
})

test("최근 파일's Upload hands the files to 내 파일 once", () => {
  const f = new File(['x'], 'x.txt')
  handUploads([f], 'users/mina')
  expect(takeHandedUploads('shared')).toBeNull()
  expect(takeHandedUploads('users/mina')).toEqual([f])
  expect(takeHandedUploads('users/mina')).toBeNull()
})
