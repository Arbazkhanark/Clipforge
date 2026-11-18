import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
import { computePreviewLayout } from "../lib/domain/editing-settings.ts";
import { samplePreviewSettings } from "../lib/domain/bulk-edit.ts";
import type { MediaCard } from "../server/queries.ts";
import type { BulkDraft, RenderBatch } from "../server/bulk/bulk-service.ts";
import type { EditingSettings } from "../lib/domain/editing-settings.ts";
import type { MaxResolution } from "../lib/render/ffmpeg-command.ts";
import { BulkLivePreview } from "./BulkLivePreview.tsx";
import { RenderBatchGallery, type RenderBatchGalleryItem } from "./RenderBatchGallery.tsx";

const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = { "9:16": "9:16", "4:5": "4:5", "1:1": "1:1", "16:9": "16:9", original: "Original" };
const bulkSelectionHref = (mediaIds: string[]) => `/editor/bulk?${mediaIds.map((id) => `media=${encodeURIComponent(id)}`).join("&")}`;

export function BulkForm({ videos, images, templates, batchSize, maxResolution = "1080p" }: { videos: (MediaCard & { settings?: EditingSettings })[]; images: MediaCard[]; templates: { id: string; name: string; summary: string; settings?: EditingSettings }[]; batchSize: number; maxResolution?: MaxResolution }) {
  return (
    <main className="bulk-editor-page">
      <header className="bulk-editor-header">
        <a className="bulk-editor-back" href="/media">← Media library</a>
        <p className="bulk-editor-eyebrow">CLIPFORGE STUDIO · BATCH EDIT</p>
        <h1>Apply a template to multiple videos</h1>
        <p>Choose one saved style for the selected videos, review the changes, then confirm. Original uploads stay unchanged.</p>
      </header>

      <section className="bulk-selection-panel" aria-labelledby="bulk-selection-heading">
        <div className="bulk-section-heading">
          <span className="bulk-step">01</span>
          <div><h2 id="bulk-selection-heading">Videos selected</h2><p>{videos.length} video{videos.length === 1 ? "" : "s"} · up to {batchSize} per batch with your current plan</p></div>
        </div>
        {videos.length > batchSize && <p className="bulk-limit-warning" role="alert">This collection has {videos.length} videos, above your current batch limit of {batchSize}. Reduce the selection in Media Library before continuing.</p>}
        <ul className="bulk-selected-videos">{videos.map((video) => <li key={video.id}><span aria-hidden="true">▶</span><strong>{video.title}</strong><small>{video.durationMs ? `${Math.round(video.durationMs / 1000)} sec` : "Video"}</small></li>)}</ul>
      </section>

      <form id="bulk-edit-form" method="post" action="/api/forms/bulk-review" className="bulk-edit-form">
        {videos.map((video) => <input key={video.id} type="hidden" name="media" value={video.id} />)}
        <BulkLivePreview videos={videos} images={images} templates={templates} maxResolution={maxResolution} formId="bulk-edit-form" />
        <section className="bulk-template-panel" aria-labelledby="bulk-template-heading">
          <div className="bulk-section-heading">
            <span className="bulk-step">02</span>
            <div><h2 id="bulk-template-heading">Choose a saved template</h2><p>Use the same look across every selected video.</p></div>
          </div>
          {templates.length === 0 ? <div className="bulk-no-templates"><strong>No templates yet</strong><p>Create one in the <a href="/editor">video editor</a>, then return here. You can also continue with individual settings below.</p></div> : <div className="bulk-template-choice"><label htmlFor="bulk-style-template">Template</label><select id="bulk-style-template" name="styleTemplateId" defaultValue=""><option value="">Choose a template…</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.summary}</option>)}</select><p>Applies the saved visual settings to {videos.length} selected video{videos.length === 1 ? "" : "s"}. Individual trim ranges stay as they are unless you opt in below.</p><label className="bulk-trim-option"><input type="checkbox" name="copyTemplateTrim" value="yes" /> Also copy the template&apos;s trim range</label></div>}
        </section>

        <details className="bulk-advanced-settings">
          <summary>Individual settings <span>Optional · use these instead of a template</span></summary>
          <fieldset>
            <legend>Choose the fields to apply</legend>
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
        </details>

        <footer className="bulk-form-footer">
          <p>Nothing changes yet. The next screen shows a review before any settings are saved.</p>
          <div><a href="/media">Cancel</a><button type="submit" disabled={videos.length === 0 || videos.length > batchSize}>Review changes</button></div>
        </footer>
      </form>
    </main>
  );
}

