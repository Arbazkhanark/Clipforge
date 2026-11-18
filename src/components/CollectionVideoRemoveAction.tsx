"use client";

import { useEffect, useRef, useState } from "react";

type Props = { collectionId: string; collectionName: string; mediaAssetId: string; mediaTitle: string };

export type CollectionRemovalUiState = { status: "idle" | "confirming" | "loading" | "success" | "error"; message?: string };
export type CollectionRemovalUiAction = { type: "confirm" | "cancel" | "start" | "success" } | { type: "failure"; message: string };
export function collectionRemovalUiReducer(state: CollectionRemovalUiState, action: CollectionRemovalUiAction): CollectionRemovalUiState {
  if (action.type === "confirm" && state.status === "idle") return { status: "confirming" };
  if (action.type === "cancel" && (state.status === "confirming" || state.status === "error")) return { status: "idle" };
  if (action.type === "start" && (state.status === "confirming" || state.status === "error")) return { status: "loading" };
  if (action.type === "success" && state.status === "loading") return { status: "success" };
  if (action.type === "failure" && state.status === "loading") return { status: "error", message: action.message };
  return state;
}

export function CollectionVideoRemoveAction({ collectionId, collectionName, mediaAssetId, mediaTitle }: Props) {
  const [state, setState] = useState<CollectionRemovalUiState>({ status: "idle" });
  const dispatch = (action: CollectionRemovalUiAction) => setState((current) => collectionRemovalUiReducer(current, action));
  const open = state.status === "confirming" || state.status === "loading" || state.status === "error";
  const busy = state.status === "loading";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousStatus = useRef<CollectionRemovalUiState["status"]>("idle");

  useEffect(() => {
    if (state.status === "confirming" || state.status === "error") confirmRef.current?.focus();
    else if (state.status === "idle" && previousStatus.current !== "idle") triggerRef.current?.focus();
    previousStatus.current = state.status;
  }, [state.status]);

  async function remove() {
    if (busy) return;
    if (!open || state.status === "loading") return;
    dispatch({ type: "start" });
    try {
      const response = await fetch("/api/collections/remove-item", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId, mediaAssetId }),
      });
      const result = await response.json() as { status?: unknown; error?: { message?: unknown } };
      if (!response.ok) throw new Error(typeof result.error?.message === "string" ? result.error.message : "The video could not be removed. Try again.");
      if (result.status !== "removed" && result.status !== "already_absent") throw new Error("The video could not be removed. Refresh the collection and try again.");
      dispatch({ type: "success" });
      window.setTimeout(() => window.location.reload(), 650);
    } catch (cause) {
      dispatch({ type: "failure", message: cause instanceof Error ? cause.message : "The video could not be removed. Try again." });
    }
  }

  return (
    <div className="collection-remove-action">
      {state.status === "success" ? (
        <p className="collection-remove-success" role="status">Removed from collection.</p>
      ) : (
        <button ref={triggerRef} type="button" className="collection-remove-trigger" onClick={() => dispatch({ type: "confirm" })}>
          Remove from collection
        </button>
      )}
      {open && (
        <div className="collection-remove-backdrop" onMouseDown={(event: { target: EventTarget | null; currentTarget: HTMLDivElement }) => { if (event.target === event.currentTarget && !busy) dispatch({ type: "cancel" }); }}>
          <section
            className="collection-remove-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`remove-title-${mediaAssetId}`}
            aria-describedby={`remove-description-${mediaAssetId}`}
            onKeyDown={(event: { key: string; shiftKey: boolean; preventDefault(): void; currentTarget: HTMLElement }) => {
              if (event.key === "Escape" && !busy) { dispatch({ type: "cancel" }); return; }
              if (event.key !== "Tab") return;
              const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
              const first = controls[0]; const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}
          >
            <h2 id={`remove-title-${mediaAssetId}`}>Remove video from collection?</h2>
            <p><strong>{mediaTitle}</strong> will be removed from <strong>{collectionName}</strong>.</p>
            <p id={`remove-description-${mediaAssetId}`}>The original stays in the owner’s Media Library. Files, previews, and copies in other collections are not deleted.</p>
            {state.status === "error" && <p className="collection-remove-error" role="alert">{state.message}</p>}
            <div className="collection-remove-dialog-actions">
              <button type="button" className="collection-secondary-button" onClick={() => dispatch({ type: "cancel" })} disabled={busy}>Cancel</button>
              <button ref={confirmRef} type="button" className="collection-danger-button" onClick={() => void remove()} disabled={busy}>
                {busy ? "Removing…" : "Remove from collection"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
