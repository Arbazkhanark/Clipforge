// // src/components/EditorViews.tsx
// import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
// import { formatEditorZoomPercent } from "../lib/domain/editor-gestures.ts";
// import { EditorSession } from "./EditorSession.tsx";
// import { EditorVideoPreview } from "./EditorVideoPreview.tsx";
// import { Thumbnail } from "./MediaTable.tsx";
// import type { EditorPageData } from "../server/queries.ts";

// const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = { "9:16": "9:16 (Reels, recommended)", "4:5": "4:5 (portrait post)", "1:1": "1:1 (square)", "16:9": "16:9 (landscape)", original: "Original" };

// /** Server-authorized media URL plus owned image URLs are passed to the interactive preview. */
// export function EditorPreview({ data }: { data: EditorPageData }) {
//   const { source } = data;
//   if (!data.layout || !source) return null;
//   const fileUrl = (id: string) => `/api/media/file?id=${encodeURIComponent(id)}&variant=preview`;
//   return <EditorVideoPreview videoUrl={fileUrl(source.id)} sourceId={source.id} sourceWidth={source.width} sourceHeight={source.height} durationMs={source.durationMs} assumedSourceSize={data.assumedSourceSize} settings={data.settings} maxResolution={data.maxResolution} formId="editor-form" images={data.logoChoices.map((image) => ({ id: image.id, url: fileUrl(image.id), width: image.width, height: image.height }))} />;
// }

// const Range = ({ name, label, min, max, step, value }: { name: string; label: string; min: number; max: number; step: number; value: number }) =>
//   <p><label>{label}: <output id={`editor-range-${name}-value`}>{value}</output><br /><input type="range" name={name} min={min} max={max} step={step} defaultValue={value} /></label></p>;

