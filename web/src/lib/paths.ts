// Team-relative paths as the API uses them: "finance/2026/q3.xlsx", '' = the team root. No leading or trailing
// slash, no "." / ".." segments (RelPath in shared/src/api/common.ts).

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)
export const parentPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** Breadcrumb parts: [{name:'finance', path:'finance'}, {name:'2026', path:'finance/2026'}] */
export function crumbs(p: string): { name: string; path: string }[] {
  if (!p) return []
  const parts = p.split('/')
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

/** Is `child` the same as or inside `folder`? */
export const isInside = (child: string, folder: string) => folder === '' || child === folder || child.startsWith(folder + '/')

/** A file or folder name a person typed: same characters the server refuses everywhere (tab 2 name rules). */
export function nameProblem(name: string): 'empty' | 'chars' | 'dots' | 'long' | null {
  const n = name.trim()
  if (!n) return 'empty'
  if (n === '.' || n === '..' || /[. ]$/.test(n)) return 'dots'
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(n)) return 'chars'
  if (new TextEncoder().encode(n).length > 255) return 'long'
  return null
}

// today's words (server files/store.ts CONFLICT_COPY) and the earlier ones, for copies made before
const CONFLICT_RE = / \((동시에 고친 사본|edited at the same time|diubah bersamaan|同時に編集したコピー|editado a la vez|同时修改的副本|충돌 사본|conflict copy|salinan konflik|競合コピー|copia en conflicto|冲突副本)[^)]*\)(\.[^.]+)?$/i
/** Conflict copies made by the server: "이름 (동시에 고친 사본 - 사람 날짜 HH.mm).확장자". */
export const isConflictCopy = (name: string) => CONFLICT_RE.test(name)

export const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
