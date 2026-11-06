import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCycle, makeItem, makeMedia, NOW } from "./helpers.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { buildPreflightReport } from "../src/server/preflight-service.ts";
import { setCycleRepeat } from "../src/server/handlers/cycles.ts";
import type { RequestContext } from "../src/server/context.ts";
import { consecutiveDefiniteFailures, decidePublishAttempt, decideSettledCycle, itemsEligibleForRepeat, orderDueItems, shouldPauseForAccount } from "../src/lib/domain/publish-workflow.ts";
import { runPreflight, type PreflightInput } from "../src/lib/domain/preflight.ts";

const attempts = (...outcomes: ("in_progress" | "success" | "definite_failure" | "ambiguous")[]) => outcomes.map((outcome) => ({ outcome }));

test("due items are ordered per queue, and published or ambiguous attempts are not uploaded again", () => {
  const later = makeItem({ id: "later", position: 1, scheduledFor: new Date(NOW.getTime() + 60_000) });
  const first = makeItem({ id: "first", position: 2, scheduledFor: new Date(NOW.getTime() - 60_000) });
  const second = makeItem({ id: "second", position: 0, scheduledFor: new Date(NOW.getTime() - 120_000) });
  assert.deepEqual(orderDueItems([later, first, second], NOW).map((item) => item.id), ["second", "first"]);
  const item = makeItem();
  assert.equal(decidePublishAttempt(item, []), "publish");
  assert.equal(decidePublishAttempt(item, attempts("definite_failure")), "publish");
  assert.equal(decidePublishAttempt({ ...item, status: "published" }, attempts("success")), "skip_published");
  assert.equal(decidePublishAttempt(item, attempts("ambiguous")), "verify_before_retry");
  assert.equal(decidePublishAttempt(item, attempts("in_progress")), "skip_in_progress");
  assert.equal(decidePublishAttempt({ ...item, status: "needs_review", reviewReason: "ambiguous_publish_result" }, []), "verify_before_retry");
});

test("expired permissions and repeated failures pause; repeat mode never republishes", () => {
  assert.equal(shouldPauseForAccount({ status: "token_expired", consecutiveDefiniteFailures: 0 }).pause, true);
  assert.equal(shouldPauseForAccount({ status: "revoked", consecutiveDefiniteFailures: 0 }).pause, true);
  assert.equal(shouldPauseForAccount({ status: "connected", consecutiveDefiniteFailures: 2 }).pause, false);
  assert.equal(shouldPauseForAccount({ status: "connected", consecutiveDefiniteFailures: 3 }).pause, true);
  const published = makeItem({ id: "done", status: "published" });
  const failed = makeItem({ id: "failed", status: "failed" });
  const cycle = makeCycle({ status: "running" });
  assert.equal(decideSettledCycle(cycle, [published], "never"), "complete");
  assert.equal(decideSettledCycle(cycle, [published], "ask"), "ask_before_repeat");
  assert.equal(decideSettledCycle(cycle, [published, failed], "automatic"), "repeat_without_published_items");
  assert.deepEqual(itemsEligibleForRepeat([published, failed]).map((item) => item.id), ["failed"]);
  assert.equal(decideSettledCycle(cycle, [makeItem({ status: "upcoming" })], "automatic"), "keep_running");
});

