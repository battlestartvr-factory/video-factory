import type { DiscoveryFeedbackMemory } from "../../lib/game-discovery/shot-planner";
import type { WorkflowTickContext } from "./types";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function mergeDiscoveryFeedback(
  base: DiscoveryFeedbackMemory,
  extra: DiscoveryFeedbackMemory,
): DiscoveryFeedbackMemory {
  return {
    mustShow: [...new Set([...base.mustShow, ...extra.mustShow])],
    mustAvoid: [...new Set([...base.mustAvoid, ...extra.mustAvoid])],
    errorTags: [...new Set([...base.errorTags, ...extra.errorTags])],
  };
}

export function automaticFeedbackFromState(
  state: Record<string, unknown>,
): DiscoveryFeedbackMemory | null {
  const value = object(state.gameplay_authenticity_auto_feedback_memory);
  const result = {
    mustShow: strings(value.mustShow ?? value.must_show),
    mustAvoid: strings(value.mustAvoid ?? value.must_avoid),
    errorTags: strings(value.errorTags ?? value.error_tags),
  };
  return result.mustShow.length || result.mustAvoid.length || result.errorTags.length ? result : null;
}

export function contextWithAutomaticGameplayFeedback(
  context: WorkflowTickContext,
): WorkflowTickContext {
  const extra = automaticFeedbackFromState(context.state);
  const target = context.services?.gameDiscovery;
  if (!extra || !context.services || !target) return context;

  const gameDiscovery = new Proxy(target, {
    get(repository, property, receiver) {
      if (property === "getFeedbackMemory") {
        return async (input: { rootCreativeRunId: string }) =>
          mergeDiscoveryFeedback(await repository.getFeedbackMemory(input), extra);
      }
      return Reflect.get(repository, property, receiver);
    },
  });

  return {
    ...context,
    services: { ...context.services, gameDiscovery },
  };
}
