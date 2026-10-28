import { STATUS_LABELS } from "./format.ts";
import type { CycleItemStatus } from "../lib/domain/types.ts";

/** Status is always shown as TEXT (colour only helps) so it works for everyone. */
export function StatusBadge({ status }: { status: CycleItemStatus }) {
  return <span className={`badge badge-${status}`} data-status={status}>{STATUS_LABELS[status]}</span>;
}
