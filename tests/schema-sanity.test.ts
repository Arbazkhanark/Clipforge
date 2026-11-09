// Offline sanity checks for prisma/schema.prisma. This is NOT `prisma validate` (the CLI is not
// installed here). It catches the mistakes we can detect with plain text parsing:
//  - enums that drifted away from the TypeScript domain lists,
//  - relation fields pointing at models that do not exist or lacking the opposite side,
//  - media foreign keys that would cascade-delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEDIA_STATUSES, COLLECTION_VISIBILITIES, CAPABILITIES, GRANT_STATUSES, CYCLE_ITEM_STATUSES, CYCLE_STATUSES, SOURCE_KINDS } from "../src/lib/domain/types.ts";
import { IMPORT_STATUSES } from "../src/lib/domain/media-lifecycle.ts";
import { PLAN_IDS } from "../src/lib/billing/catalog.ts";

const schemaText = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

function parseEnums(text: string): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  for (const match of text.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    enums[match[1] as string] = (match[2] as string).trim().split(/\s+/).filter(Boolean);
  }
  return enums;
}
function parseModels(text: string): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  for (const match of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    models[match[1] as string] = (match[2] as string).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("/") && !l.startsWith("*") && !l.startsWith("@@"));
  }
  return models;
}
const enums = parseEnums(schemaText);
const models = parseModels(schemaText);

test("schema parses into a reasonable number of models and enums", () => {
  assert.ok(Object.keys(models).length >= 20, `found ${Object.keys(models).length} models`);
  assert.ok(Object.keys(enums).length >= 20);
  const braces = (schemaText.match(/\{/g) ?? []).length - (schemaText.match(/\}/g) ?? []).length;
  assert.equal(braces, 0, "unbalanced braces");
});

test("every brief-required entity exists (or is deliberately merged)", () => {
  const required = ["User", "Subscription", "SocialAccount", "MediaAsset", "MediaDerivative", "VideoCollection", "CollectionItem",
    "CollectionShareLink", "CollectionAccessRequest", "CollectionPermission", "MediaImportJob", "EditingTemplate", "PublishingCycle",
    "CycleItem", "CaptionRevision", "CoverImageSelection", "PublishingJob", "ProcessingJob", "Notification", "UsageRecord",
    "PaymentRecord", "WebhookEvent", "AuditLog", "Session", "AuthToken"];
  for (const name of required) assert.ok(models[name], `missing model ${name}`);
});

test("Prisma enums match the TypeScript domain lists exactly", () => {
  assert.deepEqual(enums["MediaStatus"], [...MEDIA_STATUSES]);
  assert.deepEqual(enums["CollectionVisibility"], [...COLLECTION_VISIBILITIES]);
  assert.deepEqual(enums["Capability"], [...CAPABILITIES]);
  assert.deepEqual(enums["GrantStatus"], [...GRANT_STATUSES]);
  assert.deepEqual(enums["CycleItemStatus"], [...CYCLE_ITEM_STATUSES]);
  assert.deepEqual(enums["CycleStatus"], [...CYCLE_STATUSES]);
  assert.deepEqual(enums["SourceKind"], [...SOURCE_KINDS]);
  assert.deepEqual(enums["ImportStatus"], [...IMPORT_STATUSES]);
  assert.deepEqual(enums["BillingInterval"], ["weekly", "monthly"]);
  assert.deepEqual(enums["SubscriptionStatus"], ["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"]);
  assert.deepEqual(enums["CaptionSource"], ["none", "individual", "bulk"]);
  assert.deepEqual(enums["CoverState"], ["none", "saved_internally", "applied_on_instagram"]);
});

test("every field type is a scalar, an enum, or a model that exists", () => {
  const scalars = new Set(["String", "Int", "BigInt", "Boolean", "DateTime", "Json", "Float", "Decimal", "Bytes"]);
  for (const [modelName, lines] of Object.entries(models)) {
    for (const line of lines) {
      const [fieldName, rawType] = line.split(/\s+/);
      if (!fieldName || !rawType) continue;
      const typeName = rawType.replace(/[?\[\]]/g, "");
      assert.ok(scalars.has(typeName) || enums[typeName] || models[typeName], `${modelName}.${fieldName} has unknown type ${typeName}`);
    }
  }
});

