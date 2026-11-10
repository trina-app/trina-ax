// A text with some of its values in <bdi> (the handover's card, Inbox rows and confirm): a name, a username or the
// owner's words for the lead link are shown beside facts the joiner cannot set (the join time), so a right-to-left
// character in one of them must not reorder the words around it. The server strips control and format characters too;
// this keeps the page safe on its own. The words are the same as translate() gives: the honorific and particle rules
// read the real values first (shared/src/honorific.ts), then the values are put in as their own elements.
import { Fragment, type ReactNode } from 'react'
import type { Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'
import { DICTS, format, type MessageKey, type Params } from '../../i18n'

const MARK = '\u0000'

export function isolate(locale: Locale, key: MessageKey, params: Params, keys: readonly string[]): ReactNode {
  const template = dropDoubleHonorifics(DICTS[locale]?.[key] ?? DICTS.en[key], params)
  const marked = format(template, { ...params, ...Object.fromEntries(keys.map((k) => [k, `${MARK}${k}${MARK}`])) }, locale)
  return marked.split(MARK).map((part, i) => (i % 2 ? <bdi key={i}>{String(params[part] ?? '')}</bdi> : <Fragment key={i}>{part}</Fragment>))
}
