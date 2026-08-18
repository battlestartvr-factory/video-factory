import { randomUUID } from "node:crypto";
import type { AgentTool } from "@/lib/agent/types";
import { startGameDiscoverySchema } from "@/lib/agent/schemas";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createGameDiscoveryBatch } from "@/lib/game-discovery/service";
import type { DiscoveryObjectiveSpecV1 } from "@/lib/game-discovery/schemas";
import { processKnowledgeDocument } from "@/lib/knowledge/document-processor";

const MAX_USER_BRIEF_CHARS = 20_000;
const MAX_RESEARCH_CHARS_PER_DOCUMENT = CONTENT_LIMITS.maxExtractedTextChars;
const MAX_RESEARCH_TOTAL_CHARS = 140_000;
const MAX_RESEARCH_DOCUMENTS = 3;
const LEGACY_EXTRACTED_TEXT_CAP = 50_000;

function compactTitle(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Поиск новой co-op игры";
  return cleaned.length <= 200 ? cleaned : `${cleaned.slice(0, 197)}…`;
}

function compactIntent(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) {
    return "Найти перспективную новую PC/Steam friends co-op игру с настоящей взаимозависимостью игроков, высокой gameplay readability и реалистичным indie scope.";
  }
  return cleaned.length <= 4_000 ? cleaned : `${cleaned.slice(0, 3_997)}…`;
}

