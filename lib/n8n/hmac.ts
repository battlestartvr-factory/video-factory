import { createHmac, timingSafeEqual } from "crypto";

const MAX_TIMESTAMP_DRIFT_SECONDS = 5 * 60;

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmacSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = signPayload(rawBody, secret);
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

export function verifyTimestamp(
  timestampHeader: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestampHeader) return false;
  const ts = Number.parseInt(timestampHeader, 10);
  if (Number.isNaN(ts)) return false;
  return Math.abs(nowSeconds - ts) <= MAX_TIMESTAMP_DRIFT_SECONDS;
}

export function buildWebhookHeaders(
  rawBody: string,
  secret: string,
  idempotencyKey: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(rawBody, secret);
  return {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": signature,
    "Idempotency-Key": idempotencyKey,
  };
}
