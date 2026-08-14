import type { AgentTool } from "@/lib/agent/types";
import { answerUserSchema } from "@/lib/agent/schemas";

export const answerUserTool: AgentTool<typeof answerUserSchema._output> = {
  name: "answer_user",
  description:
    "Return the final answer to the user when no further tool execution is needed. Use after tools have gathered enough information, or for pure text work (posts, scripts, ideas).",
  inputSchema: answerUserSchema,
  risk: "safe",
  async handler(input) {
    return {
      ok: true,
      userContent: input.content,
      terminate: true,
      data: { answered: true },
    };
  },
};
