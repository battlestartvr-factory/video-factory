import type { OrchestratorRpcClient } from "../rpc";
import {
  parseOrchestratorQueueMessage,
  type OrchestratorQueueAdapter,
  type QueueDelivery,
  type QueueReadOptions,
} from "./types";

interface QueueRow {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: unknown;
}

function isQueueRow(value: unknown): value is QueueRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.msg_id === "number" &&
    typeof row.read_ct === "number" &&
    typeof row.enqueued_at === "string" &&
    typeof row.vt === "string" &&
    "message" in row
  );
}

export type OrchestratorQueueMode = "core" | "research";

function queueRpcNames(mode: OrchestratorQueueMode) {
  return mode === "research"
    ? {
        read: "research_orchestrator_read_queue",
        archive: "research_orchestrator_archive_queue_message",
      }
    : {
        read: "orchestrator_read_queue",
        archive: "orchestrator_archive_queue_message",
      };
}

export class PgmqQueueAdapter implements OrchestratorQueueAdapter {
  private readonly rpcNames: ReturnType<typeof queueRpcNames>;

  constructor(
    private readonly rpcClient: OrchestratorRpcClient,
    readonly mode: OrchestratorQueueMode = "core",
  ) {
    this.rpcNames = queueRpcNames(mode);
  }

  async read(options: QueueReadOptions = {}): Promise<QueueDelivery[]> {
    const visibilitySeconds = options.visibilitySeconds ?? 120;
    const quantity = options.quantity ?? 1;
    const { data, error } = await this.rpcClient.rpc(this.rpcNames.read, {
      p_visibility_seconds: visibilitySeconds,
      p_qty: quantity,
    });

    if (error) {
      throw new Error(`Failed to read ${this.mode} orchestrator queue: ${error.message}`);
    }

    if (!Array.isArray(data)) return [];

    return data.map((row, index) => {
      if (!isQueueRow(row)) {
        throw new Error(`Invalid ${this.mode} orchestrator queue delivery at index ${index}`);
      }

      return {
        msgId: row.msg_id,
        readCount: row.read_ct,
        enqueuedAt: row.enqueued_at,
        visibleAt: row.vt,
        message: parseOrchestratorQueueMessage(row.message),
      };
    });
  }

  async ack(msgId: number): Promise<boolean> {
    const { data, error } = await this.rpcClient.rpc(this.rpcNames.archive, {
      p_msg_id: msgId,
    });

    if (error) {
      throw new Error(`Failed to archive ${this.mode} orchestrator queue message ${msgId}: ${error.message}`);
    }

    return data === true;
  }
}