// export function EditorForm({ data }: { data: EditorPageData }) {
//   const { settings, source } = data;
//   if (!source) return null;
//   return (
//     <form id="editor-form" method="get" action="/editor">
//       <input type="hidden" name="media" value={source.id} />
//       <fieldset>
//         <legend>Trim video</legend>
//         <p className="muted">Times are measured from the start of the source video. Leave the end at the source duration to export through the final frame.</p>
//         <p><label>Start time (seconds)<br /><input type="number" name="trimStart" min={0} max={source.durationMs ? source.durationMs / 1000 : undefined} step={0.01} required defaultValue={settings.trim.startSeconds} /></label></p>
//         <p><label>End time (seconds)<br /><input type="number" name="trimEnd" min={0.01} max={source.durationMs ? source.durationMs / 1000 : undefined} step={0.01} required defaultValue={settings.trim.endSeconds ?? (source.durationMs ? source.durationMs / 1000 : Math.max(1, settings.trim.startSeconds + 1))} /></label></p>
//         {!source.durationMs && <p role="note">The source duration is not verified. Rendering remains unavailable until it can be checked.</p>}
//       </fieldset>
//       <fieldset>
//         <legend>Shape</legend>
//         <p><label>Aspect ratio<br /><select name="aspect" defaultValue={settings.aspect}>{ASPECT_RATIOS.map((a) => <option key={a} value={a}>{ASPECT_LABELS[a]}</option>)}</select></label></p>
//         <p><label>Zoom: <output id="editor-range-zoom-value">{formatEditorZoomPercent(settings.zoom)}</output><br /><input type="range" name="zoom" min={1} max={3} step={0.05} defaultValue={settings.zoom} /></label></p>
//         <p className="editor-zoom-actions" aria-label="Zoom controls">
//           <button type="button" data-zoom-action="out" aria-label="Zoom out">−</button>{" "}
//           <button type="button" data-zoom-action="in" aria-label="Zoom in">+</button>{" "}
//           <button type="button" data-zoom-action="reset">Reset zoom</button>
//         </p>
//         <Range name="offsetX" label="Move left / right" min={-1} max={1} step={0.05} value={settings.offsetX} />
//         <Range name="offsetY" label="Move up / down" min={-1} max={1} step={0.05} value={settings.offsetY} />
//       </fieldset>
//       <fieldset>
//         <legend>Background</legend>
//         <p><label><input type="radio" name="bg" value="blur" defaultChecked={settings.background.kind === "blur"} /> Blurred copy of the video</label>{" "}
//           <label><input type="radio" name="bg" value="solid" defaultChecked={settings.background.kind === "solid"} /> Solid colour</label>{" "}
//           <label><input type="radio" name="bg" value="image" defaultChecked={settings.background.kind === "image"} /> One of your images</label></p>
//         <Range name="blur" label="Blur strength" min={1} max={40} step={1} value={settings.background.kind === "blur" ? settings.background.strength : 20} />
//         <p><label>Colour<br /><input type="color" name="bgColor" defaultValue={settings.background.kind === "solid" ? settings.background.colorHex : "#000000"} /></label></p>
//         {data.logoChoices.length > 0 && <p><label>Background image<br /><select name="bgImage" defaultValue={settings.background.kind === "image" ? settings.background.mediaId : ""}><option value="">Choose an image</option>{data.logoChoices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label></p>}
//       </fieldset>
//       <fieldset>
//         <legend>Border (around the video itself)</legend>
//         <p><label>Thickness in pixels (0 = none)<br /><input type="number" name="borderPx" min={0} max={40} step={1} defaultValue={settings.border.thicknessPx} /></label></p>
//         <p><label>Colour<br /><input type="color" name="borderColor" defaultValue={settings.border.colorHex} /></label></p>
//       </fieldset>
//       <fieldset>
//         <legend>Logo</legend>
//         {data.logoChoices.length === 0 ? <p>Upload an image in the <a href="/media">media library</a> to use it as a logo.</p> : (
//           <>
//             <p><label>Image<br /><select name="logoMedia" defaultValue={settings.logo?.mediaId ?? ""}><option value="">No logo</option>{data.logoChoices.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label></p>
//             <Range name="logoWidth" label="Width (share of the picture)" min={0.05} max={0.5} step={0.01} value={settings.logo?.widthFraction ?? 0.2} />
//             <Range name="logoX" label="Horizontal position" min={0} max={1} step={0.01} value={settings.logo?.centerX ?? 0.85} />
//             <Range name="logoY" label="Vertical position" min={0} max={1} step={0.01} value={settings.logo?.centerY ?? 0.1} />
//             <Range name="logoOpacity" label="Opacity" min={0.1} max={1} step={0.05} value={settings.logo?.opacity ?? 1} />
//             <p className="muted">You can also drag the logo in the sketch (needs JavaScript; then press "Update preview").</p>
//           </>
//         )}
//       </fieldset>
//       <p><button type="submit" formNoValidate>Update preview</button> <EditorSession formId="editor-form" /> <a href={`/editor?media=${encodeURIComponent(source.id)}`}>Reset</a> <a href={`/media/${encodeURIComponent(source.id)}`}>Cancel</a></p>
//       <p className="muted">{data.settingsSource === "template" ? "This preview is the whole template. It is not saved on the video until you choose Save settings. Reset returns to the saved settings." : data.settingsSource === "preview" ? "This is an unsaved preview. Save settings to keep it, or Reset to return to the saved settings." : "These are the saved settings for this video."}</p>
//       <p><button type="submit" formMethod="post" formAction="/api/forms/editor-settings" formNoValidate>Save settings</button></p>
//       <fieldset>
//         <legend>Save these settings</legend>
//         <p><label>Template name<br /><input type="text" name="name" maxLength={100} required /></label></p>
//         <button type="submit" formMethod="post" formAction="/api/forms/editor-save">Save as template</button>
//         <p className="muted">Templates hold only the settings. The original video is never changed. Saving the same name and settings again does not create a duplicate.</p>
//         {data.templates.length >= data.templateLimit && <p role="status">Your plan allows {data.templateLimit} saved template{data.templateLimit === 1 ? "" : "s"}, and that limit is reached.</p>}
//       </fieldset>
//     </form>
//   );
// }

