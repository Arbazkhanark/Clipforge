// Editing settings: what the user chose in the editor. They are stored SEPARATELY from media (as a template that
// refers to media only by id) and never change an original file. Validation reuses the renderer's own rules.
import { ASPECT_RATIOS, computeRenderLayout, validateRenderSettings, type AspectRatio, type MaxResolution, type RenderSettings } from "../render/ffmpeg-command.ts";

export interface EditingSettings {
  aspect: AspectRatio;
  background: { kind: "solid"; colorHex: string } | { kind: "blur"; strength: number } | { kind: "image"; mediaId: string };
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Drawn around the main video itself, not around the whole canvas. */
  border: { thicknessPx: number; colorHex: string };
  /** An image from the user's own library, placed by its centre (fractions of the canvas). */
  logo: null | { mediaId: string; widthFraction: number; centerX: number; centerY: number; opacity: number };
}

export const DEFAULT_EDITING_SETTINGS: EditingSettings = {
  aspect: "9:16", background: { kind: "blur", strength: 20 }, zoom: 1, offsetX: 0, offsetY: 0, border: { thicknessPx: 0, colorHex: "#ffffff" }, logo: null,
};

/** Per-video saved settings use this name in the template table. They are not user templates and do not use the template cap. */
export const videoSettingsName = (mediaId: string): string => `v:${mediaId}`;
export const isReservedTemplateName = (name: string): boolean => name.startsWith("v:");

/** Only used to run the range checks; the real source dimensions do not affect which values are allowed. */
const NOMINAL_SOURCE = { width: 1920, height: 1080, durationSeconds: 1 };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type ParsedSettings = { ok: true; settings: EditingSettings } | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Turns the editor's JSON-like input into settings, or explains every problem. Unknown keys are dropped. */
export function parseEditingSettings(raw: unknown): ParsedSettings {
  if (!isObject(raw)) return { ok: false, problems: ["Settings must be an object."] };
  const problems: string[] = [];
  const num = (value: unknown, label: string): number => { if (typeof value !== "number" || !Number.isFinite(value)) { problems.push(`${label} must be a number.`); return 0; } return value; };

  const aspect = raw["aspect"];
  if (typeof aspect !== "string" || !(ASPECT_RATIOS as readonly string[]).includes(aspect)) problems.push("Choose a supported aspect ratio.");

  let background: EditingSettings["background"] = DEFAULT_EDITING_SETTINGS.background;
  const bg = raw["background"];
  if (!isObject(bg)) problems.push("Choose a background.");
  else if (bg["kind"] === "solid") background = { kind: "solid", colorHex: typeof bg["colorHex"] === "string" ? bg["colorHex"] : "" };
  else if (bg["kind"] === "blur") background = { kind: "blur", strength: num(bg["strength"], "Blur strength") };
  else if (bg["kind"] === "image") {
    if (typeof bg["mediaId"] !== "string" || !ID.test(bg["mediaId"])) problems.push("The background image must be one of your images.");
    else background = { kind: "image", mediaId: bg["mediaId"] };
  } else problems.push("Background must be a solid colour, a blurred copy of the video, or one of your images.");

  const border = isObject(raw["border"]) ? raw["border"] : null;
  if (!border) problems.push("Border settings are missing.");
  const thicknessPx = num(border?.["thicknessPx"], "Border thickness");
  const borderColor = typeof border?.["colorHex"] === "string" ? border["colorHex"] : "#000000";

  let logo: EditingSettings["logo"] = null;
  const rawLogo = raw["logo"];
  if (rawLogo !== null && rawLogo !== undefined) {
    if (!isObject(rawLogo) || typeof rawLogo["mediaId"] !== "string" || !ID.test(rawLogo["mediaId"])) problems.push("The logo must be one of your images.");
    else logo = { mediaId: rawLogo["mediaId"], widthFraction: num(rawLogo["widthFraction"], "Logo width"), centerX: num(rawLogo["centerX"], "Logo horizontal position"), centerY: num(rawLogo["centerY"], "Logo vertical position"), opacity: num(rawLogo["opacity"], "Logo opacity") };
  }

  const settings: EditingSettings = { aspect: aspect as AspectRatio, background, zoom: num(raw["zoom"], "Zoom"), offsetX: num(raw["offsetX"], "Horizontal position"), offsetY: num(raw["offsetY"], "Vertical position"), border: { thicknessPx, colorHex: borderColor }, logo };
  if (problems.length > 0) return { ok: false, problems };

  // Range and colour rules come from the renderer itself, so the editor can never accept what the renderer would refuse.
  const rangeProblems = validateRenderSettings(toRenderSettings(settings, "1080p"), NOMINAL_SOURCE);
  return rangeProblems.length > 0 ? { ok: false, problems: rangeProblems } : { ok: true, settings };
}

