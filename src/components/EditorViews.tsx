import { ASPECT_RATIOS } from "../lib/render/ffmpeg-command.ts";
import { LogoDragger } from "./LogoDragger.tsx";
import { Thumbnail } from "./MediaTable.tsx";
import type { EditorPageData } from "../server/queries.ts";

const ASPECT_LABELS: Record<(typeof ASPECT_RATIOS)[number], string> = { "9:16": "9:16 (Reels, recommended)", "4:5": "4:5 (portrait post)", "1:1": "1:1 (square)", "16:9": "16:9 (landscape)", original: "Original" };

/** A to-scale sketch of the layout. It is NOT a rendered video and says so. */
export function EditorPreview({ data }: { data: EditorPageData }) {
  const { layout, settings, source } = data;
  if (!layout || !source) return null;
  const { canvas, video, borderBox, logo } = layout;
  const thumb = source.hasThumbnail ? `/api/media/file?id=${encodeURIComponent(source.id)}&variant=thumbnail` : null;
  return (
    <figure>
      <svg id="editor-preview" viewBox={`0 0 ${canvas.width} ${canvas.height}`} role="img" aria-label="Layout sketch of the edited video" style={{ width: "100%", maxWidth: "22rem", border: "1px solid var(--border)" }}>
        <defs><clipPath id="canvas-clip"><rect width={canvas.width} height={canvas.height} /></clipPath></defs>
        <g clipPath="url(#canvas-clip)">
          <rect width={canvas.width} height={canvas.height} fill={settings.background.kind === "solid" ? settings.background.colorHex : "#777777"} data-background={settings.background.kind} />
          {settings.background.kind === "blur" && thumb && <image href={thumb} width={canvas.width} height={canvas.height} preserveAspectRatio="xMidYMid slice" opacity={0.45} />}
          {layout.borderPx > 0 && <rect data-border x={borderBox.x} y={borderBox.y} width={borderBox.width} height={borderBox.height} fill={settings.border.colorHex} />}
          {thumb ? <image data-video href={thumb} x={video.x} y={video.y} width={video.width} height={video.height} preserveAspectRatio="none" /> : <rect data-video x={video.x} y={video.y} width={video.width} height={video.height} fill="#444444" />}
          {logo && settings.logo && (
            <g opacity={settings.logo.opacity}>
              <rect data-logo-handle data-x={settings.logo.centerX} data-y={settings.logo.centerY} x={logo.x} y={logo.y} width={logo.width} height={logo.height} fill="rgba(255,235,59,0.75)" stroke="#000000" strokeWidth={Math.max(2, canvas.width / 270)} strokeDasharray="12 8" style={{ cursor: "move", touchAction: "none" }} />
            </g>
          )}
        </g>
      </svg>
      <figcaption className="muted">Layout sketch ({canvas.width} × {canvas.height}), not a rendered video. {data.assumedSourceSize ? "The video's size is unknown, so a 16:9 picture is assumed. " : ""}Background rendering is not connected yet.</figcaption>
      {logo && <LogoDragger svgId="editor-preview" formId="editor-form" />}
    </figure>
  );
}

const Range = ({ name, label, min, max, step, value }: { name: string; label: string; min: number; max: number; step: number; value: number }) =>
  <p><label>{label}: {value}<br /><input type="range" name={name} min={min} max={max} step={step} defaultValue={value} /></label></p>;

export function EditorForm({ data }: { data: EditorPageData }) {
  const { settings, source } = data;
  if (!source) return null;
  return (
    <form id="editor-form" method="get" action="/editor">
      <input type="hidden" name="media" value={source.id} />
      <fieldset>
        <legend>Shape</legend>
        <p><label>Aspect ratio<br /><select name="aspect" defaultValue={settings.aspect}>{ASPECT_RATIOS.map((a) => <option key={a} value={a}>{ASPECT_LABELS[a]}</option>)}</select></label></p>
        <Range name="zoom" label="Zoom" min={1} max={3} step={0.05} value={settings.zoom} />
        <Range name="offsetX" label="Move left / right" min={-1} max={1} step={0.05} value={settings.offsetX} />
        <Range name="offsetY" label="Move up / down" min={-1} max={1} step={0.05} value={settings.offsetY} />
      </fieldset>
      <fieldset>
        <legend>Background</legend>
        <p><label><input type="radio" name="bg" value="blur" defaultChecked={settings.background.kind === "blur"} /> Blurred copy of the video</label>{" "}
          <label><input type="radio" name="bg" value="solid" defaultChecked={settings.background.kind === "solid"} /> Solid colour</label></p>
        <Range name="blur" label="Blur strength" min={1} max={40} step={1} value={settings.background.kind === "blur" ? settings.background.strength : 20} />
        <p><label>Colour<br /><input type="color" name="bgColor" defaultValue={settings.background.kind === "solid" ? settings.background.colorHex : "#000000"} /></label></p>
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
      <p><button type="submit" formNoValidate>Update preview</button></p>
      <fieldset>
        <legend>Save these settings</legend>
        <p><label>Template name<br /><input type="text" name="name" maxLength={100} required /></label></p>
        <button type="submit" formMethod="post" formAction="/api/forms/editor-save">Save as template</button>
        <p className="muted">Templates hold only the settings. The original video is never changed.</p>
      </fieldset>
    </form>
  );
}

export function EditorView({ data }: { data: EditorPageData }) {
  const { source } = data;
  return (
    <>
      <h1>Editor</h1>
      <p role="note" className="notice">Rendering is not connected yet: this editor builds and saves settings and shows a layout sketch. No video is rendered, exported or published from here.</p>
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
          <p><button type="button" disabled>Render video (not available yet)</button></p>
        </>
      )}
      <section aria-labelledby="templates-heading">
        <h2 id="templates-heading">Your templates ({data.templates.length} of {data.templateLimit})</h2>
        {data.templates.length === 0 ? <p>No templates yet.</p> : <ul>{data.templates.map((t) => <li key={t.id}><strong>{t.name}</strong> <span className="muted">{t.summary}</span></li>)}</ul>}
        <p className="muted">Applying a template to videos in a cycle is not available yet.</p>
      </section>
    </>
  );
}
