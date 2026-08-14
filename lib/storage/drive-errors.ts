export type DriveAuthMode = "service_account" | "oauth_user";

export type DriveErrorCode =
  | "DRIVE_NOT_CONFIGURED"
  | "DRIVE_AUTH_FAILED"
  | "DRIVE_FOLDER_ACCESS_DENIED"
  | "DRIVE_FOLDER_NOT_FOUND"
  | "DRIVE_FOLDER_CREATE_FAILED"
  | "DRIVE_UPLOAD_SESSION_FAILED";

export interface DriveErrorDetails {
  stage: string;
  googleHttpStatus?: number;
  googleErrorReason?: string;
}

export class DriveStorageError extends Error {
  readonly code: DriveErrorCode;
  readonly stage: string;
  readonly googleHttpStatus?: number;
  readonly googleErrorReason?: string;

  constructor(code: DriveErrorCode, message: string, details: DriveErrorDetails) {
    super(message);
    this.name = "DriveStorageError";
    this.code = code;
    this.stage = details.stage;
    this.googleHttpStatus = details.googleHttpStatus;
    this.googleErrorReason = details.googleErrorReason;
  }
}

interface GoogleApiErrorShape {
  code?: number;
  response?: {
    status?: number;
    data?: {
      error?: {
        errors?: Array<{ reason?: string; message?: string }>;
        message?: string;
      };
    };
  };
  errors?: Array<{ reason?: string; message?: string }>;
}

function extractGoogleApiError(err: unknown): { httpStatus?: number; reason?: string } {
  if (!err || typeof err !== "object") return {};

  const candidate = err as GoogleApiErrorShape;
  const httpStatus = candidate.code ?? candidate.response?.status;
  const reason =
    candidate.response?.data?.error?.errors?.[0]?.reason ??
    candidate.errors?.[0]?.reason ??
    undefined;

  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function mapGoogleHttpStatusToDriveError(
  httpStatus: number,
  _stage: string,
  fallbackCode: DriveErrorCode = "DRIVE_FOLDER_ACCESS_DENIED",
): DriveErrorCode {
  if (httpStatus === 401) return "DRIVE_AUTH_FAILED";
  if (httpStatus === 403) return "DRIVE_FOLDER_ACCESS_DENIED";
  if (httpStatus === 404) return "DRIVE_FOLDER_NOT_FOUND";
  return fallbackCode;
}

export function normalizeDriveError(
  err: unknown,
  stage: string,
  fallbackCode: DriveErrorCode = "DRIVE_FOLDER_ACCESS_DENIED",
): DriveStorageError {
  if (err instanceof DriveStorageError) return err;

  const { httpStatus, reason } = extractGoogleApiError(err);
  const code =
    httpStatus !== undefined
      ? mapGoogleHttpStatusToDriveError(httpStatus, stage, fallbackCode)
      : fallbackCode;

  const message =
    err instanceof Error && err.message.trim()
      ? err.message
      : "Google Drive request failed";

  return new DriveStorageError(code, message, {
    stage,
    ...(httpStatus !== undefined ? { googleHttpStatus: httpStatus } : {}),
    ...(reason ? { googleErrorReason: reason } : {}),
  });
}

export function driveErrorHttpStatus(code: DriveErrorCode): number {
  switch (code) {
    case "DRIVE_NOT_CONFIGURED":
      return 503;
    case "DRIVE_FOLDER_ACCESS_DENIED":
      return 403;
    case "DRIVE_FOLDER_NOT_FOUND":
      return 404;
    case "DRIVE_AUTH_FAILED":
      return 502;
    default:
      return 500;
  }
}

export function driveErrorUserMessage(code: DriveErrorCode): string {
  switch (code) {
    case "DRIVE_NOT_CONFIGURED":
      return "Google Drive не настроен для загрузки документов";
    case "DRIVE_AUTH_FAILED":
      return "Не удалось авторизоваться в Google Drive";
    case "DRIVE_FOLDER_ACCESS_DENIED":
      return "Permission denied: нет доступа к папке Google Drive";
    case "DRIVE_FOLDER_NOT_FOUND":
      return "Folder not found: папка Google Drive не найдена";
    case "DRIVE_FOLDER_CREATE_FAILED":
      return "Не удалось создать папку в Google Drive";
    case "DRIVE_UPLOAD_SESSION_FAILED":
      return "Не удалось создать сессию загрузки в Google Drive";
  }
}
