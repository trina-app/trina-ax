# AI scenarios: a per-feature catalog of what the team AI can and can't do, run on the real AI

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: test/ai-scenarios (the owner)

- **Ask:** On 2026-11-16, in a shared project chat, the AI refused two tasks it should have done. It said "no
  terminal, can't run Python" when asked to stamp the company seal on a PDF, and it refused to change a team skill's
  file path. The owner asked for a systematic check: build the situations first, then run every case through the real
  AI. The same day the owner added that cases are built **per feature**, from the feature map and the AI's tool lists.
  Each feature gets the happy path, each place and install where it differs, and a refusal where one applies. The
  real-office flows (quote and seal) sit on top, and coverage is reported per feature.
- **Rule:**
  - The catalog is `tests/ai-scenarios/cases.yaml`. Each case names its feature ids, and its variants are separate
    cases.
  - `tests/ai-scenarios/feature-scope.ts` says, for every feature of `docs/features.ts`, whether the AI acts on it,
    explains it, or cannot reach it (with the reason).
  - A feature without a line there stops the tool, as `features:check` stops on an endpoint without a feature.
  - Runs use a fictional company seeded on a throwaway local server. The engine is the machine's own Claude Code
    sign-in, so there is no new account or key.
  - Files are checked automatically. A Sonnet judge, with no tools, grades each answer.
- **Install types are simulated on one server, and two of them are blocked on a Mac.**
  - The dev environment (srt) runs commands on Linux, or on a Mac set up by `install-macos.sh` with dev accounts and
    sudo. A plain dev server on a Mac cannot run it.
  - A local-login server never gives a guest AI.
  - So `linux-devenv` and `managed` cases are reported as "blocked". They run with `up --devenv` on Linux, or on a
    managed test server.
  - We did not set up dev accounts with sudo on a shared Mac. We did not copy the Mac's Claude sign-in into a Linux
    container either: a refresh there would sign out every session on the Mac.
- **Cards go ahead.** The runner answers the server's cards the way a person who wants the task done would, and it
  records every card. Refusals that need a person to say no on a card are not covered.
- **Not in CI.** A run uses real model turns (the product's default model, about $0.3–0.5 list price per case) and
  takes about an hour for the first pass, so it runs by hand: before a release, and after changes to the AI's tools or
  instructions.
- **Tests:** `bun run ai:scenarios coverage` checks the catalog against the feature map without a server. The first
  run's report is `tests/ai-scenarios/reports/2026-11-16-first-run.md`.
