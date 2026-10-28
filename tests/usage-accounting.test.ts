import { test } from "node:test";
import assert from "node:assert/strict";
import { nextUsageResetUtc, describeUsageReset, monthStartUtc, recordsToInsert, chargeableSourceStorageBytes, buildRenderUsage, totalsForPeriod } from "../src/lib/domain/usage-accounting.ts";
import { NOW } from "./helpers.ts";

test("month start is the first instant of the UTC month", () => {
  assert.equal(monthStartUtc(new Date("2026-06-30T23:59:59Z")).toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(monthStartUtc(new Date("2026-07-01T00:00:00Z")).toISOString(), "2026-07-01T00:00:00.000Z");
});

test("a successful render creates seconds, one export and output storage, charged to the consumer", () => {
  const usage = buildRenderUsage({ consumerId: "bob", renderJobId: "r1", succeeded: true, outputValidated: true, processingSeconds: 61.2, outputSizeBytes: 5000, now: NOW });
  assert.deepEqual(usage.map((u) => [u.kind, u.amount, u.userId]), [["processing_seconds", 62, "bob"], ["exports", 1, "bob"], ["storage_bytes", 5000, "bob"]]);
});

test("a render that finished but failed output validation charges nothing", () => {
  assert.deepEqual(buildRenderUsage({ consumerId: "bob", renderJobId: "r1", succeeded: true, outputValidated: false, processingSeconds: 30, outputSizeBytes: 100, now: NOW }), []);
});

test("usage resets on the 1st of next calendar month, independent of billing date, and the notice says so", () => {
  assert.equal(nextUsageResetUtc(new Date("2026-06-15T10:00:00Z")).toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(nextUsageResetUtc(new Date("2026-12-31T23:59:59Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  const notice = describeUsageReset(new Date("2026-06-15T10:00:00Z"), "Asia/Kolkata");
  assert.match(notice, /1 July 2026/); assert.match(notice, /5:30/); assert.match(notice, /Asia\/Kolkata/); assert.match(notice, /billing renewal/);
});

test("a failed render charges nothing", () => {
  assert.deepEqual(buildRenderUsage({ consumerId: "bob", renderJobId: "r1", succeeded: false, outputValidated: false, processingSeconds: 30, outputSizeBytes: 0, now: NOW }), []);
});

test("retrying the same job never double-counts", () => {
  const usage = buildRenderUsage({ consumerId: "bob", renderJobId: "r1", succeeded: true, outputValidated: true, processingSeconds: 10, outputSizeBytes: 100, now: NOW });
  const first = recordsToInsert(new Set(), usage);
  assert.equal(first.length, 3);
  const retry = recordsToInsert(new Set(first.map((r) => r.idempotencyKey)), usage);
  assert.equal(retry.length, 0);
  // Duplicates inside one batch are also collapsed.
  assert.equal(recordsToInsert(new Set(), [...usage, ...usage]).length, 3);
});

test("shared references cost no source storage; owned and imported copies do", () => {
  assert.equal(chargeableSourceStorageBytes("shared_reference", 9000), 0);
  assert.equal(chargeableSourceStorageBytes("owned", 9000), 9000);
  assert.equal(chargeableSourceStorageBytes("imported_copy", 9000), 9000);
});

test("totals only count the right user and period", () => {
  const june = monthStartUtc(NOW);
  const mine = buildRenderUsage({ consumerId: "bob", renderJobId: "r1", succeeded: true, outputValidated: true, processingSeconds: 10, outputSizeBytes: 100, now: NOW });
  const other = buildRenderUsage({ consumerId: "eve", renderJobId: "r2", succeeded: true, outputValidated: true, processingSeconds: 99, outputSizeBytes: 999, now: NOW });
  const july = buildRenderUsage({ consumerId: "bob", renderJobId: "r3", succeeded: true, outputValidated: true, processingSeconds: 50, outputSizeBytes: 50, now: new Date("2026-07-02T00:00:00Z") });
  const totals = totalsForPeriod([...mine, ...other, ...july], "bob", june);
  assert.deepEqual(totals, { storage_bytes: 100, processing_seconds: 10, exports: 1, scheduled_items: 0 });
});
