# The setup offers everyday office skills: meeting notes, reports, customer replies, contract review

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (changes which kept skills the owner's setup step shows; builds on DS3 and W6 in
  [docs/DECISIONS.md](../DECISIONS.md) and keeps [20261120-office-skills](20261120-office-skills.md) for file formats)
- Branch: feat/onboarding-everyday-skills (the owner, 2026-11-22)

- **Ask (the owner):** the setup step "팀이 쓸 스킬을 골라 주세요" offered the company intro deck, card news, an 18 s
  promo video and natural writing. Those are not what people do every week; offer everyday, widely used skills.
- **Rule:** the setup step shows six skills, in this order, the first ones checked:
  1. 회의록 정리 / Meeting notes (`work/meeting-notes`), checked
  2. 주간 보고·공지 / Reports & announcements (`work/team-report`), checked
  3. 고객 답장 / Customer replies (`work/customer-reply`), checked
  4. 계약서 검토 / Contract review (`work/contract-review`), not checked: it says "not legal advice" in every answer
  5. 자연스러운 글 / Natural writing (`work/humanizer`), checked
  6. 회사 소개서 / Company intro deck (`general/intro-deck`), not checked

  A checked skill whose text the team gets in another language comes unchecked (`setupMark`): natural writing is
  Korean and English only, so a Japanese, Chinese, Spanish or Indonesian team sees it unchecked.

  Card news and the promo video leave the setup list. They stay in the catalog: Team skills › "트리나가 준비한 스킬 ·
  N개 더" lists every kept skill as before. The catalog entry says where the setup puts a skill (`onboarding:
  'checked' | 'offered' | null`, server/src/onboarding/skill-packs.ts CATALOG); a server from before the field sends
  none, and the app then shows every row as it did.
- **Teams that installed the old skills keep them.** Nothing is deleted or replaced: installs only add missing files.
  A new team's setup shows the new list.
- **File-format skills stay out.** Word, Excel, PowerPoint and PDF are made and edited by the built-in tools
  (make_file, edit_office, comment_docx, edit_pdf); the 2026-11-20 A/B found no gain from Anthropic's docx, xlsx and
  pdf skills and a worse result from pptx ([20261120-office-skills](20261120-office-skills.md)). A planned line under
  the list saying so was dropped by the owner.
- **Why these four, when the 11-20 test found meeting notes and internal-comms "as good, not clearly better":** that
  test asked whether a skill improves an answer the AI could give anyway. This list answers a different question: what
  a new team recognises and tries first. A row named after the week's real work (minutes, the weekly report, a customer
  reply, a contract) is a reason to start; the skills also fix the shape (one owner and a date per to-do, "not set"
  instead of a guess, nothing promised to a customer that the person did not give, a fixed not-legal-advice line), which
  the 11-20 test saw as more consistent output.
- **All six app languages (the owner, 2026-11-22).** The four skills are written in Korean (해요체), English, Japanese,
  Chinese, Spanish and Indonesian, each in that language's own office register, not translated line by line. A team gets
  the text in its language (onboarding/skill-packs.ts `skillLocale`, now per skill: natural writing stays Korean and
  English, card news, the promo video and the deck stay as they were). Each SKILL.md tells the AI to answer in the
  language the person writes in (a customer reply's draft in the customer's language; a contract's clauses quoted as
  written).
- **Sources and licences (DS3: known origin only).** Each skill is text only, rewritten in the six languages from
  Anthropic's Apache-2.0 skills, read at pinned commits:
  - meeting-notes: knowledge-work-plugins `sales/skills/call-summary` and `legal/skills/meeting-briefing`
  - team-report: anthropics/skills `skills/internal-comms` (its LICENSE.txt, Apache-2.0) and knowledge-work-plugins
    `operations/skills/status-report`
  - customer-reply: knowledge-work-plugins `customer-support/skills/draft-response`
  - contract-review: knowledge-work-plugins `legal/skills/review-contract`
  - commits: anthropics/skills `e4bb5d960d87126ff3b3a8af1a104b7db67560ba`, anthropics/knowledge-work-plugins
    `0e0fcacddcc892eb92a1b7873ff9d68159c47571` (root LICENSE, Apache-2.0)

  The CRM, email, calendar, chat, tracker, playbook, CLM and connector steps, `CONNECTORS.md` placeholders and scripts
  were removed: the team AI reads pasted text and team files and has no shell. Each folder keeps the Apache LICENSE and
  a NOTICE that names the source, the commit and the changes; the SKILL.md a team gets ends with its credits and the
  licence link (a pack installs SKILL.md only). The knowledge-work-plugins LICENSE file has stray lines after the end of
  the Apache text; they are not part of the licence and are left out of our copy. Entries: docs/THIRD-PARTY-NOTICES.md.
  The catalog's source line links to the upstream folder at the commit ("원본 보기").
- **Names:** new skill names never take an old pack name (onboarding/retired-skills.ts LEGACY_PACK_SKILL_NAMES has
  `meeting-summary` and `weekly-team-report`), so an older release's copy on a team is never read as the new skill.
  Like every pack name, the four are reserved from now on: a person's own skill brought in with the name
  `meeting-notes` (a common one) goes in as `meeting-notes-2`, so "/meeting-notes" never runs two skills.
- **Examples:** each new skill has a text example in each language on a fictional local roaster (예시커피, Example Coffee,
  見本コーヒー, 示例咖啡, Café Ejemplo, Kopi Contoh), made by running the skill once per language on the ai-scenarios local
  server (real Claude Code engine, 2026-11-22). The EXAMPLE.md holds the start of the input and the start of the answer,
  cut at whole blocks to the size limit (900 characters in Korean, Japanese and Chinese; 1,200 in the others).
- **Left out:** HR, sales follow-up, expense and other packs (a later list can add rows; the catalog shows them on Team
  skills), audio transcription (the skill asks for a transcript when only a recording is given).
- **Tests:** tests/unit/b-skill-catalog (order, `onboarding`, sources, LICENSE and NOTICE, examples),
  c-onboarding-pack, c-default-skills, b-skill-examples; web onb6-skills and welcome.
- **Version impact:** minor. New skills a team can add and a new optional field in GET /api/onboarding/packs; nothing
  removed, old apps keep working.
