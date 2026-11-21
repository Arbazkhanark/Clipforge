"use client";
// Selection and organization actions apply only to video checkboxes on this page.
import { useEffect, useState } from "react";

export function MediaSelection({ formId, collections = [] }: { formId: string; collections?: { id: string; name: string }[] }) {
  const [collectionId, setCollectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const boxes = () => [...form.querySelectorAll('input[name="media"]')] as HTMLInputElement[];
    const update = () => { const node = form.querySelector("[data-selected-count]"); if (node) node.textContent = String(boxes().filter((box) => box.checked).length); };
    const onClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset["select"] === "all") boxes().forEach((box) => { box.checked = true; });
      if (target.dataset["select"] === "clear") boxes().forEach((box) => { box.checked = false; });
      update();
    };
    form.addEventListener("change", update);
    form.addEventListener("click", onClick);
    update();
    return () => { form.removeEventListener("change", update); form.removeEventListener("click", onClick); };
  }, [formId]);

  async function addSelectedToCollection() {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement) || !collectionId || busy) return;
    const ids = [...form.querySelectorAll<HTMLInputElement>('input[name="media"]:checked')].map((input) => input.value);
    if (ids.length === 0) { setMessage("Select at least one video first."); return; }
    setBusy(true); setMessage(`Adding ${ids.length} video${ids.length === 1 ? "" : "s"}…`);
    let added = 0; let failed = 0;
    for (const mediaAssetId of ids) {
      try {
        const response = await fetch("/api/collections/add-item", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ collectionId, mediaAssetId }) });
        if (!response.ok) throw new Error("add failed");
        added += 1;
      } catch { failed += 1; }
    }
    setBusy(false);
    setMessage(`${added} added or already present${failed ? ` · ${failed} could not be added` : ""}.`);
    if (added > 0) window.setTimeout(() => window.location.reload(), 450);
  }
  return (
    <div className="library-actions">
      <button type="button" data-select="all">Select all on this page</button>
      <button type="button" data-select="clear">Clear selection</button>
      <p><strong data-selected-count>0</strong> selected on this page</p>
      <button type="submit">Bulk edit</button>
      <p className="muted">Select all applies only to the videos on this page, not to every filtered result.</p>
      <div className="media-bulk-collection" aria-label="Add selected videos to a collection">
        {collections.length > 0 ? <>
          <label htmlFor={`${formId}-collection`}>Add selected videos to</label>
          <select id={`${formId}-collection`} value={collectionId} onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setCollectionId(event.currentTarget.value)}>
            <option value="">Choose a collection</option>
            {collections.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}
          </select>
          <button type="button" onClick={addSelectedToCollection} disabled={busy || !collectionId}>{busy ? "Adding…" : "Add selected"}</button>
        </> : <a href="/collections#new-collection-heading">Create your first collection</a>}
        {message && <p role="status" aria-live="polite">{message}</p>}
      </div>
    </div>
  );
}
