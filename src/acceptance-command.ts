/** One reserved product command, not a classifier for arbitrary user requirements. */
export const ACCEPTANCE_COMMAND = "用 VibeGuard 验收";
export function isAcceptanceCommand(text: string) { return text.trim() === ACCEPTANCE_COMMAND; }
