const SENSITIVE_KEY =
  /^(api[_-]?key|authorization|token|secret|password|service[_-]?role|cookie|set-cookie)$/i;
const SIGNED_QUERY = /(x-amz-signature|x-amz-credential|token|sig|signature|key)=([^&]+)/gi;

const MAX_STRING = 2000;
const MAX_ARRAY = 30;
const MAX_DEPTH = 6;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") {
    const withoutSigned = value.replace(SIGNED_QUERY, "$1=[redacted]");
    if (withoutSigned.length > MAX_STRING) {
      return `${withoutSigned.slice(0, MAX_STRING)}…[truncated]`;
    }
    return withoutSigned;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactValue(nested, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function redactForStorage(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated]`;
}

export function stripSignedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[url]";
  }
}
