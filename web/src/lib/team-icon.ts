// The team logo (Admin › Team settings; shared/src/team-icon.ts): the check before uploading. The logo shows only in the
// computer's sidebar header; the tab and app icons stay the product's (index.html as built).
import { checkTeamIcon, isTeamIconType, TEAM_ICON_MAX_BYTES, type TeamIconProblem, type TeamIconType } from '@mycel/shared'

/**
 * The same checks the server makes, before uploading (the server's are the ones that count): the type the browser
 * gives the file, its size, its first bytes and its pixel size.
 */
export async function checkIconFile(file: Blob): Promise<{ ok: true; type: TeamIconType; width: number; height: number } | { ok: false; problem: TeamIconProblem }> {
  if (!isTeamIconType(file.type)) return { ok: false, problem: 'type' }
  if (file.size > TEAM_ICON_MAX_BYTES) return { ok: false, problem: 'too_big' }
  return checkTeamIcon(new Uint8Array(await file.arrayBuffer()), file.type)
}
