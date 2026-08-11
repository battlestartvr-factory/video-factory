export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, meta) => log("debug", message, { ...context, ...meta }),
    info: (message, meta) => log("info", message, { ...context, ...meta }),
    warn: (message, meta) => log("warn", message, { ...context, ...meta }),
    error: (message, meta) => log("error", message, { ...context, ...meta }),
  };
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}
