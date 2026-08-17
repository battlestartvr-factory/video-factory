import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logging/logger";
import {
  redactForStorage,
  redactValue,
  stripSignedUrl,
  truncateText,
} from "@/lib/agent/redaction";
import { addCreativeReference, createCreativeRun } from "@/lib/creative/repository";
import type { CreativeRunType } from "@/lib/creative/types";
import type { TurnIntent } from "@/lib/agent/tools/resolve-tools-for-turn";
import type {
  GenerationCardData,
  MessageMetadata,
  SourceCitation,
} from "@/lib/types/workspace";

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_REFERENCE_CHARS = 2_000;
const MAX_TITLE_CHARS = 120;

export interface AgentCreativeLineageInput {
  requestId: string;
  userId: string;
  chatId: string;
  projectId?: string | null;
  userMessageId: string;
  assistantMessageId: string;
  userMessage: string;
  modelId?: string | null;
  reasoningLevel?: string | null;
  presetId?: string | null;
  attachmentIds?: string[];
  turnIntent: TurnIntent;
  agentRunId?: string | null;
  status: "completed" | "failed";
  errorCode?: string | null;
  assistantContent: string;
  metadata: MessageMetadata;
}

interface AgentRunSnapshot {
  model: string | null;
  usage: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export function inferCreativeRunType(input: {
  intent: TurnIntent;
  generations?: GenerationCardData[];
}): CreativeRunType {
  const generatedType = input.generations?.[0]?.type;
  if (generatedType === "image") return "image";
  if (generatedType === "video") return "video";

  switch (input.intent) {
    case "knowledge":
    case "web":
      return "research";
    case "image":
      return "image";
    case "video":
      return "video";
    case "general":
      return "concept";
    case "memory":
    case "projects":
      return "mixed";
  }
}

export function collectGenerationCards(metadata: MessageMetadata): GenerationCardData[] {
  const cards = [
    ...(metadata.generations ?? []),
    ...(metadata.generation ? [metadata.generation] : []),
  ];
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.generationId)) return false;
    seen.add(card.generationId);
    return true;
  });
}

export function sanitizeGenerationCard(card: GenerationCardData): Record<string, unknown> {
  return {
    generation_id: card.generationId,
    type: card.type,
    mode: card.mode,
    status: card.status,
    model_id: card.modelId,
    model_name: card.modelName ?? null,
    quality: card.quality ?? null,
    prompt: truncateText(card.prompt, MAX_OBJECTIVE_CHARS),
    outputs: (card.outputs ?? []).map((output) => ({
      kind: output.kind ?? null,
      url: output.url ? stripSignedUrl(output.url) : null,
    })),
  };
}

export function sanitizeSourceUrl(url: string): string {
  const redacted = redactValue(url);
  return typeof redacted === "string" ? redacted : "[url]";
}

