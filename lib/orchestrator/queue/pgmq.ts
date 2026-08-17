import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
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

export class PgmqQueueAdapter implements OrchestratorQueueAdapter {
  async read(options: QueueReadOptions = {}): Promise<QueueDelivery[]> {
    const visibilitySeconds = options.visibilitySeconds ?? 120;
    const quantity = options.quantity ?? 1;
    const service = createSupabaseServiceClient();
    const { data, error } = await service.rpc("orchestrator_read_queue", {
      p_visibility_seconds: visibilitySeconds,
      p_qty: quantity,
    });

    if (error) {
      throw new Error(`Failed to read orchestrator queue: ${error.message}`);
    }

    if (!Array.isArray(data)) return [];

    return data.map((row, index) => {
      if (!isQueueRow(row)) {
        throw new Error(`Invalid orchestrator queue delivery at index ${index}`);
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
    const service = createSupabaseServiceClient();
    const { data, error } = await service.rpc("orchestrator_archive_queue_message", {
      p_msg_id: msgId,
    });

    if (error) {
      throw new Error(`Failed to archive orchestrator queue message ${msgId}: ${error.message}`);
    }

    return data === true;
  }
}

export function createPgmqQueueAdapter(): OrchestratorQueueAdapter {
  return new PgmqQueueAdapter();
}
