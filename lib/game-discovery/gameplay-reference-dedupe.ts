export interface GameplayReferenceDedupeCandidate {
  referenceId: string;
  perceptualHash: string | null;
  canonicalReferenceId?: string | null;
}

function normalizeHexHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("GAMEPLAY_REFERENCE_PHASH_INVALID");
  }
  return normalized;
}

export function perceptualHashHammingDistance(left: string, right: string): number {
  const a = normalizeHexHash(left);
  const b = normalizeHexHash(right);
  if (a.length !== b.length) throw new Error("GAMEPLAY_REFERENCE_PHASH_LENGTH_MISMATCH");

  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let xor = Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16);
    while (xor) {
      distance += xor & 1;
      xor >>>= 1;
    }
  }
  return distance;
}

export function findPerceptualNearDuplicate(input: {
  referenceId: string;
  perceptualHash: string | null | undefined;
  candidates: GameplayReferenceDedupeCandidate[];
  maxDistance?: number;
}): { canonicalReferenceId: string; distance: number } | null {
  if (!input.perceptualHash) return null;
  const maxDistance = input.maxDistance ?? 4;
  let best: { canonicalReferenceId: string; distance: number } | null = null;

  for (const candidate of input.candidates) {
    if (candidate.referenceId === input.referenceId || !candidate.perceptualHash) continue;
    let distance: number;
    try {
      distance = perceptualHashHammingDistance(input.perceptualHash, candidate.perceptualHash);
    } catch {
      continue;
    }
    if (distance > maxDistance) continue;
    const canonicalReferenceId = candidate.canonicalReferenceId ?? candidate.referenceId;
    if (!best || distance < best.distance) best = { canonicalReferenceId, distance };
  }

  return best;
}
