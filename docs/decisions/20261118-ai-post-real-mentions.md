# The AI's room post mentions room members for real, picked by the server

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/ai-post-real-mentions (the owner, 2026-11-18)

- **Ask:** the owner asked the AI side chat to forward a mail to a teammate in a room. The AI posted "@Full Name
  Forwarding a mail…" with post_to_room and said it tagged him, but the name was plain text: no highlight, no mention
  notice. A person's mention in the same room showed highlighted.
- **Why it was plain:** a room message mentions the people its sender picked (`room_messages.mentions`, user ids); the
  app marks "@Name" only for those, and only a mention notifies. Every post_to_room message goes through "share an
  answer" (chat/answer-share.ts), which by rule mentions nobody ("@Name" in an answer is the AI's words).
- **Rule:**
  - post_to_room takes `mention` (up to 20: a name, a username or person:<id>). The server resolves each among the
    people in that room (for a 1:1 chat made on send: that person), active accounts, never the asker. A name that fits
    nobody there, or several people, posts nothing and tells the AI (no card).
  - An "@Name" in the AI's text that is exactly one room member's display name (any case, a word edge after it; never a
    username, never a name two members share) is a mention too. Any other "@word" stays plain text, and the result
    says it notified nobody.
  - The mentions are written as "@Name" at the start of the person's own line, before the AI's quote (with own_words:
    in the text, each written as the exact name; the missing ones before it). That is where the app already marks a
    person's mentions; inside the AI's quote names are never marked. A text that starts with "@Name …" has those names
    moved to the person's line, so nothing is written twice.
  - "@everyone" (each language's word, and "@channel"/"@here") only when the asker's own message of this turn wrote
    it where a mention may start; in the room for everyone only for an owner or admin (Rooms.send's "@전체" rule, now
    checked before any card too). Otherwise `mention: ["everyone"]` is refused and "@everyone" in the text stays plain.
  - Rooms.send keeps mentions on a shared answer only when it is post_to_room's (`via: 'ai'`), through the same
    `validMentions` as any send (room members, never the sender). The button's share still mentions nobody. The audit
    row counts them (`mentions`, `mentionsAll`), no names.
  - The card has a "Mentions (they get a notice)" line with the names from the server's records. The result has
    `mentioned` (names; in a shared chat only how many) and `mentioned_everyone`, read from the stored message. The tool
    description and one prompt sentence tell the model to use `mention` and to say someone was tagged only when
    `mentioned` lists them.
  - "Always allow" for post_to_room covers posts that mention room members, also ones the AI resolved from a nickname
    the asker used (Rule A, [Always allow means done](20261116-always-allow-final-rule-a.md); the owner's case: "이거
    라카에게 전달해줘 LG톡방에" with Always allow on goes with no card). A wrong member mention is a notice to someone
    already in that room. "@everyone" (and "@channel"/"@here") always shows the card, without the "Always allow" button,
    and needs the asker's own "@everyone" and, in the room for everyone, an owner or admin. A non-member is never
    mentioned.
  - The explicit-ask skip (no card when the asker's message asked for exactly this post) applies with mentions when the
    asker's own words name each person: in full (display name or username as whole words; a Hangul name followed only
    by a particle), or by the word the AI resolved to exactly that one member (a nickname is fine), unless that word is
    part of another member's name the asker also wrote ("tell Erin Yoo" is no ask to tag Erin). Never with "@everyone".
  - In a shared chat (everyone there reads the AI's results) the result gives only how many people were mentioned, and a
    name that matches nobody or several people is refused with one neutral line, never which names are or are not in
    the room. Others still see only the step's verb. Guests and scheduled runs (post_to_room off) are unchanged.
  - A name in the text never matches inside a longer name: names are tried longest first, a name two members share
    stays plain text (and stops a shorter one inside it), and Rooms.send drops an account turned off while the card
    waited.
- **Left out:** marking names inside the AI's quote; mentioning someone who is not in the room (they cannot see the
  post).
- **Tests:** tests/unit/post-mentions.test.ts, tests/unit/b-post-to-room-mentions.test.ts,
  web/test/unit/room-messages.test.tsx.
- **Version impact:** patch.
