// Which in-app viewer can show a file (side panel). Everything else can only be downloaded.
import { cp949Text } from '@mycel/shared/text-encoding'
import { extOf } from './paths'

export type PreviewKind = 'pdf' | 'docx' | 'pptx' | 'sheet' | 'csv' | 'markdown' | 'text' | 'html' | 'svg' | 'xml' | 'image' | 'audio' | 'video'

const KINDS: Record<string, PreviewKind> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'sheet', xls: 'sheet', ods: 'sheet',
  csv: 'csv', tsv: 'csv',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', json: 'text', log: 'text', yml: 'text', yaml: 'text', toml: 'text', ini: 'text', js: 'text', mjs: 'text', ts: 'text', tsx: 'text', jsx: 'text',
  py: 'text', sql: 'text', css: 'text', sh: 'text', go: 'text', rs: 'text', java: 'text', kt: 'text', swift: 'text', c: 'text', cpp: 'text', h: 'text',
  rb: 'text', php: 'text', mmd: 'text', env: 'text',
  html: 'html', htm: 'html',
  svg: 'svg',
  xml: 'xml',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio',
  // WebM can contain video or only audio; the video viewer supports both without hiding video tracks.
  mp4: 'video', mov: 'video', webm: 'video',
}

/** Text previews show this much of a file at most (the rest: "only the beginning is shown"). */
export const PREVIEW_TEXT_MAX = 2_000_000
/** Preview limits (tab 5): PDF and Office 50 MB, images 20 MB, audio / video 60 MB; text kinds read only their beginning. */
const MB = 1024 * 1024
const TEXT_KINDS: PreviewKind[] = ['markdown', 'text', 'csv', 'html', 'svg', 'xml']
export function previewLimit(kind: PreviewKind): { max: number; truncate: boolean } {
  if (TEXT_KINDS.includes(kind)) return { max: PREVIEW_TEXT_MAX, truncate: true }
  if (kind === 'image') return { max: 20 * MB, truncate: false }
  if (kind === 'audio' || kind === 'video') return { max: 60 * MB, truncate: false }
  return { max: 50 * MB, truncate: false }
}

export const previewKind = (name: string): PreviewKind | null => KINDS[extOf(name)] ?? null

/**
 * Text of a text preview (QA R2-FMT-08): UTF-8 when the bytes are valid UTF-8 (a BOM is dropped), else legacy Korean
 * (CP949 / EUC-KR, the Korean Excel CSV default) when the bytes are clearly Korean (shared `cp949Text`: no decode
 * error, no Windows-1252 punctuation pair, at least 2 Hangul syllables, at least 80% of the non-ASCII characters are
 * Hangul syllables, at least 90% of the syllables are KS X 1001 pairs, no Hanja), else
 * UTF-8 with replacement characters. The server reads files for the AI with the same rule
 * (server/src/files/extract.ts decodeText).
 * `cut`: the bytes are only the beginning of the file, so a character cut at the end is dropped before the check.
 */
export function decodePreviewText(bytes: Uint8Array, cut = false): string {
  for (let drop = 0; drop <= (cut ? 3 : 0) && drop < bytes.length; drop++) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - drop)) } catch {}
  }
  for (let drop = 0; drop <= (cut ? 1 : 0) && drop < bytes.length; drop++) {
    const text = cp949Text(bytes.subarray(0, bytes.length - drop))
    if (text !== null) return text
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** Highlight.js language for a file name (code preview). */
export function languageOf(name: string): string | undefined {
  const e = extOf(name)
  const map: Record<string, string> = { js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', yml: 'yaml', rs: 'rust', kt: 'kotlin', h: 'c', rb: 'ruby', md: 'markdown', htm: 'xml', html: 'xml', svg: 'xml' }
  return map[e] ?? (e || undefined)
}

export type FileIconKind = 'folder' | 'image' | 'pdf' | 'doc' | 'sheet' | 'slides' | 'audio' | 'video' | 'code' | 'archive' | 'text' | 'other'
export function iconKind(name: string, folder = false): FileIconKind {
  if (folder) return 'folder'
  const e = extOf(name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (['doc', 'docx', 'odt', 'rtf', 'hwp', 'hwpx'].includes(e)) return 'doc'
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(e)) return 'sheet'
  if (['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'slides'
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(e)) return 'audio'
  if (['mp4', 'mov', 'mkv', 'avi'].includes(e)) return 'video'
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(e)) return 'archive'
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'json', 'yml', 'yaml', 'html', 'css', 'sh', 'sql'].includes(e)) return 'code'
  if (['txt', 'md', 'log'].includes(e)) return 'text'
  return 'other'
}
