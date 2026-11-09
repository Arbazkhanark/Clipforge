import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
import { formatEditorZoomPercent } from "../lib/domain/editor-gestures.ts";
import { EditorSession } from "./EditorSession.tsx";
import { EditorVideoPreview } from "./EditorVideoPreview.tsx";
import { Thumbnail } from "./MediaTable.tsx";
import type { EditorPageData } from "../server/queries.ts";

const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = { "9:16": "9:16 (Reels, recommended)", "4:5": "4:5 (portrait post)", "1:1": "1:1 (square)", "16:9": "16:9 (landscape)", original: "Original" };

/** Server-authorized media URL plus owned image URLs are passed to the interactive preview. */
export function EditorPreview({ data }: { data: EditorPageData }) {
  const { source } = data;
  if (!data.layout || !source) return null;
  const fileUrl = (id: string) => `/api/media/file?id=${encodeURIComponent(id)}&variant=preview`;
  return <EditorVideoPreview videoUrl={fileUrl(source.id)} sourceId={source.id} sourceWidth={source.width} sourceHeight={source.height} durationMs={source.durationMs} assumedSourceSize={data.assumedSourceSize} settings={data.settings} maxResolution={data.maxResolution} formId="editor-form" images={data.logoChoices.map((image) => ({ id: image.id, url: fileUrl(image.id), width: image.width, height: image.height }))} />;
}

const Range = ({ name, label, min, max, step, value }: { name: string; label: string; min: number; max: number; step: number; value: number }) =>
  <p><label>{label}: <output id={`editor-range-${name}-value`}>{value}</output><br /><input type="range" name={name} min={min} max={max} step={step} defaultValue={value} /></label></p>;

