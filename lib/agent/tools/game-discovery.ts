import { randomUUID } from "node:crypto";
import type { AgentTool } from "@/lib/agent/types";
import { startGameDiscoverySchema } from "@/lib/agent/schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createGameDiscoveryBatch } from "@/lib/game-discovery/service";
import type { DiscoveryObjectiveSpecV1 } from "@/lib/game-discovery/schemas";

const MAX_USER_BRIEF_CHARS = 20_000;
const MAX_RESEARCH_CHARS_PER_DOCUMENT = 30_000;
const MAX_RESEARCH_DOCUMENTS = 3;

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
    const { data: attachmentRows, error: attachmentError } = await service
      .from("chat_attachments")
      .select("id,filename,mime_type,metadata")
      .eq("user_id", ctx.userId)
      .eq("chat_id", ctx.chatId)
      .eq("message_id", ctx.userMessageId)
      .limit(MAX_RESEARCH_DOCUMENTS);

    if (attachmentError) {
      return {
        ok: false,
        code: "DISCOVERY_RESEARCH_LOAD_FAILED",
        error: "Не удалось загрузить приложенный research context.",
      };
    }

    const researchDocuments = (attachmentRows ?? []).map((row) => {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const extracted = typeof metadata.extracted_text === "string" ? metadata.extracted_text : "";
      return {
        attachmentId: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        extractedText:
          extracted.length <= MAX_RESEARCH_CHARS_PER_DOCUMENT
            ? extracted
            : `${extracted.slice(0, MAX_RESEARCH_CHARS_PER_DOCUMENT)}\n[research text truncated by chat launcher]`,
        sourceRole: "research_context",
      };
    });

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
            extracted_chars: document.extractedText.length,
          })),
          review_url: "/discovery",
          next_gate: "human_reference_approval_pending",
        },
        terminate: true,
        userContent:
          `Запустил полноценный Stage 4 discovery batch «${title}». ` +
          `Research-документы переданы в discovery context. Завод сам пройдёт концепты → diversity → pre-evaluation → gameplay moment → shot → reference images и остановится перед видео. ` +
          `Следить за прогрессом и утвердить/исправить reference можно в разделе «Поиск игры».`,
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
