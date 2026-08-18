import { describe, expect, it } from "vitest";
import { toAnthropicTool } from "@/lib/models/kie/adapters/kie-anthropic";
import { normalizeKieError } from "@/lib/models/kie/errors";
import { PROVIDER_ERROR_CODES } from "@/lib/models/kie/types";

describe("Claude tool schema compatibility", () => {
  it("strips validation-only JSON Schema keywords before sending tools to KIE Claude", () => {
    const tool = toAnthropicTool({
      name: "start_game_discovery",
      description: "Start discovery",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 240,
            format: "uuid",
            description: "Discovery title",
          },
          count: { type: "number", minimum: 2, maximum: 12 },
          mode: { type: "string", enum: ["explore", "balanced"] },
        },
        required: ["title"],
      },
    });

    expect(tool.input_schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", description: "Discovery title" },
        count: { type: "number" },
        mode: { type: "string", enum: ["explore", "balanced"] },
      },
      required: ["title"],
    });
  });

  it("classifies invalid Claude Messages requests instead of hiding them as generic provider errors", () => {
    const error = normalizeKieError(
      400,
      JSON.stringify({ error: { type: "invalid_request_error", message: "bad tools schema" } }),
      "application/json",
      "claude_messages",
    );
    expect(error.code).toBe(PROVIDER_ERROR_CODES.CLAUDE_REQUEST_INVALID);
    expect(error.statusCode).toBe(400);
  });
});