// export function EditorView({ data }: { data: EditorPageData }) {
//   const { source } = data;
//   return (
//     <>
//       <h1>Editor</h1>
//       <p role="note" className="notice">Rendering runs on this server and writes a new file. The original video is kept.</p>
//       {data.problems.length > 0 && <ul role="alert" className="notice">{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
//       {!source ? (
//         <section aria-labelledby="choose-heading">
//           <h2 id="choose-heading">Choose a video</h2>
//           {data.videoChoices.length === 0 ? <p>Upload a video in the <a href="/media">media library</a> first.</p> : (
//             <ul className="card-list">{data.videoChoices.map((v) => <li key={v.id} className="card"><Thumbnail media={v} /><p><a href={`/editor?media=${encodeURIComponent(v.id)}`}>{v.title}</a></p></li>)}</ul>
//           )}
//         </section>
//       ) : (
//         <>
//           <h2>{source.title}</h2>
//           <p className="muted">Your plan renders up to {data.maxResolution === "original" ? "the original resolution" : data.maxResolution}. These settings never change the original file.</p>
//           <div className="editor-grid"><EditorPreview data={data} /><EditorForm data={data} /></div>
//           <p><button type="submit" form="editor-form" formAction="/api/forms/render" formMethod="post" formNoValidate>Render video</button></p>
//           {data.job && (
//             <section aria-labelledby="render-status-heading">
//               <h2 id="render-status-heading">Render status</h2>
//               {data.job.refreshPath && <meta httpEquiv="refresh" content={`2;url=${data.job.refreshPath}`} />}
//               <p>Status: {data.job.status}{data.job.message ? `. ${data.job.message}` : ""}</p>
//               {data.job.status === "completed" && data.job.outputId && <p><a href={`/api/renders/file?id=${encodeURIComponent(data.job.outputId)}`}>Download export</a></p>}
//             </section>
//           )}
//         </>
//       )}
//       <section aria-labelledby="templates-heading">
//         <h2 id="templates-heading">Your templates ({data.templates.length} of {data.templateLimit})</h2>
//         {data.templates.length === 0 ? <p>No templates yet.</p> : <ul>{data.templates.map((t) => <li key={t.id}><strong>{t.name}</strong> <span className="muted">{t.summary}</span> {source ? <a href={`/editor?media=${encodeURIComponent(source.id)}&template=${encodeURIComponent(t.id)}`}>Apply</a> : null}</li>)}</ul>}
//         <h3>Exports</h3>
//         {data.exports.length === 0 ? <p>No finished exports yet. A render is listed here only after its file has been checked.</p> : <ul>{data.exports.map((item) => <li key={item.id}><a href={`/api/renders/file?id=${encodeURIComponent(item.id)}`}>Download {item.sourceTitle}</a> <span className="muted">{item.aspect}, {item.createdOn}</span></li>)}</ul>}
//       </section>
//     </>
//   );
// }

















import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
import { formatEditorZoomPercent } from "../lib/domain/editor-gestures.ts";
import { EditorSession } from "./EditorSession.tsx";
import { EditorVideoPreview } from "./EditorVideoPreview.tsx";
import { Thumbnail } from "./MediaTable.tsx";
import type { EditorPageData } from "../server/queries.ts";

const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = {
  "9:16": "9:16 (Reels, recommended)",
  "4:5": "4:5 (portrait post)",
  "1:1": "1:1 (square)",
  "16:9": "16:9 (landscape)",
  original: "Original",
};

/** Server-authorized media URL plus owned image URLs are passed to the interactive preview. */
export function EditorPreview({ data }: { data: EditorPageData }) {
  const { source } = data;
  if (!data.layout || !source) return null;

  const fileUrl = (id: string) =>
    `/api/media/file?id=${encodeURIComponent(id)}&variant=preview`;

  return (
    <div className="editor-preview-panel">
      <div className="editor-panel-heading">
        <div>
          <span className="editor-eyebrow">LIVE CANVAS</span>
          <h2>Preview</h2>
        </div>
        <span className="editor-live-indicator">
          <span /> Preview
        </span>
      </div>

      <div className="editor-preview-canvas">
        <EditorVideoPreview
          videoUrl={fileUrl(source.id)}
          sourceId={source.id}
          sourceWidth={source.width}
          sourceHeight={source.height}
          durationMs={source.durationMs}
          assumedSourceSize={data.assumedSourceSize}
          settings={data.settings}
          maxResolution={data.maxResolution}
          formId="editor-form"
          images={data.logoChoices.map((image) => ({
            id: image.id,
            url: fileUrl(image.id),
            width: image.width,
            height: image.height,
          }))}
        />
      </div>

      <p className="editor-preview-hint">
        Adjust the settings to customize your video. Update preview to see your
        latest changes.
      </p>
    </div>
  );
}

