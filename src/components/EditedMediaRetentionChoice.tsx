"use client";

import { useState } from "react";
import { reconcileEditedRetentionStatus, type EditedRetentionStatus } from "../lib/domain/edited-retention-status.ts";

export type EditedRetentionItem = { mediaId: string; outputId: string; title: string; retentionStatus?: EditedRetentionStatus; retentionMessage?: string };
type Result = { mediaId: string; status: "queued" | "existing" | "blocked" | "unknown" | EditedRetentionStatus; message: string };

export function EditedMediaRetentionChoice({ items, presentation = "completion" }: { items: EditedRetentionItem[]; presentation?: "completion" | "history" }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [keptBoth, setKeptBoth] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  if (items.length === 0) return null;

  async function reconcile(itemsToCheck = items) {
    setCheckingStatus(true);
    setRequestError(null);
    try {
      const states = await reconcileEditedRetentionStatus(itemsToCheck);
      setResults(states.map(({ mediaId, status, message }) => ({ mediaId, status, message })));
      setConfirming(false);
    } catch {
      setRequestError("The request result is still unknown. Check the deletion status again before taking another action.");
    } finally {
      setCheckingStatus(false);
    }
  }

  async function deleteOriginals() {
    if (submitting) return;
    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/media/edited-retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, items: items.map(({ mediaId, outputId }) => ({ mediaId, outputId })) }),
      });
      const body = await response.json() as { results?: Result[]; error?: { message?: string } };
      if (!response.ok || !Array.isArray(body.results)) {
        await reconcile();
      } else if (body.results.some((result) => result.status === "unknown")) {
        setRequestError("Checking deletion status…");
        await reconcile();
      } else {
        setResults(body.results);
        setKeptBoth(false);
        setConfirming(false);
      }
    } catch (error) {
      // A lost response does not prove the server kept the originals. Reconcile by
      // reading status; this path never resubmits the destructive POST.
      setRequestError("Checking deletion status…");
      await reconcile();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={`edited-retention${presentation === "history" ? " edited-retention-history" : ""}`} aria-labelledby={presentation === "history" ? undefined : "edited-retention-heading"}>
      {presentation === "completion" ? <div className="edited-retention-heading">
        <span className="edited-retention-mark" aria-hidden="true">✓</span>
        <div>
          <p className="editor-eyebrow">EDIT COMPLETE</p>
          <h2 id="edited-retention-heading">Your videos have been edited. What would you like to save?</h2>
          <p>{items.length} edited {items.length === 1 ? "version is" : "versions are"} saved and verified. Edited versions stay separate from the original uploads.</p>
        </div>
      </div> : <h3>Original video retention</h3>}

      {checkingStatus ? <p className="edited-retention-status" role="status" aria-live="polite">Checking deletion status…</p> : keptBoth ? (
        <div className="edited-retention-results" role="status" aria-live="polite">
          <p>Original and edited versions are both kept. The original uploads were not changed.</p>
          <button type="button" className="edited-retention-secondary" onClick={() => setKeptBoth(false)}>Done</button>
        </div>
      ) : results ? (
        <div className="edited-retention-results" role="status" aria-live="polite">
          {results.map((result) => <p key={result.mediaId} data-status={result.status}><strong>{items.find((item) => item.mediaId === result.mediaId)?.title ?? "Video"}:</strong> {result.message}</p>)}
          {results.some((result) => result.status === "unknown" || result.status === "unavailable") && <button type="button" className="edited-retention-secondary" onClick={() => void reconcile()}>Check deletion status</button>}
          {results.some((result) => result.status === "available") && <button type="button" className="edited-retention-secondary" onClick={() => { setResults(null); setRequestError(null); }}>Review retention choice</button>}
          <button type="button" className="edited-retention-secondary" onClick={() => window.location.reload()}>Done</button>
        </div>
      ) : items.some((item) => item.retentionStatus && item.retentionStatus !== "available") ? (
        <div className="edited-retention-results" role="status" aria-live="polite">
          {items.filter((item) => item.retentionStatus && item.retentionStatus !== "available").map((item) => <p key={item.mediaId} data-status={item.retentionStatus}><strong>{item.title}:</strong> {item.retentionMessage ?? "Original retention status is unavailable."}</p>)}
          <button type="button" className="edited-retention-secondary" onClick={() => void reconcile()}>Refresh deletion status</button>
        </div>
      ) : confirming ? (
        <div className="edited-retention-confirm" role="group" aria-labelledby="edited-retention-confirm-heading" aria-describedby="edited-retention-confirm-description">
          <h3 id="edited-retention-confirm-heading">Replace the originals with these edited videos?</h3>
          <p id="edited-retention-confirm-description">Each edited copy will be saved as a new private video and verified first. Its collection memberships and settings will move to the edited copy. The original will stay available if copying, verification, or dependency checks fail. After a safe transfer, the existing private-storage cleanup process removes the original object.</p>
          <ul>{items.map((item) => <li key={item.mediaId}>{item.title}</li>)}</ul>
          {requestError && <p className="edited-retention-error" role="alert">{requestError}</p>}
          <div className="edited-retention-actions">
            <button type="button" className="edited-retention-secondary" disabled={submitting} onClick={() => { setConfirming(false); setRequestError(null); }}>Cancel — Keep originals</button>
            <button type="button" className="edited-retention-danger" disabled={submitting} onClick={() => void deleteOriginals()}>{submitting ? "Queuing safe replacement…" : "Confirm — Keep only edited videos"}</button>
          </div>
        </div>
      ) : (
        <div className="edited-retention-actions">
          <button type="button" className="edited-retention-secondary" onClick={() => { setKeptBoth(true); setResults(null); }}>Keep original + edited videos</button>
          <button type="button" className="edited-retention-recommended" onClick={() => setConfirming(true)}>
            <span>Keep only edited videos</span><span className="edited-retention-recommended-label">Recommended · save storage</span>
          </button>
        </div>
      )}
    </section>
  );
}
