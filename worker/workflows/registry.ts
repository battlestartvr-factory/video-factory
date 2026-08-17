import { coreSmokeV1 } from "./core-smoke-v1";
import type { WorkflowTickHandler } from "./types";

const registry = new Map<string, WorkflowTickHandler>([["core_smoke@1", coreSmokeV1]]);

export function workflowRegistryKey(kind: string, version: number): string {
  return `${kind}@${version}`;
}

export function getWorkflowHandler(kind: string, version: number): WorkflowTickHandler | null {
  return registry.get(workflowRegistryKey(kind, version)) ?? null;
}

export function listRegisteredWorkflows(): string[] {
  return [...registry.keys()].sort();
}
