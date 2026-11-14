- **Hands-on demo build** (`bun run build:demo`): the real web app with a scripted backend that runs entirely in the
  browser, for a try-it-yourself demo on the website. It can be hosted as static files, at the root or under a path
  (`DEMO_BASE=/demo/`), needs no account, server, AI or database, and every visitor gets a fresh copy in their own tab.
  The story ("Mina's first day", English first) is a content file played on the app's own screens: the welcome card,
  a company answer with its sources, a DM from the team lead, a photo campaign made with one prompt and shown inline in
  the answer, the app's own Send to room, live replies and reactions, an email with the AI's confirm card, and the
  CEO's shoutout in #Everyone. Only a guide line and a ring around the next control are added; "Start over" or a reload
  begins again. The normal build is unchanged.
