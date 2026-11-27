import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../errors.ts";

export type MediaUploadDiagnosticContext = {
  requestId: string;
  environment: "development" | "preview" | "test" | "staging" | "production" | "unknown";
  provider: "s3" | "local-disk" | "memory" | "unavailable";
};

export type MediaUploadErrorInfo = {
  errorCategory: string;
  errorName?: string;
  errorCode?: string;
  storageHttpStatus?: number;
  awsRequestId?: string;
  awsExtendedRequestId?: string;
  retryable?: boolean;
};

const contextStorage = new AsyncLocalStorage<MediaUploadDiagnosticContext>();
const operationByError = new WeakMap<object, string>();
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9/_+=-]{1,128}$/;
const SAFE_EXTRA_FIELDS = new Set([
  "configured", "credentialMode", "clipforgeSessionTokenPresent", "awsSessionTokenEnvironmentPresent",
  "awsEnvironmentAccessKeyPresent", "awsEnvironmentSecretPresent", "errorType", "reason", "stage",
]);

const AWS_ERROR_CATEGORIES: Record<string, string> = {
  InvalidToken: "aws_credentials_or_session_token",
  ExpiredToken: "aws_credentials_expired",
  InvalidAccessKeyId: "aws_access_key_invalid",
  SignatureDoesNotMatch: "aws_signature_mismatch",
  AccessDenied: "aws_permission_denied",
  AccessDeniedException: "aws_permission_denied",
  NoSuchBucket: "aws_bucket_not_found",
  PermanentRedirect: "aws_region_mismatch",
  AuthorizationHeaderMalformed: "aws_region_mismatch",
  IncorrectEndpoint: "aws_region_mismatch",
  IllegalLocationConstraintException: "aws_region_mismatch",
  SlowDown: "aws_throttling",
  Throttling: "aws_throttling",
  ThrottlingException: "aws_throttling",
  RequestLimitExceeded: "aws_throttling",
};
const NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"]);

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: unknown; requestId?: unknown; extendedRequestId?: unknown };
  $retryable?: unknown;
  retryable?: unknown;
};

function errorChain(error: unknown): ErrorLike[] {
  const values: ErrorLike[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const value = current as ErrorLike;
    values.push(value);
    current = value.cause;
  }
  return values;
}

function safeString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

export function classifyMediaUploadError(error: unknown, operation = "upload.unknown"): MediaUploadErrorInfo {
  const chain = errorChain(error);
  const errorNames = chain.map((value) => safeString(value.name, SAFE_IDENTIFIER)).filter((item): item is string => Boolean(item));
  const errorCodes = chain.map((value) => safeString(value.code, SAFE_CODE)).filter((item): item is string => Boolean(item));
  const codes = [...errorCodes, ...errorNames];
  const awsCode = codes.find((code) => AWS_ERROR_CATEGORIES[code]);
  const networkCode = codes.find((code) => NETWORK_CODES.has(code));
  const appCode = codes.find((code) => [
    "file_too_large", "unsupported_media_type", "invalid_media", "validation_failed", "database_unavailable", "database_error",
  ].includes(code));
  const category = operation.startsWith("database.") || appCode === "database_unavailable" || appCode === "database_error"
    ? "database_error"
    : appCode && ["file_too_large", "unsupported_media_type", "invalid_media", "validation_failed"].includes(appCode)
      ? "file_validation_error"
      : awsCode
        ? AWS_ERROR_CATEGORIES[awsCode]!
        : networkCode || codes.includes("TimeoutError") || codes.includes("NetworkingError")
          ? "storage_network_error"
          : operation.startsWith("s3.")
            ? "aws_unknown_error"
            : "unexpected_media_upload_failure";
  const metadata = chain.find((value) => value.$metadata)?.$metadata;
  const status = metadata?.httpStatusCode;
  const requestId = safeString(metadata?.requestId, SAFE_REQUEST_ID);
  const extendedRequestId = safeString(metadata?.extendedRequestId, SAFE_REQUEST_ID);
  const retryable = chain.some((value) => value.retryable === true || value.$retryable === true ||
    (typeof value.$retryable === "object" && value.$retryable !== null)) ||
    Boolean(networkCode) || codes.includes("TimeoutError") || codes.includes("NetworkingError") || category === "aws_throttling";
  const errorName = errorNames.find((name) => !/^(Error|AppError)$/.test(name));
  const errorCode = errorCodes.find((code) => !/^(Error|AppError)$/.test(code));
  return {
    errorCategory: category,
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { storageHttpStatus: status } : {}),
    ...(requestId ? { awsRequestId: requestId } : {}),
    ...(extendedRequestId ? { awsExtendedRequestId: extendedRequestId } : {}),
    ...(chain.some((value) => typeof value.retryable === "boolean" || typeof value.$retryable === "boolean" || typeof value.$retryable === "object") || networkCode || category === "aws_throttling" ? { retryable } : {}),
  };
}

export function withMediaUploadDiagnosticContext<T>(context: MediaUploadDiagnosticContext, work: () => Promise<T>): Promise<T> {
  return contextStorage.run(context, work);
}

export function mediaUploadDiagnosticContext(): MediaUploadDiagnosticContext | undefined {
  return contextStorage.getStore();
}

export function mediaUploadOperationFor(error: unknown): string | undefined {
  for (const value of errorChain(error)) {
    const operation = operationByError.get(value as object);
    if (operation) return operation;
  }
  return undefined;
}

