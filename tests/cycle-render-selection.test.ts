import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { itemToRow } from "../src/server/prisma/mappers.ts";
import { makeCycle, makeItem, makeMedia, NOW } from "./helpers.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { buildPreflightReport } from "../src/server/preflight-service.ts";
import type { RequestContext } from "../src/server/context.ts";
import { selectCycleItemRenderOutput } from "../src/server/handlers/cycles.ts";
import { cycleRenderOutputForm } from "../src/server/form-handlers.ts";
import { setRuntimeForTests } from "../src/server/runtime.ts";
import { CycleEditor } from "../src/components/CycleForms.tsx";
import type { CycleDetail } from "../src/server/queries.ts";

async function memorySetup() {
  const repo = new MemoryRepository();
  await repo.createCycle({ ...makeCycle({ status: "draft" }), name: "Cycle", socialAccountId: "account1" });
  repo.media.set("media1", makeMedia({ id: "media1", ownerId: "bob", sizeBytes: 100, kind: "video", durationMs: 10_000 }));
  repo.items.set("item1", makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", sourceKind: "owned", sourceCollectionId: null }));
  const save = async (id: string, ownerId = "bob", sourceMediaId = "media1", sizeBytes = 400, createdAt = NOW) =>
    repo.saveRenderOutput({ id, ownerId, sourceMediaId, storageKey: `render/${ownerId}/${id}`, sizeBytes, settingsHash: id, createdAt }, 1_000_000);
  return { repo, save };
}

test("memory repository selects only a successful output for the exact owner and source", async () => {
  const { repo, save } = await memorySetup();
  await save("valid"); await save("other-owner", "mallory"); await save("other-source", "bob", "different-source");
  const base = { cycleId: "cycle1", itemId: "item1", ownerId: "bob", expectedVersion: 1 };
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "valid" }), true);
  const selected = (await repo.getCycleItems("cycle1"))[0]!;
  assert.deepEqual([selected.selectedRenderOutputId, selected.version], ["valid", 2]);
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "other-owner" }), false);
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "other-source" }), false);
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "missing" }), false);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "valid");
});

test("a failed render has no selectable output; new renders never replace an explicit selection", async () => {
  const { repo, save } = await memorySetup();
  repo.renderJobs.set("failed-job", { id: "failed-job", ownerId: "bob", kind: "render", status: "failed", cycleItemId: "item1", mediaAssetId: "media1", progressPercent: 0, attempts: 1, idempotencyKey: "failed-job", lockedBy: null, lockToken: null, lockExpiresAt: null, errorMessage: "safe", createdAt: NOW, finishedAt: NOW, settingsHash: "failed", payload: {}, pendingOutputId: null, outputDerivativeId: null, ffmpegPid: null, ffmpegStartedAt: null });
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "failed-job", expectedVersion: 1 }), false);
  await save("first");
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "first", expectedVersion: 1 }), true);
  await save("rerender", "bob", "media1", 400, new Date(NOW.getTime() + 1000));
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "first");
  assert.deepEqual(await repo.listRenderOutputsForOwnerAndSource("bob", "media1").then((items) => items.map((item) => item.id)), ["rerender", "first"]);
});

test("stale version, clearing selection, and non-draft cycle state transitions", async () => {
  const { repo, save } = await memorySetup();
  await save("valid");
  // Stale version rejected
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "valid", expectedVersion: 99 }), false);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, null);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 1);

  // Valid selection succeeds and increments version
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "valid", expectedVersion: 1 }), true);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "valid");
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 2);

  // Clearing selection with renderOutputId: null succeeds and increments version
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: null, expectedVersion: 2 }), true);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, null);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 3);

  // Transition to running rejects further render output selection
  assert.equal(await repo.transitionCycleStatus("cycle1", "draft", "running", true), true);
  assert.equal(await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "valid", expectedVersion: 3 }), false);
});

