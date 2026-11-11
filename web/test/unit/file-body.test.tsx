// A file's body (components/FileBody.tsx), which the side panel draws under its header: which renderer each kind of
// file gets (bodyRenderer), what comes before the viewer (the card, busy, an error, a Hangul file's pages,
// loading), and that the body draws it. Drawn here: files from this computer and room files with no preview here (no
// server); the PDF, Office and Hangul viewers load pdf.js and the Office renderers, so the e2e specs draw those.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import FileBody, { bodyRenderer, useFileBlob, type BodyRenderer, type FileBlob, type FileBlobError } from '../../src/components/FileBody'
import { translate, useLocaleStore } from '../../src/i18n'
import { closeImageViewer, getImageViewer } from '../../src/lib/imageViewer'
import { previewKind, type PreviewKind } from '../../src/lib/preview'
import type { PreviewFile } from '../../src/lib/sidePanel'
import { useSession } from '../../src/store/session'
import type { Me } from '@mycel/shared/api'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const realFetch = globalThis.fetch
let fetched: string[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  // the image viewer adds one history entry when it opens
  Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { state: null, pushState() {}, back() {} } })
})
/** one body on the page at a time: the next one replaces it */
let shown: Mounted | null = null
async function show(ui: ReactNode): Promise<Mounted> {
  await shown?.unmount()
  shown = await mount(<MemoryRouter>{ui}</MemoryRouter>)
  return shown
}
afterEach(async () => {
  closeImageViewer()
  globalThis.fetch = realFetch
  await shown?.unmount()
  shown = null
})
afterAll(() => {
  removeDom()
  useLocaleStore.setState({ locale })
})

const bytes = new Blob(['x'])
const read = (name: string): Pick<FileBlob, 'kind' | 'blob' | 'error'> => ({ kind: previewKind(name), blob: bytes, error: null })
const failed = (kind: FileBlobError['kind'], text = 'why'): FileBlobError => ({ kind, text })

test('each kind of file gets its renderer once its bytes are read', () => {
  const want: Record<string, BodyRenderer> = {
    'report.pdf': 'pdf',
    'memo.docx': 'docx',
    'deck.pptx': 'pptx',
    'budget.xlsx': 'sheet', 'old.xls': 'sheet', 'calc.ods': 'sheet',
    'photo.png': 'picture', 'photo.jpg': 'picture', 'photo.jpeg': 'picture', 'anim.gif': 'picture', 'shot.webp': 'picture',
    // a team HEIC photo: the server's JPEG, drawn as a picture
    'iphone.heic': 'picture',
    'voice.mp3': 'media', 'talk.m4a': 'media', 'clip.mp4': 'media', 'clip.mov': 'media', 'clip.webm': 'media',
    // CSV, Markdown, text and code, HTML and SVG (the sandbox frame), XML (escaped text): one text renderer
    'leads.csv': 'text', 'leads.tsv': 'text', 'README.md': 'text', 'notes.txt': 'text', 'app.log': 'text', 'config.json': 'text',
    'main.ts': 'text', 'page.html': 'text', 'logo.svg': 'text', 'feed.xml': 'text',
    // no viewer for the format: the card with its download
    'archive.zip': 'card', 'old.doc': 'card', 'slides.ppt': 'card', 'noext': 'card',
  }
  for (const [name, renderer] of Object.entries(want)) expect([name, bodyRenderer(read(name))]).toEqual([name, renderer])
  // every kind the app knows, by its kind (a Hangul file's pages come from the server: no bytes read here)
  const byKind: Record<PreviewKind, BodyRenderer> = {
    hwp: 'hwp', pdf: 'pdf', docx: 'docx', pptx: 'pptx', sheet: 'sheet', image: 'picture', audio: 'media', video: 'media',
    csv: 'text', markdown: 'text', text: 'text', html: 'text', svg: 'text', xml: 'text',
  }
  for (const [kind, renderer] of Object.entries(byKind) as [PreviewKind, BodyRenderer][]) {
    expect([kind, bodyRenderer({ kind, blob: kind === 'hwp' ? null : bytes, error: null })]).toEqual([kind, renderer])
  }
})

