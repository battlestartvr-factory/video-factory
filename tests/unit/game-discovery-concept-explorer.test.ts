import { describe, expect, it } from "vitest";
import {
  exploreConcepts,
  MAX_CONCEPTS_PER_PROVIDER_CALL,
  parseConceptBatch,
} from "../../lib/game-discovery/concept-explorer";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
} from "../../lib/game-discovery/schemas";

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "objective-test",
  title: "Explore readable co-op dependency",
  searchIntent: "Find mechanically necessary 2-player co-op ideas with visible social failure.",
  playerCount: { min: 2, max: 4 },
  platform: "pc_steam",
  desiredNovelty: "explore",
  conceptCount: 2,
  maxConceptsToPrototype: 1,
  constraints: {},
};

function concept(input: {
  id: string;
  core: string;
  dependency: string;
  social: string;
  tempo: string;
  camera: string;
  failure: string;
}): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: input.id,
    oneSentencePitch: `${input.id} pitch`,
    coreMechanic: input.core,
    coopDependency: `Players depend through ${input.dependency}.`,
    playerRoles: [
      { role: "left", responsibility: "Controls one necessary half of the system." },
      { role: "right", responsibility: "Controls the other necessary half of the system." },
    ],
    playerCount: { min: 2, max: 2, ideal: 2 },
    interactionModel: [input.dependency],
    failureMode: input.failure,
    socialMoment: input.social,
    gameplayHook: "Both players visibly act on the same problem and one mistake immediately affects both.",
    spectacle: "A readable physical consequence fills the frame.",
    setting: "Minimal test arena",
    artDirection: "Readable chunky shapes",
    camera: input.camera,
    readability: "Player responsibilities and the shared consequence are visible at once.",
    noveltyAxes: [
      { axis: "dependency_type", choice: input.dependency, whyDifferent: "Changes the required co-op dependency." },
      { axis: "social_tension", choice: input.social, whyDifferent: "Changes the social reaction." },
      { axis: "tempo", choice: input.tempo, whyDifferent: "Changes the cadence." },
      { axis: "camera_scale", choice: input.camera, whyDifferent: "Changes how the mechanic reads." },
      { axis: "failure_signature", choice: input.failure, whyDifferent: "Changes the visible failure." },
      { axis: "buildability_shape", choice: `low-${input.id}`, whyDifferent: "Keeps a small but distinct implementation shape." },
    ],
    buildability: {
      networking: "low",
      physics: "low",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "low",
      mainRisks: ["timing feel"],
      mvpRead: "One arena, one shared system, two roles.",
    },
    referenceInfluences: [],
  };
}

const first = concept({
  id: "shared-crank",
  core: "Both players rotate separate handles to steer one unstable machine.",
  dependency: "shared-machine",
  social: "blame",
  tempo: "precision",
  camera: "close-third-person",
  failure: "instant-spinout",
});

const duplicate = concept({
  id: "shared-crank-reskin",
  core: first.coreMechanic,
  dependency: "shared-machine",
  social: "blame",
  tempo: "precision",
  camera: "close-third-person",
  failure: "instant-spinout",
});

const replacement = concept({
  id: "blind-bridge",
  core: "One player walks a fragile bridge while the other rotates unseen supports using callouts.",
  dependency: "information-asymmetry",
  social: "trust",
  tempo: "calm-escalation",
  camera: "split-readability",
  failure: "cascading-collapse",
});

const relay = concept({
  id: "pressure-relay",
  core: "Players hand off pressure between remote valves before a visible tank ruptures.",
  dependency: "timed-relay",
  social: "anticipation",
  tempo: "rhythmic-handoff",
  camera: "fixed-overview",
  failure: "tank-rupture",
});

const rescue = concept({
  id: "counterweight-rescue",
  core: "One player moves a suspended rescue cage while the other redistributes counterweights.",
  dependency: "asymmetric-load-balancing",
  social: "responsibility",
  tempo: "slow-crisis",
  camera: "wide-side-view",
  failure: "visible-cage-drop",
});

function response(concepts: CoopGameConceptSpecV1[]) {
  return {
    text: JSON.stringify({ concepts }),
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    stopReason: "end_turn",
    responsePayload: {},
  };
}

function geminiSchemaDrift(concepts: CoopGameConceptSpecV1[]) {
  const drifted = JSON.parse(JSON.stringify({ concepts })) as {
    concepts: Array<Record<string, unknown>>;
  };
  for (const candidate of drifted.concepts) {
    const roles = candidate.playerRoles as Array<Record<string, unknown>>;
    for (const role of roles) {
      role.information = true;
      role.power = false;
    }
    const buildability = candidate.buildability as Record<string, unknown>;
    buildability.mainRisks = "A single readable implementation risk that Gemini returned as a scalar string.";
  }
  return {
    text: JSON.stringify(drifted),
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    stopReason: "end_turn",
    responsePayload: {},
  };
}

