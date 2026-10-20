/** Access denied by policy. Message is safe to show to the AI (never reveals whether a hidden path exists). */
export class Denied extends Error { readonly code = 'denied' }
/** Ordinary tool error (bad input, not found inside an accessible area, conflict ...). */
export class ToolError extends Error { constructor(message: string, readonly code = 'error') { super(message) } }
