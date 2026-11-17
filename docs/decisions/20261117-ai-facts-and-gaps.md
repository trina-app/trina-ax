# The AI's facts and gaps from the 2026-11-17 rerun

- Date: 2026-11-17
- Status: accepted
- Supersedes: the app map's own-chat thread line "the AI does not read it" (left over after
  [20261117-ai-reads-answer-comments.md](20261117-ai-reads-answer-comments.md)); the 1,200-token cap of the app map in
  [20261117-ai-app-map-five-places.md](20261117-ai-app-map-five-places.md) (now 1,250)
- Branch: fix/facts-and-gaps (on batch/1117c, which holds fix/answer-tool-facts and fix/connections-check-first)

- **Ask:** eight real-AI cases failed twice on dev d4a853a0b. Fix what #1224 does not already fix, at the source: the
  facts the AI is given, or a test that expected the wrong thing.
- **An image read names the file's facts.** The picture the model gets is drawn on white (mycel-safeops vision) and its
  size read off it is a guess: asked "is the seal transparent, how big is it?", the AI said "about 600 × 600" and
  stamped a test PDF nobody asked for (VIEW-05). The read result now adds one line read from the file: the format (by
  its first bytes), the size in pixels as shown (EXIF orientation applied), and whether it has see-through parts: the
  background (all four corners), some, or none. A picture that cannot have them (JPEG, a PNG without alpha or tRNS) is
  "none" with no look; one that can is shrunk to 32 × 32 alpha by an isolated ffmpeg, as thumbnails already are
  (`uploads/image.ts seeThrough`), only after the normalizer took the picture, in the image conversion slots, under the
  converters' 1 GiB cap and only up to 50 million pixels (ffmpeg decodes the whole picture). A look that finds
  nothing see-through says "the background is not see-through", not "none" (one see-through pixel in a big picture
  averages away). No ffmpeg, a HEIC, a too large picture or a failed look: that part is left out, never guessed.
- **Where a chat is shared** is in the app map: Share at the top right of the chat, by its starter; people or groups
  then see all of it and can ask; a team project's chat is shared with its members (CHT-04.how: the AI said it did not
  know where and offered workarounds). The longest form (an owner's or admin's, in Korean) grows from about 1,189 to
  about 1,241 tokens, so the cap is 1,250.
- **The dev environment in everyday words** ("the AI does heavier work itself, e.g. big data files"; not on this team's
  app; for owners and admins also that it comes with how the app was installed), without "server" and "runs programs",
  which came back in answers to members (ADM-07.member).
- **No "server" in what the AI is told about where it runs.** "I'd be able to do more on the team's server" still
  reached a member (ADM-07.member) from "You run on the team's Trina AX server" ("Where you run") and "the computer
  this server runs on" (the situation's AI line). Both now name the team's app and the computer it runs on; a hosted
  team's is "run for the team by the service in the cloud".
- **The own-chat thread line** now says the AI in that chat reads a thread when someone asks, as the 11-17 decision
  made it (the shared chat's own section already said so).
- **Not product bugs (the runner, `tests/ai-scenarios`):**
  - the judge saw only the actions, so it called facts from the AI's instructions invented: the team time zone
    (ADM-05.member), the dev environment's absence (ADM-07.member), "Slack is not added" (CON-04.member). It is now told
    what the server gives the AI every turn, and that set_title is the app naming a new chat (CHT-04.how called it an
    unasked rename);
  - SKL-03.room inherited the base case's expectation (최하나's 11/20 task) for 이소라, whose only task in the notes is
    the 11/13 quote;
  - CHT-16 expected the rule the 11-17 decision replaced (the AI reads a thread only through Send to Trina);
  - CHT-05.project required the artifact tool; a project chat saves its work in the project folder, and an .html page
    there opens as the same working page (the sandbox frame runs it): a `page_made` check takes either.
- **Already fixed by #1224:** CON-04.member's missing "she can link her own Slack" (fix/connections-check-first).
- **Tests:** `tests/unit/image-read-facts.test.ts`, `tests/unit/ai-app-map.test.ts`.
- **Version impact:** patch (the AI's answers; no screen, API or migration).
