"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";
import type { CollectionDetail, MediaCard } from "../server/queries.ts";

const previewUrl = (id: string, variant: "thumbnail" | "preview") => `/api/media/file?id=${encodeURIComponent(id)}&variant=${variant}`;

export function CollectionCaptionCoverEditor({ detail }: { detail: CollectionDetail }) {
  const [captionMode, setCaptionMode] = useState(detail.captionMode);
  const [coverMode, setCoverMode] = useState(detail.coverMode);
  const [sharedCaptionText, setSharedCaptionText] = useState(detail.sharedCaptionText);
  const [sharedCoverMediaId, setSharedCoverMediaId] = useState(detail.sharedCoverMediaId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [itemSubmitting, setItemSubmitting] = useState<string | null>(null);
  const [itemCoverSelections, setItemCoverSelections] = useState<Record<string, string>>(() => Object.fromEntries(detail.itemSettings.map((item) => [item.mediaAssetId, item.coverMediaId ?? ""])));
  const initialSharedCover = detail.sharedCoverMediaId ?? "";
  const needsConfirmation = (captionMode === "shared" && (detail.captionMode !== "shared" || sharedCaptionText !== detail.sharedCaptionText))
    || (coverMode === "shared" && (detail.coverMode !== "shared" || sharedCoverMediaId !== initialSharedCover));
  const titleById = new Map(detail.videos.map((video) => [video.id, video.title]));

  function updateCaptionMode(event: ChangeEvent<HTMLSelectElement>) { setCaptionMode(event.currentTarget.value as "individual" | "shared"); setConfirmed(false); }
  function updateCoverMode(event: ChangeEvent<HTMLSelectElement>) { setCoverMode(event.currentTarget.value as "individual" | "shared"); setConfirmed(false); }
  function updateSharedCaption(event: ChangeEvent<HTMLTextAreaElement>) { setSharedCaptionText(event.currentTarget.value); setConfirmed(false); }
  function updateSharedCover(event: ChangeEvent<HTMLSelectElement>) { setSharedCoverMediaId(event.currentTarget.value); setConfirmed(false); }
  function submitBulk(event: { preventDefault: () => void }) {
    if (needsConfirmation && !confirmed) { event.preventDefault(); return; }
    setBulkSubmitting(true);
  }

  return (
    <section className="collection-panel collection-caption-cover-panel" aria-labelledby="collection-caption-cover-heading">
      <div className="collection-section-heading">
        <div><span className="collection-eyebrow">PUBLISHING SETTINGS</span><h2 id="collection-caption-cover-heading">Captions and covers</h2><p>Collection defaults are copied into a cycle. Cycle changes never edit these saved settings.</p></div>
        <span className="collection-count">{detail.itemSettings.length}</span>
      </div>
      <form method="post" action="/api/forms/collection-shared-settings" className="collection-shared-settings-form" onSubmit={submitBulk}>
        <input type="hidden" name="collectionId" value={detail.collection.id} />
        <input type="hidden" name="expectedVersion" value={detail.settingsVersion} />
        <label className="collection-form-field"><span>Caption mode</span><select name="captionMode" value={captionMode} onChange={updateCaptionMode}><option value="individual">Individual captions</option><option value="shared">Same caption for all</option></select></label>
        {captionMode === "shared" ? <label className="collection-form-field"><span>Shared caption</span><textarea name="sharedCaptionText" rows={4} maxLength={2200} value={sharedCaptionText} onChange={updateSharedCaption} /></label> : <input type="hidden" name="sharedCaptionText" value={sharedCaptionText} />}
        <label className="collection-form-field"><span>Cover mode</span><select name="coverMode" value={coverMode} onChange={updateCoverMode}><option value="individual">Individual covers</option><option value="shared">Same cover for all</option></select></label>
        {coverMode === "shared" ? <label className="collection-form-field"><span>Shared cover image</span><select name="sharedCoverMediaId" value={sharedCoverMediaId} onChange={updateSharedCover}><option value="">No cover</option>{detail.coverChoices.map((cover) => <option key={cover.id} value={cover.id}>{cover.title}</option>)}</select>{sharedCoverMediaId && <img className="collection-cover-preview" src={previewUrl(sharedCoverMediaId, "preview")} alt="Selected shared cover" loading="lazy" />}</label> : <input type="hidden" name="sharedCoverMediaId" value={sharedCoverMediaId} />}
        {detail.coverChoices.length === 0 && <p className="collection-form-hint">No eligible image covers yet. Upload an image to your library to choose one.</p>}
        {needsConfirmation && <label className="collection-confirm-shared"><input type="checkbox" name="confirmSharedSettings" value="yes" checked={confirmed} onChange={(event: ChangeEvent<HTMLInputElement>) => setConfirmed(event.currentTarget.checked)} required /><span>Confirm changing the saved caption/cover behavior for all {detail.itemSettings.length} video{detail.itemSettings.length === 1 ? "" : "s"}. Individual values stay saved and return when individual mode is selected.</span></label>}
        <button type="submit" className="collection-primary-button" disabled={bulkSubmitting || (needsConfirmation && !confirmed)}>{bulkSubmitting ? "Saving collection settings…" : "Save collection defaults"}</button>
      </form>
      {detail.itemSettings.length === 0 ? <div className="collection-empty-state"><h3>Add videos to configure settings</h3><p>Add collection videos first, then set individual or shared captions and covers.</p></div> : <div className="collection-item-settings-list">
        {detail.itemSettings.map((item) => <form key={item.mediaAssetId} method="post" action="/api/forms/collection-item-settings" className="collection-item-settings-card" onSubmit={() => setItemSubmitting(item.mediaAssetId)}>
          <input type="hidden" name="collectionId" value={detail.collection.id} /><input type="hidden" name="mediaAssetId" value={item.mediaAssetId} /><input type="hidden" name="expectedVersion" value={item.version} />
          <div className="collection-item-preview-setting"><div className="collection-item-preview-thumb">{detail.videos.find((video) => video.id === item.mediaAssetId)?.hasThumbnail ? <img src={previewUrl(item.mediaAssetId, "thumbnail")} alt={`Preview of ${titleById.get(item.mediaAssetId) ?? "collection video"}`} loading="lazy" /> : <span aria-hidden="true">▶</span>}</div><div><span className="collection-eyebrow">INDIVIDUAL SETTINGS</span><h3>{titleById.get(item.mediaAssetId) ?? "Collection video"}</h3></div></div>
          <p className="collection-setting-source">Used for new cycle items: caption <strong>{detail.captionMode === "shared" ? "shared" : "individual"}</strong>; cover <strong>{detail.coverMode === "shared" ? "shared" : "individual"}</strong>. Individual values remain saved while shared mode is active.</p>
          <label className="collection-form-field"><span>Caption</span><textarea name="captionText" rows={3} maxLength={2200} defaultValue={item.captionText} /></label>
          <label className="collection-form-field"><span>Cover image</span><select name="coverMediaId" value={itemCoverSelections[item.mediaAssetId] ?? item.coverMediaId ?? ""} onChange={(event: ChangeEvent<HTMLSelectElement>) => { const value = event.currentTarget.value; setItemCoverSelections((current) => ({ ...current, [item.mediaAssetId]: value })); }}><option value="">No cover</option>{detail.coverChoices.map((cover) => <option key={cover.id} value={cover.id}>{cover.title}</option>)}</select>{itemCoverSelections[item.mediaAssetId] && <img className="collection-cover-preview" src={previewUrl(itemCoverSelections[item.mediaAssetId]!, "preview")} alt={`Selected cover for ${titleById.get(item.mediaAssetId) ?? "video"}`} loading="lazy" />}</label>
          <p className="collection-form-hint">This individual value remains saved while a shared default is active.</p>
          <button type="submit" className="collection-secondary-button" disabled={itemSubmitting === item.mediaAssetId}>{itemSubmitting === item.mediaAssetId ? "Saving…" : "Save this video’s settings"}</button>
        </form>)}
      </div>}
    </section>
  );
}