test("preflight blocks a personal account, a non-video, and an expired token, and a missing token only recommends", () => {
  const items = [makeItem({ id: "a", captionText: "Hello" })];
  const base = (): PreflightInput => ({
    cycle: makeCycle({ status: "draft", finalReviewConfirmed: true }), items, socialAccountStatus: "connected",
    scheduledItemsPerMonthLimit: 100, scheduledItemsUsedThisMonth: 0, coverSupport: "supported",
    sourceAccessByItemId: { a: { allowed: true, reason: "ok" } },
    instagram: { now: NOW, hasStoredToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2026-08-01T00:00:00Z"), mediaByItemId: { a: { kind: "video", mimeType: "video/mp4" } }, publicMediaUrlAvailable: true, consecutiveDefiniteFailures: 0, repeatBehavior: "never" },
  });
  const level = (input: PreflightInput, id: string) => runPreflight(input).checks.find((check) => check.id === id)?.level;
  assert.equal(level(base(), "instagram_public_url"), undefined);
  assert.equal(runPreflight({ ...base(), instagram: { ...base().instagram!, publicMediaUrlAvailable: false } }).checks.find((check) => check.id === "instagram_public_url")?.level, "blocked");
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, accountType: "PERSONAL" } }, "instagram_account_type"), "blocked");
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, grantedScopes: ["instagram_business_basic"] } }, "instagram_permissions"), "blocked");
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, tokenExpiresAt: new Date("2026-01-01T00:00:00Z") } }, "instagram_token_expiry"), "blocked");
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, mediaByItemId: { a: { kind: "image", mimeType: "image/png" } } } }, "instagram_media"), "blocked");
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, mediaByItemId: { a: { kind: "video", mimeType: "video/mp4", durationMs: 1000, sizeBytes: 10 } } } }, "instagram_duration"), "blocked");
  assert.match(runPreflight(base()).checks.find((check) => check.id === "instagram_failures")?.message ?? "", /pauses new claims after 3/);
  const local = runPreflight({ ...base(), instagram: { ...base().instagram!, hasStoredToken: false } });
  assert.equal(level({ ...base(), instagram: { ...base().instagram!, hasStoredToken: false } }, "instagram_token"), "recommendation");
  assert.equal(local.canStart, true);
});

test("stored PublishingJob rows set the pause count, and repeat mode is owner-checked", async () => {
  const repo = new MemoryRepository();
  await repo.createCycle({ id: "cycle1", ownerId: "bob", status: "draft", finalReviewConfirmed: true, name: "Spring", socialAccountId: "acct" });
  repo.media.set("media1", makeMedia({ ownerId: "bob" }));
  repo.items.set("item1", makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", captionText: "Hello" }));
  repo.socialAccounts.set("acct", { id: "acct", userId: "bob", status: "connected", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2026-08-01T00:00:00Z") });
  for (const n of [1, 2, 3]) repo.publishingJobs.set(`job-${n}`, { id: `job-${n}`, cycleItemId: "item1", outcome: "definite_failure", startedAt: new Date(NOW.getTime() - n * 1000) });
  repo.publishingJobs.set("older-success", { id: "older-success", cycleItemId: "item1", outcome: "success", startedAt: new Date(NOW.getTime() - 60_000) });
  await repo.createCycle({ id: "other", ownerId: "ada", status: "draft", finalReviewConfirmed: false, name: "Other", socialAccountId: "acct" });
  repo.items.set("other-item", makeItem({ id: "other-item", cycleId: "other", cycleOwnerId: "ada" }));
  repo.publishingJobs.set("other-job", { id: "other-job", cycleItemId: "other-item", outcome: "definite_failure", startedAt: new Date(NOW.getTime() + 1000) });
  const bobJobs = await repo.listPublishingJobsForAccount("bob", "acct");
  assert.equal(bobJobs.some((job) => job.id === "other-job"), false);
  assert.equal(consecutiveDefiniteFailures(bobJobs), 3);
  const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => "next", config: { coverSupport: "unknown" } };
  const cycle = await repo.getCycle("cycle1");
  const report = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(report.checks.find((check) => check.id === "instagram_failures")?.level, "action_required");
  await setCycleRepeat(ctx, { cycleId: "cycle1", repeatBehavior: "automatic" });
  assert.equal((await repo.getCycle("cycle1"))?.repeatBehavior, "automatic");
  await assert.rejects(() => setCycleRepeat({ ...ctx, userId: "ada" }, { cycleId: "cycle1", repeatBehavior: "never" }));
  assert.equal((await repo.getCycle("cycle1"))?.repeatBehavior, "automatic");
});