test("handler selectCycleItemRenderOutput validates authentication, ownership, draft state, version, and source permission", async () => {
  const { repo, save } = await memorySetup();
  await save("valid");
  const ctx: RequestContext = {
    userId: "bob",
    now: NOW,
    repo,
    newId: () => "id-1",
    config: { coverSupport: "supported" },
  };

  // Valid selection
  const result = await selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "valid", expectedVersion: 1 });
  assert.deepEqual(result, { selected: true });
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "valid");
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 2);
  const audit = repo.audit.find((a) => a.action === "cycle_item.render_output_selected");
  assert.ok(audit);
  assert.equal(audit.entityId, "item1");

  // Valid clearing
  const cleared = await selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "", expectedVersion: 2 });
  assert.deepEqual(cleared, { selected: false });
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, null);
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 3);

  // Stale version throws conflict
  await assert.rejects(
    () => selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "valid", expectedVersion: 1 }),
    (err: any) => err.status === 409 || err.code === "conflict",
  );

  // Non-existent item throws notFound
  await assert.rejects(
    () => selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "nonexistent", renderOutputId: "valid", expectedVersion: 1 }),
    (err: any) => err.status === 404 || err.code === "not_found",
  );

  // Wrong owner cycle throws notFound
  const strangerCtx: RequestContext = { ...ctx, userId: "mallory" };
  await assert.rejects(
    () => selectCycleItemRenderOutput(strangerCtx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "valid", expectedVersion: 3 }),
    (err: any) => err.status === 404 || err.code === "not_found",
  );

  // Wrong owner output throws notFound
  await save("mallory-render", "mallory", "media1");
  await assert.rejects(
    () => selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "mallory-render", expectedVersion: 3 }),
    (err: any) => err.status === 404 || err.code === "not_found",
  );

  // Wrong source media output throws notFound
  await save("other-source-render", "bob", "other-media");
  await assert.rejects(
    () => selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "other-source-render", expectedVersion: 3 }),
    (err: any) => err.status === 404 || err.code === "not_found",
  );

  // Non-draft cycle throws forbidden
  await repo.transitionCycleStatus("cycle1", "draft", "running", true);
  await assert.rejects(
    () => selectCycleItemRenderOutput(ctx, { cycleId: "cycle1", itemId: "item1", renderOutputId: "valid", expectedVersion: 3 }),
    (err: any) => err.status === 403 || err.code === "forbidden",
  );
});

test("form route cycleRenderOutputForm handles CSRF, flash redirection, and input normalization", async () => {
  const { repo, save } = await memorySetup();
  await save("valid");
  setRuntimeForTests({
    mode: "local",
    repo,
    currentUserId: async () => "bob",
    newId: () => "gen-1",
    now: () => NOW,
  });

  try {
    const post = (fields: [string, string][], origin = "http://localhost:3000") =>
      new Request("http://localhost:3000/api/forms/cycle-render-output", {
        method: "POST",
        headers: { host: "localhost:3000", origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });

    // Valid selection redirect
    const res1 = await cycleRenderOutputForm(post([
      ["cycleId", "cycle1"],
      ["itemId", "item1"],
      ["renderOutputId", "valid"],
      ["expectedVersion", "1"],
    ]));
    assert.equal(res1.status, 303);
    assert.equal(res1.headers.get("location"), "/cycles/cycle1?notice=cycle_render_output_saved");
    assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "valid");
    assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 2);

    // Valid clearing redirect
    const res2 = await cycleRenderOutputForm(post([
      ["cycleId", "cycle1"],
      ["itemId", "item1"],
      ["renderOutputId", ""],
      ["expectedVersion", "2"],
    ]));
    assert.equal(res2.status, 303);
    assert.equal(res2.headers.get("location"), "/cycles/cycle1?notice=cycle_render_output_cleared");
    assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, null);
    assert.equal((await repo.getCycleItems("cycle1"))[0]!.version, 3);

    // Stale version redirect
    const res3 = await cycleRenderOutputForm(post([
      ["cycleId", "cycle1"],
      ["itemId", "item1"],
      ["renderOutputId", "valid"],
      ["expectedVersion", "1"],
    ]));
    assert.equal(res3.status, 303);
    assert.equal(res3.headers.get("location"), "/cycles/cycle1?error=conflict");

    // Cross-site request forbidden (CSRF protection)
    const csrfRes = await cycleRenderOutputForm(post([
      ["cycleId", "cycle1"],
      ["itemId", "item1"],
      ["renderOutputId", "valid"],
      ["expectedVersion", "3"],
    ], "http://evil.com"));
    assert.equal(csrfRes.status, 403);
  } finally {
    setRuntimeForTests(null);
  }
});

