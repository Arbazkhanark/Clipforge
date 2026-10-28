import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCollectionCapabilities, canAddVideoToCycle, canImportVideo, canDownloadVideo, canKeepUsingSourceForCycleItem,
  generateShareToken, validateShareLink, canCreateAccessRequest, decideAccessRequest, revokeGrant,
} from "../src/lib/domain/sharing-permissions.ts";
import { NOW, inDays, makeMedia, makeCollection, makeGrant, makeItem } from "./helpers.ts";

test("owner can do everything with their own collection", () => {
  const caps = getCollectionCapabilities("owner", makeCollection(), [], NOW);
  for (const c of ["view", "use_in_cycle", "import_copy", "download", "manage"] as const) assert.ok(caps.has(c), c);
});

test("private collection: strangers get nothing", () => {
  assert.equal(getCollectionCapabilities("eve", makeCollection(), [], NOW).size, 0);
});

test("public view lets anyone look but NOT use, import or download", () => {
  const caps = getCollectionCapabilities("eve", makeCollection({ visibility: "public_view" }), [], NOW);
  assert.deepEqual([...caps], ["view"]);
  const d = canAddVideoToCycle("eve", makeMedia(), makeCollection({ visibility: "public_view" }), [], NOW);
  assert.equal(d.allowed, false);
});

test("a grant gives exactly its capabilities, and only to the grantee", () => {
  const grants = [makeGrant()];
  assert.ok(getCollectionCapabilities("bob", makeCollection(), grants, NOW).has("use_in_cycle"));
  assert.equal(getCollectionCapabilities("bob", makeCollection(), grants, NOW).has("download"), false);
  assert.equal(getCollectionCapabilities("carol", makeCollection(), grants, NOW).size, 0);
});

test("revoked and expired grants stop working", () => {
  assert.equal(getCollectionCapabilities("bob", makeCollection(), [makeGrant({ status: "revoked" })], NOW).size, 0);
  assert.equal(getCollectionCapabilities("bob", makeCollection(), [makeGrant({ expiresAt: new Date(NOW.getTime() - 1) })], NOW).size, 0);
  assert.ok(getCollectionCapabilities("bob", makeCollection(), [makeGrant({ expiresAt: inDays(1) })], NOW).size > 0);
});

test("a grant on a different collection does not leak", () => {
  assert.equal(getCollectionCapabilities("bob", makeCollection(), [makeGrant({ collectionId: "other" })], NOW).size, 0);
});

test("archived collections cannot be newly used/imported/downloaded by recipients", () => {
  const caps = getCollectionCapabilities("bob", makeCollection({ archived: true }), [makeGrant({ capabilities: ["view", "use_in_cycle", "import_copy", "download"] })], NOW);
  assert.deepEqual([...caps], ["view"]);
});

test("canAddVideoToCycle: owner, permitted recipient, unauthorised recipient", () => {
  assert.equal(canAddVideoToCycle("owner", makeMedia(), makeCollection(), [], NOW).allowed, true);
  assert.equal(canAddVideoToCycle("bob", makeMedia(), makeCollection(), [makeGrant()], NOW).allowed, true);
  assert.equal(canAddVideoToCycle("bob", makeMedia(), makeCollection(), [makeGrant({ capabilities: ["view"] })], NOW).allowed, false);
  assert.equal(canAddVideoToCycle("eve", makeMedia(), makeCollection(), [], NOW).allowed, false);
});

test("video not in the collection, deleted, or pending deletion cannot be newly added", () => {
  assert.equal(canAddVideoToCycle("bob", makeMedia({ id: "other" }), makeCollection(), [makeGrant()], NOW).allowed, false);
  assert.equal(canAddVideoToCycle("bob", makeMedia({ status: "deleted" }), makeCollection(), [makeGrant()], NOW).allowed, false);
  assert.equal(canAddVideoToCycle("bob", makeMedia({ status: "pending_deletion", deleteAfter: inDays(3) }), makeCollection(), [makeGrant()], NOW).allowed, false);
});

test("import: needs import_copy; allowed during grace; denied after grace; owner cannot import own", () => {
  const grants = [makeGrant({ capabilities: ["view", "import_copy"] })];
  assert.equal(canImportVideo("bob", makeMedia(), makeCollection(), grants, NOW).allowed, true);
  assert.equal(canImportVideo("bob", makeMedia(), makeCollection(), [makeGrant()], NOW).allowed, false);
  assert.equal(canImportVideo("bob", makeMedia({ status: "pending_deletion", deleteAfter: inDays(2) }), makeCollection(), grants, NOW).allowed, true);
  assert.equal(canImportVideo("bob", makeMedia({ status: "pending_deletion", deleteAfter: inDays(-1) }), makeCollection(), grants, NOW).allowed, false);
  assert.equal(canImportVideo("owner", makeMedia(), makeCollection(), grants, NOW).allowed, false);
});

