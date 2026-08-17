export type WorkerLogLevel = "info" | "warn" | "error";

export function workerLog(
  level: WorkerLogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    component: "durable-orchestrator-worker",
    ...fields,
  };

  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
