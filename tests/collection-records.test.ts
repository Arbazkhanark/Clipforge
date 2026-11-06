import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollection, replaceCollectionMedia, updateCollection } from "../src/server/handlers/collections.ts";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { makeMedia } from "./helpers.ts";

function context(repo: MemoryRepository, userId: string): RequestContext {
  let n = 0;
  return { userId, now: new Date("2026-11-06T12:00:00Z"), repo, newId: () => `col-${++n}`, config: { coverSupport: "unknown" } };
}

test("collection writes use the signed-in user and hide someone else's collection", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "mine", ownerId: "ann", title: "Mine" }), { storageKey: "k/mine", thumbnailKey: null }, 1000);
  await repo.addMediaIfStorageWithin(makeMedia({ id: "theirs", ownerId: "bob", title: "Theirs" }), { storageKey: "k/theirs", thumbnailKey: null }, 1000);
  const ann = context(repo, "ann");
  const created = await createCollection(ann, { name: "Campaign", description: "Notes", visibility: "private", mediaIds: ["mine"] });
  assert.equal(created.collectionId, "col-1");
  assert.equal((await repo.getCollection("col-1"))?.ownerId, "ann");
  await assert.rejects(() => createCollection(ann, { name: "Nope", visibility: "private", mediaIds: ["theirs"] }), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => updateCollection(context(repo, "bob"), { collectionId: "col-1", name: "Stolen", visibility: "public_view", archived: false }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.equal((await repo.getCollection("col-1"))?.name, "Campaign");
  await updateCollection(ann, { collectionId: "col-1", name: "Renamed", description: "", visibility: "link", archived: true });
  const renamed = await repo.getCollection("col-1");
  assert.equal(renamed?.name, "Renamed");
  assert.equal(renamed?.archived, true);
  assert.equal(renamed?.visibility, "link");
  await replaceCollectionMedia(ann, { collectionId: "col-1", mediaIds: [] });
  assert.deepEqual((await repo.getCollection("col-1"))?.mediaIds, []);
  await assert.rejects(() => replaceCollectionMedia(ann, { collectionId: "col-1", mediaIds: ["mine", "mine"] }), (error: unknown) => error instanceof AppError && error.status === 422);
  assert.deepEqual((await repo.getCollection("col-1"))?.mediaIds, []);
});
