import { CycleItemsTable } from "./CycleItemsTable.tsx";
import { isEditableItem } from "../lib/domain/cycle-state.ts";
import type { CycleDetail } from "../server/queries.ts";

export function CreateCycleForm({ accounts }: { accounts: { id: string; label: string }[] }) {
  return (
    <section aria-labelledby="new-cycle-heading" className="card">
      <h2 id="new-cycle-heading">New publishing cycle</h2>
      {accounts.length === 0 ? <p>No Instagram account is connected. Open the Instagram page to connect one. Live publishing is not configured, so connecting an account does not send a Reel.</p> : (
        <form method="post" action="/api/forms/cycle-create">
          <p><label>Name<br /><input type="text" name="name" required maxLength={100} /></label></p>
          <p><label>Account<br /><select name="socialAccountId" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label></p>
          <button type="submit">Create cycle (nothing is published)</button>
        </form>
      )}
    </section>
  );
}

export function RepeatModeForm({ cycleId, repeatBehavior, ended }: { cycleId: string; repeatBehavior: "never" | "ask" | "automatic"; ended: boolean }) {
  return (
    <section aria-labelledby="repeat-heading" className="card">
      <h2 id="repeat-heading">Repeat mode</h2>
      <p>A repeat round can republish only eligible, unpublished items, and only under the mode you save here. Published, publishing, and processing items are left out. Automatic queues another round when this cycle finishes. Ask waits for you. Never does not start another round. Saving this does not send a Reel.</p>
      {ended ? <p>This cycle has ended, so repeat mode cannot be changed.</p> : (
        <form method="post" action="/api/forms/cycle-repeat">
          <input type="hidden" name="cycleId" value={cycleId} />
          <p><label>Repeat<br />
            <select name="repeatBehavior" defaultValue={repeatBehavior}>
              <option value="never">Never</option>
              <option value="ask">Ask first</option>
              <option value="automatic">Automatic</option>
            </select>
          </label></p>
          <button type="submit">Save repeat mode</button>
        </form>
      )}
    </section>
  );
}

export function StartCycleForm({ cycleId, readyToConfirm }: { cycleId: string; readyToConfirm: boolean }) {
  return (
    <section aria-labelledby="start-heading" className="card">
      <h2 id="start-heading">Start this cycle</h2>
      {!readyToConfirm && <p role="note">Fix the blocked or required items above first.</p>}
      <p className="muted">Starting only changes this cycle inside ClipForge. It does not upload a Reel.</p>
      <form method="post" action="/api/forms/cycle-start">
        <input type="hidden" name="cycleId" value={cycleId} />
        <p><label><input type="checkbox" name="confirmFinalReview" value="yes" required disabled={!readyToConfirm} /> I reviewed the final list of videos, captions and covers.</label></p>
        <button type="submit" disabled={!readyToConfirm}>Start cycle</button>
      </form>
    </section>
  );
}

/**
 * One form around the items table. The checkboxes in the table pick the videos; each button below sends the SAME form to a
 * different route (formAction). Hidden "version.<id>" fields tell the server which version of each item you were looking at,
 * so edits that collide with a newer change are reported instead of silently overwriting it.
 */
export function CycleEditor({ detail, timeZone }: { detail: CycleDetail; timeZone: string }) {
  const editableItems = detail.items.filter(isEditableItem);
  const cycleEnded = detail.cycle.status === "stopped" || detail.cycle.status === "completed";
  if (cycleEnded || detail.items.length === 0) return <CycleItemsTable items={detail.items} mediaTitles={detail.mediaTitles} timeZone={timeZone} />;
  return (
    <>
      <form id="cycle-items-form" method="post" action="/api/forms/captions">
        <input type="hidden" name="cycleId" value={detail.cycle.id} />
        {editableItems.map((item) => <input key={item.id} type="hidden" name={`version.${item.id}`} value={item.version} />)}
        <CycleItemsTable items={detail.items} mediaTitles={detail.mediaTitles} timeZone={timeZone} />
        <fieldset>
          <legend>Apply to</legend>
          <label><input type="radio" name="scope" value="selected" defaultChecked /> Only the videos I ticked</label>{" "}
          <label><input type="radio" name="scope" value="all" /> All upcoming videos</label>
          <p className="muted">Published, publishing and processing videos are never changed.</p>
        </fieldset>
        <fieldset>
          <legend>Caption</legend>
          <p><label>New caption<br /><textarea name="caption" rows={4} cols={50} /></label></p>
          <p><label><input type="checkbox" name="overwriteCustomConfirmed" value="yes" /> Replace captions I wrote for individual videos</label></p>
          <button type="submit" formAction="/api/forms/captions">Apply caption</button>
        </fieldset>
        <fieldset>
          <legend>Cover image</legend>
          {detail.coverChoices.length === 0 ? <p>Upload an image in the <a href="/media">media library</a> to use it as a cover.</p> : (
            <p><label>Cover<br /><select name="coverMediaId">{detail.coverChoices.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label></p>
          )}
          <p className="muted">Covers are saved in ClipForge only. Instagram has not received them, and a saved cover is never shown as applied on Instagram.</p>
          <button type="submit" formAction="/api/forms/covers" disabled={detail.coverChoices.length === 0}>Save cover</button>
        </fieldset>
        <fieldset>
          <legend>Remove videos</legend>
          <p className="muted">Removing a video from the cycle never deletes the video or unpublishes anything.</p>
          <button type="submit" formAction="/api/forms/cycle-unmix">Remove ticked videos from this cycle</button>
        </fieldset>
      </form>
      {detail.cycle.status === "draft" && <CycleRenderSelectionForms detail={detail} />}
    </>
  );
}

function CycleRenderSelectionForms({ detail }: { detail: CycleDetail }) {
  const items = detail.items.filter(isEditableItem);
  return (
    <section className="card" aria-labelledby="render-selection-heading">
      <h2 id="render-selection-heading">Rendered outputs for publishing</h2>
      <p>Choose the exact completed render for each video. Originals stay unchanged, and a newer render never replaces your selection automatically.</p>
      {items.map((item) => {
        const outputs = detail.renderOutputsByItemId[item.id] ?? [];
        const selectedAvailable = detail.selectedRenderOutputAvailableByItemId[item.id] === true;
        const selectedIsListed = outputs.some((output) => output.id === item.selectedRenderOutputId);
        const status = item.selectedRenderOutputId
          ? selectedAvailable && selectedIsListed ? "Selected render is available." : "The selected render is missing or stale. Choose an available render again."
          : outputs.length ? "No render selected yet; publishing preflight remains blocked." : "No successful render is available for this source yet.";
        return (
          <form key={item.id} method="post" action="/api/forms/cycle-render-output" className="card">
            <input type="hidden" name="cycleId" value={detail.cycle.id} />
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="expectedVersion" value={item.version} />
            <p><strong>Original source:</strong> {detail.mediaTitles[item.mediaAssetId] ?? "Unavailable video"}</p>
            <p role="status">{status}</p>
            <label>Rendered output<br />
              <select name="renderOutputId" defaultValue={selectedAvailable && selectedIsListed ? item.selectedRenderOutputId ?? "" : ""}>
                <option value="">No rendered output selected</option>
                {outputs.map((output) => <option key={output.id} value={output.id}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(output.createdAt)} — {(output.sizeBytes / (1024 * 1024)).toFixed(1)} MB</option>)}
              </select>
            </label>{" "}
            <button type="submit">Save rendered output</button>
          </form>
        );
      })}
    </section>
  );
}
