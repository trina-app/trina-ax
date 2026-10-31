// Video and audio files the AI reads with `read` (server/src/files/media.ts: frames and a timed transcript). One list for
// the server, the step labels ("Watch video · …") and the web app. docs/DECISIONS.md "AI reads video and audio".

/** videos: frames (pictures with their times) and a transcript of the sound */
export const VIDEO_EXT: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp'])
/** audio files: a transcript */
export const AUDIO_EXT: ReadonlySet<string> = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'amr', 'aiff', 'aif', 'aifc', 'caf', 'wma'])
export type MediaKind = 'video' | 'audio'

/** 'video' / 'audio' by the file name's extension, else null */
export function mediaKind(name: string): MediaKind | null {
  const x = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase()
  return VIDEO_EXT.has(x) ? 'video' : AUDIO_EXT.has(x) ? 'audio' : null
}
