// What a downloaded file is, judged by its first bytes, never by what the site or the service said (save_url,
// docs/DECISIONS.md "save_url"). It takes images (PNG, JPEG, GIF, WebP), PDF, video (MP4, MOV, WebM) and audio (MP3,
// WAV, M4A, AAC, FLAC, Ogg with Vorbis or Opus): what image, video and voice services return (fal, Replicate,
// ElevenLabs). Everything else is refused, named when it is something people would recognise (SVG, HTML, an archive,
// a program), so the AI can say why.

export type KindName = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'mp4' | 'mov' | 'webm' | 'mp3' | 'wav' | 'm4a' | 'aac' | 'flac' | 'ogg' | 'opus'
export interface FileKind { name: KindName; ext: string; mime: string; label: string; image: boolean; media: 'image' | 'document' | 'video' | 'audio' }

const K = (name: KindName, ext: string, mime: string, label: string, media: FileKind['media']): FileKind => ({ name, ext, mime, label, image: media === 'image', media })
export const KINDS: Record<KindName, FileKind> = {
  png: K('png', 'png', 'image/png', 'PNG', 'image'),
  jpeg: K('jpeg', 'jpg', 'image/jpeg', 'JPEG', 'image'),
  gif: K('gif', 'gif', 'image/gif', 'GIF', 'image'),
  webp: K('webp', 'webp', 'image/webp', 'WebP', 'image'),
  pdf: K('pdf', 'pdf', 'application/pdf', 'PDF', 'document'),
  mp4: K('mp4', 'mp4', 'video/mp4', 'MP4', 'video'),
  mov: K('mov', 'mov', 'video/quicktime', 'MOV (QuickTime)', 'video'),
  webm: K('webm', 'webm', 'video/webm', 'WebM', 'video'),
  mp3: K('mp3', 'mp3', 'audio/mpeg', 'MP3', 'audio'),
  wav: K('wav', 'wav', 'audio/wav', 'WAV', 'audio'),
  m4a: K('m4a', 'm4a', 'audio/mp4', 'M4A', 'audio'),
  aac: K('aac', 'aac', 'audio/aac', 'AAC', 'audio'),
  flac: K('flac', 'flac', 'audio/flac', 'FLAC', 'audio'),
  ogg: K('ogg', 'ogg', 'audio/ogg', 'Ogg', 'audio'),
  opus: K('opus', 'opus', 'audio/ogg', 'Opus', 'audio'),
}
/** extensions that already name a kind correctly (kept as written) */
const SAME_EXT: Partial<Record<KindName, string[]>> = { jpeg: ['jpg', 'jpeg'], mov: ['mov', 'qt'], ogg: ['ogg', 'oga'], opus: ['opus', 'ogg'] }
export const ACCEPTED = 'PNG, JPEG, GIF and WebP images, PDF, MP4, MOV and WebM video, and MP3, WAV, M4A, AAC, FLAC and Ogg (Vorbis, Opus) audio'

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
/** MP4 major / compatible brands that are a video file (not HEIC / AVIF images; QuickTime's `qt  ` is MOV) */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'NDAS', 'mmp4', 'f4v '])
const M4A_BRANDS = new Set(['M4A ', 'M4B '])
const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'])
/** the atoms an older QuickTime file (no ftyp) starts with, and the filler atoms that may come before them */
const QT_FIRST = new Set(['moov', 'mdat'])
const QT_FILLER = new Set(['wide', 'free', 'skip'])

