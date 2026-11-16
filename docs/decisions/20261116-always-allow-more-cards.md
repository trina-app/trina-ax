# Always allow on the share, web address and room-post-with-files cards

- Date: 2026-11-16
- Status: accepted
- Supersedes: the archive's "A member shares their own files" (its card was shown every time); the "review of #678"
  line of "Always allow on every card" (no Always allow on a room post card that offers the linked files); the
  "an unknown exit address" exception of "Allow all websites covers the AI's web reads"
- Branch: fix/always-allow-more-cards (QA TC-3809, TC-3810, TC-3811)

The AI flow check of 2026-11-16 (tests/ai-scenarios, report 2026-11-16-flows) found three cards with no "Always allow",
against the owner's rule (2026-11-11 and 11-14: "Always allow" ends the asking for its scope, offered on the first card,
the caller's own switch, also in rooms, side chats and scheduled runs). In the flows that pick "Always allow" these
cards still came every time: FL-02 and FL-13 (sharing), FL-05 (a web address), FL-14 and FL-27 (a room post with files).

- **Sharing a file with a person or group (share_with_person, kind `share_files`).** The card offers "Always allow"
  on its first showing; once picked, shares go without the card. Every other check stays and runs without the card
  too: only the person's own files they may share, never a folder or a guest, the team's switch, the grant's own
  checks. A scheduled run of that person may share under it (only their own choice counts there, as for
  post_to_room). Where other people's words are in the turn (a shared chat, a chat others wrote in, or one that read
  rooms: a ✦ side chat, room_read, a quoted room message; independent review):
  - the file must still come from the asker (named or attached in their own message, or made by the AI in this turn),
    with or without the card;
  - the choice counts only when the asker's own message names every recipient (post_to_room's rule, `namesRecipient`):
    otherwise the card shows, without "Always allow". This is the existing post_to_room rule, kept so the two actions do
    not drift, not a new guard.
- **A room post that offers the linked files (post_to_room, kind `post_files`).** The card that offers
  [파일도 함께 보내기] now offers "Always send with the files" / "항상 파일도 함께 보내기". Picking it sends this post with
  its files; later posts that can carry linked files go with them and no card. A post with no file to offer stays
  kind `post_to_room` (its own first card). Shared chats keep post_to_room's rule (the asker names the recipient; never
  for own words). It holds after a room read too (a side chat): the independent review suggested sharing's file-origin
  rule here as well, but that would make "고친 제안서 방에 올려줘" (no file name) ask every time, and the owner's rule is
  no teammate-injection guard that makes the person's own choice ask again; left to the owner.
  The two kinds stay apart on purpose: "Always" on the files card can only mean "with the files" (nothing sends more
  than the person picked), so a person who chose it on one kind still meets the other kind's first card once.
  This also covers the report's "room-read guard" card ("여기에 대화 메시지(다른 사람이 쓴 글)가 들어와서…") without
  "always": in FL-14 and FL-27 that was this same card (its first line is the room-read line), not another kind.
- **A web address while the server's exit address is unknown (url-gate.ts, "Allow all websites").** The FL-05 card
  ("AI가 이 주소를 열려고 해요. 내부 네트워크의 기기…") is the `noEgress` card: the server has not learned its own public
  exit address yet (tools/egress.ts), so it cannot refuse a name that leads back to itself (hairpin NAT). The gate
  skipped every rule there, ①d included, and the card never offered "Allow all websites", so nothing ended the asking.
  Now, while the address is unknown:
  - ①d (the person's own "Allow all websites", while the team allows it, in a turn they watch) opens a plain address
    without the card, and the card offers "Allow all websites" on such an address;
  - a plain address has a site name, never a number (`siteOf`), no random-looking part, long name before the site,
    user name or long query, and is not an echo; everything else still asks;
  - private, local and metadata addresses stay refused on every hop after the lookup (web-fetch.ts), with or without
    the switch; ①b ("this site in this conversation") and typed addresses still ask while the address is unknown;
  - accepted: a public name that resolves to this server's own exit address can open under the person's switch, the
    same trust the switch gives any site ("can send anything it can read to any site"). On a running server the
    address is learned at start (the feed's /ip), so this card is rare outside test servers.
- **Where it still never applies:** as before (always-allow.ts): a Slack question, a company profile draft and other
  restricted turns, a confidential chat, the team's switch off, someone else's choice.
- **Settings:** the two new kinds are listed in Settings › 트리나에게 허용한 것 ("Sharing my files with people", "Sending
  linked files with posts to conversations") and taken back there. "Allow all websites" stays in Settings › Browser.
- **Tests:** tests/unit/b-share-with-person.test.ts, b-post-to-room.test.ts, web-allow-all.test.ts.
