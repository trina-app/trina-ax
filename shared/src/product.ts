// The working name lives here and only here (it will be renamed). Everything else imports PRODUCT.
export const PRODUCT = {
  /** machine name: folders, sockets, bundle ids, temp-file prefixes */
  id: 'mycel',
  displayName: 'Mycel',
  /** MCP server name the engine sees: tools appear as mcp__team__<tool> */
  mcpServerName: 'team',
  /** prefix for the server's own temp files inside the team folder (never visible to tools) */
  tmpPrefix: '.mycel-tmp-',
  /** reserved top-level folder for history / trash (tools can never reach it) */
  systemDir: '.system',
} as const

export const TEAM_TOOL_PREFIX = `mcp__${PRODUCT.mcpServerName}__`
