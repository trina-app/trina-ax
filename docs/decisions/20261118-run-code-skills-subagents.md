# Run code where Claude Code would: skill scripts, sub-agents, old teams

- Date: 2026-11-18
- Status: accepted
- Supersedes: the 50-round sub-agent cap and "box_shell is the main AI's only" in docs/DECISIONS.md "Sub-agents"
- Branch: fix/limits-run-code (QA TC-4911, limits audit #11, #18, #16)

Plan: docs/AGENTS/plan/20261118-1043-limits-run-code.md.

- **Skill scripts.** When the turn offers `box_shell` (the dev environment is on for the person), the skills section and
  every skill block (a "/name" skill and the skill tool's result) say that a skill's bundled scripts run with
  `box_shell`, by their team path under `$TRINA_TEAM`, when the skill's steps say to. They run like any other command:
  the person's folders (a shared chat's fence in a shared chat), the network allowlist, the limits. Without `box_shell`
  the old line stays ("This runtime cannot execute bundled scripts."). `allowed-tools` still grants nothing, and which
  skills are listed does not change (known origins only, docs/DECISIONS.md and the skills origin rule).
- **Sub-agents get `box_shell`.** It leaves PARENT_ONLY_TOOLS: a general-purpose sub-agent has it whenever the main AI
  has it, through the same tool object, so the same view (`spaceOf`, a shared chat's `SharedRun`), the same checks per
  call (`mayUseDevEnv`, storage, the update wait) and the same audit line. Explore stays read-only. What only the
  person can answer stays with the main AI: a sub-agent's `request_sites` for a host that is not allowed yet and a
  login command after other people's changes are refused with "say it in your report" (no card, nothing recorded as
  the person's no). Jobs and dev servers stay the main AI's (their notice, the Preview button and their results belong
  to the main chat): a sub-agent's `job`/`background` is refused, and its calls never take job results. A sub-agent's
  call patches no step (`queueStep` is not given), so patchToolStep's FIFO per tool stays the main AI's. The call's
  agent comes from its turn file state (files/service.ts `forCall`); the audit summary says "(sub-agent)" and the
  tool_events row has the parent tool use id as before.
- **Sub-agent rounds.** Each sub-agent gets the answer's own cap (Admin › Team settings `answerStepLimit`, read when
  the turn starts, 10-500), not 50. Another PR raises the default; this follows the setting, whatever it is.
  `MAX_SUBAGENT_TURNS` (50) stays only as the fallback of `buildAgentDefinitions` without a turn.
- **Old teams.** Migration 236 gave every team that had people on 2026-11-06 an explicit off row `{"enabled":false}`.
  It stays off. While that exact row is there (no admin has saved the setting since: a save writes the whole setting),
  GET /api/admin/dev-env answers `offer: true`. Admin › Home shows a one-time line to owners and admins (only when the
  server can run the dev environment) that says what turning it on allows in plain words and links to the switch
  (Team settings › Dev environment); ✕ or the link saves `prefs.devEnvOffer = 'seen'` for that person. The Dev
  environment card says the same above its switch until the setting is saved. Turning it on still needs the srt
  warning accepted; nothing turns on by itself.
- **Not here:** srt socket paths in shared chats (PR #1277).
