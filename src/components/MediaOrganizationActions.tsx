"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";

type Choice = { id: string; name: string };

/** Per-file, owner-scoped quick actions; saved templates update editor settings, not the source file. */
export function MediaOrganizationActions({ mediaId, isVideo, templates, collections, collectionMemberships, matchingTemplateName, hasSavedEditorSettings }: {
  mediaId: string;
  isVideo: boolean;
  templates: Choice[];
  collections: Choice[];
  collectionMemberships: Choice[];
  matchingTemplateName: string | null;
  hasSavedEditorSettings: boolean;
}) {
  const [templateId, setTemplateId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [busy, setBusy] = useState<"template" | "collection" | null>(null);
  const [message, setMessage] = useState("");
  const [memberships, setMemberships] = useState(collectionMemberships);
  const [currentTemplateName, setCurrentTemplateName] = useState(matchingTemplateName);
  const [hasSettings, setHasSettings] = useState(hasSavedEditorSettings);

  async function applyTemplate() {
    if (!templateId || busy) return;
    if (hasSettings && !window.confirm("Replace this video's saved editor settings with the selected template? The original media file will not change.")) return;
    setBusy("template"); setMessage("");
    try {
      const response = await fetch("/api/media/template/apply", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId, templateId }) });
      if (!response.ok) throw new Error("template");
      const choice = templates.find((item) => item.id === templateId);
      setCurrentTemplateName(choice?.name ?? null); setHasSettings(true);
      setMessage(choice ? `Saved ${choice.name} settings. The original file is unchanged.` : "Template settings saved. The original file is unchanged.");
      setTemplateId("");
    } catch { setMessage("Could not apply the template. Refresh and try again."); }
    finally { setBusy(null); }
  }

  async function addToCollection() {
    if (!collectionId || busy) return;
    setBusy("collection"); setMessage("");
    try {
      const response = await fetch("/api/collections/add-item", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collectionId, mediaAssetId: mediaId }) });
      if (!response.ok) throw new Error("collection");
      const choice = collections.find((item) => item.id === collectionId);
      if (choice) setMemberships((current) => current.some((item) => item.id === choice.id) ? current : [...current, choice]);
      setMessage(choice ? `Added to ${choice.name}.` : "Added to collection.");
      setCollectionId("");
    } catch { setMessage("Could not add this file to the collection. Refresh and try again."); }
    finally { setBusy(null); }
  }

  if (!isVideo) return <div className="media-organization-actions"><div className="media-organization-current"><span>{memberships.length ? `In: ${memberships.map((item) => item.name).join(", ")}` : "Not in a collection"}</span></div><span className="media-organization-message" role="status" aria-live="polite">{message}</span></div>;
  return <div className="media-organization-actions">
    <div className="media-organization-current" aria-label="Current organization">
      <span>{currentTemplateName ? `Settings match template: ${currentTemplateName}` : hasSettings ? "Custom editor settings saved" : "No template settings saved"}</span>
      {memberships.length ? <span>In: {memberships.map((item) => item.name).join(", ")}</span> : <span>Not in a collection</span>}
    </div>
    {templates.length > 0 && <div className="media-organization-control">
      <label className="media-visually-hidden" htmlFor={`template-${mediaId}`}>Template for this video</label>
      <select id={`template-${mediaId}`} value={templateId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setTemplateId(event.currentTarget.value)} disabled={busy !== null}>
        <option value="">Choose template…</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button type="button" onClick={() => void applyTemplate()} disabled={!templateId || busy !== null}>{busy === "template" ? "Applying…" : "Apply settings"}</button>
    </div>}
    {collections.length > 0 && <div className="media-organization-control">
      <label className="media-visually-hidden" htmlFor={`collection-${mediaId}`}>Add this media to a collection</label>
      <select id={`collection-${mediaId}`} value={collectionId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setCollectionId(event.currentTarget.value)} disabled={busy !== null}>
        <option value="">Add to collection…</option>{collections.filter((item) => !memberships.some((member) => member.id === item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button type="button" onClick={() => void addToCollection()} disabled={!collectionId || busy !== null}>{busy === "collection" ? "Adding…" : "Add"}</button>
    </div>}
    {templates.length === 0 && <p className="media-organization-hint">No templates yet. Upload videos normally, then open a video in the editor to save reusable settings.</p>}
    <span className="media-organization-message" role="status" aria-live="polite">{message}</span>
  </div>;
}