export function EditorForm({ data }: { data: EditorPageData }) {
  const { settings, source } = data;
  if (!source) return null;
  return (
    <form id="editor-form" method="get" action="/editor">
      <input type="hidden" name="media" value={source.id} />
      <fieldset>
        <legend>Trim video</legend>
        <p className="muted">Times are measured from the start of the source video. Leave the end at the source duration to export through the final frame.</p>
        <p><label>Start time (seconds)<br /><input type="number" name="trimStart" min={0} max={source.durationMs ? source.durationMs / 1000 : undefined} step={0.01} required defaultValue={settings.trim.startSeconds} /></label></p>
        <p><label>End time (seconds)<br /><input type="number" name="trimEnd" min={0.01} max={source.durationMs ? source.durationMs / 1000 : undefined} step={0.01} required defaultValue={settings.trim.endSeconds ?? (source.durationMs ? source.durationMs / 1000 : Math.max(1, settings.trim.startSeconds + 1))} /></label></p>
        {!source.durationMs && <p role="note">The source duration is not verified. Rendering remains unavailable until it can be checked.</p>}
      </fieldset>
      <fieldset>
        <legend>Shape</legend>
        <p><label>Aspect ratio<br /><select name="aspect" defaultValue={settings.aspect}>{ASPECT_RATIOS.map((a) => <option key={a} value={a}>{ASPECT_LABELS[a]}</option>)}</select></label></p>
        <p><label>Zoom: <output id="editor-range-zoom-value">{formatEditorZoomPercent(settings.zoom)}</output><br /><input type="range" name="zoom" min={1} max={3} step={0.05} defaultValue={settings.zoom} /></label></p>
        <p className="editor-zoom-actions" aria-label="Zoom controls">
          <button type="button" data-zoom-action="out" aria-label="Zoom out">−</button>{" "}
          <button type="button" data-zoom-action="in" aria-label="Zoom in">+</button>{" "}
          <button type="button" data-zoom-action="reset">Reset zoom</button>
        </p>
        <Range name="offsetX" label="Move left / right" min={-1} max={1} step={0.05} value={settings.offsetX} />
        <Range name="offsetY" label="Move up / down" min={-1} max={1} step={0.05} value={settings.offsetY} />
      </fieldset>
      <fieldset>
        <legend>Background</legend>
        <p><label><input type="radio" name="bg" value="blur" defaultChecked={settings.background.kind === "blur"} /> Blurred copy of the video</label>{" "}
          <label><input type="radio" name="bg" value="solid" defaultChecked={settings.background.kind === "solid"} /> Solid colour</label>{" "}
          <label><input type="radio" name="bg" value="image" defaultChecked={settings.background.kind === "image"} /> One of your images</label></p>
        <Range name="blur" label="Blur strength" min={1} max={40} step={1} value={settings.background.kind === "blur" ? settings.background.strength : 20} />
        <p><label>Colour<br /><input type="color" name="bgColor" defaultValue={settings.background.kind === "solid" ? settings.background.colorHex : "#000000"} /></label></p>
        {data.logoChoices.length > 0 && <p><label>Background image<br /><select name="bgImage" defaultValue={settings.background.kind === "image" ? settings.background.mediaId : ""}><option value="">Choose an image</option>{data.logoChoices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label></p>}
      </fieldset>
      <fieldset>
        <legend>Border (around the video itself)</legend>
        <p><label>Thickness in pixels (0 = none)<br /><input type="number" name="borderPx" min={0} max={40} step={1} defaultValue={settings.border.thicknessPx} /></label></p>
        <p><label>Colour<br /><input type="color" name="borderColor" defaultValue={settings.border.colorHex} /></label></p>
      </fieldset>
      <fieldset>
        <legend>Logo</legend>
        {data.logoChoices.length === 0 ? <p>Upload an image in the <a href="/media">media library</a> to use it as a logo.</p> : (
          <>
            <p><label>Image<br /><select name="logoMedia" defaultValue={settings.logo?.mediaId ?? ""}><option value="">No logo</option>{data.logoChoices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label></p>
            <Range name="logoWidth" label="Width (share of the picture)" min={0.05} max={0.5} step={0.01} value={settings.logo?.widthFraction ?? 0.2} />
            <Range name="logoX" label="Horizontal position" min={0} max={1} step={0.01} value={settings.logo?.centerX ?? 0.85} />
            <Range name="logoY" label="Vertical position" min={0} max={1} step={0.01} value={settings.logo?.centerY ?? 0.1} />
            <Range name="logoOpacity" label="Opacity" min={0.1} max={1} step={0.05} value={settings.logo?.opacity ?? 1} />
            <p className="muted">You can also drag the logo in the sketch (needs JavaScript; then press "Update preview").</p>
          </>
        )}
      </fieldset>
      <p><button type="submit" formNoValidate>Update preview</button> <EditorSession formId="editor-form" /> <a href={`/editor?media=${encodeURIComponent(source.id)}`}>Reset</a> <a href={`/media/${encodeURIComponent(source.id)}`}>Cancel</a></p>
      <p className="muted">{data.settingsSource === "template" ? "This preview is the whole template. It is not saved on the video until you choose Save settings. Reset returns to the saved settings." : data.settingsSource === "preview" ? "This is an unsaved preview. Save settings to keep it, or Reset to return to the saved settings." : "These are the saved settings for this video."}</p>
      <p><button type="submit" formMethod="post" formAction="/api/forms/editor-settings" formNoValidate>Save settings</button></p>
      <fieldset>
        <legend>Save these settings</legend>
        <p><label>Template name<br /><input type="text" name="name" maxLength={100} required /></label></p>
        <button type="submit" formMethod="post" formAction="/api/forms/editor-save">Save as template</button>
        <p className="muted">Templates hold only the settings. The original video is never changed. Saving the same name and settings again does not create a duplicate.</p>
        {data.templates.length >= data.templateLimit && <p role="status">Your plan allows {data.templateLimit} saved template{data.templateLimit === 1 ? "" : "s"}, and that limit is reached.</p>}
      </fieldset>
    </form>
  );
}

export function EditorView({ data }: { data: EditorPageData }) {
  const { source } = data;
  return (
    <>
      <h1>Editor</h1>
      <p role="note" className="notice">Rendering runs on this server and writes a new file. The original video is kept.</p>
      {data.problems.length > 0 && <ul role="alert" className="notice">{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {!source ? (
        <section aria-labelledby="choose-heading">
          <h2 id="choose-heading">Choose a video</h2>
          {data.videoChoices.length === 0 ? <p>Upload a video in the <a href="/media">media library</a> first.</p> : (
            <ul className="card-list">{data.videoChoices.map((v) => <li key={v.id} className="card"><Thumbnail media={v} /><p><a href={`/editor?media=${encodeURIComponent(v.id)}`}>{v.title}</a></p></li>)}</ul>
          )}
        </section>
      ) : (
        <>
          <h2>{source.title}</h2>
          <p className="muted">Your plan renders up to {data.maxResolution === "original" ? "the original resolution" : data.maxResolution}. These settings never change the original file.</p>
          <div className="editor-grid"><EditorPreview data={data} /><EditorForm data={data} /></div>
          <p><button type="submit" form="editor-form" formAction="/api/forms/render" formMethod="post" formNoValidate>Render video</button></p>
          {data.job && (
            <section aria-labelledby="render-status-heading">
              <h2 id="render-status-heading">Render status</h2>
              {data.job.refreshPath && <meta httpEquiv="refresh" content={`2;url=${data.job.refreshPath}`} />}
              <p>Status: {data.job.status}{data.job.message ? `. ${data.job.message}` : ""}</p>
              {data.job.status === "completed" && data.job.outputId && <p><a href={`/api/renders/file?id=${encodeURIComponent(data.job.outputId)}`}>Download export</a></p>}
            </section>
          )}
        </>
      )}
      <section aria-labelledby="templates-heading">
        <h2 id="templates-heading">Your templates ({data.templates.length} of {data.templateLimit})</h2>
        {data.templates.length === 0 ? <p>No templates yet.</p> : <ul>{data.templates.map((t) => <li key={t.id}><strong>{t.name}</strong> <span className="muted">{t.summary}</span> {source ? <a href={`/editor?media=${encodeURIComponent(source.id)}&template=${encodeURIComponent(t.id)}`}>Apply</a> : null}</li>)}</ul>}
        <h3>Exports</h3>
        {data.exports.length === 0 ? <p>No finished exports yet. A render is listed here only after its file has been checked.</p> : <ul>{data.exports.map((item) => <li key={item.id}><a href={`/api/renders/file?id=${encodeURIComponent(item.id)}`}>Download {item.sourceTitle}</a> <span className="muted">{item.aspect}, {item.createdOn}</span></li>)}</ul>}
      </section>
    </>
  );
}
