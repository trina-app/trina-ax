// The general pack's fixed first line (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"): when the files
// are not meeting notes, "할 일 정리" opens with a fixed sentence and the web reads it (web/src/lib/welcome.ts
// isBriefSwitch, the sentence in i18n as welcome.files.briefSwitch) to offer "핵심 정리" in the invite. Teams in
// Japanese, Indonesian and Spanish get the English skill and the answer comes in their language, so the skill each team
// gets must name that team's sentence exactly, compared the way isBriefSwitch compares (letters and digits only).
import { expect, test } from 'bun:test'
import { Locale } from '@mycel/shared/api'
import { packLocale, SKILL_PACKS } from '../../server/src/onboarding/skill-packs'
import { ko } from '../../web/src/i18n/ko'
import { en } from '../../web/src/i18n/en'
import { id } from '../../web/src/i18n/id'
import { ja } from '../../web/src/i18n/ja'
import { es } from '../../web/src/i18n/es'

const TABLES: Record<Locale, Record<string, string>> = { ko, en, id, ja, es }
const bare = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

test('every team language: its "not meeting notes" sentence is in the meeting-tasks skill that team gets', () => {
  for (const locale of Locale.options) {
    const sentence = TABLES[locale]['welcome.files.briefSwitch']!
    expect(sentence.length).toBeGreaterThan(5)
    const skill = SKILL_PACKS.general.skills[packLocale(SKILL_PACKS.general, locale)]!['meeting-tasks']!
    expect({ locale, found: bare(skill).includes(bare(sentence)) }).toEqual({ locale, found: true })
  }
})
