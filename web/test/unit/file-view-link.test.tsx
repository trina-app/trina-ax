// /files/view?path=… (the link the AI hands out) opens the file's panel once the files screen of its folder is the page
// on screen, not with the redirect (QA TC-228). Opened with the redirect, the panel was drawn on the old address first;
// on a phone it held its Back entry there and the change of address closed it again, so the link showed only the
// folder. A folder link opens no panel; a place in the file (&page=) comes along.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import FileView from '../../src/pages/FileView'
import { getSidePanel, setSidePanel, useSidePanel } from '../../src/lib/sidePanel'
import { installDom, mount, removeDom } from './dom-host'

beforeAll(() => installDom())
afterAll(() => removeDom())
beforeEach(() => setSidePanel(null))

/** the files screen, as far as this test needs: it says which address is drawn */
let drawn: string | null = null
function FilesProbe() {
  const loc = useLocation()
  drawn = loc.pathname + loc.search
  return <p data-testid="files">{loc.search}</p>
}
/** what was on screen when the panel was first drawn open (undefined: not yet) */
let onScreenThen: string | null | undefined
function PanelProbe() {
  const panel = useSidePanel()
  if (panel && onScreenThen === undefined) onScreenThen = drawn
  return null
}
const app = (url: string) => (
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/files/view" element={<FileView />} />
      <Route path="/files" element={<FilesProbe />} />
    </Routes>
    <PanelProbe />
  </MemoryRouter>
)

test('a file link: the panel opens after the folder is the page on screen, at the place the link names', async () => {
  drawn = null
  onScreenThen = undefined
  const m = await mount(app('/files/view?path=shared%2FNotes%2Fmemo-final.txt&page=3'))
  try {
    await m.until(() => getSidePanel(), 'the panel')
    expect(onScreenThen as string | null | undefined).toBe('/files?path=shared%2FNotes')
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/Notes/memo-final.txt', at: { kind: 'page', page: 3 } } })
  } finally {
    await m.unmount()
  }
})

test('a folder link opens the folder and no panel', async () => {
  const m = await mount(app('/files/view?path=shared%2FNotes'))
  try {
    await m.until(() => m.find('files'), 'the files screen')
    await m.settle(30)
    expect(drawn).toBe('/files?path=shared%2FNotes')
    expect(getSidePanel()).toBeNull()
  } finally {
    await m.unmount()
  }
})
