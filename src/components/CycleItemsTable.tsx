import { StatusBadge } from "./StatusBadge.tsx";
import { COVER_LABELS, REVIEW_REASON_LABELS, SOURCE_LABELS, formatDateTime } from "./format.ts";
import { isEditableItem } from "../lib/domain/cycle-state.ts";
import type { CycleItem } from "../lib/domain/types.ts";

export interface CycleItemsTableProps {
  items: CycleItem[];
  /** Display names for media (the table never shows internal ids as titles). */
  mediaTitles: Record<string, string>;
  timeZone: string;
}

/**
 * Shows every item with its real status. Only upcoming/scheduled items get a selection checkbox,
 * so the UI never invites the user to edit something already published or being published.
 * (The server re-checks this anyway - a hidden checkbox is not a security control.)
 */
export function CycleItemsTable({ items, mediaTitles, timeZone }: CycleItemsTableProps) {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  if (ordered.length === 0) return <div className="cycles-no-items"><span aria-hidden="true">▧</span><p>This cycle has no videos yet.</p><small>Add videos to review captions, covers and planned dates here.</small></div>;
  return (
    <div className="cycle-items-scroll" role="region" aria-label="Videos in this cycle" tabIndex={0}>
      <table className="cycle-items">
        <caption>Videos in this cycle</caption>
        <thead>
          <tr><th scope="col">Select</th><th scope="col">#</th><th scope="col">Video</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Scheduled for</th><th scope="col">Caption</th><th scope="col">Cover</th></tr>
        </thead>
        <tbody>
          {ordered.map((item) => {
            const title = mediaTitles[item.mediaAssetId] ?? "Unavailable video";
            const editable = isEditableItem(item);
            return (
              <tr key={item.id} data-item-id={item.id}>
                <td data-label="Select">{editable
                  ? <input type="checkbox" name="itemIds" value={item.id} aria-label={`Select ${title}`} />
                  : <span className="muted" title="This item can no longer be edited">—</span>}</td>
                <td data-label="Position">{item.position}</td>
                <td data-label="Video"><strong className="cycle-item-title">{title}</strong></td>
                <td data-label="Source">{SOURCE_LABELS[item.sourceKind]}</td>
                <td data-label="Status">
                  <StatusBadge status={item.status} />
                  {item.reviewReason && <p className="muted">{REVIEW_REASON_LABELS[item.reviewReason] ?? "Needs your attention."}</p>}
                </td>
                <td data-label="Scheduled">{item.scheduledFor ? formatDateTime(item.scheduledFor, timeZone) : "Not scheduled"}</td>
                <td data-label="Caption">{item.captionText === "" ? <span className="muted">No caption</span> : <details className="cycle-item-caption"><summary>View caption</summary><p>{item.captionText}</p></details>}</td>
                <td data-label="Cover">{COVER_LABELS[item.coverState]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
