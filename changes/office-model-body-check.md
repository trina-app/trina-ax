- Security (office Macs that use the Mac's own Claude sign-in): every AI request now goes through the same check as on
  a team server. Before, these requests went to Anthropic in a sealed tunnel the server could not read, so the rules
  that refuse MCP connectors, code running at Anthropic, page fetching and pictures loaded from an address, and the
  per-answer tool limits, were skipped. The sign-in renewal is read too and passes only as a renewal (TC-359).
