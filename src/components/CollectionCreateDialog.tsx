"use client";

import { useEffect, useState } from "react";
import type { MediaCard } from "../server/queries.ts";
import { CollectionCreateForm } from "./CollectionCreateForm.tsx";

export function CollectionCreateDialog({ libraryChoices }: { libraryChoices: MediaCard[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = document.getElementById("collection-create-dialog") as HTMLDialogElement | null;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <>
      <button type="button" className="collection-primary-link" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> Create collection
      </button>
      <dialog
        id="collection-create-dialog"
        className="collection-dialog"
        aria-labelledby="collection-dialog-title"
        onClose={() => setOpen(false)}
      >
        <div className="collection-dialog-heading">
          <div>
            <span className="collection-eyebrow">NEW WORKSPACE</span>
            <h2 id="collection-dialog-title">Create a collection</h2>
            <p>Start with a name and add videos now or later.</p>
          </div>
          <button type="button" className="collection-dialog-cancel" onClick={() => (document.getElementById("collection-create-dialog") as HTMLDialogElement | null)?.close()}>Cancel</button>
          <button type="button" className="collection-dialog-close" aria-label="Close dialog" onClick={() => (document.getElementById("collection-create-dialog") as HTMLDialogElement | null)?.close()}>×</button>
        </div>
        <CollectionCreateForm libraryChoices={libraryChoices} />
      </dialog>
    </>
  );
}
