import { CycleItemsTable } from "./CycleItemsTable.tsx";
import { isEditableItem } from "../lib/domain/cycle-state.ts";
import type { CycleDetail } from "../server/queries.ts";

export function CreateCycleForm({ accounts }: { accounts: { id: string; label: string }[] }) {
  return (
    <section aria-labelledby="new-cycle-heading" className="card">
      <h2 id="new-cycle-heading">New publishing cycle</h2>
      {accounts.length === 0 ? <p>You need a connected account first. Connecting accounts is not available yet in this build.</p> : (
        <form method="post" action="/api/forms/cycle-create">
          <p><label>Name<br /><input type="text" name="name" required maxLength={100} /></label></p>
          <p><label>Account<br /><select name="socialAccountId" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label></p>
          <button type="submit">Create cycle (nothing is published)</button>
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
      <p className="muted">Publishing to Instagram is not connected in this build, so starting only changes the cycle's status inside ClipForge.</p>
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
  );
}
