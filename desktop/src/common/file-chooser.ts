// The app's own open dialog for the team page's <input type=file> in the Mac App Store build (main/app-window.ts
// answerFileChoosers): one file or several, a folder for webkitdirectory, and the input's accept as a filter. Pure:
// unit-tested in tests/unit/e-desktop-common.test.ts.

/** Only the Mac App Store (sandboxed) build answers file inputs itself; elsewhere Electron's own dialog opens.
 * MYCEL_DESKTOP_TEST_FILE_CHOOSER=1 turns it on in an unpacked app (tests), never in a packaged one. */
export function answersFileChoosers(mas: boolean, packaged: boolean, forced?: string): boolean {
  return mas || (!packaged && forced === '1')
}

export interface FileInput {
  /** the chooser asked for several files (CDP Page.fileChooserOpened mode selectMultiple) */
  multiple: boolean
  /** the input's attributes as CDP DOM.describeNode gives them: [name, value, name, value, ...] */
  attributes?: readonly string[]
}

export interface OpenDialogChoice {
  properties: ('openFile' | 'openDirectory' | 'multiSelections')[]
  filters?: { name: string; extensions: string[] }[]
}

/** extensions of the types the team page's inputs ask for (image/*, the team icon's types) */
const TYPE_EXTENSIONS: Record<string, string[]> = {
  'image/*': ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'heic', 'heif', 'avif', 'jxl', 'bmp', 'ico', 'tif', 'tiff', 'svg'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/svg+xml': ['svg'],
  'application/pdf': ['pdf'],
}

/** accept as a dialog filter. image/* lists the common image formats, so only a rare one (a camera's raw file, for
 * example) is hidden; a type not listed above, or anything unusual, means no filter at all. */
export function acceptFilter(accept: string): OpenDialogChoice['filters'] {
  const extensions = new Set<string>()
  for (const raw of accept.split(',')) {
    const a = raw.trim().toLowerCase()
    if (!a) continue
    const known = /^\.[a-z0-9][a-z0-9+-]{0,19}$/.test(a) ? [a.slice(1)] : TYPE_EXTENSIONS[a]
    if (!known) return undefined
    for (const e of known) extensions.add(e)
  }
  return extensions.size ? [{ name: [...extensions].join(', '), extensions: [...extensions] }] : undefined
}

export function openDialogChoice(input: FileInput): OpenDialogChoice {
  const attrs = new Map<string, string>()
  const a = input.attributes ?? []
  for (let i = 0; i + 1 < a.length; i += 2) attrs.set(a[i]!.toLowerCase(), a[i + 1]!)
  // a folder upload picks one folder; the page gets the files in it
  if (attrs.has('webkitdirectory')) return { properties: ['openDirectory'] }
  const filters = acceptFilter(attrs.get('accept') ?? '')
  return { properties: input.multiple ? ['openFile', 'multiSelections'] : ['openFile'], ...(filters ? { filters } : {}) }
}
