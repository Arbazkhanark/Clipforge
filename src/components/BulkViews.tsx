import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
import { computePreviewLayout } from "../lib/domain/editing-settings.ts";
import { samplePreviewSettings } from "../lib/domain/bulk-edit.ts";
import type { MediaCard } from "../server/queries.ts";
import type { BulkDraft, RenderBatch } from "../server/bulk/bulk-service.ts";
import type { RenderJob } from "../server/render/export-service.ts";

const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = { "9:16": "9:16", "4:5": "4:5", "1:1": "1:1", "16:9": "16:9", original: "Original" };

export function BulkForm({ videos, images, templates, batchSize }: { videos: MediaCard[]; images: MediaCard[]; templates: { id: string; name: string; summary: string }[]; batchSize: number }) {
  return (
    <>
      <h1>Bulk edit</h1>
      <p className="notice">Apply an owned saved style or choose individual settings. Each video's source file stays unchanged. Nothing is saved until you review and confirm.</p>
      <p>Your plan can edit {batchSize} videos at a time. Renders use your plan&apos;s maximum resolution. {videos.length > batchSize ? `${videos.length} videos are selected, which is more than the plan allows. Remove some before reviewing.` : `${videos.length} video${videos.length === 1 ? "" : "s"} selected.`}</p>
      <ul>{videos.map((video) => <li key={video.id}>{video.title}</li>)}</ul>
      <form method="post" action="/api/forms/bulk-review">
        {videos.map((video) => <input key={video.id} type="hidden" name="media" value={video.id} />)}
        <fieldset>
          <legend>Reusable style</legend>
          {templates.length === 0 ? <p>No saved styles yet. Save one from the <a href="/editor">video editor</a> first.</p> : <p><label>Apply a saved style to every selected video<br /><select name="styleTemplateId" defaultValue=""><option value="">Choose a style…</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.summary}</option>)}</select></label></p>}
          <p><label><input type="checkbox" name="copyTemplateTrim" value="yes" /> Also copy the style's trim range (otherwise each video's trim is preserved)</label></p>
          <p className="muted">A saved style applies its border, background, zoom, position, logo and other visual settings. It replaces individual settings below.</p>
        </fieldset>
        <fieldset>
          <legend>Settings to apply</legend>
          <p><label><input type="checkbox" name="use" value="aspect" /> Aspect ratio</label><br /><select name="aspect">{ASPECT_RATIOS.map((aspect) => <option key={aspect} value={aspect}>{ASPECT_LABELS[aspect]}</option>)}</select></p>
          <p><label><input type="checkbox" name="use" value="background" /> Background type</label><br />
            <label><input type="radio" name="bg" value="blur" defaultChecked /> Blurred video</label>{" "}
            <label><input type="radio" name="bg" value="solid" /> Solid colour</label>{" "}
            <label><input type="radio" name="bg" value="image" /> Image</label></p>
          <p><label><input type="checkbox" name="use" value="bgColor" /> Solid colour</label><br /><input type="color" name="bgColor" defaultValue="#000000" /></p>
          <p><label><input type="checkbox" name="use" value="bgImage" /> Background image</label><br /><select name="bgImage"><option value="">Choose an image</option>{images.map((image) => <option key={image.id} value={image.id}>{image.title}</option>)}</select></p>
          <p><label><input type="checkbox" name="use" value="blur" /> Blur strength</label><br /><input type="number" name="blur" min={1} max={40} defaultValue={20} /></p>
          <p><label><input type="checkbox" name="use" value="zoom" /> Zoom</label><br /><input type="number" name="zoom" min={1} max={3} step={0.05} defaultValue={1} /></p>
          <p><label><input type="checkbox" name="use" value="offsetX" /> Horizontal position</label><br /><input type="number" name="offsetX" min={-1} max={1} step={0.05} defaultValue={0} /></p>
          <p><label><input type="checkbox" name="use" value="offsetY" /> Vertical position</label><br /><input type="number" name="offsetY" min={-1} max={1} step={0.05} defaultValue={0} /></p>
          <p><label><input type="checkbox" name="use" value="borderEnabled" /> Border on or off</label><br />
            <label><input type="radio" name="borderOn" value="yes" /> On</label>{" "}
            <label><input type="radio" name="borderOn" value="no" defaultChecked /> Off</label></p>
          <p><label><input type="checkbox" name="use" value="borderColor" /> Border colour</label><br /><input type="color" name="borderColor" defaultValue="#ffffff" /></p>
          <p><label><input type="checkbox" name="use" value="borderThickness" /> Border thickness</label><br /><input type="number" name="borderPx" min={0} max={40} defaultValue={0} /></p>
          <p><label><input type="checkbox" name="use" value="logo" /> Logo image</label><br /><select name="logoMedia"><option value="">No logo</option>{images.map((image) => <option key={image.id} value={image.id}>{image.title}</option>)}</select></p>
          <p><label><input type="checkbox" name="use" value="logoPosition" /> Logo position</label><br />Horizontal <input type="number" name="logoX" min={0} max={1} step={0.01} defaultValue={0.85} /> Vertical <input type="number" name="logoY" min={0} max={1} step={0.01} defaultValue={0.1} /></p>
          <p><label><input type="checkbox" name="use" value="logoSize" /> Logo size</label><br /><input type="number" name="logoWidth" min={0.05} max={0.5} step={0.01} defaultValue={0.2} /></p>
          <p><label><input type="checkbox" name="use" value="logoOpacity" /> Logo opacity</label><br /><input type="number" name="logoOpacity" min={0.1} max={1} step={0.05} defaultValue={1} /></p>
        </fieldset>
        <p><button type="submit" disabled={videos.length === 0 || videos.length > batchSize}>Review changes</button> <a href="/media">Cancel</a></p>
      </form>
    </>
  );
}

