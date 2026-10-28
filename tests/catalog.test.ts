import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_IDS, getPlan, getPricePaise, formatPaiseAsRupees, UnknownPlanError, UnsupportedBillingIntervalError, PLAN_CATALOG } from "../src/lib/billing/catalog.ts";
import { checkLimit } from "../src/lib/billing/entitlements.ts";

const GIB = 1024 ** 3;

test("exact weekly and monthly prices in paise", () => {
  const expected: Record<string, [number, number]> = {
    free: [0, 0], creator: [49900, 199900], pro: [99900, 399900], agency: [149900, 599900],
  };
  for (const [id, [weekly, monthly]] of Object.entries(expected)) {
    assert.equal(getPricePaise(id, "weekly"), weekly, `${id} weekly`);
    assert.equal(getPricePaise(id, "monthly"), monthly, `${id} monthly`);
  }
});

test("all prices are integer paise", () => {
  for (const id of PLAN_IDS) for (const p of Object.values(getPlan(id).pricePaise)) assert.ok(Number.isInteger(p));
});

test("monthly is the rounded price point near 4x weekly", () => {
  for (const id of ["creator", "pro", "agency"] as const) {
    const diff = getPricePaise(id, "monthly") - 4 * getPricePaise(id, "weekly");
    assert.equal(diff, 300, `${id} monthly should be 4x weekly + Rs 3`);
  }
});

test("rupee formatting", () => {
  assert.equal(formatPaiseAsRupees(0), "₹0");
  assert.equal(formatPaiseAsRupees(199900), "₹1,999");
  assert.equal(formatPaiseAsRupees(599900), "₹5,999");
  assert.throws(() => formatPaiseAsRupees(10.5), RangeError);
  assert.throws(() => formatPaiseAsRupees(-1), RangeError);
});

test("unknown plan and unsupported interval are rejected", () => {
  assert.throws(() => getPlan("enterprise"), UnknownPlanError);
  assert.throws(() => getPricePaise("pro", "yearly"), UnsupportedBillingIntervalError);
  assert.throws(() => getPricePaise("pro", "daily"), UnsupportedBillingIntervalError);
});

test("plan limits match the brief", () => {
  const c = PLAN_CATALOG;
  assert.deepEqual(c.free.limits, { connectedAccounts: 1, storageBytes: 5 * GIB, processingMinutesPerMonth: 30, exportsPerMonth: 10, batchSize: 5, concurrentJobs: 1, templates: 3, activeCampaigns: 1, scheduledItemsPerMonth: 10 });
  assert.deepEqual(c.creator.limits, { connectedAccounts: 1, storageBytes: 50 * GIB, processingMinutesPerMonth: 300, exportsPerMonth: 100, batchSize: 25, concurrentJobs: 2, templates: 25, activeCampaigns: 5, scheduledItemsPerMonth: 100 });
  assert.deepEqual(c.pro.limits, { connectedAccounts: 3, storageBytes: 200 * GIB, processingMinutesPerMonth: 1500, exportsPerMonth: 500, batchSize: 100, concurrentJobs: 5, templates: 100, activeCampaigns: 20, scheduledItemsPerMonth: 500 });
  assert.deepEqual(c.agency.limits, { connectedAccounts: 10, storageBytes: 1024 * GIB, processingMinutesPerMonth: 6000, exportsPerMonth: 2000, batchSize: 200, concurrentJobs: 10, templates: 500, activeCampaigns: 100, scheduledItemsPerMonth: 2000 });
});

test("feature gates: ads only on free; sharing, shared use and Mix/Unmix start at Creator", () => {
  assert.equal(PLAN_CATALOG.free.features.showDashboardAds, true);
  for (const id of ["creator", "pro", "agency"] as const) assert.equal(PLAN_CATALOG[id].features.showDashboardAds, false);
  assert.equal(PLAN_CATALOG.free.features.googleDriveImport, false);
  assert.equal(PLAN_CATALOG.creator.features.googleDriveImport, true);
  // Free: no sharing features.
  assert.equal(PLAN_CATALOG.free.features.collectionSharing, "none");
  assert.equal(PLAN_CATALOG.free.features.useSharedVideosInCycles, false);
  assert.equal(PLAN_CATALOG.free.features.mixAndUnmix, false);
  // Creator: basic sharing, direct use, Mix/Unmix.
  assert.equal(PLAN_CATALOG.creator.features.collectionSharing, "basic");
  assert.equal(PLAN_CATALOG.creator.features.useSharedVideosInCycles, true);
  assert.equal(PLAN_CATALOG.creator.features.mixAndUnmix, true);
  // Pro / Agency: advanced sharing management.
  assert.equal(PLAN_CATALOG.pro.features.collectionSharing, "advanced");
  assert.equal(PLAN_CATALOG.agency.features.collectionSharing, "advanced");
  assert.equal(PLAN_CATALOG.free.features.maxResolution, "720p");
});

test("entitlement checks", () => {
  assert.equal(checkLimit("free", "batchSize", 0, 5).allowed, true);
  assert.equal(checkLimit("free", "batchSize", 0, 6).allowed, false);
  const r = checkLimit("creator", "exportsPerMonth", 99, 1);
  assert.equal(r.allowed, true); assert.equal(r.remaining, 1);
  assert.equal(checkLimit("creator", "exportsPerMonth", 100, 1).allowed, false);
  assert.throws(() => checkLimit("nope", "batchSize", 0), UnknownPlanError);
  assert.throws(() => checkLimit("pro", "batchSize", -1), RangeError);
});

test("advanced sharing policy: expiring grants and delegation start at Pro; recipient caps grow with plan", () => {
  assert.deepEqual(PLAN_CATALOG.free.sharing, { expiringGrants: false, delegatedManagement: false, maxRecipientsPerCollection: 0 });
  assert.equal(PLAN_CATALOG.creator.sharing.expiringGrants, false);
  assert.equal(PLAN_CATALOG.creator.sharing.delegatedManagement, false);
  assert.ok(PLAN_CATALOG.creator.sharing.maxRecipientsPerCollection > 0);
  for (const id of ["pro", "agency"] as const) {
    assert.equal(PLAN_CATALOG[id].sharing.expiringGrants, true);
    assert.equal(PLAN_CATALOG[id].sharing.delegatedManagement, true);
  }
  const caps = PLAN_IDS.map((id) => PLAN_CATALOG[id].sharing.maxRecipientsPerCollection);
  assert.deepEqual(caps, [...caps].sort((a, b) => a - b));
  // Prices stay exactly as agreed.
  assert.deepEqual(PLAN_IDS.map((id) => [getPricePaise(id, "weekly"), getPricePaise(id, "monthly")]), [[0, 0], [49900, 199900], [99900, 399900], [149900, 599900]]);
});