const Range = ({
  name,
  label,
  min,
  max,
  step,
  value,
}: {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}) => (
  <div className="editor-control">
    <label htmlFor={`editor-${name}`}>
      <span>{label}</span>
      <output id={`editor-range-${name}-value`}>{value}</output>
    </label>
    <input
      id={`editor-${name}`}
      type="range"
      name={name}
      min={min}
      max={max}
      step={step}
      defaultValue={value}
    />
  </div>
);

export function EditorForm({ data }: { data: EditorPageData }) {
  const { settings, source } = data;
  if (!source) return null;

  return (
    <form id="editor-form" method="get" action="/editor" className="editor-form">
      <input type="hidden" name="media" value={source.id} />

      <div className="editor-form-heading">
        <div>
          <span className="editor-eyebrow">CUSTOMIZE YOUR VIDEO</span>
          <h2>Editing controls</h2>
          <p>Fine-tune your video before exporting.</p>
        </div>
      </div>

      <details className="editor-accordion" open>
        <summary className="editor-accordion-summary"><span className="editor-section-number">01</span><span className="editor-accordion-title">Trim video</span><span className="editor-accordion-chevron" aria-hidden="true">⌄</span></summary>
        <fieldset className="editor-section">
        <legend className="sr-only">Trim video</legend>
        <p className="editor-section-description">
          Select the part of the video you want to keep.
        </p>

        <div className="editor-two-column">
          <div className="editor-control">
            <label htmlFor="editor-trim-start">Start time (seconds)</label>
            <input
              id="editor-trim-start"
              type="number"
              name="trimStart"
              min={0}
              max={source.durationMs ? source.durationMs / 1000 : undefined}
              step={0.01}
              required
              defaultValue={settings.trim.startSeconds}
            />
          </div>

          <div className="editor-control">
            <label htmlFor="editor-trim-end">End time (seconds)</label>
            <input
              id="editor-trim-end"
              type="number"
              name="trimEnd"
              min={0.01}
              max={source.durationMs ? source.durationMs / 1000 : undefined}
              step={0.01}
              required
              defaultValue={
                settings.trim.endSeconds ??
                (source.durationMs
                  ? source.durationMs / 1000
                  : Math.max(1, settings.trim.startSeconds + 1))
              }
            />
          </div>
        </div>

        <p className="editor-help-text">
          Times are measured from the start of the source video. Leave the end
          at the source duration to export through the final frame.
        </p>

        {!source.durationMs && (
          <p role="note" className="editor-inline-warning">
            The source duration is not verified. Rendering remains unavailable
            until it can be checked.
          </p>
        )}
        </fieldset>
      </details>

      <details className="editor-accordion" open>
        <summary className="editor-accordion-summary"><span className="editor-section-number">02</span><span className="editor-accordion-title">Shape &amp; position</span><span className="editor-accordion-chevron" aria-hidden="true">⌄</span></summary>
        <fieldset className="editor-section">
        <legend className="sr-only">Shape &amp; position</legend>
        <p className="editor-section-description">
          Choose your output format and adjust the video framing.
        </p>

        <div className="editor-control">
          <label htmlFor="editor-aspect">Aspect ratio</label>
          <select id="editor-aspect" name="aspect" defaultValue={settings.aspect}>
            {ASPECT_RATIOS.map((a) => (
              <option key={a} value={a}>{ASPECT_LABELS[a]}</option>
            ))}
          </select>
        </div>

        <div className="editor-control">
          <label htmlFor="editor-zoom">
            <span>Zoom</span>
            <output id="editor-range-zoom-value">
              {formatEditorZoomPercent(settings.zoom)}
            </output>
          </label>
          <input
            id="editor-zoom"
            type="range"
            name="zoom"
            min={1}
            max={3}
            step={0.05}
            defaultValue={settings.zoom}
          />
        </div>

        <div className="editor-zoom-actions" aria-label="Zoom controls">
          <button type="button" data-zoom-action="out" aria-label="Zoom out">−</button>
          <button type="button" data-zoom-action="in" aria-label="Zoom in">+</button>
          <button type="button" data-zoom-action="reset">Reset zoom</button>
        </div>

        <div className="editor-control-grid">
          <Range name="offsetX" label="Move left / right" min={-1} max={1} step={0.05} value={settings.offsetX} />
          <Range name="offsetY" label="Move up / down" min={-1} max={1} step={0.05} value={settings.offsetY} />
        </div>
        </fieldset>
      </details>

      <details className="editor-accordion">
        <summary className="editor-accordion-summary"><span className="editor-section-number">03</span><span className="editor-accordion-title">Background</span><span className="editor-accordion-chevron" aria-hidden="true">⌄</span></summary>
        <fieldset className="editor-section">
        <legend className="sr-only">Background</legend>
        <p className="editor-section-description">
          Select what appears behind your video.
        </p>

        <div className="editor-choice-grid">
          <label className="editor-choice-card">
            <input type="radio" name="bg" value="blur" defaultChecked={settings.background.kind === "blur"} />
            <span className="editor-choice-icon">◌</span>
            <span><strong>Blurred</strong><small>Video background</small></span>
          </label>

          <label className="editor-choice-card">
            <input type="radio" name="bg" value="solid" defaultChecked={settings.background.kind === "solid"} />
            <span className="editor-choice-icon">◧</span>
            <span><strong>Solid colour</strong><small>Single colour</small></span>
          </label>

          <label className="editor-choice-card">
            <input type="radio" name="bg" value="image" defaultChecked={settings.background.kind === "image"} />
            <span className="editor-choice-icon">▧</span>
            <span><strong>Image</strong><small>Your own image</small></span>
          </label>
        </div>

        <Range
          name="blur"
          label="Blur strength"
          min={1}
          max={40}
          step={1}
          value={settings.background.kind === "blur" ? settings.background.strength : 20}
        />

        <div className="editor-two-column">
          <div className="editor-control">
            <label htmlFor="editor-bg-color">Background colour</label>
            <input
              id="editor-bg-color"
              type="color"
              name="bgColor"
              defaultValue={settings.background.kind === "solid" ? settings.background.colorHex : "#000000"}
            />
          </div>

          {data.logoChoices.length > 0 && (
            <div className="editor-control">
              <label htmlFor="editor-bg-image">Background image</label>
              <select
                id="editor-bg-image"
                name="bgImage"
                defaultValue={settings.background.kind === "image" ? settings.background.mediaId : ""}
              >
                <option value="">Choose an image</option>
                {data.logoChoices.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        </fieldset>
      </details>

      <details className="editor-accordion">
        <summary className="editor-accordion-summary"><span className="editor-section-number">04</span><span className="editor-accordion-title">Border</span><span className="editor-accordion-chevron" aria-hidden="true">⌄</span></summary>
        <fieldset className="editor-section">
        <legend className="sr-only">Border</legend>
        <p className="editor-section-description">
          Add a border around the video itself.
        </p>

        <div className="editor-two-column">
          <div className="editor-control">
            <label htmlFor="editor-border-px">Thickness (px)</label>
            <input
              id="editor-border-px"
              type="number"
              name="borderPx"
              min={0}
              max={40}
              step={1}
              defaultValue={settings.border.thicknessPx}
            />
          </div>

          <div className="editor-control">
            <label htmlFor="editor-border-color">Border colour</label>
            <input
              id="editor-border-color"
              type="color"
              name="borderColor"
              defaultValue={settings.border.colorHex}
            />
          </div>
        </div>
        </fieldset>
      </details>

      <details className="editor-accordion">
        <summary className="editor-accordion-summary"><span className="editor-section-number">05</span><span className="editor-accordion-title">Logo</span><span className="editor-accordion-chevron" aria-hidden="true">⌄</span></summary>
        <fieldset className="editor-section">
        <legend className="sr-only">Logo</legend>
        <p className="editor-section-description">
          Add your brand image and position it on the video.
        </p>

        {data.logoChoices.length === 0 ? (
          <div className="editor-empty-note">
            <span aria-hidden="true">▧</span>
            <p>
              No images available yet. Upload an image in your{" "}
              <a href="/media">media library</a> to use it as a logo.
            </p>
          </div>
        ) : (
          <>
            <div className="editor-control">
              <label htmlFor="editor-logo-media">Logo image</label>
              <select
                id="editor-logo-media"
                name="logoMedia"
                defaultValue={settings.logo?.mediaId ?? ""}
              >
                <option value="">No logo</option>
                {data.logoChoices.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            </div>

            <div className="editor-control-grid">
              <Range name="logoWidth" label="Logo width" min={0.05} max={0.5} step={0.01} value={settings.logo?.widthFraction ?? 0.2} />
              <Range name="logoOpacity" label="Opacity" min={0.1} max={1} step={0.05} value={settings.logo?.opacity ?? 1} />
              <Range name="logoX" label="Horizontal position" min={0} max={1} step={0.01} value={settings.logo?.centerX ?? 0.85} />
              <Range name="logoY" label="Vertical position" min={0} max={1} step={0.01} value={settings.logo?.centerY ?? 0.1} />
            </div>

            <p className="editor-help-text">
              You can also drag the logo in the preview, then press Update
              preview.
            </p>
          </>
        )}
        </fieldset>
      </details>

      <div className="editor-form-actions">
        <button type="submit" className="editor-secondary-button" formNoValidate>
          Update preview
        </button>
        <EditorSession formId="editor-form" />
        <a href={`/editor?media=${encodeURIComponent(source.id)}`} className="editor-text-link">Reset</a>
        <a href={`/media/${encodeURIComponent(source.id)}`} className="editor-text-link">Cancel</a>
      </div>

      <p className="editor-settings-note">
        {data.settingsSource === "template"
          ? "This preview is the whole template. It is not saved on the video until you choose Save settings. Reset returns to the saved settings."
          : data.settingsSource === "preview"
            ? "This is an unsaved preview. Save settings to keep it, or Reset to return to the saved settings."
            : "These are the saved settings for this video."}
      </p>

      <button
        type="submit"
        className="editor-primary-button editor-save-settings"
        formMethod="post"
        formAction="/api/forms/editor-settings"
        formNoValidate
      >
        Save settings
      </button>

      <fieldset className="editor-section editor-template-form">
        <legend>Save as template</legend>
        <p className="editor-section-description">
          Reuse these editing settings on another video.
        </p>

        <div className="editor-control">
          <label htmlFor="editor-template-name">Template name</label>
          <input
            id="editor-template-name"
            type="text"
            name="name"
            maxLength={100}
            required
            placeholder="e.g. Instagram Reel Style"
          />
        </div>

        <button
          type="submit"
          className="editor-secondary-button"
          formMethod="post"
          formAction="/api/forms/editor-save"
        >
          Save as template
        </button>

        <p className="editor-help-text">
          Templates store only the settings. Your original video is never
          changed. Saving the same name and settings again does not create a
          duplicate.
        </p>

        {data.templates.length >= data.templateLimit && (
          <p role="status" className="editor-inline-warning">
            Your plan allows {data.templateLimit} saved template{data.templateLimit === 1 ? "" : "s"}, and that limit is reached.
          </p>
        )}
      </fieldset>
    </form>
  );
}

export function EditorView({ data }: { data: EditorPageData }) {
  const { source } = data;

  return (
    <main className="editor-page">
      <header className="editor-page-header">
        <div>
          <span className="editor-eyebrow">CLIPFORGE STUDIO</span>
          <h1>Video editor</h1>
          <p>Make your video fit every platform with simple, precise controls.</p>
        </div>
        {source && (
          <div className="editor-source-pill">
            <span className="editor-source-dot" />
            Editing selected video
          </div>
        )}
      </header>

      <div className="editor-notice">
        <span className="editor-notice-icon">i</span>
        <p>Rendering runs on this server and writes a new file. Your original video is always kept safe.</p>
      </div>

      {data.problems.length > 0 && (
        <ul role="alert" className="editor-problems">
          {data.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      {!source ? (
        <section className="editor-library-section">
          <div className="editor-section-heading">
            <div>
              <span className="editor-eyebrow">GET STARTED</span>
              <h2>Choose a video</h2>
              <p>Select a video from your media library to start editing.</p>
            </div>
            <a href="/media" className="editor-secondary-button">Open media library</a>
          </div>

          {data.videoChoices.length === 0 ? (
            <div className="editor-empty-state">
              <span className="editor-empty-icon">▧</span>
              <h3>Your video library is empty</h3>
              <p>Upload a video first, then come back here to edit it.</p>
              <a href="/media" className="editor-primary-button">Go to media library</a>
            </div>
          ) : (
            <ul className="editor-video-grid">
              {data.videoChoices.map((v) => (
                <li key={v.id} className="editor-video-card">
                  <a href={`/editor?media=${encodeURIComponent(v.id)}`} className="editor-video-card-link">
                    <div className="editor-video-thumbnail"><Thumbnail media={v} /></div>
                    <div className="editor-video-card-info">
                      <strong>{v.title}</strong>
                      <span>Open in editor <span aria-hidden="true">→</span></span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          <section className="editor-current-video">
            <div>
              <span className="editor-eyebrow">CURRENT PROJECT</span>
              <h2>{source.title}</h2>
              <p>
                Export resolution:{" "}
                <strong>{data.maxResolution === "original" ? "Original resolution" : data.maxResolution}</strong>
              </p>
            </div>
            <a href={`/media/${encodeURIComponent(source.id)}`} className="editor-text-link">
              ← Media details
            </a>
          </section>

          <div className="editor-workspace">
            <div className="editor-preview-column">
              <EditorPreview data={data} />
              <button
                type="submit"
                form="editor-form"
                formAction="/api/forms/render"
                formMethod="post"
                formNoValidate
                className="editor-render-button"
              >
                <span aria-hidden="true">▶</span>
                Render video
              </button>

              {data.job && (
                <section className="editor-render-status" aria-labelledby="render-status-heading">
                  <div className="editor-panel-heading">
                    <div>
                      <span className="editor-eyebrow">EXPORT</span>
                      <h2 id="render-status-heading">Render status</h2>
                    </div>
                    <span className={`editor-status-pill editor-status-${data.job.status}`}>
                      {data.job.status}
                    </span>
                  </div>
                  {data.job.refreshPath && (
                    <meta httpEquiv="refresh" content={`2;url=${data.job.refreshPath}`} />
                  )}
                  {data.job.message && <p>{data.job.message}</p>}
                  {data.job.status === "completed" && data.job.outputId && (
                    <a
                      className="editor-primary-button"
                      href={`/api/renders/file?id=${encodeURIComponent(data.job.outputId)}`}
                    >
                      Download export
                    </a>
                  )}
                </section>
              )}
            </div>

            <div className="editor-controls-column">
              <EditorForm data={data} />
            </div>
          </div>
        </>
      )}

      <section className="editor-library-section editor-assets-section">
        <div className="editor-section-heading">
          <div>
            <span className="editor-eyebrow">REUSABLE SETTINGS</span>
            <h2>Your templates <span className="editor-count">{data.templates.length}/{data.templateLimit}</span></h2>
            <p>Apply a saved editing style to another video.</p>
          </div>
        </div>

        {data.templates.length === 0 ? (
          <div className="editor-compact-empty">
            <span>✳</span>
            <p>No templates saved yet. Save your editing settings as a template to reuse them later.</p>
          </div>
        ) : (
          <ul className="editor-template-grid">
            {data.templates.map((t) => (
              <li key={t.id} className="editor-template-card">
                <div className="editor-template-icon">✳</div>
                <div className="editor-template-info">
                  <strong>{t.name}</strong>
                  <span>{t.summary}</span>
                </div>
                {source ? (
                  <a href={`/editor?media=${encodeURIComponent(source.id)}&template=${encodeURIComponent(t.id)}`}>
                    Apply →
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="editor-exports-heading">
          <div>
            <span className="editor-eyebrow">COMPLETED WORK</span>
            <h2>Exports</h2>
          </div>
        </div>

        {data.exports.length === 0 ? (
          <div className="editor-compact-empty">
            <span>⇧</span>
            <p>No finished exports yet. A render appears here only after its file has been checked.</p>
          </div>
        ) : (
          <ul className="editor-export-list">
            {data.exports.map((item) => (
              <li key={item.id}>
                <div className="editor-export-icon">▶</div>
                <div className="editor-export-info">
                  <strong>{item.sourceTitle}</strong>
                  <span>{item.aspect} · {item.createdOn}</span>
                </div>
                <a href={`/api/renders/file?id=${encodeURIComponent(item.id)}`}>Download ↓</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
