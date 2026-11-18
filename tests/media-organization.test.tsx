import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addOwnedMediaToCollection } from "../src/server/handlers/collections.ts";
import { applyEditingTemplateToVideo } from "../src/server/handlers/editor.ts";
import { DEFAULT_EDITING_SETTINGS } from "../src/lib/domain/editing-settings.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { getMediaLibrary } from "../src/server/queries.ts";
import { MediaOrganizationActions } from "../src/components/MediaOrganizationActions.tsx";
import { MediaTable } from "../src/components/MediaTable.tsx";
import { makeMedia } from "./helpers.ts";

function context(repo: MemoryRepository, userId: string | null): RequestContext {
  let id = 0;
  return { userId, now: new Date("2026-11-16T12:00:00Z"), repo, newId: () => `generated-${++id}`, config: { coverSupport: "unknown" } };
}

test("Media Library shows saved template match and owner collection membership", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "video-a", ownerId: "ann", kind: "video", title: "A.mp4" }), { storageKey: "private/video-a", thumbnailKey: null }, 10000);
  await repo.createCollection({ id: "col-a", ownerId: "ann", name: "Launch", visibility: "private", archived: false, mediaIds: ["video-a"] });
  await repo.createTemplateIfWithinLimit({ id: "tpl-a", ownerId: "ann", name: "Reel style", settings: DEFAULT_EDITING_SETTINGS, createdAt: new Date("2026-01-01") }, 10);
  await repo.saveVideoSettings({ id: "video-settings", ownerId: "ann", name: "v:video-a", settings: DEFAULT_EDITING_SETTINGS, createdAt: new Date("2026-01-02") });
  const library = await getMediaLibrary(context(repo, "ann"), 1);
  assert.equal(library.items[0]?.matchingTemplateName, "Reel style");
  assert.deepEqual(library.items[0]?.collectionMemberships, [{ id: "col-a", name: "Launch" }]);
  assert.deepEqual(library.templates, [{ id: "tpl-a", name: "Reel style" }]);
  const controls = renderToStaticMarkup(createElement(MediaOrganizationActions, { mediaId: "video-a", isVideo: true, templates: library.templates ?? [], collections: library.collections ?? [], collectionMemberships: library.items[0]?.collectionMemberships ?? [], matchingTemplateName: library.items[0]?.matchingTemplateName ?? null, hasSavedEditorSettings: true }));
  assert.match(controls, /Settings match template: Reel style/);
  assert.match(controls, /Add to collection/);
  assert.match(controls, /Apply settings/);
  assert.match(controls, /Launch/);
  const table = renderToStaticMarkup(createElement(MediaTable, { library }));
  assert.match(table, /Template for this video/);
  assert.match(table, /Add this media to a collection/);
  assert.match(table, /Settings match template: Reel style/);
});

test("applying saved template is owner-scoped and changes only saved editor settings", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "video-a", ownerId: "ann", kind: "video", durationMs: 60000 }), { storageKey: "private/video-a", thumbnailKey: null }, 10000);
  const templateSettings = { ...DEFAULT_EDITING_SETTINGS, aspect: "1:1" as const, zoom: 1.25 };
  await repo.createTemplateIfWithinLimit({ id: "tpl-a", ownerId: "ann", name: "Square", settings: templateSettings, createdAt: context(repo, "ann").now }, 10);
  await applyEditingTemplateToVideo(context(repo, "ann"), { mediaId: "video-a", templateId: "tpl-a" });
  const saved = (await repo.listTemplatesForOwner("ann")).find((entry) => entry.name === "v:video-a");
  assert.deepEqual(saved?.settings, templateSettings);
  assert.equal((await repo.getMediaStorageInfo("video-a"))?.storageKey, "private/video-a");
  assert.equal(repo.audit.some((entry) => entry.action === "editor.template_applied" && entry.entityId === "video-a"), true);
  await assert.rejects(() => applyEditingTemplateToVideo(context(repo, "bob"), { mediaId: "video-a", templateId: "tpl-a" }));
});

test("add-to-collection is owner-scoped, append-only, audited and idempotent", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "video-a", ownerId: "ann", kind: "video" }), { storageKey: "private/video-a", thumbnailKey: null }, 10000);
  await repo.addMediaIfStorageWithin(makeMedia({ id: "video-b", ownerId: "ann", kind: "video" }), { storageKey: "private/video-b", thumbnailKey: null }, 10000);
  await repo.createCollection({ id: "col-a", ownerId: "ann", name: "Launch", visibility: "private", archived: false, mediaIds: ["video-a"] });
  const ann = context(repo, "ann");
  assert.equal((await addOwnedMediaToCollection(ann, { collectionId: "col-a", mediaAssetId: "video-b" })).status, "added");
  assert.equal((await addOwnedMediaToCollection(ann, { collectionId: "col-a", mediaAssetId: "video-b" })).status, "existing");
  assert.deepEqual((await repo.getCollection("col-a"))?.mediaIds, ["video-a", "video-b"]);
  assert.equal((await repo.getMedia("video-b"))?.status, "active");
  assert.equal(repo.audit.filter((entry) => entry.action === "collection.item_added").length, 1);
  await assert.rejects(() => addOwnedMediaToCollection(context(repo, "bob"), { collectionId: "col-a", mediaAssetId: "video-b" }));
});
