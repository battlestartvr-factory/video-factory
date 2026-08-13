import "server-only";

/**
 * Mock workflows are enabled only when MOCK_WORKFLOWS is strictly the string "true".
 * Absent, empty, or "false" values all mean disabled — never use Boolean(process.env.MOCK_WORKFLOWS).
 */
export function isMockWorkflowsEnabled(): boolean {
  return process.env.MOCK_WORKFLOWS === "true";
}
