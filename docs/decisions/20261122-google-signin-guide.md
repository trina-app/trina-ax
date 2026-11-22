# The Google guides show Google's warning and Google Cloud's screens

- Date: 2026-11-22
- Status: accepted
- Supersedes: the screenshot rule in `docs/AGENTS/plan/20261113-0917-google-own-app.md` step 6 ("Google Cloud's own
  screens are not captured")
- Branch: docs/google-signin-guide (the product owner)

- **Ask:** people stop at Google's "Google hasn't verified this app" screen when they connect a Google app through
  Trina's sign-in, and IT admins get lost in Google Cloud while making their company's own app. The owner asked for a
  guide with pictures of both.
- **Rule:**
  - `use/google-apps` shows Google's warning as its own step: two pictures, **Advanced**, then **Go to Trina AX
    (unsafe)**, in the page's language. They are the same crops the hosting service's start page uses
    (trina-cloud `design/google-warning/step{1,2}-<lang>.webp`), copied to
    `docs/site/images/connect/google-warning-{1,2}-<lang>.webp`. A short "Which Google sign-in" table compares Trina's
    sign-in with the company's own app.
  - `use/google-own-app` shows one picture per Google Cloud step (new project, enable an API, Get started: app
    information and audience, Data access with Manually add scopes, Create client with the two return addresses, OAuth
    client created), in `docs/site/images/google-own-app/cloud-*.webp`.
  - Google Cloud pictures are taken in a throwaway project named "acme-trina", made for the pictures and deleted
    afterwards, with the English console. They are cropped to the form: no account, no project picker. The client ID
    and secret are covered. The repository is public, so no real project, account or client may appear.
  - Every picture keeps the quoted label and the link to the Google Cloud page in the text, so the steps still work
    when Google changes its console. All six languages use the English console pictures; the text quotes the English
    labels.
- **Why:** text alone did not get people through. Google's console changes, but a picture that is slightly out of
  date still helps more than none, and the text stays the reference.
- **Left out:** taking the pictures with `bun run docs:screenshots` (it drives Trina AX, not Google Cloud); console
  pictures per language.
- **Tests:** `bun run docs:build`, `bun run check:docs` (links, anchors and images).
- **Version impact:** none, docs only.
