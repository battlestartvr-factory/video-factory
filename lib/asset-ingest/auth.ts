import { timingSafeEqual } from "node:crypto";

/**
 * Compare Authorization Bearer token to INGEST_PROXY_TOKEN without leaking timing.
 * Never log the token or Authorization header value.
 */
export function verifyIngestBearerToken(
  authorizationHeader: string | null | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || expectedToken.length === 0) return false;
  if (!authorizationHeader) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match?.[1]) return false;

  const received = match[1].trim();
  if (received.length !== expectedToken.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(received, "utf8"),
      Buffer.from(expectedToken, "utf8"),
    );
  } catch {
    return false;
  }
}
