// One message box, managed in one place (docs/decisions/20261126-one-composer.md): every box people type a message in
// is drawn by components/composer/ComposerShell.tsx. This fails when a box of its own appears: a new text field outside
// the known places, the box's parts (voice input, the mic, the box's row, the attach sheet, send and Stop) used
// outside the shell and the four boxes built on it, or an Enter handler in a text field that is not IME-safe.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '../../src')

function files(dirs: string[]): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) out.push({ path: relative(root, p).split('\\').join('/'), text: readFileSync(p, 'utf8') })
    }
  }
  for (const d of dirs) walk(join(root, d))
  return out
}
const all = files(['components', 'pages'])

// Every text field of the web app and why it is not a message box. A new message box goes on the shell
// (components/composer/ComposerField.tsx), never here.
const FIELDS: Record<string, string> = {
  'components/composer/ComposerField.tsx': 'THE message box field (every box: ComposerShell)',
  'components/TokenTextarea.tsx': 'the mention field itself (used through ComposerField)',
  'components/chat/AskCard.tsx': "an ask card's own answer field",
  'components/chat/Messages.tsx': 'editing a sent message in place',
  'components/chat/QueuedMessages.tsx': 'editing a waiting message in place',
  'components/rooms/RoomMessages.tsx': "editing a room message in place (a computer's; a phone edits in the box)",
  'components/FilePanel.tsx': "a text file's editor",
  'components/integrations/IntegrationDialog.tsx': "a connection's notes",
  'components/integrations/LocalApp.tsx': "a local app's settings",
  'components/integrations/RequestDialog.tsx': "a connection request's notes",
  'components/LinkAskAccess.tsx': 'the note of an access request',
  'components/onboarding/ProfileStep.tsx': 'profile fields',
  'components/onboarding/TeamLinkPanel.tsx': "a team link's welcome note",
  'components/ProjectForm.tsx': "a project's description and instructions",
  'components/rooms/apps/AppsDialog.tsx': "a room app's code to copy (read only)",
  'components/settings/MemoryForm.tsx': 'a memory note',
  'components/settings/ScheduleEditDialog.tsx': "a schedule's request",
  'components/skills/SkillForm.tsx': "a skill form's free text",
  'components/SuggestSkillDialog.tsx': "a suggested skill's content",
  'pages/admin/DevEnvTeam.tsx': "the dev environment's sites",
  'pages/FileLink.tsx': 'the note of an access request',
  'pages/Skills.tsx': "a shared skill's content under review",
}

test('every text field of the web app is a known one; a message box is the shell', () => {
  const found = all.filter((f) => /<textarea\b|<TokenTextarea\b/.test(f.text)).map((f) => f.path)
  expect(found.sort()).toEqual(Object.keys(FIELDS).sort())
})

// the four boxes on the shell, and where the parts are defined
const BOX_PARTS_OK = new Set([
  'components/composer/ComposerShell.tsx',
  'components/composer/AttachMenu.tsx',
  'components/chat/Composer.tsx',
  'components/rooms/SideChatPanel.tsx',
  'components/rooms/RoomComposer.tsx',
  'components/chat/ChatThreadPanel.tsx',
])

test("a message box's parts are used by the shell and the boxes built on it only", () => {
  const parts = /useVoiceInput\(|<VoiceMic\b|<VoiceBar\b|<ComposerToolbar\b|<AttachSheet\b|<SendButton\b|<StopButton\b/
  const found = all.filter((f) => parts.test(f.text)).map((f) => f.path)
  expect(found.filter((p) => !BOX_PARTS_OK.has(p)).sort()).toEqual([])
})

test('the four boxes draw no frame, field, send or attach of their own', () => {
  for (const p of BOX_PARTS_OK) {
    if (p.startsWith('components/composer/')) continue
    const text = all.find((f) => f.path === p)!.text
    expect(text, p).toContain('<ComposerShell')
    expect(text, p).toContain('<ComposerField')
    expect(/<VoiceMic\b|<VoiceBar\b|<ComposerToolbar\b|<AttachSheet\b|<StopButton\b|type="file"/.test(text), p).toBe(false)
  }
})

test("a text field's Enter is IME-safe: enterSends, or composing() checked", () => {
  // an <input>'s Enter in a file that also has a text field is not one (named here)
  const INPUT_ENTER = new Set(['components/onboarding/ProfileStep.tsx', 'components/rooms/apps/AppsDialog.tsx'])
  const bad = all
    .filter((f) => f.path in FIELDS && !INPUT_ENTER.has(f.path))
    .filter((f) => /key === 'Enter'/.test(f.text) && !/enterSends\(|composing\(/.test(f.text))
    .map((f) => f.path)
  expect(bad).toEqual([])
  // the inline copies of the touch-screen check are gone: keys.ts touchScreen / enterSends
  expect(all.filter((f) => f.path in FIELDS && /key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing && e\.keyCode !== 229/.test(f.text)).map((f) => f.path)).toEqual([])
})