export const startGameDiscoveryTool: AgentTool<typeof startGameDiscoverySchema._output> = {
  name: "start_game_discovery",
  description:
    "Start the durable Stage 4 PC/Steam co-op Game Discovery Factory. Use this when the user asks the factory to discover new co-op game concepts, evaluate them, plan gameplay evidence, generate reference images, and stop for human approval before video. Attached research documents are automatically included as source context; do not ask the user to re-upload or paste them.",
  inputSchema: startGameDiscoverySchema,
  risk: "safe",
  async handler(input, ctx) {
    const service = createSupabaseServiceClient();
    const selectColumns = "id,filename,mime_type,metadata,created_at";
    const currentAttachments = await service
      .from("chat_attachments")
      .select(selectColumns)
      .eq("user_id", ctx.userId)
      .eq("chat_id", ctx.chatId)
      .eq("message_id", ctx.userMessageId)
      .order("created_at", { ascending: false })
      .limit(MAX_RESEARCH_DOCUMENTS);

    if (currentAttachments.error) {
      return {
        ok: false,
        code: "DISCOVERY_RESEARCH_LOAD_FAILED",
        error: "Не удалось загрузить приложенный research context.",
      };
    }

    let attachmentRows = currentAttachments.data ?? [];
    // A failed durable run should be restartable from the same chat with a short command.
    // If that new message has no file attached, reuse the latest archived research files
    // from this chat instead of forcing the user to upload the same multi-MB document again.
    if (attachmentRows.length === 0) {
      const recentAttachments = await service
        .from("chat_attachments")
        .select(selectColumns)
        .eq("user_id", ctx.userId)
        .eq("chat_id", ctx.chatId)
        .order("created_at", { ascending: false })
        .limit(MAX_RESEARCH_DOCUMENTS);
      if (recentAttachments.error) {
        return {
          ok: false,
          code: "DISCOVERY_RESEARCH_LOAD_FAILED",
          error: "Не удалось восстановить research context из текущего чата.",
        };
      }
      attachmentRows = recentAttachments.data ?? [];
    }

    const researchDocuments: Array<Record<string, unknown>> = [];
    let remainingResearchChars = MAX_RESEARCH_TOTAL_CHARS;

    for (const row of attachmentRows) {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const documentId = typeof metadata.document_id === "string" ? metadata.document_id : null;
      let extracted = typeof metadata.extracted_text === "string" ? metadata.extracted_text : "";

      // Documents ingested before the Stage 4 research fix were hard-capped at exactly
      // 50k characters. Re-run extraction from the archived Drive source when possible,
      // so a user does not need to upload the same research again after a deploy.
      if (
        documentId &&
        extracted.length >= LEGACY_EXTRACTED_TEXT_CAP &&
        CONTENT_LIMITS.maxExtractedTextChars > LEGACY_EXTRACTED_TEXT_CAP
      ) {
        try {
          const refreshed = await processKnowledgeDocument(documentId);
          const refreshedText =
            typeof refreshed.extracted_text === "string" ? refreshed.extracted_text : "";
          if (refreshedText.length > extracted.length) {
            extracted = refreshedText;
            await service
              .from("chat_attachments")
              .update({
                metadata: {
                  ...metadata,
                  extracted_text: extracted,
                  extraction_refreshed_at: new Date().toISOString(),
                },
              })
              .eq("id", row.id)
              .eq("user_id", ctx.userId);
          }
        } catch {
          // The durable factory can still proceed with the already archived text. The
          // bounded source metadata below records whether the supplied context was cut.
        }
      }

      if (remainingResearchChars <= 0) break;
      const documentBudget = Math.min(MAX_RESEARCH_CHARS_PER_DOCUMENT, remainingResearchChars);
      const truncated = extracted.length > documentBudget;
      const extractedText = truncated
        ? `${extracted.slice(0, documentBudget)}\n[research text truncated by discovery context budget]`
        : extracted;
      remainingResearchChars -= Math.min(extracted.length, documentBudget);

      researchDocuments.push({
        attachmentId: row.id,
        documentId,
        filename: row.filename,
        mimeType: row.mime_type,
        extractedText,
        extractedCharsAvailable: extracted.length,
        sourceTextComplete: !truncated && extracted.length < CONTENT_LIMITS.maxExtractedTextChars,
        sourceRole: "research_context",
      });
    }

    const userBrief =
      ctx.userMessage.length <= MAX_USER_BRIEF_CHARS
        ? ctx.userMessage
        : `${ctx.userMessage.slice(0, MAX_USER_BRIEF_CHARS)}\n[user brief truncated by chat launcher]`;

    const title = compactTitle(input.title ?? "Поиск новой co-op игры");
    const objective: DiscoveryObjectiveSpecV1 = {
      schema: "discovery_objective",
      version: 1,
      objectiveId: `chat-${ctx.userMessageId}`,
      title,
      searchIntent: compactIntent(input.search_intent ?? ctx.userMessage),
      playerCount: { min: 2, max: 4 },
      platform: "pc_steam",
      desiredNovelty: input.desired_novelty ?? "explore",
      conceptCount: input.concept_count ?? 6,
      maxConceptsToPrototype: input.max_concepts_to_prototype ?? 2,
      constraints: {
        maxMvpMonths: 12,
        networkingComplexity: "medium",
        contentBurden: "medium",
        npcAiDependency: "allow_light",
      },
      metadata: {
        source: "chat_stage4_discovery",
        chatId: ctx.chatId,
        userMessageId: ctx.userMessageId,
        userBrief,
        researchDocuments,
        humanGate: "reference_image_approval_required_before_video",
        externalWebResearchAllowed: false,
      },
    };

    try {
      const result = await createGameDiscoveryBatch({
        requestId: ctx.requestId || randomUUID(),
        userId: ctx.userId,
        projectId: ctx.projectId,
        objective,
        hypothesis: "Use the supplied research as evidence, not as a set of concepts to copy.",
      });

      const runId = result.creativeRun.id;
      return {
        ok: true,
        data: {
          root_creative_run_id: runId,
          factory_job_id: result.factoryJobId,
          duplicate: result.duplicate,
          research_documents: researchDocuments.map((document) => ({
            attachment_id: document.attachmentId,
            filename: document.filename,
            extracted_chars:
              typeof document.extractedText === "string" ? document.extractedText.length : 0,
            source_text_complete: document.sourceTextComplete === true,
          })),
          review_url: "/discovery",
          next_gate: "human_reference_approval_pending",
        },
        task: {
          action: "game_discovery",
          factoryJobId: result.factoryJobId,
          status: "queued",
          progress: 0,
          settings: {
            runId,
            title,
            humanGate: "reference_image_approval_required_before_video",
          },
        },
        terminate: true,
        userContent:
          `Запустил полноценный Stage 4 discovery batch «${title}». ` +
          `Research-документы переданы в discovery context. Прогресс, reference-кадры и human approval будут отображаться прямо в этом чате; переходить на отдельную страницу не обязательно.`,
      };
    } catch (error) {
      return {
        ok: false,
        code: "DISCOVERY_START_FAILED",
        error: error instanceof Error ? error.message : "Не удалось запустить Stage 4 discovery batch",
      };
    }
  },
};
