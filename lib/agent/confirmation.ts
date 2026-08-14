const CREATE_PROJECT = /создай проект|создать проект|create (a )?project|новый проект/i;
const UPDATE_INSTRUCTIONS =
  /обнови инструкц|замени инструкц|перезапиши инструкц|update (the )?(project )?instructions|system prompt/i;
const REMEMBER = /запомни|сохрани в память|remember (this|that)|save (this )?to memory/i;

export type ExplicitCommandKind = "create_project" | "update_instructions" | "remember";

export function requiresExplicitCommand(userMessage: string, kind: ExplicitCommandKind): boolean {
  if (kind === "create_project") return CREATE_PROJECT.test(userMessage);
  if (kind === "update_instructions") return UPDATE_INSTRUCTIONS.test(userMessage);
  return REMEMBER.test(userMessage);
}

export function looksLikeRememberRequest(userMessage: string): boolean {
  return requiresExplicitCommand(userMessage, "remember");
}
