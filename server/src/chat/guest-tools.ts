// The tools a guest's AI turn may use besides the six file tools (docs/DECISIONS.md "Guests: only what they were
// invited to"). Deny by default: a tool not named here is never offered to a guest's turn (chat/tools.ts buildToolSet),
// so a new tool stays closed to guests until someone adds it on purpose. Left out on purpose: skills (find_skills,
// skill, move_skill: skills/ is the team's), room reading and posting (room tools, post_to_room), project members,
// connections and every connection provider (connect_service, Drive, Google apps, MCP: connectors stay off for guests),
// plugin tools (hwp_render), schedules, the web (web_fetch, save_url), paid services (generate_video), the dev
// environment and the browser pane. The file tools themselves follow the folder policy (their project only).
export const GUEST_TURN_TOOLS: ReadonlySet<string> = new Set([
  'edit_files', 'ask_user', 'set_title', 'remember', 'forget',
  'make_file', 'edit_hwp', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'delete_files',
])
