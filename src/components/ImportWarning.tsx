import { IMPORT_WARNING_POINTS } from "../lib/domain/media-lifecycle.ts";
import { formatStorage } from "./format.ts";

/** Mandatory warning before importing a shared video. The checkbox must be ticked; the server also requires it. */
export function ImportWarning({ videoTitle, sizeBytes, action }: { videoTitle: string; sizeBytes: number; action: string }) {
  return (
    <form method="post" action={action} aria-labelledby="import-heading">
      <h2 id="import-heading">Import “{videoTitle}” to your library?</h2>
      <p>This will use about {formatStorage(sizeBytes)} of your storage.</p>
      <ul>{IMPORT_WARNING_POINTS.map((point) => <li key={point}>{point}</li>)}</ul>
      <label><input type="checkbox" name="warningAcknowledged" value="yes" required /> I understand and want to import this video.</label>
      <button type="submit">Import to My Library</button>
    </form>
  );
}