test('before the viewer: the card, busy, an error, a Hangul file\'s pages, then loading', () => {
  // the server could not convert it, or it is download-only: the card, also for a kind with a viewer
  expect(bodyRenderer({ kind: 'image', blob: null, error: failed('unsupported') })).toBe('card')
  expect(bodyRenderer({ kind: 'pdf', blob: null, error: failed('unsupported') })).toBe('card')
  expect(bodyRenderer({ kind: 'image', blob: null, error: failed('busy') })).toBe('busy')
  for (const kind of ['missing', 'large', 'other'] as const) expect(bodyRenderer({ kind: 'pdf', blob: null, error: failed(kind) })).toBe('error')
  // a Hangul file: the server's pages, with no bytes read here
  expect(bodyRenderer({ kind: 'hwp', blob: null, error: null })).toBe('hwp')
  expect(bodyRenderer({ kind: 'pdf', blob: null, error: null })).toBe('loading')
})

/** The body as the panel draws it: useFileBlob's bytes for the file. */
function Body({ file, openPicture }: { file: PreviewFile; openPicture?: () => void }) {
  const loaded = useFileBlob(file)
  return <FileBody file={file} loaded={loaded} width={600} download={() => {}} onRetry={() => {}} openPicture={openPicture} />
}
const local = (name: string, text = 'x', type = ''): PreviewFile => ({ source: 'local', name, blob: new Blob([text], { type }) })
const draw = (file: PreviewFile, openPicture?: () => void) => show(<Body file={file} openPicture={openPicture} />)

test('a file from this computer is drawn by its kind', async () => {
  const picture = await draw(local('photo.png', 'png', 'image/png'))
  expect(picture.get('file-panel-image').querySelector('img')?.getAttribute('alt')).toBe('photo.png')

  const audio = await draw(local('voice.mp3'))
  expect(audio.container.querySelector('audio')?.getAttribute('aria-label')).toBe('voice.mp3')
  const video = await draw(local('clip.mp4'))
  expect(video.container.querySelector('video')?.getAttribute('aria-label')).toBe('clip.mp4')

  const text = await draw(local('notes.txt', 'line one'))
  await text.until(() => text.container.querySelector('pre')?.textContent === 'line one', 'the text')

  const csv = await draw(local('leads.csv', 'name,amount\nacme,1200'))
  await csv.until(() => csv.container.querySelectorAll('td').length === 4, 'the table')
  expect([...csv.container.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['name', 'amount', 'acme', '1200'])

  const md = await draw(local('SKILL.md', '---\nname: weekly-report\n---\n# Weekly'))
  await md.until(() => md.find('md-front-matter'), 'the front matter')
  expect(md.html()).toContain('Weekly')
})

test('no preview here: the card with the download, never a request', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new Response('', { status: 500 })
  }) as typeof fetch
  fetched = []
  // no viewer for the format; a HEIC photo or a Hangul file not in the team folder (the server converts team files only;
  // a room's Hangul file has its pages only while the HWP preview is on, off here)
  for (const file of [local('archive.zip'), local('iphone.heic'), local('form.hwp'), { source: 'room', roomId: 'r1', fileId: 'f1', name: 'form.hwpx' } satisfies PreviewFile, { source: 'room', roomId: 'r1', fileId: 'f2', name: 'photo.heic' } satisfies PreviewFile]) {
    const m = await draw(file)
    expect(m.get('preview-unsupported').textContent).toContain(en('preview.unsupported'))
    expect(m.find('preview-unsupported-download')).not.toBeNull()
  }
  expect(fetched).toEqual([])
})