test("CycleEditor renders render selector with available choices in draft, and hides it in running cycles", async () => {
  const { repo, save } = await memorySetup();
  await save("valid-render", "bob", "media1", 5 * 1024 * 1024);
  const items = await repo.getCycleItems("cycle1");
  const detail: CycleDetail = {
    cycle: { id: "cycle1", name: "Cycle", status: "draft", scheduleSettings: null, timezone: "UTC" },
    scheduleStartDate: "2026-11-08",
    items,
    mediaTitles: { media1: "Sample Video 1" },
    mediaOrderData: { media1: { title: "Sample Video 1", sizeBytes: 1024, createdAt: NOW.toISOString() } },
    renderOutputsByItemId: { item1: [{ id: "valid-render", ownerId: "bob", sourceMediaId: "media1", sizeBytes: 5 * 1024 * 1024, createdAt: NOW }] },
    selectedRenderOutputAvailableByItemId: { item1: false },
    report: { overall: "blocked", canStart: false, checks: [] },
    coverChoices: [],
    readyToConfirm: false,
    publishing: { repeatBehavior: "never", accountStatus: "connected", tokenExpiresAt: null, tokenExpired: false, missingPermissions: [], definiteFailureStreak: 0, pauseReason: null, eligibleUnpublishedCount: 1 },
  };

  const draftHtml = renderToStaticMarkup(React.createElement(CycleEditor, { detail, timeZone: "UTC" }));
  assert.ok(draftHtml.includes("Rendered outputs for publishing"));
  assert.ok(draftHtml.includes('action="/api/forms/cycle-render-output"'));
  assert.ok(draftHtml.includes('name="renderOutputId"'));
  assert.ok(draftHtml.includes("value=\"valid-render\""));
  assert.ok(draftHtml.includes("5.0 MB"));
  assert.ok(draftHtml.includes("No render selected yet; publishing preflight remains blocked."));
  assert.ok(draftHtml.includes('href="/editor?media=media1"'));

  // With selection available
  const selectedDetail: CycleDetail = {
    ...detail,
    items: [{ ...items[0]!, selectedRenderOutputId: "valid-render", version: 2 }],
    selectedRenderOutputAvailableByItemId: { item1: true },
  };
  const selectedHtml = renderToStaticMarkup(React.createElement(CycleEditor, { detail: selectedDetail, timeZone: "UTC" }));
  assert.ok(selectedHtml.includes("Selected render is available."));
  assert.ok(selectedHtml.includes("selected=\"\"") || selectedHtml.includes("selected"));

  // When cycle is running, render selection form is not displayed
  const runningDetail: CycleDetail = {
    ...detail,
    cycle: { ...detail.cycle, status: "running" },
  };
  const runningHtml = renderToStaticMarkup(React.createElement(CycleEditor, { detail: runningDetail, timeZone: "UTC" }));
  assert.equal(runningHtml.includes("Rendered outputs for publishing"), false);
  assert.equal(runningHtml.includes('/api/forms/cycle-render-output'), false);
});

test("Prisma repository over fake client validates output relationships and maps the explicit selection", async () => {
  const client = new FakePrismaClient();
  const repo = new PrismaRepository(client);
  await repo.createCycle({ ...makeCycle({ status: "draft" }), name: "Cycle", socialAccountId: "account1" });
  await client.cycleItem.create({ data: itemToRow(makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", sourceKind: "owned", sourceCollectionId: null })) });
  const derivative = (id: string, ownerId: string, mediaAssetId: string) => client.mediaDerivative.create({ data: { id, ownerId, mediaAssetId, kind: "render", sizeBytes: 400n, storageKey: `render/${ownerId}/${id}`, settingsHash: id, createdAt: NOW } });
  await derivative("valid", "bob", "media1"); await derivative("wrong-owner", "mallory", "media1"); await derivative("wrong-source", "bob", "other-media");
  const base = { cycleId: "cycle1", itemId: "item1", ownerId: "bob", expectedVersion: 1 };
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "valid" }), true);
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "wrong-owner" }), false);
  assert.equal(await repo.selectCycleItemRenderOutput({ ...base, renderOutputId: "wrong-source" }), false);
  const selected = (await repo.getCycleItems("cycle1"))[0]!;
  assert.deepEqual([selected.selectedRenderOutputId, selected.version], ["valid", 2]);
  const row = await client.cycleItem.findUnique({ where: { id: "item1" } });
  assert.deepEqual([row?.["selectedRenderOwnerId"], row?.["selectedRenderSourceMediaId"]], ["bob", "media1"]);
});

