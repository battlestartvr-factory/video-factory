export const GAMEPLAY_REFERENCE_SET_INSUFFICIENT = "GAMEPLAY_REFERENCE_SET_INSUFFICIENT";

export class GameplayReferenceServiceError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly status: number;

  constructor(input: { code: string; detail: string; status: number }) {
    const detail = stripRepeatedCodePrefix(input.code, input.detail);
    super(`${input.code}:${detail}`);
    this.name = "GameplayReferenceServiceError";
    this.code = input.code;
    this.detail = detail;
    this.status = input.status;
  }
}

export interface GameplayReferenceCoverageGap {
  availableReferenceCount: number | null;
  missingPurposes: string[];
}

export interface GameplayReferenceCoverageBlock extends GameplayReferenceCoverageGap {
  code: typeof GAMEPLAY_REFERENCE_SET_INSUFFICIENT;
  conceptId: string;
  momentId: string;
  shotId: string;
  camera: string;
  providerCallsMade: 0;
  blockedAt: "reference_retrieval";
}

export function stripRepeatedCodePrefix(code: string, message: string): string {
  let value = message.trim();
  const prefix = `${code}:`;
  while (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  return value || "unknown_error";
}

export function parseGameplayReferenceCoverageGap(error: unknown): GameplayReferenceCoverageGap | null {
  if (!(error instanceof GameplayReferenceServiceError)) return null;
  if (error.code !== GAMEPLAY_REFERENCE_SET_INSUFFICIENT) return null;

  const countMatch = error.detail.match(/^(\d+)(?::|$)/);
  const missingMatch = error.detail.match(/(?:^|:)missing=([a-z0-9_,.-]+)/i);
  const missingPurposes = missingMatch?.[1]
    ? missingMatch[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  return {
    availableReferenceCount: countMatch ? Number.parseInt(countMatch[1]!, 10) : null,
    missingPurposes,
  };
}

export function buildGameplayReferenceCoverageBlock(input: {
  error: unknown;
  conceptId: string;
  momentId: string;
  shotId: string;
  camera: string;
}): GameplayReferenceCoverageBlock | null {
  const gap = parseGameplayReferenceCoverageGap(input.error);
  if (!gap) return null;
  return {
    code: GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
    conceptId: input.conceptId,
    momentId: input.momentId,
    shotId: input.shotId,
    camera: input.camera,
    availableReferenceCount: gap.availableReferenceCount,
    missingPurposes: gap.missingPurposes,
    providerCallsMade: 0,
    blockedAt: "reference_retrieval",
  };
}
