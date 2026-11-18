"use client";

import { useEffect, useRef, useState } from "react";

type Props = { mediaId: string; mediaTitle: string; status: "active" | "pending_deletion" | "deleted" };
type CollectionRef = { id: string; name: string };
type Preview = { mediaId: string; title: string; collections: CollectionRef[] };
export type MediaDeleteUiState = { status: "idle" | "preview_loading" | "confirming" | "loading" | "error" | "queued"; message?: string };
export type MediaDeleteUiAction = { type: "begin_preview" | "cancel" | "start" } | { type: "preview_loaded" } | { type: "queued"; message: string } | { type: "failure"; message: string };

export function mediaDeleteUiReducer(state: MediaDeleteUiState, action: MediaDeleteUiAction): MediaDeleteUiState {
  if (action.type === "begin_preview" && (state.status === "idle" || state.status === "error")) return { status: "preview_loading" };
  if (action.type === "preview_loaded" && state.status === "preview_loading") return { status: "confirming" };
  if (action.type === "cancel" && ["preview_loading", "confirming", "error"].includes(state.status)) return { status: "idle" };
  if (action.type === "start" && (state.status === "confirming" || state.status === "error")) return { status: "loading" };
  if (action.type === "queued" && state.status === "loading") return { status: "queued", message: action.message };
  if (action.type === "failure" && ["preview_loading", "loading"].includes(state.status)) return { status: "error", message: action.message };
  return state;
}

function responseError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return fallback;
}

