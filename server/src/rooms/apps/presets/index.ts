// The presets: an Other app set up as a named service (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md
// "Presets"; migration 401). One file per service; parse.ts dispatches kind 'other' + preset here, inbound.ts takes
// the content types, the body cap and the signature scheme from here. The switches, names and signing rules the web
// app needs are in shared/src/api/room-apps.ts.
import { RoomAppPreset } from '@mycel/shared/api'
import type { PresetDef } from './common'
import { jotformPreset, tallyPreset, typeformPreset } from './forms'
import { notion } from './notion'
import { shopify } from './shopify'
import { stripe } from './stripe'
import { zendesk } from './zendesk'

export type { PresetDef } from './common'
export const PRESETS: Record<RoomAppPreset, PresetDef> = {
  notion, typeform: typeformPreset, tally: tallyPreset, jotform: jotformPreset, stripe, shopify, zendesk,
}
/** The row's preset when this build knows it; null for none; 'unknown' for one written by a newer build. */
export function presetOf(v: string | null | undefined): RoomAppPreset | null | 'unknown' {
  if (v === null || v === undefined || v === '') return null
  return RoomAppPreset.safeParse(v).success ? v as RoomAppPreset : 'unknown'
}
