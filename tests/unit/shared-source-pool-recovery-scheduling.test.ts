import { describe, expect, it } from "vitest";
import {
  selectSharedPoolRecoveryTargets,
  type SourceCoverageCategory,
} from "@/lib/research-intelligence/shared-source-pool";

describe("shared source pool recovery scheduling", () => {
  it("does not let player_voice starve gameplay_visual", () => {
    const missing: SourceCoverageCategory[] = ["player_voice", "gameplay_visual"];

    expect(selectSharedPoolRecoveryTargets(missing, 1, 4, {})).toEqual(["player_voice"]);
    expect(selectSharedPoolRecoveryTargets(missing, 1, 4, { player_voice: 1 })).toEqual(["gameplay_visual"]);
    expect(selectSharedPoolRecoveryTargets(missing, 1, 4, {
      player_voice: 1,
      gameplay_visual: 1,
    })).toEqual(["player_voice"]);
    expect(selectSharedPoolRecoveryTargets(missing, 1, 4, {
      player_voice: 2,
      gameplay_visual: 1,
    })).toEqual(["gameplay_visual"]);
  });

  it("uses contrarian recovery only after core coverage is complete and source count is still low", () => {
    expect(selectSharedPoolRecoveryTargets([], 3, 4, {})).toEqual(["contrarian"]);
    expect(selectSharedPoolRecoveryTargets([], 4, 4, {})).toEqual([]);
  });
});