export function BulkConfirmation({ draft }: { draft: BulkDraft }) {
  const sample = draft.videos[0]?.after ?? samplePreviewSettings(draft.patch);
  const layout = computePreviewLayout(sample, { width: 1920, height: 1080 });
  return (
    <main className="bulk-editor-page bulk-confirmation-page">
      <header className="bulk-editor-header"><a className="bulk-editor-back" href={bulkSelectionHref(draft.videos.map((video) => video.mediaId))}>← Back to settings</a><p className="bulk-editor-eyebrow">FINAL REVIEW</p><h1>Review your changes</h1><p>Check the selected videos and template before saving these editor settings.</p></header>
      <section className="bulk-review-summary"><strong>{draft.videos.length} video{draft.videos.length === 1 ? "" : "s"} selected</strong><span>Original uploads will remain unchanged.</span>{draft.styleName && <p>Template: <b>{draft.styleName}</b> · {draft.copyTemplateTrim ? "Template trim will be copied" : "Each video keeps its current trim"}</p>}</section>
      <div className="bulk-review-grid"><section className="bulk-review-panel">
      <h2>Settings to apply</h2>
      {draft.lines.length ? <ul className="bulk-change-list">{draft.lines.map((line) => <li key={line}>{line}</li>)}</ul> : <p>The selected template&apos;s saved visual settings will be applied.</p>}
      <figure className="bulk-layout-preview">
        <svg viewBox={`0 0 ${layout.canvas.width} ${layout.canvas.height}`} role="img" aria-label="Layout sketch of the ticked settings" style={{ width: "100%", maxWidth: "16rem", border: "1px solid var(--border)" }}>
          <rect width={layout.canvas.width} height={layout.canvas.height} fill={sample.background.kind === "solid" ? sample.background.colorHex : "#777777"} />
          {layout.borderPx > 0 && <rect data-preview-border x={layout.borderBox.x} y={layout.borderBox.y} width={layout.borderBox.width} height={layout.borderBox.height} fill={sample.border.colorHex} />}
          <rect x={layout.video.x} y={layout.video.y} width={layout.video.width} height={layout.video.height} fill="#444444" />
          {layout.logo && <rect data-preview-logo x={layout.logo.x} y={layout.logo.y} width={layout.logo.width} height={layout.logo.height} fill="#ffeb3b" fillOpacity={sample.logo?.opacity ?? 1} stroke="#111111" />}
        </svg>
        <figcaption className="muted">Layout sketch of the selected style on a sample picture; the logo is shown as a marker, not its source image. This is not a rendered video. Other videos keep their trim unless copying was selected.</figcaption>
      </figure>
      </section><section className="bulk-review-panel">
      <h2>Videos that will change</h2>
      {draft.applyError && <p role="alert">{draft.applyError}</p>}
      <ul>{draft.videos.map((video) => <li key={video.mediaId}><strong>{video.title}</strong>{video.applyStatus !== "pending" && <> — {video.applyStatus === "applied" ? "Settings applied" : "Not changed"}</>}{video.notes.length > 0 && <span className="muted"> {video.notes.join(" ")}</span>}</li>)}</ul>
      </section></div>
      {draft.skipped.length > 0 && <section className="bulk-skipped-panel"><h2>Not included</h2><ul>{draft.skipped.map((skip, index) => <li key={`${skip.reason}-${index}`}>{skip.reason}</li>)}</ul></section>}
      {draft.applied ? (
        <>
          <p className="bulk-applied-status" role="status">These settings are saved. You can still open any video and change it on its own.</p>
          <form className="bulk-confirm-actions" method="post" action="/api/forms/bulk-render"><input type="hidden" name="draft" value={draft.id} /><button type="submit">Render these videos</button><a href="/media">Back to the library</a></form>
        </>
      ) : (
        <form className="bulk-confirm-actions" method="post" action="/api/forms/bulk-apply">
          <input type="hidden" name="draft" value={draft.id} />
          <a href={bulkSelectionHref(draft.videos.map((video) => video.mediaId))}>Cancel</a><button type="submit">Apply to {draft.videos.length} video{draft.videos.length === 1 ? "" : "s"}</button>
        </form>
      )}
    </main>
  );
}

export function BatchStatus({ items }: { items: RenderBatchGalleryItem[] }) {
  const done = items.filter((item) => item.status === "completed" || item.status === "failed" || item.status === "refused").length;
  const refreshing = items.some((item) => item.status === "queued" || item.status === "processing");
  return (
    <>
      {refreshing && <meta httpEquiv="refresh" content="2" />}
      <RenderBatchGallery items={items} />
    </>
  );
}
