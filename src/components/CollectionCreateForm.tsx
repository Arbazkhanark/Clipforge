"use client";

import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { MediaCard } from "../server/queries.ts";

type VideoSetting = { mediaAssetId: string; captionText: string; coverMediaId: string | null };
const previewUrl = (id: string, variant: "thumbnail" | "preview") => `/api/media/file?id=${encodeURIComponent(id)}&variant=${variant}`;

export function CollectionCreateForm({ libraryChoices }: { libraryChoices: MediaCard[] }) {
  const videos = libraryChoices.filter((item) => item.kind === "video" && item.status === "active");
  const covers = libraryChoices.filter((item) => item.kind === "image" && item.status === "active");
  const [selected, setSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<Record<string, VideoSetting>>({});
  const [captionMode, setCaptionMode] = useState<"individual" | "shared">("individual");
  const [coverMode, setCoverMode] = useState<"individual" | "shared">("individual");
  const [sharedCaptionText, setSharedCaptionText] = useState("");
  const [sharedCoverMediaId, setSharedCoverMediaId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const needsConfirm = selected.length > 0 && (captionMode === "shared" || coverMode === "shared");
  const serialized = useMemo(() => JSON.stringify(selected.map((mediaAssetId) => settings[mediaAssetId] ?? { mediaAssetId, captionText: "", coverMediaId: null })), [selected, settings]);

  function toggleVideo(id: string, checked: boolean) {
    setSelected((current) => checked ? [...current, id] : current.filter((item) => item !== id));
    setSettings((current) => ({ ...current, [id]: current[id] ?? { mediaAssetId: id, captionText: "", coverMediaId: null } }));
    setConfirmed(false);
  }

  function updateSetting(id: string, patch: Partial<VideoSetting>) {
    setSettings((current) => ({ ...current, [id]: { ...(current[id] ?? { mediaAssetId: id, captionText: "", coverMediaId: null }), ...patch } }));
  }

  return (
    <form method="post" action="/api/forms/collection-create" className="collection-form-grid" onSubmit={(event: { preventDefault: () => void }) => { if (needsConfirm && !confirmed) { event.preventDefault(); return; } setSubmitting(true); }}>
      <label className="collection-form-field"><span>Collection name <strong>*</strong></span><input type="text" name="name" required maxLength={100} placeholder="e.g. Instagram Reels" /></label>
      <label className="collection-form-field"><span>Description</span><input type="text" name="description" maxLength={500} placeholder="What is this collection about?" /></label>
      <label className="collection-form-field"><span>Visibility</span><select name="visibility" defaultValue="private"><option value="private">Private — only you</option><option value="link">Shared by link</option><option value="public_view">Public — view only</option></select></label>

      <fieldset className="collection-create-videos">
        <legend>Add videos <span>({selected.length} selected)</span></legend>
        {videos.length === 0 ? <p className="collection-form-hint">Upload videos to your media library before adding them to a collection.</p> : <div className="collection-library-choice-list">
          {videos.map((video) => <label className="collection-library-choice" key={video.id}><input type="checkbox" checked={selected.includes(video.id)} disabled={!selected.includes(video.id) && selected.length >= 200} onChange={(event: ChangeEvent<HTMLInputElement>) => toggleVideo(video.id, event.currentTarget.checked)} /><span>{video.title}</span></label>)}
        </div>}
      </fieldset>

      {selected.length > 0 && <section className="collection-settings-builder" aria-labelledby="collection-settings-heading">
        <div><span className="collection-eyebrow">PUBLISHING DEFAULTS</span><h3 id="collection-settings-heading">Captions and covers</h3><p>These settings stay with this collection. Cycle edits are separate copies.</p></div>
        <label className="collection-form-field"><span>Caption setup</span><select name="captionMode" value={captionMode} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setCaptionMode(event.currentTarget.value as "individual" | "shared"); setConfirmed(false); }}><option value="individual">Individual captions</option><option value="shared">Same caption for all</option></select></label>
        {captionMode === "shared" ? <label className="collection-form-field"><span>Shared caption</span><textarea name="sharedCaptionText" rows={4} maxLength={2200} value={sharedCaptionText} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setSharedCaptionText(event.currentTarget.value)} /></label> : selected.map((id) => {
          const video = videos.find((item) => item.id === id);
          return <div className="collection-item-preview-setting" key={`caption-${id}`}>
            <div className="collection-item-preview-thumb">{video?.hasThumbnail ? <img src={previewUrl(id, "thumbnail")} alt={`Preview of ${video.title}`} loading="lazy" /> : <span aria-hidden="true">▶</span>}</div>
            <label className="collection-form-field"><span>Caption — {video?.title ?? id}</span><textarea rows={3} maxLength={2200} value={settings[id]?.captionText ?? ""} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateSetting(id, { captionText: event.currentTarget.value })} /></label>
          </div>;
        })}

        <label className="collection-form-field"><span>Cover setup</span><select name="coverMode" value={coverMode} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setCoverMode(event.currentTarget.value as "individual" | "shared"); setConfirmed(false); }}><option value="individual">Individual covers</option><option value="shared">Same cover for all</option></select></label>
        {coverMode === "shared" ? <label className="collection-form-field"><span>Shared cover image</span><select name="sharedCoverMediaId" value={sharedCoverMediaId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSharedCoverMediaId(event.currentTarget.value)}><option value="">No cover</option>{covers.map((cover) => <option key={cover.id} value={cover.id}>{cover.title}</option>)}</select>{sharedCoverMediaId && <img className="collection-cover-preview" src={previewUrl(sharedCoverMediaId, "preview")} alt="Selected shared cover" loading="lazy" />}</label> : selected.map((id) => <label className="collection-form-field" key={`cover-${id}`}><span>Cover — {videos.find((video) => video.id === id)?.title ?? id}</span><select value={settings[id]?.coverMediaId ?? ""} onChange={(event: ChangeEvent<HTMLSelectElement>) => updateSetting(id, { coverMediaId: event.currentTarget.value || null })}><option value="">No cover</option>{covers.map((cover) => <option key={cover.id} value={cover.id}>{cover.title}</option>)}</select>{settings[id]?.coverMediaId && <img className="collection-cover-preview" src={previewUrl(settings[id]!.coverMediaId!, "preview")} alt={`Selected cover for ${videos.find((video) => video.id === id)?.title ?? "video"}`} loading="lazy" />}</label>)}
        {covers.length === 0 && <p className="collection-form-hint">No eligible image covers yet. Upload an image to your library to choose one.</p>}
        {needsConfirm && <label className="collection-confirm-shared"><input type="checkbox" name="confirmSharedSettings" value="yes" checked={confirmed} onChange={(event: ChangeEvent<HTMLInputElement>) => setConfirmed(event.currentTarget.checked)} required /><span>Confirm applying the shared setting to {selected.length} selected video{selected.length === 1 ? "" : "s"}. Individual values remain saved and return when you switch back to individual mode.</span></label>}
      </section>}
      {selected.map((id) => <input key={id} type="hidden" name="mediaIds" value={id} />)}
      <input type="hidden" name="itemSettings" value={serialized} />
      <div className="collection-form-submit"><button type="submit" className="collection-primary-button" disabled={submitting || (needsConfirm && !confirmed)}>{submitting ? "Creating collection…" : "Create collection"}</button></div>
    </form>
  );
}
