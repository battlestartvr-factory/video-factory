import type { AgentTool } from "@/lib/agent/types";
import {
  createProjectSchema,
  getProjectContextSchema,
  listProjectFilesSchema,
  updateProjectInstructionsSchema,
} from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import {
  createProjectForUser,
  getProjectForUser,
  listProjectFiles,
  updateProjectInstructions,
} from "@/lib/projects";
import { requiresExplicitCommand } from "@/lib/agent/confirmation";

export const getProjectContextTool: AgentTool<typeof getProjectContextSchema._output> = {
  name: "get_project_context",
  description:
    "Load the current (or specified) project workspace: name, description, instructions, language, platforms. Project id is optional when already inside a project chat.",
  inputSchema: getProjectContextSchema,
  risk: "safe",
  async handler(input, ctx) {
    const projectId = input.project_id ?? ctx.projectId;
    if (!projectId) {
      return {
        ok: false,
        code: AGENT_ERROR_CODES.NOT_FOUND,
        error: "Сейчас чат вне проекта. Укажите project_id или попросите создать проект.",
      };
    }
    try {
      const project = await getProjectForUser(ctx.userId, projectId);
      if (!project) {
        return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Проект не найден" };
      }
      return {
        ok: true,
        data: {
          id: project.id,
          name: project.name,
          description: project.description,
          system_prompt: project.system_prompt,
          status: project.status,
          default_language: project.default_language,
          target_platforms: project.target_platforms,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "ForbiddenError") {
        return { ok: false, code: AGENT_ERROR_CODES.FORBIDDEN, error: "Нет доступа к проекту" };
      }
      return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR, error: "Не удалось загрузить проект" };
    }
  },
};

export const listProjectFilesTool: AgentTool<typeof listProjectFilesSchema._output> = {
  name: "list_project_files",
  description: "List knowledge documents, chat attachments, and assets belonging to the current project.",
  inputSchema: listProjectFilesSchema,
  risk: "safe",
  async handler(input, ctx) {
    const projectId = input.project_id ?? ctx.projectId;
    if (!projectId) {
      return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Чат вне проекта" };
    }
    try {
      const files = await listProjectFiles(ctx.userId, projectId);
      return { ok: true, data: { files } };
    } catch (error) {
      if (error instanceof Error && error.name === "ForbiddenError") {
        return { ok: false, code: AGENT_ERROR_CODES.FORBIDDEN, error: "Нет доступа к проекту" };
      }
      return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR, error: "Не удалось получить файлы проекта" };
    }
  },
};

export const createProjectTool: AgentTool<typeof createProjectSchema._output> = {
  name: "create_project",
  description:
    "Create a new project workspace. Use only when the user explicitly asks to create a project. Never invent a fake project automatically for a global chat.",
  inputSchema: createProjectSchema,
  risk: "safe",
  async handler(input, ctx) {
    if (!requiresExplicitCommand(ctx.userMessage, "create_project")) {
      return {
        ok: false,
        code: AGENT_ERROR_CODES.CONFIRMATION_REQUIRED,
        error: "Создание проекта нужно явным запросом пользователя.",
      };
    }
    const project = await createProjectForUser({
      userId: ctx.userId,
      name: input.name,
      description: input.description,
      defaultLanguage: input.default_language,
      targetPlatforms: input.target_platforms,
    });
    return {
      ok: true,
      data: { project_id: project.id, name: project.name },
    };
  },
};

export const updateProjectInstructionsTool: AgentTool<typeof updateProjectInstructionsSchema._output> = {
  name: "update_project_instructions",
  description:
    "Overwrite the project system prompt / instructions. This is a project-admin write. Require a clear user command or confirmed=true after asking.",
  inputSchema: updateProjectInstructionsSchema,
  risk: "destructive",
  async handler(input, ctx) {
    const projectId = input.project_id ?? ctx.projectId;
    if (!projectId) {
      return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Чат вне проекта" };
    }
    if (!input.confirmed && !requiresExplicitCommand(ctx.userMessage, "update_instructions")) {
      return {
        ok: false,
        code: AGENT_ERROR_CODES.CONFIRMATION_REQUIRED,
        error: "Перезапись инструкций проекта требует явной команды пользователя.",
      };
    }
    try {
      const project = await updateProjectInstructions({
        userId: ctx.userId,
        projectId,
        instructions: input.instructions,
      });
      return { ok: true, data: { project_id: project.id, updated: true } };
    } catch (error) {
      if (error instanceof Error && error.name === "ForbiddenError") {
        return { ok: false, code: AGENT_ERROR_CODES.FORBIDDEN, error: "Нет доступа к проекту" };
      }
      return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR, error: "Не удалось обновить инструкции" };
    }
  },
};
