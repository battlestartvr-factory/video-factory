import { randomUUID } from "node:crypto";
import type { AgentTool } from "@/lib/agent/types";
import { startGameDiscoverySchema } from "@/lib/agent/schemas";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createGameDiscoveryBatchV2 } from "@/lib/game-discovery/service-v2";
import type { DiscoveryObjectiveSpecV1 } from "@/lib/game-discovery/schemas";
import { defaultResearchPolicyV1 } from "@/lib/research-intelligence/schemas";
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

function boundedBrief(value: string): string {
  return value.length <= MAX_USER_BRIEF_CHARS
    ? value
    : `${value.slice(0, MAX_USER_BRIEF_CHARS)}\n[user brief truncated by chat launcher]`;
}

export const startGameDiscoveryTool: AgentTool<typeof startGameDiscoverySchema._output> = {
  name: "start_game_discovery",
  description:
    "Start the durable Stage 4.5 PC/Steam co-op Game Discovery Factory v2. Use this when the user asks the factory to discover new co-op game concepts, research current external evidence, stop at the Human Concept Gate, then generate reference images and gameplay video only after human approvals. Attached research documents are automatically included as source context; do not ask the user to re-upload or paste them.",
  inputSchema: startGameDiscoverySchema,
  risk: "safe",
  async handler(input, ctx) {
    const service = createSupabaseServiceClient();
    const selectColumns = "id,message_id,filename,mime_type,metadata,created_at";
    const currentAttachments = await service
      .from("chat_attachments")
      .select(selectColumns)
      .eq("user_id", ctx.userId)
      .eq("chat_id", ctx.chatId)
      .eq("message_id", ctx.userMessageId)
      .order("created_at", { ascending: false })
      .limit(MAX_RESEARCH_DOCUMENTS);

    if (currentAttachments.error) {
      return { ok: false, code: "DISCOVERY_RESEARCH_LOAD_FAILED", error: "Не удалось загрузить приложенный research context." };
    }

    let attachmentRows = currentAttachments.data ?? [];
    let reusedPreviousResearch = false;
    if (attachmentRows.length === 0) {
      const recentAttachments = await service
        .from("chat_attachments")
        .select(selectColumns)
        .eq("user_id", ctx.userId)
        .eq("chat_id", ctx.chatId)
        .order("created_at", { ascending: false })
        .limit(MAX_RESEARCH_DOCUMENTS);
      if (recentAttachments.error) {
        return { ok: false, code: "DISCOVERY_RESEARCH_LOAD_FAILED", error: "Не удалось восстановить research context из текущего чата." };
      }
      attachmentRows = recentAttachments.data ?? [];
      reusedPreviousResearch = attachmentRows.length > 0;
    }

    let effectiveUserMessage = ctx.userMessage;
    const sourceMessageId = attachmentRows[0]?.message_id;
    if (reusedPreviousResearch && typeof sourceMessageId === "string" && sourceMessageId !== ctx.userMessageId) {
      const { data: sourceMessage } = await service
        .from("chat_messages")
        .select("content")
        .eq("id", sourceMessageId)
        .eq("chat_id", ctx.chatId)
        .eq("role", "user")
        .maybeSingle();
      if (typeof sourceMessage?.content === "string" && sourceMessage.content.trim()) effectiveUserMessage = sourceMessage.content;
    }

    const researchDocuments: Array<Record<string, unknown>> = [];
    let remainingResearchChars = MAX_RESEARCH_TOTAL_CHARS;
    for (const row of attachmentRows) {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const documentId = typeof metadata.document_id === "string" ? metadata.document_id : null;
      let extracted = typeof metadata.extracted_text === "string" ? metadata.extracted_text : "";

      if (documentId && extracted.length >= LEGACY_EXTRACTED_TEXT_CAP && CONTENT_LIMITS.maxExtractedTextChars > LEGACY_EXTRACTED_TEXT_CAP) {
        try {
          const refreshed = await processKnowledgeDocument(documentId);
          const refreshedText = typeof refreshed.extracted_text === "string" ? refreshed.extracted_text : "";
          if (refreshedText.length > extracted.length) {
            extracted = refreshedText;
            await service.from("chat_attachments").update({ metadata: { ...metadata, extracted_text: extracted, extraction_refreshed_at: new Date().toISOString() } }).eq("id", row.id).eq("user_id", ctx.userId);
          }
        } catch {
          // Keep the already archived bounded context.
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

    const userBrief = boundedBrief(effectiveUserMessage);
    const title = compactTitle(input.title ?? "Поиск новой co-op игры");
    const objective: DiscoveryObjectiveSpecV1 = {
      schema: "discovery_objective",
      version: 1,
      objectiveId: `chat-${ctx.userMessageId}`,
      title,
      searchIntent: compactIntent(input.search_intent ?? effectiveUserMessage),
      playerCount: { min: 2, max: 4 },
      platform: "pc_steam",
      desiredNovelty: input.desired_novelty ?? "explore",
      conceptCount: input.concept_count ?? 6,
      maxConceptsToPrototype: input.max_concepts_to_prototype ?? 2,
      constraints: { maxMvpMonths: 12, networkingComplexity: "medium", contentBurden: "medium", npcAiDependency: "allow_light" },
      metadata: {
        source: "chat_stage4_5_discovery_v2",
        chatId: ctx.chatId,
        userMessageId: ctx.userMessageId,
        sourceUserMessageId: typeof sourceMessageId === "string" ? sourceMessageId : ctx.userMessageId,
        retryInstruction: reusedPreviousResearch ? ctx.userMessage : null,
        userBrief,
        researchDocuments,
        workflowVersion: 2,
        humanGates: ["human_concept_approval_pending", "human_reference_approval_pending", "human_video_approval_pending"],
        externalWebResearchAllowed: true,
        externalResearchProvider: "kie_gemini_google_search",
      },
    };

    try {
      const result = await createGameDiscoveryBatchV2({
        requestId: ctx.requestId || randomUUID(),
        userId: ctx.userId,
        projectId: ctx.projectId,
        objective,
        hypothesis: "Use attached research and current source-backed web evidence as evidence, never as concepts or visual assets to copy.",
        researchPolicy: defaultResearchPolicyV1,
      });
      const runId = result.creativeRun.id;
      return {
        ok: true,
        data: {
          root_creative_run_id: runId,
          factory_job_id: result.factoryJobId,
          duplicate: result.duplicate,
          workflow_version: 2,
          reused_previous_research: reusedPreviousResearch,
          research_documents: researchDocuments.map((document) => ({
            attachment_id: document.attachmentId,
            filename: document.filename,
            extracted_chars: typeof document.extractedText === "string" ? document.extractedText.length : 0,
            source_text_complete: document.sourceTextComplete === true,
          })),
          review_url: "/discovery",
          next_gate: "human_concept_approval_pending",
        },
        task: {
          action: "game_discovery",
          factoryJobId: result.factoryJobId,
          status: "queued",
          progress: 0,
          settings: {
            runId,
            title,
            workflowVersion: 2,
            researchProvider: "kie_gemini_google_search",
            humanGates: ["concept", "reference_image", "video"],
          },
        },
        terminate: true,
        userContent:
          `Запустил Game Discovery v2 «${title}». ` +
          `${reusedPreviousResearch ? "Исходный brief и приложенный research восстановлены из этого чата. " : "Приложенные research-документы переданы как дополнительный context. "}` +
          "Сначала завод проведёт внешний source-backed research и Concept Council. Затем прямо здесь появится Human Concept Gate; только после вашего approval начнётся media pipeline с отдельными Human Gate для reference и gameplay-видео.",
      };
    } catch (error) {
      return { ok: false, code: "DISCOVERY_START_FAILED", error: error instanceof Error ? error.message : "Не удалось запустить Stage 4.5 Game Discovery v2" };
    }
  },
};
