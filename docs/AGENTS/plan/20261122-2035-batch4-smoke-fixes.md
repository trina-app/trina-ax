# Batch 4 smoke fixes: a chat file sent to a teammate opens for them

- Date (UTC): 2026-11-22 20:35
- Branch: `fix/batch4-smoke` (on the batch 4 head, PR #414)
- Status: done
- Where: server (`server/src/chat`), shared step words. Why: the post's checks and the card words are the server's.
- Version impact: patch. A send that left a dead link now carries the file; card and answer words only.

## Goal

The batch 4 smoke test (S1-A/E, r119): a file the AI attached to its answer in a shared chat (`chat:files/`, link
`/c/<chat>?file=<id>`) sent with post_to_room to a teammate went as that link only. The teammate is not in the chat, so
it opened "파일을 찾을 수 없거나 볼 권한이 없어요", while the answer said "보냈습니다". The post's check
(answer-share.ts answerCheck) only knows team-file links, so the chat link was neither offered as a file nor counted as
one some people cannot open. Batch 3 sent such files because the AI saved them in the person's own folder first.

## Scope

1. post_to_room: every link to a file of this chat is first kept as a copy in the person's own downloads (copy_files'
   own route, places-copy.ts chatFileToTeam) and the post links the copy. The usual check then offers it as a file that
   goes with the post ("함께 보낼 파일"); Send without the files reports `cannot_open`. The same call again reuses the
   copy (same path, same bytes). A copy that cannot be kept: nothing is posted, with why.
2. A post card shows a chat file's link as the file's name (share-words.ts cardTextWords), never the raw Markdown.
3. One curl in a ✦ side chat: a `>` inside quotes is no redirect (the card said "파일 바꾸기"); a plain run that uses the
   internet reads "인터넷을 쓰는 명령 실행"; the same command again with `request_sites` goes under the room card's yes
   and asks only the site card.
4. The save note's "only you" (save-audience.ts) is no longer quoted in English, so a Korean answer does not echo it.

Out: share_with_person of a chat file (refused as not found, no false claim); links to another chat's files.

## Tests

`tests/unit/b-post-chat-file-copy.test.ts` (the recipient opens the copy byte for byte, one copy on a retry, Send
without files says cannot_open, card words), `tests/unit/step-labels-shell.test.ts`,
`tests/unit/prompt-honesty-qa-1122.test.ts`.