/** Prisma constraint/not-found rejections are definite transaction failures; connection/unknown failures are ambiguous. */
export function databaseWriteOutcomeUncertain(error: unknown): boolean {
  const definiteRollbackCodes = new Set(["P2002", "P2003", "P2004", "P2025"]);
  const codes = errorChain(error).map((value) => safeString(value.code, SAFE_CODE)).filter((item): item is string => Boolean(item));
  return !codes.some((code) => definiteRollbackCodes.has(code));
}

export function logMediaUploadEvent(event: string, operation: string, error?: unknown, extra: Record<string, string | number | boolean> = {}): void {
  const context = contextStorage.getStore();
  if (!context) return;
  const info = error === undefined ? undefined : classifyMediaUploadError(error, operation);
  const safeExtra = Object.fromEntries(Object.entries(extra).filter(([key]) => SAFE_EXTRA_FIELDS.has(key)));
  const entry = {
    ...safeExtra,
    event,
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    operation,
    provider: context.provider,
    environment: context.environment,
    ...(info ?? {}),
  };
  (event.endsWith("failed") || event === "media_upload_failed" || event === "media_thumbnail_failed" || event === "media_database_record_failed" || event === "media_cleanup_failed" ? console.error : console.info)(JSON.stringify(entry));
}

export async function runMediaUploadOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
  const context = contextStorage.getStore();
  if (!context) return work();
  const prefix = operation.startsWith("s3.") ? "media_s3_operation" : operation.startsWith("database.") ? "media_database_operation" : "media_storage_operation";
  logMediaUploadEvent(`${prefix}_started`, operation);
  try {
    const result = await work();
    logMediaUploadEvent(`${prefix}_succeeded`, operation);
    return result;
  } catch (error) {
    if (typeof error === "object" && error !== null) operationByError.set(error, operation);
    logMediaUploadEvent(operation === "database.media_record_create" ? "media_database_record_failed" : `${prefix}_failed`, operation, error);
    throw error;
  }
}

export function safeDeploymentEnvironment(env: Record<string, string | undefined>): MediaUploadDiagnosticContext["environment"] {
  const value = env["CLIPFORGE_DEPLOYMENT_ENV"]?.trim().toLowerCase() ?? env["VERCEL_ENV"]?.trim().toLowerCase() ?? env["NODE_ENV"]?.trim().toLowerCase();
  return value === "development" || value === "preview" || value === "test" || value === "staging" || value === "production" ? value : "unknown";
}

export function publicMediaUploadFailure(error: unknown, requestId: string, operation: string): { status: number; code: string; message: string; confirmationRequired: boolean } {
  const info = classifyMediaUploadError(error, operation);
  const ambiguousStorageWrite = (operation === "s3.PutObject" || operation === "s3.CopyObject") &&
    (info.errorCategory === "storage_network_error" || ((info.storageHttpStatus ?? 0) >= 500 && (info.storageHttpStatus ?? 0) <= 599)) &&
    !((info.storageHttpStatus ?? 0) >= 400 && (info.storageHttpStatus ?? 0) <= 499);
  if (ambiguousStorageWrite) {
    return { status: 502, code: "storage_network_error", message: `The upload result could not be confirmed. Check your media library before retrying. Reference: ${requestId}.`, confirmationRequired: true };
  }
  if (error instanceof AppError) {
    const appError = error;
    if (appError.code === "database_unavailable" || appError.code === "database_error") {
      const confirmationRequired = databaseWriteOutcomeUncertain(error);
      return { status: 503, code: "database_error", message: confirmationRequired ? `The database could not confirm whether the upload was saved. Check your media library before retrying. Reference: ${requestId}.` : `The media record could not be saved. Reference: ${requestId}.`, confirmationRequired };
    }
    return { status: appError.status, code: appError.code, message: appError.message, confirmationRequired: false };
  }
  const messages: Record<string, { code: string; message: string }> = {
    aws_credentials_or_session_token: { code: "storage_authentication_failed", message: "Media storage authentication failed. Please contact support." },
    aws_credentials_expired: { code: "storage_authentication_failed", message: "Media storage authentication failed. Please contact support." },
    aws_access_key_invalid: { code: "storage_authentication_failed", message: "Media storage authentication failed. Please contact support." },
    aws_signature_mismatch: { code: "storage_authentication_failed", message: "Media storage authentication failed. Please contact support." },
    aws_permission_denied: { code: "storage_permission_denied", message: "The media storage service does not have permission to save this file." },
    aws_bucket_not_found: { code: "storage_configuration_error", message: "Media storage is not configured correctly." },
    aws_region_mismatch: { code: "storage_configuration_error", message: "Media storage is not configured correctly." },
    aws_throttling: { code: "storage_network_error", message: "Media storage is temporarily busy. Please try again." },
    storage_network_error: { code: "storage_network_error", message: "Media storage could not be reached. Please try again." },
    database_error: { code: "database_error", message: `The media record could not be saved. Reference: ${requestId}.` },
    aws_unknown_error: { code: "storage_error", message: `Upload could not be completed. Reference: ${requestId}.` },
    unexpected_media_upload_failure: { code: "internal_error", message: `Upload could not be completed. Reference: ${requestId}.` },
  };
  const selected = messages[info.errorCategory] ?? messages["unexpected_media_upload_failure"]!;
  const confirmationRequired = info.errorCategory === "database_error" && databaseWriteOutcomeUncertain(error);
  return { status: info.errorCategory === "database_error" ? 503 : 502, ...selected, confirmationRequired };
}
