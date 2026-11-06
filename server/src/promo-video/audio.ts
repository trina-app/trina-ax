// The promo video's sound (docs/DECISIONS.md "V"): three music beds cut to the video's length on its 120 BPM grid
// (a downbeat on frame 0) and six short effects placed on the hits. Every file is CC0 or public domain, listed with its
// source in resources/promo-video/audio/SOURCES.md and the third-party notices; tests/unit/b-promo-video.test.ts checks
// that the folder holds exactly these files and that each one's licence is one we allow. The MP4 mixes them (the
// HyperFrames <audio> clips of renderDocument); the chat's player loads them from /vendor/promo-video/ only when the
// person turns the sound on (web/scripts/build-vendor.ts).
import path from 'node:path'
import { REPO_ROOT } from '../app-config'
import { STARTS, type VideoDoc } from './layout'

export const AUDIO_DIR = path.join(REPO_ROOT, 'resources', 'promo-video', 'audio')

export interface Sound {
  /** the file's name without ".m4a" (also its /vendor/promo-video/<name>.js) */
  name: string
  kind: 'bed' | 'sfx'
  /** seconds */
  duration: number
  /** seconds from the start to the loudest moment (an effect is placed so this lands on its hit) */
  peak: number
}

/** The sound files (durations and peaks measured when they were cut; see SOURCES.md). */
export const SOUNDS: Sound[] = [
  { name: 'bed-bright', kind: 'bed', duration: 18.5, peak: 0 },
  { name: 'bed-calm', kind: 'bed', duration: 18.5, peak: 0 },
  { name: 'bed-pulse', kind: 'bed', duration: 18.5, peak: 0 },
  { name: 'whoosh', kind: 'sfx', duration: 0.8, peak: 0.457 },
  { name: 'whoosh-short', kind: 'sfx', duration: 0.4, peak: 0.218 },
  { name: 'click', kind: 'sfx', duration: 0.06, peak: 0.005 },
  { name: 'hit', kind: 'sfx', duration: 0.45, peak: 0.022 },
  { name: 'impact', kind: 'sfx', duration: 2.3, peak: 0.506 },
  { name: 'chime', kind: 'sfx', duration: 1.4, peak: 0.097 },
]
const byName = new Map(SOUNDS.map((s) => [s.name, s]))

export interface AudioCue { id: string; file: string; start: number; volume: number }
const r3 = (n: number) => Math.round(n * 1000) / 1000

/** When the sounds play: the music from frame 0, each effect peaking on its hit (the template's beats). */
export function audioCues(doc: Pick<VideoDoc, 'music' | 'hook' | 'proof'>): AudioCue[] {
  const at = (file: string, hit: number, volume: number, id: string): AudioCue => ({ id, file, start: r3(Math.max(0, hit - (byName.get(file)?.peak ?? 0))), volume })
  const cues: AudioCue[] = [{ id: 'bed', file: `bed-${doc.music}`, start: 0, volume: 0.8 }]
  cues.push(doc.hook.mode === 'strike' ? at('hit', 2.0, 0.5, 'sfx-slam') : at('click', 1.5, 0.45, 'sfx-swap'))
  cues.push(at('whoosh', STARTS[1], 0.35, 'sfx-seam1'), at('whoosh-short', STARTS[2], 0.32, 'sfx-seam2'), at('whoosh-short', STARTS[3], 0.22, 'sfx-seam3'))
  if (doc.proof.stats.length) cues.push(at('click', STARTS[3] + 1.0, 0.3, 'sfx-count1'))
  if (doc.proof.stats.length > 1) cues.push(at('hit', STARTS[3] + 2.0, 0.35, 'sfx-count2'))
  cues.push(at('whoosh', STARTS[4], 0.35, 'sfx-seam4'), at('impact', STARTS[4] + 1.0, 0.5, 'sfx-lock'), at('chime', STARTS[4] + 1.0, 0.3, 'sfx-chime'))
  return cues
}

export const soundDuration = (name: string) => byName.get(name)?.duration ?? 1
