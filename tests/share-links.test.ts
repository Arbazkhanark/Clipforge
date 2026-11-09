import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { NOW, makeMedia } from "./helpers.ts";
import type { RequestContext } from "../src/server/context.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { createCollectionShareLink, revokeCollectionShareLink, updateCollectionShareLink } from "../src/server/handlers/sharing.ts";
import { getCollectionDetail, getSharedCollectionDetail } from "../src/server/queries.ts";
import { CollectionDetailView } from "../src/components/CollectionViews.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { AppError } from "../src/server/errors.ts";
import { createCollectionShareLinkRoute } from "../src/server/share-link-route.ts";
import { generateShareToken } from "../src/lib/domain/sharing-permissions.ts";

function context(repo: MemoryRepository, userId: string | null): RequestContext {
  let sequence = 0;
  return { userId, now: NOW, repo, newId: () => `share-${++sequence}`, config: { coverSupport: "unknown" } };
}

async function memoryFixture() {
  const repo = new MemoryRepository();
  repo.plans.set("owner", "pro");
  repo.plans.set("recipient", "pro");
  repo.collections.set("link-col", { id: "link-col", ownerId: "owner", name: "Shared title", description: "Shared notes", visibility: "link", archived: false, mediaIds: [] });
  return repo;
}