test("a room's Hangul file: its pages while the HWP preview is on, else the card; its bytes are never read here", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new Response('', { status: 500 })
  }) as typeof fetch
  fetched = []
  const on = { server: { version: '0', dev: false, hwpPreview: true } } as unknown as Me
  const off = { server: { version: '0', dev: false } } as unknown as Me
  function Renderer({ file }: { file: PreviewFile }) {
    return <p data-testid="renderer">{bodyRenderer(useFileBlob(file))}</p>
  }
  const status = useSession.getState().status
  try {
    for (const [me, room, here] of [[on, 'hwp', 'card'], [off, 'card', 'card']] as const) {
      useSession.setState({ status: { kind: 'signed-in', me } } as never)
      const inRoom = await show(<Renderer file={{ source: 'room', roomId: 'r1', fileId: 'f1', name: 'acme-form.HWPX' }} />)
      expect(inRoom.get('renderer').textContent).toBe(room)
      // a Hangul file from this computer has no pages either way (not uploaded yet)
      const fromHere = await show(<Renderer file={local('acme-form.hwp')} />)
      expect(fromHere.get('renderer').textContent).toBe(here)
    }
  } finally {
    useSession.setState({ status })
  }
  expect(fetched).toEqual([])
})

test('the card, busy and error states from the bytes read', async () => {
  const room: PreviewFile = { source: 'room', roomId: 'r1', fileId: 'f1', name: 'report.pdf' }
  const teamPdf: PreviewFile = { source: 'team', path: 'finance/report.pdf', name: 'report.pdf' }
  const body = (file: PreviewFile, loaded: FileBlob, onRetry = () => {}) => show(<FileBody file={file} loaded={loaded} width={600} download={() => {}} onRetry={onRetry} />)
  // download-only: the server's own words; a team file also says why the AI cannot read it, a room file has no AI action
  const held = { kind: 'pdf', blob: null, error: failed('unsupported', 'Download only'), downloadOnly: true } as const
  const heldTeam = await body(teamPdf, held)
  expect(heldTeam.get('preview-unsupported').textContent).toContain('Download only')
  expect(heldTeam.get('preview-download-only-ai').textContent).toBe(en('files.askAiDownloadOnly'))
  expect((await body(room, held)).find('preview-download-only-ai')).toBeNull()

  // too many photo conversions on the server now: "try again" reads it again
  let retried = 0
  const photo: PreviewFile = { source: 'team', path: 'photos/iphone.heic', name: 'iphone.heic' }
  const busy = await body(photo, { kind: 'image', blob: null, error: failed('busy', 'Busy'), downloadOnly: false }, () => retried++)
  expect(busy.get('preview-busy').textContent).toContain('Busy')
  await busy.click('preview-busy-retry')
  expect(retried).toBe(1)

  const missing = await body(teamPdf, { kind: 'pdf', blob: null, error: failed('missing', 'Not found'), downloadOnly: false })
  expect(missing.container.querySelector('[role="alert"]')?.textContent).toBe('Not found')
  const other = await body(teamPdf, { kind: 'pdf', blob: null, error: failed('other', 'Offline'), downloadOnly: false })
  expect(other.container.querySelector('[role="alert"]')?.getAttribute('class')).toContain('text-danger')

  const loading = await body(room, { kind: 'pdf', blob: null, error: null, downloadOnly: false })
  expect(loading.container.textContent).toContain(en('common.loading'))
})

test('a picture opens the image viewer alone, or the caller\'s viewer when it passes one', async () => {
  const own = await draw(local('photo.png', 'png', 'image/png'))
  await own.click('file-panel-image')
  expect(getImageViewer()?.entry.item.name).toBe('photo.png')
  closeImageViewer()

  let opened = 0
  const theirs = await draw(local('photo.png', 'png', 'image/png'), () => opened++)
  await theirs.click('file-panel-image')
  expect(opened).toBe(1)
  expect(getImageViewer()).toBeNull()
})