describe("Stage 4 Concept Explorer", () => {
  it("parses strict concept JSON even when wrapped in a JSON code fence", () => {
    const parsed = parseConceptBatch(`\`\`\`json\n${JSON.stringify({ concepts: [first] })}\n\`\`\``);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.conceptId).toBe("shared-crank");
  });

  it("normalizes observed Gemini primitive/container drift without paying for schema repair", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const llm = {
      generate: async (input: { prompt: string }) => {
        calls += 1;
        prompts.push(input.prompt);
        if (calls > 1) throw new Error("schema repair should not be needed for known drift");
        return geminiSchemaDrift([first, replacement]);
      },
    };

    const result = await exploreConcepts({
      llm,
      objective,
      replacementBuffer: 0,
      maxReplacementAttempts: 0,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(30);
    expect(calls).toBe(1);
    expect(result.accepted[0]?.playerRoles[0]?.information).toBeUndefined();
    expect(result.accepted[0]?.playerRoles[0]?.power).toBeUndefined();
    expect(result.accepted[0]?.buildability.mainRisks).toEqual([
      "A single readable implementation risk that Gemini returned as a scalar string.",
    ]);
    expect(prompts[0]).toContain("information?: string, power?: string");
    expect(prompts[0]).toContain("mainRisks: string[]");
    expect(prompts[0]).toContain("never booleans");
  });

  it("rejects a deterministic near-duplicate and uses a bounded replacement call", async () => {
    const calls: Array<{ model: string; prompt: string }> = [];
    const queued = [response([first, duplicate]), response([replacement])];
    const llm = {
      generate: async (input: { model: string; prompt: string }) => {
        calls.push(input);
        const next = queued.shift();
        if (!next) throw new Error("unexpected extra LLM call");
        return next;
      },
    };

    const result = await exploreConcepts({
      llm,
      objective,
      replacementBuffer: 0,
      maxReplacementAttempts: 2,
    });

    expect(result.accepted.map((item) => item.conceptId)).toEqual([
      "shared-crank",
      "blind-bridge",
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.conceptId).toBe("shared-crank-reskin");
    expect(result.rejected[0]?.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("same_core_mechanic_and_dependency")]),
    );
    expect(result.replacementAttempts).toBe(1);
    expect(result.generatedCount).toBe(3);
    expect(result.usage.totalTokens).toBe(60);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("EXACT REJECTION REASONS");
  });

  it("splits a larger initial pool into provider-safe batches and carries prior candidates forward", async () => {
    expect(MAX_CONCEPTS_PER_PROVIDER_CALL).toBe(3);
    const largerObjective: DiscoveryObjectiveSpecV1 = {
      ...objective,
      objectiveId: "objective-bounded-batches",
      conceptCount: 4,
      maxConceptsToPrototype: 2,
    };
    const calls: Array<{ prompt: string; thinking?: boolean }> = [];
    const queued = [response([first, replacement, relay]), response([rescue])];
    const llm = {
      generate: async (input: { prompt: string; thinking?: boolean }) => {
        calls.push(input);
        const next = queued.shift();
        if (!next) throw new Error("unexpected extra LLM call");
        return next;
      },
    };

    const result = await exploreConcepts({
      llm,
      objective: largerObjective,
      replacementBuffer: 0,
      maxReplacementAttempts: 0,
    });

    expect(result.accepted).toHaveLength(4);
    expect(result.generatedCount).toBe(4);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("Generate 3 substantially different");
    expect(calls[1]?.prompt).toContain("Generate 1 substantially different");
    expect(calls[1]?.prompt).toContain("shared-crank");
    expect(calls.every((call) => call.thinking === false)).toBe(true);
  });

  it("repairs malformed provider output once before accepting typed concepts", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const llm = {
      generate: async (input: { prompt: string }) => {
        calls += 1;
        prompts.push(input.prompt);
        if (calls === 1) {
          return {
            ...response([first, replacement]),
            text: "not-json",
          };
        }
        return response([first, replacement]);
      },
    };

    const result = await exploreConcepts({
      llm,
      objective,
      replacementBuffer: 0,
      maxReplacementAttempts: 0,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rawResponseHashes).toHaveLength(2);
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("VALIDATION ERRORS FROM THE STRICT PARSER");
    expect(prompts[1]).toContain("invalid JSON");
  });
});
