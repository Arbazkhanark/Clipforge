"use client";

import { useEffect, useState } from "react";
import type { MediaVerificationState } from "../server/repository.ts";

const stages: Record<MediaVerificationState["stage"], string> = {
  queued: "Waiting for verification worker",
  uploading: "Uploading",
  uploaded_to_storage: "Upload stored",
  storage_verifying: "Checking private storage",
  storage_verified: "Private storage checked",
  media_probing: "Decoding media and checking metadata",
  media_verified: "Media decoded",
  thumbnail_generating: "Generating preview",
  thumbnail_verifying: "Checking preview",
  thumbnail_verified: "Preview checked",
  thumbnail_skipped: "Preview not generated (optional)",
  completed: "Verification complete",
};

function validState(value: unknown): value is MediaVerificationState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state["mediaId"] === "string" && ["processing", "verified", "incomplete", "failed", "legacy_unverified"].includes(String(state["status"])) && Object.hasOwn(stages, String(state["stage"]));
}

export function mediaVerificationLoadingCopy(requestError: boolean): { label: string; description: string } {
  return requestError
    ? { label: "Status unavailable", description: "Verification status could not be loaded. Retrying automatically." }
    : { label: "Checking", description: "Verification status is loading." };
}

export function MediaVerificationStatus({ mediaId, initial }: { mediaId: string; initial?: MediaVerificationState }) {
  const [state, setState] = useState<MediaVerificationState | undefined>(initial);
  const [checking, setChecking] = useState(false);
  const [requestError, setRequestError] = useState(false);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const refresh = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const response = await fetch(`/api/media/verification?ids=${encodeURIComponent(mediaId)}`, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error("status");
        const body = await response.json() as { items?: unknown };
        const next = Array.isArray(body.items) ? body.items.find((item) => validState(item) && item.mediaId === mediaId) : undefined;
        if (!stopped && validState(next)) { setState(next); setRequestError(false); }
      } catch { if (!stopped) setRequestError(true); }
      finally { busy = false; }
    };
    if (!state || state.status === "processing") void refresh();
    const timer = !state || state.status === "processing" ? setInterval(() => void refresh(), 3_000) : null;
    return () => { stopped = true; if (timer) clearInterval(timer); };
  }, [mediaId, state?.status]);

  async function retry() {
    setChecking(true); setRequestError(false);
    try {
      const response = await fetch("/api/media/verification", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId }) });
      if (!response.ok) throw new Error("retry");
      setState((current) => current ? { ...current, status: "processing", stage: "queued", errorCode: null, errorMessage: null, retryable: false } : current);
    } catch { setRequestError(true); }
    finally { setChecking(false); }
  }

  if (!state) {
    const copy = mediaVerificationLoadingCopy(requestError);
    return <div className="media-validation-cell" role="status"><span className="media-validation incomplete">{copy.label}</span><small>{copy.description}</small></div>;
  }
  if (state.status === "verified") return <div className="media-validation-cell"><span className="media-validation verified">Verified</span><small>Private object, size, checksum and media decode passed. Preview: {state.thumbnailStatus}.</small></div>;
  if (state.status === "processing") return <div className="media-validation-cell" aria-live="polite"><span className="media-validation incomplete">Processing</span><small><span className="media-verification-indicator" aria-hidden="true" />{stages[state.stage]}</small>{state.errorMessage && <small>{state.errorMessage}</small>}{requestError && <small role="status">Status temporarily unavailable; checking again.</small>}</div>;
  if (state.status === "legacy_unverified") return <div className="media-validation-cell"><span className="media-validation incomplete">Not rechecked</span><small>{state.errorMessage}</small></div>;
  return <div className="media-validation-cell"><span className="media-validation incomplete">{state.status === "failed" ? "Failed" : "Incomplete"}</span><small>{state.errorMessage ?? "A required verification did not complete."}</small>{requestError && <small role="status">The retry request could not be confirmed.</small>}{state.retryable && <button type="button" className="media-upload-secondary" onClick={() => void retry()} disabled={checking}>{checking ? "Queueing…" : "Retry verification"}</button>}</div>;
}