export function dedupeSourceCitations(sources: SourceCitation[]): SourceCitation[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const safeUrl = source.url ? sanitizeSourceUrl(source.url) : "";
    const key = [
      source.source ?? "",
      source.documentId ?? "",
      String(source.chunkIndex ?? ""),
      safeUrl,
      source.title ?? source.filename ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadAgentRunSnapshot(agentRunId?: string | null): Promise<AgentRunSnapshot | null> {
  if (!agentRunId) return null;
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("agent_runs")
    .select("model,usage,error_code,error_message,started_at,finished_at")
    .eq("id", agentRunId)
    .maybeSingle();

  if (error || !data) return null;
  return data as AgentRunSnapshot;
}

async function findExistingCreativeRunId(agentRunId?: string | null): Promise<string | null> {
  if (!agentRunId) return null;
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_runs")
    .select("id")
    .eq("agent_run_id", agentRunId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.id as string;
}

/**
 * Best-effort Stage 2 lineage writer. Creative telemetry must never make a
 * successful chat turn fail, so all persistence failures are contained here.
 */
export async function recordAgentCreativeRunBestEffort(
  input: AgentCreativeLineageInput,
): Promise<string | null> {
  const logger = createLogger({
    request_id: input.requestId,
    event: "creative.agent_lineage",
    chat_id: input.chatId,
    project_id: input.projectId ?? null,
    agent_run_id: input.agentRunId ?? null,
  });

  try {
    const existingRunId = await findExistingCreativeRunId(input.agentRunId);
    if (existingRunId) {
      logger.info("creative_agent_lineage_already_recorded", {
        creative_run_id: existingRunId,
      });
      return existingRunId;
    }

    const agentRun = await loadAgentRunSnapshot(input.agentRunId);
    const generations = collectGenerationCards(input.metadata);
    const sources = dedupeSourceCitations(input.metadata.sources ?? []);
    const finishedAt = agentRun?.finished_at ?? new Date().toISOString();
    const normalizedTitle = input.userMessage.trim().replace(/\s+/g, " ");
    const errorCode = input.errorCode ?? agentRun?.error_code ?? null;
    const errorMessage = agentRun?.error_message
      ? truncateText(agentRun.error_message, MAX_REFERENCE_CHARS)
      : null;

    const creativeRun = await createCreativeRun({
      userId: input.userId,
      projectId: input.projectId ?? null,
      agentRunId: input.agentRunId || null,
      generationId: generations[0]?.generationId ?? null,
      runType: inferCreativeRunType({ intent: input.turnIntent, generations }),
      status: input.status,
      title: normalizedTitle
        ? truncateText(normalizedTitle, MAX_TITLE_CHARS)
        : "Universal Agent turn",
      objective: truncateText(input.userMessage, MAX_OBJECTIVE_CHARS),
      prompt: truncateText(input.userMessage, MAX_OBJECTIVE_CHARS),
      model: agentRun?.model ?? input.modelId ?? null,
      parameters: {
        requested_model_id: input.modelId ?? null,
        reasoning_level: input.reasoningLevel ?? null,
        preset_id: input.presetId ?? null,
      },
      inputs: {
        chat_id: input.chatId,
        user_message_id: input.userMessageId,
        attachment_ids: input.attachmentIds ?? [],
        turn_intent: input.turnIntent,
      },
      outputs: {
        assistant_message_id: input.assistantMessageId,
        assistant_content: truncateText(input.assistantContent, MAX_OUTPUT_CHARS),
        generations: generations.map(sanitizeGenerationCard),
      },
      usage: redactForStorage(agentRun?.usage ?? {}),
      errorCode,
      errorMessage,
      metadata: {
        request_id: input.requestId,
        source: "universal_agent",
        turn_intent: input.turnIntent,
        reference_count: sources.length,
        generation_count: generations.length,
      },
      startedAt: agentRun?.started_at ?? null,
      completedAt: finishedAt,
    });

    for (const source of sources) {
      try {
        await addCreativeReference({
          runId: creativeRun.id,
          userId: input.userId,
          referenceType:
            source.source === "knowledge"
              ? "knowledge"
              : source.source === "web"
                ? "web"
                : "other",
          sourceId: source.documentId ?? null,
          sourceUrl: source.url ? sanitizeSourceUrl(source.url) : null,
          title: source.title ?? source.filename ?? null,
          excerpt: source.excerpt
            ? truncateText(source.excerpt, MAX_REFERENCE_CHARS)
            : source.snippet
              ? truncateText(source.snippet, MAX_REFERENCE_CHARS)
              : null,
          metadata: {
            filename: source.filename ?? null,
            domain: source.domain ?? null,
            published_at: source.publishedAt ?? null,
            chunk_index: source.chunkIndex ?? null,
          },
        });
      } catch (error) {
        logger.warn("creative_reference_write_failed", {
          creative_run_id: creativeRun.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    logger.info("creative_agent_lineage_recorded", {
      creative_run_id: creativeRun.id,
      run_type: creativeRun.run_type,
      status: creativeRun.status,
      reference_count: sources.length,
      generation_count: generations.length,
    });
    return creativeRun.id;
  } catch (error) {
    logger.warn("creative_agent_lineage_failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}
