# The desktop browser stops at a key screen, and the server hides key-like text in what it reads

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: feat/browser-key-guard (founder decision 2026-11-24; plan
  [20261124-1205-browser-key-guard](../AGENTS/plan/20261124-1205-browser-key-guard.md))

- **Ask:** the founder: in the desktop app the AI may take the person to a service's sign-up or API key page, but when
  the screen shows a key the AI stops reading the screen and hands over ("여기서부터는 직접 해 주세요"); in addition,
  key-like strings are masked on the server, so a key never reaches the model or any record.
- **Threat:** the desktop app's browser runs on the person's computer, but what the AI reads there (read_page,
  get_page_text, find, a script's output, a network body, console lines, the address and title after navigate) comes to
  the server as a tool result. From there it goes into the model's input (and so to the AI provider), the engine's
  session file, the answer the AI writes and saves, the step record, the audit line (tool_events) and possibly the log.
  A key page puts the key right there: one read_page on "Your new API key" was enough to copy it into all of them.
  A screenshot carries it as pixels, which no text filter sees. Before this only auth values in URLs were hidden, and
  only on the desktop's site card.
- **Rule: two layers.**
  1. **The AI stops.** The desktop browser rules (chat/prompt.ts) say: you may open a service's sign-up or API key page
     and guide the steps, but stop at the screen that shows the key; never read, copy, type or say a key, nor press show
     or reveal for one; the person copies it into the connection card (connect_service) themselves. A result that
     found a key tells the AI so and gives it the sentence to hand over with, in the chat's language (i18n
     `browserKeyHandOver`: "여기서부터는 직접 해 주세요. 키를 복사해서 연결 카드에 붙여 넣으면 돼요." and the other five
     languages). Outside the desktop app (the web, the phone) connect_service's rule says to give the steps and the link
     to the service's key page instead.
  2. **The server hides.** Every text of every browser result, and its error, goes through
     `shared/src/page-keys.ts` (`scanPageText`) in `chat/browser-keys.ts` before anything else sees it; the key becomes
     `[hidden key]` (the marker stored keys already use, `integrations/connections/hide.ts` HIDDEN). Found: the shapes
     `secrets.ts` already knows (sk-, sk-ant-, sk-proj-, sk_live_/rk_live_, gh*_ and github_pat_, glpat-, xox*-, AKIA/ASIA,
     AIza, npm_, hf_, ntn_/secret_, lin_api_, gsk_, JWTs, Bearer and Basic values, private key blocks, a value after
     "password:" / "API_KEY=" / "비밀번호:"), more provider prefixes (Google OAuth ya29./GOCSPX-, SendGrid, Shopify, Toss
     test_/live_ sk/ck, xAI, Perplexity, Replicate, Figma, Supabase, DigitalOcean, Postman, Sentry, Grafana, Atlassian,
     Doppler, PyPI, Slack app tokens, Stripe webhook secrets, Mapbox, Airtable, ElevenLabs, Mailgun, New Relic, Square,
     Twilio, Telegram and Discord bot tokens), a generated-looking value within a few words after a word that names a key
     ("REST API 키", "Client Secret", "Secret access key", "인증키", "비밀키", "시크릿", "토큰", "APIキー", "密钥", …), and
     secret query values in addresses (?token=, &sig=, ?code=, X-Amz-Signature). A sentence that says a key is shown only
     once ("You won't be able to see it again", "다시 볼 수 없어요", and the same in ja/zh/es/id), next to a key word,
     marks a key screen too.
- **Rule: a key screen.** A text with a find outside an address, or with such a sentence, is a key screen. Then every
  random-looking run, every generated-looking value and every UUID in it is hidden too (find lists a field without its
  label), its pictures are dropped, and the AI gets the hand-over note. A find inside an address is hidden but makes no
  key screen: a screenshot shows no address, and a sign-in return carries a code.
- **Rule: pictures and scripts.** A screenshot cannot be text-masked, and a script can return a key in a form no
  filter knows (reversed, spaced). So before `computer` screenshot or zoom, `javascript_tool`, or a `browser_batch` with
  one, the server reads the tab itself (read_page, all, depth 100, up to 1,000,000 characters; never shown to the AI)
  and refuses the call on a key screen without running it. After a batch or a script that brought back a picture or
  output (it may have opened the key screen before its picture) the tab is read again, and on a key screen the
  pictures and the output are left out; a shared screenshot is not saved. A single picture or script whose page
  cannot be read first is not run (fails closed); a batch goes on (its first step may open the pane) and is checked
  after, where a failed read leaves the output out.
- **Rule: the records.** The audit line says what happened without any value: `read_page -> ok (key screen: 19
  key-like values hidden, pictures left out, handed over)`, `computer -> refused: the page shows a key (handed over)`.
- **Why on the server:** every desktop app version goes through it, and it is the one place every record is written
  from. The AI's own stop is the first layer; the server's is the one that holds when the AI does not stop, misreads
  the page, or is told by a page to do otherwise.
- **Left out / not covered:**
  - The desktop app still shows the key to the person in the browser pane (that is the point). Its own debug log
    (`MYCEL_DESKTOP_DEBUG=1` only) and its in-memory result cache on the person's computer are not touched.
  - A key in a shape the finder does not know, without a key word before it and on a page without a "shown once"
    sentence, gets through as text. A key drawn as an image or in a canvas is not read as text at all, so the
    screenshot check does not see it either.
  - A screenshot whose page changes between the server's read and the picture (the page's own timer) is not caught.
  - The AI typing a key it got from the chat into a page is not refused here (the step record keeps typed text only as
    its length; the prompt says never to type a key).
  - Known false positives, accepted for safety: a documentation page that shows sample keys in real shapes (Stripe's
    docs show the signed-in person's test keys) or quotes "you won't be able to see it again", a page with a
    generated-looking value right after a key word (a commit hash right after "key" is not one: "commit", "SHA", "ID"
    before a value make it an id), and an SSH or deploy key list. On those the AI is told to stop and screenshots are
    refused.
  - One more read_page before each screenshot or script (and after a batch or a script): a round trip to the window,
    about 0.5 s per MB of outline to scan.
- **Tests:** `tests/unit/page-keys.test.ts` (each shape, labels apart from values, a value cut at 60 characters, the
  reveal sentences in six languages, addresses, false positives on ordinary pages, the guard with a fake window: refused
  screenshot and script, a batch that opens the key screen, fails closed, the hand-over sentence);
  `tests/unit/b-browser-key-guard.test.ts` (canary keys of 19 shapes on a fake key page read every way through the
  server: none in the model input, tool_events, audit_log, any table, the server log at debug level or any file under
  the data and team folders; screenshots, zoom, scripts and batches refused before the window runs them; the Korean
  sentence; an ordinary page unchanged).
- **Version impact:** minor (new visible behaviour: the AI hands over on a key screen, screenshots there are refused).
