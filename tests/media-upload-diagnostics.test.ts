import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/server/errors.ts";
import { classifyMediaUploadError, databaseWriteOutcomeUncertain, logMediaUploadEvent, publicMediaUploadFailure, withMediaUploadDiagnosticContext } from "../src/server/storage/media-upload-diagnostics.ts";

const awsFailure = (code: string, httpStatusCode = 400) => Object.assign(new Error("synthetic secret-bearing provider response must not be logged"), {
  name: code,
  code,
  $metadata: { httpStatusCode, requestId: "aws-request-123", extendedRequestId: "extended-request-456" },
});

test("S3 diagnostics classify AWS credential, permission, bucket, region, throttling, and network failures by code", () => {
  const cases: [string, string][] = [
    ["InvalidToken", "aws_credentials_or_session_token"],
    ["ExpiredToken", "aws_credentials_expired"],
    ["InvalidAccessKeyId", "aws_access_key_invalid"],
    ["SignatureDoesNotMatch", "aws_signature_mismatch"],
    ["AccessDenied", "aws_permission_denied"],
    ["NoSuchBucket", "aws_bucket_not_found"],
    ["PermanentRedirect", "aws_region_mismatch"],
    ["SlowDown", "aws_throttling"],
  ];
  for (const [code, category] of cases) assert.equal(classifyMediaUploadError(awsFailure(code), "s3.PutObject").errorCategory, category, code);
  assert.equal(classifyMediaUploadError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), "s3.GetObject").errorCategory, "storage_network_error");
  assert.equal(classifyMediaUploadError(new Error("database unavailable"), "database.media_record_create").errorCategory, "database_error");
  assert.equal(classifyMediaUploadError(awsFailure("OddS3Failure"), "s3.CopyObject").errorCategory, "aws_unknown_error");
  const distinctNameAndCode = Object.assign(new Error("synthetic response"), { name: "InvalidToken", code: "InvalidTokenException" });
  assert.deepEqual(
    [classifyMediaUploadError(distinctNameAndCode, "s3.PutObject").errorName, classifyMediaUploadError(distinctNameAndCode, "s3.PutObject").errorCode],
    ["InvalidToken", "InvalidTokenException"],
  );
});

test("S3 structured diagnostics keep request metadata but never serialize raw errors, credentials, keys, or URLs", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    await withMediaUploadDiagnosticContext({ requestId: "request-uuid", environment: "production", provider: "s3" }, async () => {
      logMediaUploadEvent("media_s3_operation_failed", "s3.PutObject", awsFailure("InvalidToken"), {
        credentialMode: "static", password: "synthetic-password", operation: "private/key/path", requestId: "attacker-value",
      });
    });
  } finally { console.error = original; }
  assert.equal(lines.length, 1);
  const serialized = lines[0]!;
  const event = JSON.parse(serialized) as Record<string, unknown>;
  assert.deepEqual([event["requestId"], event["operation"], event["provider"], event["errorCategory"], event["errorName"], event["errorCode"], event["storageHttpStatus"], event["awsRequestId"], event["awsExtendedRequestId"]], ["request-uuid", "s3.PutObject", "s3", "aws_credentials_or_session_token", "InvalidToken", "InvalidToken", 400, "aws-request-123", "extended-request-456"]);
  assert.doesNotMatch(serialized, /secret-bearing|synthetic-password|attacker-value|private\/key|AKIA|SECRET_ACCESS_KEY|media\/owner|s3\.amazonaws\.com|CopySource/);
});

test("upload responses use safe category-specific messages and retain the support reference", () => {
  const auth = publicMediaUploadFailure(awsFailure("InvalidToken"), "request-uuid", "s3.PutObject");
  assert.deepEqual([auth.status, auth.code, auth.message, auth.confirmationRequired], [502, "storage_authentication_failed", "Media storage authentication failed. Please contact support.", false]);
  const denied = publicMediaUploadFailure(awsFailure("AccessDenied", 403), "request-uuid", "s3.CopyObject");
  assert.equal(denied.message, "The media storage service does not have permission to save this file.");
  const uncertainPutTimeout = publicMediaUploadFailure(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }), "request-uuid", "s3.PutObject");
  assert.deepEqual([uncertainPutTimeout.confirmationRequired, uncertainPutTimeout.message.includes("Check your media library before retrying")], [true, true]);
  const uncertainPutServerError = publicMediaUploadFailure(awsFailure("InternalError", 503), "request-uuid", "s3.PutObject");
  assert.deepEqual([uncertainPutServerError.confirmationRequired, uncertainPutServerError.message.includes("Check your media library before retrying")], [true, true]);
  const definitePutAuthFailure = publicMediaUploadFailure(awsFailure("InvalidToken", 400), "request-uuid", "s3.PutObject");
  assert.equal(definitePutAuthFailure.confirmationRequired, false);
  const uncertainCopy = publicMediaUploadFailure(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }), "request-uuid", "s3.CopyObject");
  assert.deepEqual([uncertainCopy.confirmationRequired, uncertainCopy.message.includes("Check your media library before retrying")], [true, true]);
  const uncertainCopyServerError = publicMediaUploadFailure(awsFailure("InternalError", 503), "request-uuid", "s3.CopyObject");
  assert.equal(uncertainCopyServerError.confirmationRequired, true);
  const definiteCopyAuthFailure = publicMediaUploadFailure(awsFailure("InvalidToken", 400), "request-uuid", "s3.CopyObject");
  assert.equal(definiteCopyAuthFailure.confirmationRequired, false);
  const db = publicMediaUploadFailure(Object.assign(new Error("hidden database detail"), { code: "P2025" }), "request-uuid", "database.media_record_create");
  assert.deepEqual([db.status, db.code, db.confirmationRequired], [503, "database_error", false]);
  assert.match(db.message, /Reference: request-uuid/);
  const validation = new AppError(415, "unsupported_media_type", "That file is not supported.");
  assert.equal(publicMediaUploadFailure(validation, "request-uuid", "upload.validate").message, "That file is not supported.");
});

test("database constraint rejection is definite while transport and unclassified failures require confirmation", () => {
  assert.equal(databaseWriteOutcomeUncertain(Object.assign(new Error("constraint"), { code: "P2025" })), false);
  assert.equal(databaseWriteOutcomeUncertain(Object.assign(new Error("connection lost"), { code: "P1001" })), true);
  assert.equal(databaseWriteOutcomeUncertain(new Error("unknown commit outcome")), true);
  assert.equal(publicMediaUploadFailure(Object.assign(new Error("connection lost"), { code: "P1001" }), "ref", "database.media_record_create").confirmationRequired, true);
});