test("publishing preflight checks the selected render size, while existing unselected items remain blocked", async () => {
  const { repo } = await memorySetup();
  const outputSize = 300 * 1024 * 1024 + 1;
  const largeResult = await repo.saveRenderOutput({ id: "large-output", ownerId: "bob", sourceMediaId: "media1", storageKey: "render/bob/large-output", sizeBytes: outputSize, settingsHash: "large-output", createdAt: NOW }, 1_000_000_000);
  assert.equal(largeResult.status, "saved");
  const storage = new MemoryMediaStorage();
  const storageKey = `render/bob/large-output`;
  const originalMetadata = storage.getPrivateMetadata.bind(storage);
  storage.getPrivateMetadata = async (key) => key === storageKey ? { sizeBytes: outputSize, storageKind: "memory" } : originalMetadata(key);
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: "large-output" });
  repo.socialAccounts.set("account1", { id: "account1", userId: "bob", status: "connected", platform: "instagram", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2027-01-01T00:00:00Z") });
  const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => "unused", config: { coverSupport: "supported" }, media: { storage, probe: null, maxUploadBytes: 1000 } };
  const cycle = await repo.getCycle("cycle1");
  const report = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(report.checks.find((check) => check.id === "instagram_file_size")?.level, "blocked");
  assert.equal(report.checks.find((check) => check.id === "publishing_media_ineligible"), undefined);
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: null });
  const unselected = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(unselected.checks.find((check) => check.id === "publishing_media_ineligible")?.level, "blocked");
  assert.equal(unselected.checks.find((check) => check.id === "instagram_media"), undefined, "a valid source video without a chosen derivative is not a non-video");
});

test("preflight classifies the actual source MIME and defers configured URL minting to the worker", async () => {
  const { repo, save } = await memorySetup();
  repo.socialAccounts.set("account1", { id: "account1", userId: "bob", status: "connected", platform: "instagram", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2027-01-01T00:00:00Z") });
  const cycle = await repo.getCycle("cycle1");
  const storage = new MemoryMediaStorage();
  const access = { mode: "provider" as const, createTemporaryAccess: async () => { throw new Error("preflight must not mint URLs"); }, validateTemporaryAccess: async () => false, createTemporaryCoverAccess: async () => { throw new Error("not used"); }, validateTemporaryCoverAccess: async () => false };
  const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => "unused", config: { coverSupport: "supported" }, media: { storage, probe: null, maxUploadBytes: 1000 }, publishingMediaAccess: access };

  const noOutput = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(noOutput.checks.find((check) => check.id === "instagram_media"), undefined);
  assert.equal(noOutput.checks.find((check) => check.id === "publishing_media_ineligible")?.level, "blocked");

  repo.media.set("media1", makeMedia({ id: "media1", ownerId: "bob", kind: "image", mimeType: "image/png" }));
  const actualImage = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(actualImage.checks.find((check) => check.id === "instagram_media")?.level, "blocked");
  repo.media.set("media1", makeMedia({ id: "media1", ownerId: "bob", kind: "video", mimeType: "video/mp4", durationMs: 10_000 }));

  await save("valid");
  const outputKey = "render/bob/valid";
  const originalMetadata = storage.getPrivateMetadata.bind(storage);
  storage.getPrivateMetadata = async (key) => key === outputKey ? { sizeBytes: 400, storageKind: "memory" } : originalMetadata(key);
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: "valid" });
  const readyToMint = await buildPreflightReport(ctx, "bob", cycle!, await repo.getCycleItems("cycle1"), true);
  assert.equal(readyToMint.checks.find((check) => check.id === "temporary_access_deferred")?.level, "recommendation");
  assert.equal(readyToMint.checks.find((check) => check.id === "temporary_access_not_configured"), undefined);
});

test("a missing selected render row and original source data are not rewritten", async () => {
  const { repo, save } = await memorySetup();
  await save("selected");
  await repo.selectCycleItemRenderOutput({ cycleId: "cycle1", itemId: "item1", ownerId: "bob", renderOutputId: "selected", expectedVersion: 1 });
  repo.renders.delete("selected");
  assert.equal((await repo.getCycleItems("cycle1"))[0]!.selectedRenderOutputId, "selected");
  assert.equal(await repo.getRenderOutput("selected"), null);
  assert.equal((await repo.getMedia("media1"))!.sizeBytes, 100);
});
