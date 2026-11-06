// What the AI is about to do, in the words of the person's language, for the pane's permission question ("Open page ·
// https://…"): the same words as the step under the answer (shared/src/step-labels.ts), never the tool's own name
// (preview_start, computer, …), which means nothing to the person.
import { BROWSER_STEP_FALLBACK, BROWSER_STEP_VERB } from '@mycel/shared'
import type { UiLocale } from './locales'

export function browserAction(tool: string, locale: UiLocale): string {
  const words = Object.hasOwn(BROWSER_STEP_VERB, tool) ? BROWSER_STEP_VERB[tool]! : BROWSER_STEP_FALLBACK
  return words[locale] ?? words.en
}