/** Editing settings -> renderer settings. The resolution cap comes from the PLAN, never from the saved settings. */
export function toRenderSettings(s: EditingSettings, maxResolution: MaxResolution): RenderSettings {
  return {
    aspect: s.aspect, maxResolution, background: s.background.kind === "image" ? { kind: "image" } : s.background, zoom: s.zoom, offsetX: s.offsetX, offsetY: s.offsetY, border: s.border,
    ...(s.logo ? { logo: { widthFraction: s.logo.widthFraction, centerX: s.logo.centerX, centerY: s.logo.centerY, opacity: s.logo.opacity } } : {}),
  };
}

export interface PreviewLayout {
  canvas: { width: number; height: number };
  /** The video picture itself (without its border). */
  video: { x: number; y: number; width: number; height: number };
  /** The whole main-video area including the border. Equals `video` when there is no border. */
  borderBox: { x: number; y: number; width: number; height: number };
  borderPx: number;
  logo: null | { x: number; y: number; width: number; height: number };
}

/** Where everything goes for the preview sketch. Same maths as the renderer (computeRenderLayout). */
export function computePreviewLayout(s: EditingSettings, source: { width: number; height: number }, logoAspect = 1, maxResolution: MaxResolution = "1080p"): PreviewLayout {
  const layout = computeRenderLayout(toRenderSettings(s, maxResolution), { width: source.width, height: source.height, durationSeconds: 1 });
  const { canvas, box, border } = layout;
  let logo: PreviewLayout["logo"] = null;
  if (s.logo && layout.logoWidth) {
    const height = Math.round(layout.logoWidth / (logoAspect > 0 ? logoAspect : 1));
    logo = { width: layout.logoWidth, height, x: Math.round(s.logo.centerX * canvas.width - layout.logoWidth / 2), y: Math.round(s.logo.centerY * canvas.height - height / 2) };
  }
  return { canvas, borderPx: border, borderBox: { ...box }, video: { x: box.x + border, y: box.y + border, width: layout.videoWidth, height: layout.videoHeight }, logo };
}

type Search = Record<string, string | string[] | undefined>;

/**
 * Builds the raw candidate settings from flat form/query fields. `onBadNumber` decides what a non-numeric value becomes:
 * the preview uses a default (and reports the problem); saving uses NaN so the strict parser refuses it.
 */
export function editorCandidateFromFields(get: (key: string) => string | undefined, onBadNumber: (label: string, fallback: number) => number): unknown {
  const number = (key: string, fallback: number, label: string): number => {
    const v = get(key); if (v === undefined || v === "") return fallback;
    const n = Number(v); return Number.isFinite(n) ? n : onBadNumber(label, fallback);
  };
  const d = DEFAULT_EDITING_SETTINGS; const logoMedia = get("logoMedia"); const bg = get("bg") ?? d.background.kind;
  return {
    aspect: get("aspect") ?? d.aspect,
    background: bg === "solid" ? { kind: "solid", colorHex: get("bgColor") ?? "#000000" } : bg === "image" ? { kind: "image", mediaId: get("bgImage") ?? "" } : { kind: "blur", strength: number("blur", 20, "Blur strength") },
    zoom: number("zoom", d.zoom, "Zoom"), offsetX: number("offsetX", 0, "Horizontal position"), offsetY: number("offsetY", 0, "Vertical position"),
    border: { thicknessPx: number("borderPx", 0, "Border thickness"), colorHex: get("borderColor") ?? "#ffffff" },
    logo: logoMedia ? { mediaId: logoMedia, widthFraction: number("logoWidth", 0.2, "Logo width"), centerX: number("logoX", 0.85, "Logo horizontal position"), centerY: number("logoY", 0.1, "Logo vertical position"), opacity: number("logoOpacity", 1, "Logo opacity") } : null,
  };
}

/** Reads the editor's form fields from a query string. Bad values are reported and replaced by the defaults. */
export function parseEditorQuery(search: Search | undefined): { settings: EditingSettings; problems: string[] } {
  if (!search) return { settings: DEFAULT_EDITING_SETTINGS, problems: [] };
  const problems: string[] = [];
  const candidate = editorCandidateFromFields((k) => { const v = search[k]; return typeof v === "string" ? v : undefined; }, (label, fallback) => { problems.push(`${label} must be a number.`); return fallback; });
  const parsed = parseEditingSettings(candidate);
  return parsed.ok ? { settings: parsed.settings, problems } : { settings: DEFAULT_EDITING_SETTINGS, problems: [...problems, ...parsed.problems] };
}