/** The kind of a file from its first bytes (at least 16 of them for most kinds), or null. */
export function sniffKind(b: Uint8Array): FileKind | null {
  const n = b.length
  if (n >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return KINDS.png
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return KINDS.jpeg
  if (n >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return KINDS.gif
  if (n >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return KINDS.webp
  if (n >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return KINDS.wav
  if (n >= 5 && ascii(b, 0, 5) === '%PDF-') return KINDS.pdf
  if (n >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const size = (b[0]! << 24 | b[1]! << 16 | b[2]! << 8 | b[3]!) >>> 0
    const brands = [ascii(b, 8, 4)]
    for (let at = 16; at + 4 <= Math.min(n, size || n); at += 4) brands.push(ascii(b, at, 4))
    if (IMAGE_BRANDS.has(brands[0]!)) return null
    if (M4A_BRANDS.has(brands[0]!)) return KINDS.m4a
    if (brands[0] === 'qt  ') return KINDS.mov
    if (brands.some((x) => MP4_BRANDS.has(x))) return KINDS.mp4
    if (brands.includes('qt  ')) return KINDS.mov
    return null
  }
  // an older QuickTime file without ftyp: it starts with its movie or media atom (after a `wide`, `free` or `skip`
  // filler atom at most). Its size is binary: a text file that happens to say "mdat" there (<!--mdat) is not one
  const textSize = n >= 4 && /^[\x20-\x7e]{4}$/.test(ascii(b, 0, 4))
  if (n >= 8 && !textSize && QT_FIRST.has(ascii(b, 4, 4))) return KINDS.mov
  if (n >= 8 && !textSize && QT_FILLER.has(ascii(b, 4, 4))) {
    const size = (b[0]! << 24 | b[1]! << 16 | b[2]! << 8 | b[3]!) >>> 0
    if (size >= 8 && size + 8 <= n && QT_FIRST.has(ascii(b, size + 4, 4))) return KINDS.mov
  }
  if (n >= 4 && ascii(b, 0, 4) === 'fLaC') return KINDS.flac
  // Ogg: the first page's first packet says the codec (Opus: OpusHead)
  if (n >= 4 && ascii(b, 0, 4) === 'OggS') return n >= 36 && ascii(b, 28, 8) === 'OpusHead' ? KINDS.opus : KINDS.ogg
  // EBML with DocType "webm" (Matroska's "matroska" is not taken in v1)
  if (n >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ascii(b, 0, n).includes('webm') ? KINDS.webm : null
  if (n >= 3 && ascii(b, 0, 3) === 'ID3') return KINDS.mp3
  // an MPEG audio frame header: sync, a known version, layer III, a usable bitrate and sample rate
  if (n >= 4 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    const version = (b[1]! >> 3) & 3, layer = (b[1]! >> 1) & 3, rate = (b[2]! >> 4) & 15, freq = (b[2]! >> 2) & 3
    if (version !== 1 && layer === 1 && rate !== 0 && rate !== 15 && freq !== 3) return KINDS.mp3
  }
  // AAC in ADTS: a 12-bit sync, layer 0, a known sample rate and a frame at least as long as its header
  if (n >= 7 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) {
    const freq = (b[2]! >> 2) & 15
    const frame = ((b[3]! & 3) << 11) | (b[4]! << 3) | (b[5]! >> 5)
    if (freq < 13 && frame >= ((b[1]! & 1) ? 7 : 9)) return KINDS.aac
  }
  return null
}

/** A name for a refused file, when it is one people would recognise. */
export function refusedName(b: Uint8Array): string | null {
  const n = b.length
  if (n >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'a ZIP archive (or an Office file)'
  if (n >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'a gzip archive'
  if (n >= 6 && ascii(b, 0, 6) === '7z\xbc\xaf\x27\x1c') return 'a 7-Zip archive'
  if (n >= 4 && ascii(b, 0, 4) === 'Rar!') return 'a RAR archive'
  if (n >= 4 && b[0] === 0x7f && ascii(b, 1, 3) === 'ELF') return 'a program'
  if (n >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes((b[0]! << 24 | b[1]! << 16 | b[2]! << 8 | b[3]!) >>> 0)) return 'a program'
  if (n >= 2 && ascii(b, 0, 2) === 'MZ') return 'a program'
  if (n >= 4 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (IMAGE_BRANDS.has(brand)) return 'a HEIC or AVIF image'
  }
  if (n >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'a Matroska (MKV) video'
  // text: skip a BOM and white space
  const t = new TextDecoder('utf-8', { fatal: false }).decode(b).replace(/^﻿/, '').trimStart().slice(0, 200).toLowerCase()
  if (t.startsWith('#!')) return 'a script'
  if (/^<svg\b/.test(t) || (/^<\?xml\b/.test(t) && t.includes('<svg'))) return 'an SVG image'
  if (/^<(!doctype html|html\b|head\b|body\b|script\b|iframe\b|meta\b)/.test(t)) return 'an HTML page'
  if (/^<\?xml\b/.test(t)) return 'an XML document'
  if (/^[{[]/.test(t)) return 'JSON or text'
  return null
}

/** `name` with the extension of `kind` (kept when it is already right): the name and whether it changed. */
export function withExtension(name: string, kind: FileKind): { name: string; changed: boolean } {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  const cur = m?.[1]?.toLowerCase()
  if (cur && (cur === kind.ext || SAME_EXT[kind.name]?.includes(cur))) return { name, changed: false }
  // a known media / document extension is replaced; any other dot in the name stays part of the name
  const replace = cur && /^(png|jpe?g|gif|webp|avif|heic|svg|bmp|tiff?|pdf|mp4|m4v|mov|qt|webm|mkv|mp3|wav|m4a|aac|ogg|oga|opus|flac|bin|dat|tmp|html?|txt|json|xml)$/.test(cur)
  return { name: (replace ? name.slice(0, -(cur!.length + 1)) : name) + '.' + kind.ext, changed: true }
}
