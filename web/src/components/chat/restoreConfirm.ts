// The confirm before a version of something in a chat comes back as its newest (QA TC-v1c-01, b3s S-033): a chat file in
// its panel (components/FilePanel.tsx) and a web page in its panel (components/ArtifactPanel.tsx) ask the same. The
// Files screen's words: whose later versions drop out of the newest (`dropouts`, never me), else that the current
// content stays a version; and in a chat others see, who will see the change (the people who see it now but me; the
// read failing leaves that line out). The restore then writes the chat's line ("{actor} restored {name} to version {n}").
import type { Locale, UserRef } from '@mycel/shared/api'
import type { MessageKey } from '../../i18n'
import { api, API } from '../../lib/api'
import { nameList } from '../../lib/restoreDropouts'
import { confirmDialog } from '../ui'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

export async function confirmChatRestore(o: { chatId: string; n: number; dropouts: readonly UserRef[]; t: T; locale: Locale }): Promise<boolean> {
  const { t, locale } = o
  const seeing = await api.call(API.getChatAudience, { params: { id: o.chatId } }).then((a) => a.mentionable ?? [], () => [] as UserRef[])
  const body = [o.dropouts.length ? t('files.restoreBodyNames', { names: nameList(locale, o.dropouts) }) : t('files.restoreBody'),
    seeing.length ? t('chatFile.restoreSeen', { names: nameList(locale, seeing) }) : ''].filter(Boolean).join(' ')
  return confirmDialog({ title: t('chatFile.restoreTitle', { n: o.n }), body, confirm: t('common.restore') })
}
