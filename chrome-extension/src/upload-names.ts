// file_upload's pure helpers, the same rules as the desktop's desktop/src/common/upload-files.ts (that file also writes
// temp files with node:fs, so it cannot be bundled here). Keep the two in step.

export const NAME_MAX = 120
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** A file name that is safe on every computer and still reads as the original (see the desktop's cleanUploadName). */
export function cleanUploadName(raw: string): string {
  let n = String(raw ?? '').normalize('NFC')
  n = n.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/[​-‏‪-‮⁦-⁩]/g, '')
  n = n.trim().replace(/[. ]+$/, '')
  n = n.replace(/^\.+/, (d) => '_'.repeat(d.length))
  if (!n) n = 'file'
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`
  const chars = Array.from(n)
  if (chars.length > NAME_MAX) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 ? Array.from(n.slice(dot)) : []
    const keepExt = ext.length > 0 && ext.length <= 16 ? ext : []
    n = chars.slice(0, NAME_MAX - keepExt.length).join('').replace(/[. ]+$/, '') + keepExt.join('')
  }
  return n || 'file'
}

export type UploadHow = 'input' | 'chooser' | 'drop'

/** auto: the file field behind the ref, else the picker its click opens, else a drop on it; or the one way asked for. */
export function uploadOrder(how: 'auto' | UploadHow | undefined): UploadHow[] {
  return how && how !== 'auto' ? [how] : ['input', 'chooser', 'drop']
}