test("download is only allowed when explicitly granted", () => {
  assert.equal(canDownloadVideo("bob", makeMedia(), makeCollection(), [makeGrant()], NOW).allowed, false);
  assert.equal(canDownloadVideo("bob", makeMedia(), makeCollection(), [makeGrant({ capabilities: ["view", "download"] })], NOW).allowed, true);
});

test("recheck for an item already in a cycle: valid, revoked, removed from collection, source gone", () => {
  const item = makeItem();
  const check = (over: { media?: ReturnType<typeof makeMedia> | null; col?: ReturnType<typeof makeCollection> | null; grants?: ReturnType<typeof makeGrant>[] }) =>
    canKeepUsingSourceForCycleItem(item, over.media === undefined ? makeMedia() : over.media, over.col === undefined ? makeCollection() : over.col, over.grants ?? [makeGrant()], NOW);
  assert.equal(check({}).allowed, true);
  assert.equal(check({ grants: [makeGrant({ status: "revoked" })] }).allowed, false);
  assert.equal(check({ col: makeCollection({ mediaIds: [] }) }).allowed, false);
  assert.equal(check({ media: null }).allowed, false);
  assert.equal(check({ media: makeMedia({ status: "deleted" }) }).allowed, false);
});

test("an item may keep using a video during the grace period, but not after", () => {
  const item = makeItem();
  const during = makeMedia({ status: "pending_deletion", deleteAfter: inDays(2) });
  const after = makeMedia({ status: "pending_deletion", deleteAfter: inDays(-1) });
  assert.equal(canKeepUsingSourceForCycleItem(item, during, makeCollection(), [makeGrant()], NOW).allowed, true);
  assert.equal(canKeepUsingSourceForCycleItem(item, after, makeCollection(), [makeGrant()], NOW).allowed, false);
});

test("owned and imported items only need their media to exist", () => {
  const ownMedia = makeMedia({ ownerId: "bob" });
  assert.equal(canKeepUsingSourceForCycleItem(makeItem({ sourceKind: "imported_copy", sourceCollectionId: null }), ownMedia, null, [], NOW).allowed, true);
});

test("share link: valid, wrong token, revoked, expired; stores only a hash", () => {
  const { token, tokenHash } = generateShareToken();
  assert.notEqual(token, tokenHash);
  assert.ok(token.length >= 40);
  assert.notEqual(generateShareToken().token, token);
  assert.equal(validateShareLink({ tokenHash, revoked: false, expiresAt: null }, token, NOW).allowed, true);
  assert.equal(validateShareLink({ tokenHash, revoked: false, expiresAt: null }, token + "x", NOW).allowed, false);
  assert.equal(validateShareLink({ tokenHash, revoked: true, expiresAt: null }, token, NOW).allowed, false);
  assert.equal(validateShareLink({ tokenHash, revoked: false, expiresAt: inDays(-1) }, token, NOW).allowed, false);
});

test("access requests: no duplicates, owner-only decisions, approval creates grant, rejection does not", () => {
  const col = makeCollection();
  const pending = { collectionId: "col1", requesterId: "bob", requestedCapabilities: ["view", "use_in_cycle"] as const, status: "pending" as const };
  const req = { ...pending, requestedCapabilities: [...pending.requestedCapabilities] };
  assert.equal(canCreateAccessRequest("bob", col, [req]).allowed, false);
  assert.equal(canCreateAccessRequest("carol", col, [req]).allowed, true);
  assert.equal(canCreateAccessRequest("owner", col, []).allowed, false);

  const notOwner = decideAccessRequest("eve", col, req, "approved");
  assert.equal(notOwner.ok, false);
  const approved = decideAccessRequest("owner", col, req, "approved");
  assert.ok(approved.ok && approved.newGrant?.granteeId === "bob" && approved.request.status === "approved");
  const rejected = decideAccessRequest("owner", col, req, "rejected");
  assert.ok(rejected.ok && rejected.newGrant === null && rejected.request.status === "rejected");
  // Cannot decide twice.
  assert.equal(decideAccessRequest("owner", col, { ...req, status: "approved" }, "rejected").ok, false);
  // Can grant fewer rights than requested.
  const narrower = decideAccessRequest("owner", col, req, "approved", ["view"]);
  assert.ok(narrower.ok && narrower.newGrant?.capabilities.join() === "view");
});

test("only the owner can revoke; revoking blocks access immediately", () => {
  const col = makeCollection(); const grant = makeGrant();
  assert.equal(revokeGrant("bob", col, grant).ok, false);
  const result = revokeGrant("owner", col, grant);
  assert.ok(result.ok);
  if (result.ok) assert.equal(getCollectionCapabilities("bob", col, [result.grant], NOW).size, 0);
});
