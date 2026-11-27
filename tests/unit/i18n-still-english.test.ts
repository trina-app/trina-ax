// Texts never translated (language audit 2026-11-27): a value in a language that is the same as English is a text
// someone forgot, unless the word is the same there. A new key whose translation equals the English fails here: translate
// it (web/src/i18n/<language>.ts, desktop/src/common/i18n.ts), or, when the English word is what that language says too
// (a loanword like "Admin" or "Status" in Indonesian, "Total" in Spanish), add it to SAME below for that language.
// Not counted: values with no words left once placeholders, brand and product names and acronyms are taken out
// ("{n} / {total}", "Google Drive", "PDF"), and the words of a vendor's own screen the app quotes so a person finds the
// same button there (roomApps.vendorLabel.*, roomApps.kind.*, slack.admin.*: those screens are in English).
import { describe, expect, test } from 'bun:test'
import { DICTS } from '../../web/src/i18n'
import { STRINGS } from '../../desktop/src/common/i18n'
import catalog from '../../resources/plugins/catalog.json'

const LANGS = ['ko', 'id', 'ja', 'es', 'zh'] as const
const NAMES = /\(\.\w+\)|\b(Trina|AX|Google|Drive|Gmail|Calendar|Slack|GitHub|Notion|Claude|Code|Codex|ChatGPT|OpenAI|OpenRouter|Anthropic|Ollama|Figma|Canva|Microsoft|Windows|macOS|Linux|Android|iPhone|iOS|Mac|Chrome|Safari|Docker|Tailscale|Discord|Jira|HubSpot|Stripe|Zapier|Sentry|Typeform|Tally|Jotform|Shopify|Zendesk|Outlook|PowerPoint|OneDrive|Toss|Payments|Channel|Talk|PortOne|glibc|Beta|Internet|Emoji|acme|com|name|company|Acme)\b/g
/** the words of a text that a translator would translate */
export const words = (v: string) => v.replace(/\{\w+, plural,|\b(one|other|zero|few|many|two)\s*\{/g, ' ').replace(/\{\w+\}/g, ' ').replace(NAMES, ' ')
  .replace(/\b[A-Z0-9][A-Z0-9_.-]+\b/g, ' ').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => /\p{Ll}/u.test(w) && w.length >= 2)
const VENDOR_SCREEN = /^(roomApps\.vendorLabel\.|roomApps\.kind\.|slack\.admin\.)/

/** `<app>:<key>`: the languages where the English text is right as it is (a loanword, a vendor's or a format's own name). */
const SAME: Record<string, string> = {
  'desktop:localApp.program': 'id',
  'desktop:menu.edit': 'id',
  'desktop:menu.zoom': 'id es',
  'desktop:pane.title': 'id',
  'desktop:signin.emailLabel': 'id',
  'desktop:workFiles.desktop': 'id',
  'web:activity.chip.admin': 'id',
  'web:activity.detail.item': 'id',
  'web:admin.title': 'id',
  'web:apps.mockEdit': 'id',
  'web:apps.mockFile': 'id',
  'web:artifact.type.mermaid': 'id',
  'web:audit.source.admin': 'id',
  'web:audit.source.file': 'id',
  'web:browser.title': 'id',
  'web:budgets.tokensUsed': 'es',
  'web:composer.effort.normal': 'es',
  'web:credentials.setupToken.paste': 'id es zh',
  'web:credentials.spendLimitTokens': 'es',
  'web:credentials.target.personal': 'es',
  'web:deck.progress.slide': 'id',
  'web:engines.api.model': 'id',
  'web:engines.experimental': 'es',
  'web:engines.status.error': 'id es',
  'web:files.findWork.root.desktop': 'id',
  'web:files.summary.original': 'es',
  'web:folderAccess.canEdit': 'id es',
  'web:gapps.gmail.category': 'id',
  'web:guest.ai.tokens': 'es',
  'web:integrations.field.clientId': 'ko',
  'web:integrations.pick.label': 'es',
  'web:integrations.status.error': 'es',
  'web:md.diagram': 'id',
  'web:plan.title': 'es',
  'web:presence.offline': 'id',
  'web:presence.online': 'id',
  'web:preview.kind.sheet': 'id',
  'web:projects.ruleInside': 'id',
  'web:projectsPanel.chats': 'es',
  'web:promo.kind': 'id',
  'web:role.admin': 'id',
  'web:role.owner': 'id',
  'web:roomApps.address': 'ko id ja es zh',
  'web:roomApps.addressLabel': 'ko id ja es zh',
  'web:roomApps.hint.zendesk': 'es',
  'web:roomApps.preview.channel_talk.status': 'id',
  'web:roomApps.preview.jira.status': 'id',
  'web:roomApps.preview.sentry.detail': 'ko id ja es zh',
  'web:roomApps.preview.sentry.title': 'ko id ja es zh',
  'web:roomApps.secretName.stripe': 'id',
  'web:roomApps.secretPlaceholder': 'ko id ja es zh',
  'web:roomApps.switch.github.issue': 'es',
  'web:roomApps.switch.github.pull_request': 'es',
  'web:roomApps.switch.github.push': 'es',
  'web:roomApps.switch.hubspot.ticket': 'es',
  'web:search.tab.mcp': 'es',
  'web:search.tab.rooms': 'es',
  'web:settings.browser': 'id',
  'web:settings.email': 'id',
  'web:settings.group.app': 'es',
  'web:settings.myEngine.model': 'id',
  'web:sidebar.admin': 'id',
  'web:sidebar.label': 'id',
  'web:sidebar.view.status': 'id',
  'web:skillShare.latestFile': 'id',
  'web:skills.kind.skill': 'id',
  'web:skills.personal': 'es',
  'web:sources.sheet': 'id',
  'web:sources.sheetRange': 'id',
  'web:sources.slide': 'id',
  'web:speech.model': 'id',
  'web:speech.openrouter': 'id',
  'web:status.c.30m': 'es',
  'web:status.sr': 'id',
  'web:suggest.folder': 'id',
  'web:system.backupKind.manual': 'id es',
  'web:system.backupScope.incremental': 'es',
  'web:system.exportWhat.chats': 'es',
  'web:system.host': 'id',
  'web:system.row.status': 'id',
  'web:tabs.chats': 'es',
  'web:teamLink.skill': 'id',
  'web:teamSettings.section.general': 'es',
  'web:usage.by.model': 'id',
  'web:usage.by.skill': 'id',
  'web:usage.tokens': 'es',
  'web:usage.total': 'id es',
  'web:viewer.fileLabel': 'id',
  'web:welcome.skills.keysLinux': 'ko id ja es zh',
  'web:welcome.skills.short.scripts': 'es',
  'web:welcome.teamFiles.reason.proposal': 'id',
}

describe('no text left in English in another language', () => {
  test('every value equal to the English one is a word that language uses too (SAME)', () => {
    const found: string[] = []
    const seen = new Set<string>()
    for (const [app, d] of [['web', DICTS], ['desktop', STRINGS]] as const) {
      const en = d.en as Record<string, string>
      for (const l of LANGS) {
        const x = (d as unknown as Record<string, Record<string, string>>)[l]!
        for (const [k, v] of Object.entries(en)) {
          if (x[k] !== v || VENDOR_SCREEN.test(k) || !words(v).length) continue
          const id = `${app}:${k}`
          if (SAME[id]?.split(' ').includes(l)) { seen.add(`${id} ${l}`); continue }
          found.push(`${id} (${l}): "${v}"`)
        }
      }
    }
    const stale = Object.entries(SAME).flatMap(([id, ls]) => ls.split(' ').filter((l) => !seen.has(`${id} ${l}`)).map((l) => `${id} ${l}`))
    expect({ untranslated: found, staleInSAME: stale }).toEqual({ untranslated: [], staleInSAME: [] })
  })

  test('the word check skips placeholders, names and acronyms', () => {
    expect(words('{n} / {total}')).toEqual([])
    expect(words('Google Drive')).toEqual([])
    expect(words('PowerPoint (.pptx)')).toEqual([])
    expect(words('Save changes')).toEqual(['Save', 'changes'])
    expect(words('{n, plural, one {# chat} other {# chats}}')).toEqual(['chat', 'chats'])
  })

  test('the official plugin list names and describes each plugin in all six languages (the walk: Chinese saw English)', () => {
    for (const e of catalog.entries as { id: string; i18n: Record<string, { name?: string; description?: string }> }[]) {
      for (const l of ['en', ...LANGS]) expect({ id: e.id, l, name: !!e.i18n[l]?.name, description: !!e.i18n[l]?.description }).toEqual({ id: e.id, l, name: true, description: true })
    }
  })
})
