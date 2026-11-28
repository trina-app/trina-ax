# Before a web send, submit or post the AI reads each field back from its own element, and checks the result after

- Date: 2026-11-28
- Status: accepted
- Supersedes: none
- Branch: fix/irreversible-web-readback (the owner's session of 2026-11-28, "이것도 좀 행동이 어설프긴 한듯..")

- **Ask:** the AI wrote a mail in a webmail through Aside. The person attached a PDF and said "첨부했어. 이어서 해",
  and the AI sent it at once with an empty body. Its script had put the body into another field; its check before
  sending searched the whole page for a sentence of the body and found it elsewhere; it checked To, Subject and the
  attachment in their own fields but not the body, and told the person the body held the apology and the amounts.
  Fix the general weakness, not Daum Mail or e-mail.
- **Rule (WEB_ACTION_CHECK_RULE, server/src/chat/prompt.ts):** sending, submitting, posting, paying or deleting on a
  web page cannot be undone, through the in-app browser, the person's own Chrome or a connected app that drives a
  browser. Right before it the AI reads back every field the action depends on from that field's own element (an
  input's value, the editor's own content also inside a frame, the recipient chips, the attachment list). What it
  typed and a search of the whole page prove nothing. A step the person has not asked for yet is asked as before, with
  a short summary built from the read-back. A go-ahead already given ("send it", "go on") does not skip the read-back:
  every field right, it goes on; a field empty or wrong stops the action and the AI says which. After the action it
  looks where the result shows (the sent folder, the confirmation page, the post) and reports only what that showed.
- **Where:** one constant, in the in-app browser's section, the Chrome section and the connected-services section
  (Aside and other apps on the person's computer are connections). It names no site, service or wording.
- **Two lines for every turn:** a warning or request is said once and again only when it still matters
  (ONCE_RULE: the AI repeated "cancel the two Gmail cards" in every message); a tool, app or way of working the person
  chose for a task holds for the rest of it (CHOSEN_TOOL_RULE: after "Aside만" it kept trying the in-app browser).
- **Why a rule and not a tool check:** the incident ran in Aside, whose tools are the app's own; the server cannot see
  a field there. For the in-app browser, form_input could report what the field holds after it is set (today it
  echoes the value it was given). That change is in the page script the Chrome extension ships too (a store release),
  so it is left for later; "never claim what you did not see" (SHOWN_ONLY_RULE) already covers claims, and this rule
  says what counts as seeing a field.
- **Measured:** AI scenario flows FL-41..45 (tests/ai-scenarios, mock browser app "Web Pilot" on made-up pages: a
  webmail whose body is an editor inside a frame with a hidden field the page overwrites on send and an autosave line
  that repeats the text, a form, a board post, a go-ahead with the body still empty), before and after, on the Claude
  Code engine with the QA subscription: script tool (Aside-like) before 23/24, after 25/25; full tool set before
  10/10 (judge 9/10), after 10/10. The one failure before was the incident (an empty body after reading a hidden field
  back).
- **Version impact:** patch (the AI's instructions).