test("memory owner creation stores only a hash, one-time route shows raw link once, edits/revokes are audited", async () => {
  const repo = await memoryFixture();
  const routeRuntime: Runtime = { mode: "local", repo, currentUserId: async () => "owner", newId: () => "route-link", now: () => NOW };
  const route = createCollectionShareLinkRoute(() => routeRuntime);
  const form = new URLSearchParams([ ["collectionId", "link-col"], ["capabilities", "view"] ]);
  const response = await route(new Request("http://localhost:3000/api/forms/share-link-create", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  const html = await response.text();
  const path = html.match(/href="(\/shared\/[A-Za-z0-9_-]{43})"/)?.[1];
  assert.ok(path, "raw link should be shown in creation response");
  const token = path!.slice("/shared/".length);
  const stored = [...repo.collectionShareLinks.values()][0]!;
  assert.notEqual(stored.tokenHash, token);
  assert.equal(stored.tokenHash.length, 64);
  assert.ok(!html.includes(stored.tokenHash));
  assert.ok(!JSON.stringify(repo.audit).includes(stored.tokenHash));
  assert.equal(repo.collectionShareLinks.size, 1);

  const updated = await updateCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", shareLinkId: stored.id, capabilities: ["view", "download"], expiresAt: null });
  assert.equal(updated.status, "updated");
  await assert.rejects(() => updateCollectionShareLink(context(repo, "recipient"), { collectionId: "link-col", shareLinkId: stored.id, capabilities: ["view"], expiresAt: null }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.equal((await repo.getCollectionShareLinkByTokenHash(stored.tokenHash))?.capabilities.includes("manage"), false);
  await assert.rejects(() => revokeCollectionShareLink(context(repo, "recipient"), { collectionId: "link-col", shareLinkId: stored.id }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.deepEqual(await revokeCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", shareLinkId: stored.id }), { id: stored.id, status: "revoked" });
});

test("share links authorize only selected capabilities and are invalidated by malformed, unknown, expired, revoked, or non-link collection state", async () => {
  const repo = await memoryFixture();
  const created = await createCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", capabilities: ["view"], expiresAt: null });
  const token = created.path.slice("/shared/".length);
  const detail = await getSharedCollectionDetail(context(repo, "recipient"), token);
  assert.equal(detail.permissions.canUseInCycle, false);
  assert.equal(detail.permissions.canImport, false);
  assert.equal(detail.permissions.canDownload, false);
  assert.equal(detail.permissions.isOwner, false);
  assert.equal(detail.sharingManagement, undefined);
  assert.equal(JSON.stringify(detail).includes("tokenHash"), false);
  assert.equal(JSON.stringify(detail).includes("Shared notes"), true);
  await assert.rejects(() => getCollectionDetail(context(repo, "recipient"), "link-col"), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => getSharedCollectionDetail(context(repo, null), token), (error: unknown) => error instanceof AppError && error.status === 401);
  for (const invalid of ["bad", `${token}x`, "A".repeat(43)]) await assert.rejects(() => getSharedCollectionDetail(context(repo, "recipient"), invalid), (error: unknown) => error instanceof AppError && error.status === 404);

  const link = [...repo.collectionShareLinks.values()][0]!;
  repo.collectionShareLinks.set(link.id, { ...link, expiresAt: new Date(NOW.getTime() - 1) });
  await assert.rejects(() => getSharedCollectionDetail(context(repo, "recipient"), token), (error: unknown) => error instanceof AppError && error.status === 404);
  repo.collectionShareLinks.set(link.id, link);
  repo.collections.set("link-col", { ...repo.collections.get("link-col")!, visibility: "private" });
  await assert.rejects(() => getSharedCollectionDetail(context(repo, "recipient"), token), (error: unknown) => error instanceof AppError && error.status === 404);
  repo.collections.set("link-col", { ...repo.collections.get("link-col")!, visibility: "link", archived: true });
  await assert.rejects(() => getSharedCollectionDetail(context(repo, "recipient"), token), (error: unknown) => error instanceof AppError && error.status === 404);
  repo.collections.set("link-col", { ...repo.collections.get("link-col")!, archived: false });
  assert.deepEqual(await revokeCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", shareLinkId: link.id }), { id: link.id, status: "revoked" });
  assert.deepEqual(await revokeCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", shareLinkId: link.id }), { id: link.id, status: "already_revoked" });
  await assert.rejects(() => getSharedCollectionDetail(context(repo, "recipient"), token), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["sharing.share_link_created", "sharing.share_link_revoked"]);
});

test("share-link creation obeys owner plan, requires view, forbids manage, and checks expiry", async () => {
  const repo = await memoryFixture();
  const owner = context(repo, "owner");
  await assert.rejects(() => createCollectionShareLink({ ...owner, userId: "missing" }, { collectionId: "link-col", capabilities: ["view"] }), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["manage"] }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["use_in_cycle"] }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view", "use_in_cycle"] }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view"], expiresAt: new Date(NOW.getTime() - 1).toISOString() }), (error: unknown) => error instanceof AppError && error.status === 422);
  repo.plans.set("owner", "free");
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view"] }), (error: unknown) => error instanceof AppError && error.status === 403);
  repo.plans.set("owner", "creator");
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view"], expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString() }), (error: unknown) => error instanceof AppError && error.status === 403);
  assert.equal(repo.collectionShareLinks.size, 0);
  assert.equal(repo.audit.length, 0);
});

test("owner UI lists safe link metadata only; link recipient UI exposes no management controls", async () => {
  const repo = await memoryFixture();
  const { path } = await createCollectionShareLink(context(repo, "owner"), { collectionId: "link-col", capabilities: ["view"], expiresAt: null });
  const token = path.slice("/shared/".length);
  const ownerDetail = await getCollectionDetail(context(repo, "owner"), "link-col");
  const ownerHtml = renderToStaticMarkup(CollectionDetailView({ detail: ownerDetail }));
  assert.match(ownerHtml, /Secure share links/);
  assert.match(ownerHtml, /Create one-time share link/);
  assert.ok(!ownerHtml.includes(token));
  assert.ok(!ownerHtml.includes([...repo.collectionShareLinks.values()][0]!.tokenHash));
  const recipient = await getSharedCollectionDetail(context(repo, "recipient"), token);
  const recipientHtml = renderToStaticMarkup(CollectionDetailView({ detail: recipient }));
  assert.ok(!recipientHtml.includes("People with collection access"));
  assert.ok(!recipientHtml.includes("Secure share links"));
  assert.ok(!recipientHtml.includes("Revoke link"));
});

test("fake-Prisma share-link create, edit, revoke and audit writes are atomic and expose no token hash", async () => {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "owner", email: "owner@example.test", role: "user" } });
  await db.user.create({ data: { id: "recipient", email: "recipient@example.test", role: "user" } });
  await db.subscription.create({ data: { id: "sub", userId: "owner", planId: "pro", interval: "monthly", status: "active", trialEndsAt: null, currentPeriodEnd: new Date(NOW.getTime() + 86_400_000), cancelAtPeriodEnd: false, razorpaySubscriptionId: null, lastEventAt: 0 } });
  await db.videoCollection.create({ data: { id: "col", ownerId: "owner", name: "Collection", description: null, visibility: "link", archived: false } });
  const repo = new PrismaRepository(db, () => NOW);
  const { token, tokenHash } = generateShareToken();
  const created = await repo.createCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", tokenHash, capabilities: ["view"], expiresAt: null, now: NOW });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  assert.ok(!("tokenHash" in created.link));
  assert.equal((await repo.getCollectionShareLinkByTokenHash(tokenHash))?.tokenHash, tokenHash);
  assert.equal((await repo.listCollectionShareLinksForOwner("col", "recipient")).length, 0);
  assert.equal((await repo.listCollectionShareLinksForOwner("col", "owner"))[0]?.id, "link");
  assert.ok(!JSON.stringify(await repo.listCollectionShareLinksForOwner("col", "owner")).includes(tokenHash));
  assert.ok(!JSON.stringify(await db.auditLog.findMany()).includes(tokenHash));
  assert.equal((await repo.updateCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", capabilities: ["view", "download"], expiresAt: null, now: NOW })).status, "updated");
  assert.equal(await repo.revokeCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", now: NOW }), "revoked");
  assert.equal(await repo.revokeCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", now: NOW }), "already_revoked");
  assert.deepEqual((await db.auditLog.findMany()).map((row) => row["action"]), ["sharing.share_link_created", "sharing.share_link_updated", "sharing.share_link_revoked"]);
  assert.notEqual(token, tokenHash);
});

test("fake-Prisma share-link audit failures roll back create, edit and revoke", async () => {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "owner", email: "owner@example.test", role: "user" } });
  await db.subscription.create({ data: { id: "sub", userId: "owner", planId: "pro", interval: "monthly", status: "active", trialEndsAt: null, currentPeriodEnd: new Date(NOW.getTime() + 86_400_000), cancelAtPeriodEnd: false, razorpaySubscriptionId: null, lastEventAt: 0 } });
  await db.videoCollection.create({ data: { id: "col", ownerId: "owner", name: "Collection", visibility: "link", archived: false } });
  const repo = new PrismaRepository(db, () => NOW);
  const { tokenHash } = generateShareToken();
  const originalAudit = db.auditLog.create.bind(db.auditLog);
  db.auditLog.create = async (args) => { if (String(args.data["action"]).startsWith("sharing.share_link")) throw new Error("audit injection"); return originalAudit(args); };
  await assert.rejects(() => repo.createCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", tokenHash, capabilities: ["view"], expiresAt: null, now: NOW }));
  assert.equal(await db.collectionShareLink.count(), 0);
  assert.equal(await db.auditLog.count(), 0);
  db.auditLog.create = originalAudit;
  await repo.createCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", tokenHash, capabilities: ["view"], expiresAt: null, now: NOW });
  db.auditLog.create = async (args) => { if (args.data["action"] === "sharing.share_link_updated") throw new Error("audit injection"); return originalAudit(args); };
  await assert.rejects(() => repo.updateCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", capabilities: ["view", "download"], expiresAt: null, now: NOW }));
  assert.deepEqual((await repo.listCollectionShareLinksForOwner("col", "owner"))[0]?.capabilities, ["view"]);
  db.auditLog.create = async (args) => { if (args.data["action"] === "sharing.share_link_revoked") throw new Error("audit injection"); return originalAudit(args); };
  await assert.rejects(() => repo.revokeCollectionShareLink({ id: "link", collectionId: "col", ownerId: "owner", now: NOW }));
  assert.equal((await repo.listCollectionShareLinksForOwner("col", "owner"))[0]?.revokedAt, null);
  assert.equal(await db.auditLog.count(), 1);
});

test("memory share-link audit failures roll back creation, permission changes, and revocation", async () => {
  const repo = await memoryFixture();
  const owner = context(repo, "owner");
  repo.beforeSharingAuditInsert = () => false;
  await assert.rejects(() => createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view"] }));
  assert.equal(repo.collectionShareLinks.size, 0);
  assert.equal(repo.audit.length, 0);

  repo.beforeSharingAuditInsert = null;
  const created = await createCollectionShareLink(owner, { collectionId: "link-col", capabilities: ["view"] });
  const link = [...repo.collectionShareLinks.values()][0]!;
  repo.beforeSharingAuditInsert = (entry) => entry.action !== "sharing.share_link_updated";
  await assert.rejects(() => updateCollectionShareLink(owner, { collectionId: "link-col", shareLinkId: link.id, capabilities: ["view", "download"] }));
  assert.deepEqual((await repo.getCollectionShareLinkByTokenHash(link.tokenHash))?.capabilities, ["view"]);
  assert.equal(repo.audit.length, 1);

  repo.beforeSharingAuditInsert = (entry) => entry.action !== "sharing.share_link_revoked";
  await assert.rejects(() => revokeCollectionShareLink(owner, { collectionId: "link-col", shareLinkId: link.id }));
  assert.equal((await repo.getCollectionShareLinkByTokenHash(link.tokenHash))?.revokedAt, null);
  assert.equal(repo.audit.length, 1);
  assert.ok(created.path.startsWith("/shared/"));
});
