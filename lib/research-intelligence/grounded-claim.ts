export function sanitizeGroundedEvidenceClaim(value: string): string | null {
  let claim = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!claim) return null;
  if (/^(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]/i.test(claim)) return null;
  if (/^https?:\/\//i.test(claim)) return null;

  claim = claim
    .replace(/^(?:[-•]\s+|\*+\s*)+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!claim || /^(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]/i.test(claim)) return null;
  if (/^[\p{P}\p{S}\s]+$/u.test(claim)) return null;
  const letters = claim.match(/\p{L}/gu)?.length ?? 0;
  const words = claim.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length ?? 0;
  if (claim.length < 24 || letters < 8 || words < 5) return null;
  return claim.slice(0, 4_000);
}
