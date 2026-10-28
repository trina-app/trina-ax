// Which in-app viewer can show a file (side panel). Everything else can only be downloaded.
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