export function MediaDeleteAction({ mediaId, mediaTitle, status }: Props) {
  const [state, setState] = useState<MediaDeleteUiState>({ status: "idle" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const dispatch = (action: MediaDeleteUiAction) => setState((current) => mediaDeleteUiReducer(current, action));
  const open = ["preview_loading", "confirming", "loading", "error"].includes(state.status);
  const busy = state.status === "loading" || state.status === "preview_loading";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const requestInFlight = useRef(false);
  const previousStatus = useRef<MediaDeleteUiState["status"]>("idle");

  useEffect(() => {
    if (state.status === "confirming" || state.status === "error") confirmRef.current?.focus();
    else if (state.status === "idle" && previousStatus.current !== "idle") triggerRef.current?.focus();
    previousStatus.current = state.status;
  }, [state.status]);

  async function loadPreview() {
    if (requestInFlight.current || state.status === "preview_loading" || state.status === "loading") return;
    requestInFlight.current = true;
    setPreview(null);
    dispatch({ type: "begin_preview" });
    try {
      const response = await fetch(`/api/media/delete?mediaId=${encodeURIComponent(mediaId)}`, { method: "GET", credentials: "same-origin", cache: "no-store" });
      let body: unknown = null; try { body = await response.json(); } catch { /* Generic fallback below. */ }
      if (!response.ok) throw new Error(responseError(body, "The affected collections could not be checked."));
      if (typeof body !== "object" || body === null) throw new Error("The affected collections could not be verified.");
      const value = body as Partial<Preview>;
      if (value.mediaId !== mediaId || typeof value.title !== "string" || !Array.isArray(value.collections) || value.collections.some((item) => typeof item !== "object" || item === null || typeof item.id !== "string" || typeof item.name !== "string")) throw new Error("The affected collections could not be verified.");
      setPreview({ mediaId, title: value.title, collections: value.collections as CollectionRef[] });
      dispatch({ type: "preview_loaded" });
    } catch (cause) {
      dispatch({ type: "failure", message: cause instanceof Error ? cause.message : "The affected collections could not be checked." });
    } finally { requestInFlight.current = false; }
  }

  async function permanentlyDelete() {
    if (requestInFlight.current || !preview || (state.status !== "confirming" && state.status !== "error")) return;
    requestInFlight.current = true;
    dispatch({ type: "start" });
    try {
      const response = await fetch("/api/media/delete", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId, confirm: true, expectedCollectionIds: preview.collections.map((collection) => collection.id) }),
      });
      let body: unknown = null; try { body = await response.json(); } catch { /* Generic fallback below. */ }
      if (!response.ok) throw new Error(responseError(body, "Permanent deletion could not be queued. Refresh and try again."));
      const result = body as { mediaId?: unknown; jobId?: unknown; status?: unknown };
      if (result.mediaId !== mediaId || typeof result.jobId !== "string" || !["queued", "existing"].includes(String(result.status))) throw new Error("The deletion request could not be verified. Refresh the library before retrying.");
      dispatch({ type: "queued", message: `Deletion queued. The media has been removed from ${preview.collections.length === 1 ? "this collection" : `${preview.collections.length} collections`}; private storage cleanup is pending.` });
      window.setTimeout(() => window.location.reload(), 1600);
    } catch (cause) {
      dispatch({ type: "failure", message: cause instanceof Error ? cause.message : "Permanent deletion could not be queued. Refresh and try again." });
    } finally { requestInFlight.current = false; }
  }

  if (status === "deleted") return null;
  if (state.status === "queued") return <p className="media-delete-status" role="status">{state.message}</p>;

  return (
    <div className="media-delete-action" data-media-delete-id={mediaId}>
      {status === "pending_deletion" && <p className="media-delete-status">Already scheduled. You can permanently delete it now.</p>}
      <button ref={triggerRef} type="button" className="media-delete-trigger" onClick={() => void loadPreview()}>
        Delete permanently
      </button>
      {open && (
        <div className="media-delete-backdrop" onMouseDown={(event: { target: EventTarget | null; currentTarget: HTMLDivElement }) => { if (event.target === event.currentTarget && !busy) dispatch({ type: "cancel" }); }}>
          <section
            className="media-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`media-delete-title-${mediaId}`}
            aria-describedby={`media-delete-description-${mediaId}`}
            onKeyDown={(event: { key: string; shiftKey: boolean; preventDefault(): void; currentTarget: HTMLElement }) => {
              if (event.key === "Escape" && !busy) { dispatch({ type: "cancel" }); return; }
              if (event.key !== "Tab") return;
              const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
              const first = controls[0]; const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}
          >
            <h2 id={`media-delete-title-${mediaId}`}>Permanently delete this media?</h2>
            <p><strong>{mediaTitle}</strong></p>
            <p id={`media-delete-description-${mediaId}`}>The original and its preview will be permanently removed from private storage. Collection links will also be removed. This cannot be undone. Published cycle history is retained, and deletion waits if an active cycle, render, import, or cover still depends on this media.</p>
            {state.status === "preview_loading" && <p role="status">Checking collection usage…</p>}
            {preview && state.status !== "preview_loading" && (
              <div className="media-delete-collections" aria-label="Collections affected by deletion">
                <strong>{preview.collections.length ? `Also removed from ${preview.collections.length === 1 ? "collection" : "collections"}:` : "This media is not in a collection."}</strong>
                {preview.collections.length > 0 && <ul>{preview.collections.map((collection) => <li key={collection.id}>{collection.name}</li>)}</ul>}
              </div>
            )}
            {state.status === "error" && <p className="media-delete-error" role="alert">{state.message}</p>}
            <div className="media-delete-dialog-actions">
              <button type="button" className="media-delete-cancel" onClick={() => { setPreview(null); dispatch({ type: "cancel" }); }} disabled={busy}>Cancel</button>
              {preview && <button ref={confirmRef} type="button" className="media-delete-confirm" onClick={() => void permanentlyDelete()} disabled={busy || state.status === "preview_loading"}>
                {state.status === "loading" ? "Deleting…" : "Permanently delete"}
              </button>}
              {!preview && state.status === "error" && <button ref={confirmRef} type="button" className="media-delete-confirm" onClick={() => void loadPreview()}>Retry check</button>}
              {state.status === "preview_loading" && <button ref={confirmRef} type="button" className="media-delete-confirm" disabled>Checking…</button>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
