import type { GameplayAuthenticityPlanV1 } from "../../lib/game-discovery/gameplay-authenticity";

export function validGameplayAuthenticityPlan(input: {
  shotId: string;
  momentId: string;
  playerRole?: string;
  teammateRole?: string;
  cameraType?: "first_person" | "third_person_follow" | "over_shoulder";
}): GameplayAuthenticityPlanV1 {
  const playerRole = input.playerRole ?? "Driver";
  const teammateRole = input.teammateRole ?? "Rigger";
  return {
    schema: "gameplay_authenticity_plan",
    version: 1,
    shotId: input.shotId,
    momentId: input.momentId,
    controllablePlayer: {
      role: playerRole,
      obvious: true,
      viewpointPlausiblyPlayable: true,
      scriptedCharactersOnly: false,
    },
    camera: {
      type: input.cameraType ?? "third_person_follow",
      physicallyAttached: true,
      gameplayCameraJustified: true,
      visibleEvidence: `The camera follows ${playerRole} from normal playable distance while the controlled interaction remains in front of the player.`,
    },
    playerInput: {
      input: "hold the active control while adjusting movement",
      visibleEvidence: `The ${playerRole} is visibly operating the player-bound control and the controlled object responds immediately.`,
      visible: true,
    },
    playerAction: {
      action: `${playerRole} actively changes the controlled object's movement while remaining under player camera control.`,
      target: "The shared dangerous physical object in the playable interaction space.",
    },
    worldResponse: {
      response: "The shared physical object immediately changes movement and swing in response to the active control.",
      causalResponseVisible: true,
    },
    gameplayAffordances: [
      {
        type: "object_state",
        visible: true,
        meaningful: true,
        informationUsedByPlayer: "The changing cable/object state shows the player how the active control affects the shared object.",
      },
      {
        type: "contextual_prompt",
        visible: true,
        meaningful: true,
        informationUsedByPlayer: "The control prompt communicates the currently available player action.",
      },
    ],
    coop: {
      dependencyVisible: true,
      teammateFunction: `${teammateRole} performs the complementary control needed to keep the same shared object safe.`,
      visualEvidence: `${teammateRole} and the complementary control are visible inside the playable frame and affect the same object.`,
    },
    physics: {
      event: "The shared object's motion changes according to the combined controls.",
      consistent: true,
      affectedEntities: ["shared object", "cable"],
      exceptions: [],
    },
    readability: {
      primaryActionReadable: true,
      visibleGoal: true,
      riskExpected: true,
      visibleRisk: true,
      visualClutter: "low",
    },
  };
}