export function BulkConfirmation({ draft }: { draft: BulkDraft }) {
  const sample = draft.videos[0]?.after ?? samplePreviewSettings(draft.patch);
  const layout = computePreviewLayout(sample, { width: 1920, height: 1080 });
  return (
    <>
      <h1>Confirm bulk edit</h1>
      <p className="notice">This will change {draft.videos.length} video{draft.videos.length === 1 ? "" : "s"}. Unticked settings stay as they are. Original uploads are not changed.</p>
      {draft.styleName && <p>Saved style: <strong>{draft.styleName}</strong>. {draft.copyTemplateTrim ? "The template trim range will be copied." : "Each video's trim range will be preserved."}</p>}
      <h2>Settings that will change</h2>
      <ul>{draft.lines.map((line) => <li key={line}>{line}</li>)}</ul>
      <figure>
        <svg viewBox={`0 0 ${layout.canvas.width} ${layout.canvas.height}`} role="img" aria-label="Layout sketch of the ticked settings" style={{ width: "100%", maxWidth: "16rem", border: "1px solid var(--border)" }}>
          <rect width={layout.canvas.width} height={layout.canvas.height} fill={sample.background.kind === "solid" ? sample.background.colorHex : "#777777"} />
          {layout.borderPx > 0 && <rect data-preview-border x={layout.borderBox.x} y={layout.borderBox.y} width={layout.borderBox.width} height={layout.borderBox.height} fill={sample.border.colorHex} />}
          <rect x={layout.video.x} y={layout.video.y} width={layout.video.width} height={layout.video.height} fill="#444444" />
          {layout.logo && <rect data-preview-logo x={layout.logo.x} y={layout.logo.y} width={layout.logo.width} height={layout.logo.height} fill="#ffeb3b" fillOpacity={sample.logo?.opacity ?? 1} stroke="#111111" />}
        </svg>
        <figcaption className="muted">Layout sketch of the selected style on a sample picture; the logo is shown as a marker, not its source image. This is not a rendered video. Other videos keep their trim unless copying was selected.</figcaption>
      </figure>
      <h2>Videos that will change</h2>
      {draft.applyError && <p role="alert">{draft.applyError}</p>}
      <ul>{draft.videos.map((video) => <li key={video.mediaId}><strong>{video.title}</strong>{video.applyStatus !== "pending" && <> — {video.applyStatus === "applied" ? "Settings applied" : "Not changed"}</>}{video.notes.length > 0 && <span className="muted"> {video.notes.join(" ")}</span>}</li>)}</ul>
      <h2>Not eligible</h2>
      {draft.skipped.length === 0 ? <p>Every selected item can be edited.</p> : <ul>{draft.skipped.map((skip, index) => <li key={`${skip.reason}-${index}`}>{skip.reason}</li>)}</ul>}
      {draft.applied ? (
        <>
          <p role="status">These settings are saved. You can still open any video and change it on its own.</p>
          <form method="post" action="/api/forms/bulk-render"><input type="hidden" name="draft" value={draft.id} /><button type="submit">Render these videos</button></form>
          <p><a href="/media">Back to the library</a></p>
        </>
      ) : (
        <form method="post" action="/api/forms/bulk-apply">
          <input type="hidden" name="draft" value={draft.id} />
          <p><button type="submit">Apply to {draft.videos.length} video{draft.videos.length === 1 ? "" : "s"}</button> <a href="/media">Cancel</a></p>
        </form>
      )}
    </>
  );
}

export function BatchStatus({ items }: { items: { title: string; mediaId: string; status: RenderJob["status"] | "refused"; message: string | null; outputId: string | null }[] }) {
  const done = items.filter((item) => item.status === "completed" || item.status === "failed" || item.status === "refused").length;
  const refreshing = items.some((item) => item.status === "queued" || item.status === "processing");
  return (
    <>
      <h1>Render batch</h1>
      <p>Finished {done} of {items.length}. Each export is a new file. A failure does not change the original or the exports that succeeded.</p>
      {refreshing && <meta httpEquiv="refresh" content="2" />}
      <ul>
        {items.map((item) => (
          <li key={item.mediaId}>
            <strong>{item.title}</strong> — {item.status}
            {item.message ? `. ${item.message}` : ""}
            {item.status === "completed" && item.outputId && <> <a href={`/api/renders/file?id=${encodeURIComponent(item.outputId)}`}>Download</a></>}
            {" "}<a href={`/editor?media=${encodeURIComponent(item.mediaId)}`}>Edit</a>
          </li>
        ))}
      </ul>
    </>
  );
}