test("every relation has an opposite field on the other model (with the same relation name if named)", () => {
  for (const [modelName, lines] of Object.entries(models)) {
    for (const line of lines.filter((l) => l.includes("@relation"))) {
      const [fieldName, rawType] = line.split(/\s+/);
      const targetModel = (rawType as string).replace(/[?\[\]]/g, "");
      const relationName = line.match(/@relation\("(\w+)"/)?.[1];
      const targetLines = models[targetModel] ?? [];
      const opposite = targetLines.filter((l) => {
        const t = (l.split(/\s+/)[1] ?? "").replace(/[?\[\]]/g, "");
        if (t !== modelName) return false;
        if (modelName === targetModel && l.startsWith(`${fieldName} `)) return false; // self relation: skip itself
        return relationName ? l.includes(`"${relationName}"`) : true;
      });
      assert.ok(opposite.length >= 1, `${modelName}.${fieldName} -> ${targetModel} has no opposite field`);
    }
  }
});

test("videos are never cascade-deleted by the database", () => {
  for (const modelName of ["CycleItem", "CollectionItem", "MediaImportJob", "MediaDerivative"]) {
    const mediaRelation = models[modelName]!.find((l) => /^\w+\s+MediaAsset\??\s+@relation/.test(l) && !l.includes("CycleItemCover"));
    assert.ok(mediaRelation, `${modelName} has no MediaAsset relation`);
    assert.match(mediaRelation as string, /onDelete: Restrict/, `${modelName} must use onDelete: Restrict for media`);
  }
});

test("idempotency / dedupe keys are unique", () => {
  const mustBeUnique: [string, string][] = [["WebhookEvent", "providerEventId"], ["MediaImportJob", "idempotencyKey"], ["PublishingJob", "idempotencyKey"],
    ["ProcessingJob", "idempotencyKey"], ["UsageRecord", "idempotencyKey"], ["Notification", "dedupeKey"], ["CollectionShareLink", "tokenHash"], ["MediaAsset", "storageKey"]];
  for (const [modelName, field] of mustBeUnique) {
    const line = models[modelName]!.find((l) => l.startsWith(field + " "));
    assert.ok(line?.includes("@unique"), `${modelName}.${field} must be @unique`);
  }
});

test("CycleItem has the version and lock columns the locking rules need", () => {
  const text = models["CycleItem"]!.join("\n");
  for (const column of ["version", "lockedBy", "lockExpiresAt", "reviewReason", "captionSource", "coverState"]) assert.match(text, new RegExp(`^${column}\\s`, "m"));
});

test("subscription plan ids in docs/tests are the catalog's", () => {
  assert.deepEqual([...PLAN_IDS], ["free", "creator", "pro", "agency"]);
});

test("schema follows the Prisma 7 rules we verified in the docs: no url in the datasource, prisma-client generator with output", () => {
  const datasource = /datasource\s+db\s*\{([^}]*)\}/.exec(schemaText)?.[1] ?? "";
  assert.ok(!/\burl\s*=/.test(datasource), "datasource url must live in prisma.config.ts (Prisma 7)");
  const generator = /generator\s+client\s*\{([^}]*)\}/.exec(schemaText)?.[1] ?? "";
  assert.match(generator, /provider\s*=\s*"prisma-client"/);
  assert.match(generator, /output\s*=/);
  const config = readFileSync(new URL("../prisma.config.ts", import.meta.url), "utf8");
  assert.match(config, /DATABASE_URL/);
  assert.ok(!/postgres(ql)?:\/\/\w+:\w+@/.test(config), "no real connection string in source");
});

test("auth tables store hashes only (no raw token or password columns)", () => {
  for (const name of ["Session", "AuthToken"]) {
    const text = models[name]!.join("\n");
    assert.match(text, /^tokenHash\s+String\s+@unique/m, `${name}.tokenHash must be unique`);
    assert.ok(!/^(token|rawToken|password)\s/m.test(text), `${name} must not store a raw secret`);
  }
  assert.deepEqual(enums["AuthTokenKind"], ["email_verification", "password_reset", "instagram_oauth_state"]);
  assert.ok(!/^password\s/m.test(models["User"]!.join("\n")), "User stores passwordHash, never password");
});
