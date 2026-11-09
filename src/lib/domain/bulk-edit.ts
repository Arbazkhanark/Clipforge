// Pure rules for applying SOME editor settings to a video and leaving the rest untouched.
import { ASPECT_RATIOS, type AspectRatio } from "../render/ffmpeg-command.ts";
import { DEFAULT_EDITING_SETTINGS, parseEditingSettings, type EditingSettings } from "./editing-settings.ts";

export const BULK_FIELDS = ["aspect", "background", "bgColor", "bgImage", "blur", "zoom", "offsetX", "offsetY", "borderEnabled", "borderColor", "borderThickness", "logo", "logoPosition", "logoSize", "logoOpacity"] as const;
export type BulkField = (typeof BULK_FIELDS)[number];

export interface SettingsPatch {
  aspect?: AspectRatio;
  backgroundKind?: "solid" | "blur" | "image";
  solidColor?: string;
  backgroundImageId?: string;
  blurStrength?: number;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
  borderEnabled?: boolean;
  borderColor?: string;
  borderThickness?: number;
  clearLogo?: boolean;
  logoMediaId?: string;
  logoPosition?: { centerX: number; centerY: number };
  logoSize?: number;
  logoOpacity?: number;
  trim?: EditingSettings["trim"];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function selectionAfter(current: readonly string[], videos: readonly string[], action: "all" | "clear" | { toggle: string }): string[] {
  if (action === "all") return [...videos];
  if (action === "clear") return [];
  const id = action.toggle;
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

function num(raw: string | undefined, label: string, problems: string[]): number | undefined {
  if (raw === undefined || raw.trim() === "") { problems.push(`${label} is missing.`); return undefined; }
  const value = Number(raw);
  if (!Number.isFinite(value)) { problems.push(`${label} must be a number.`); return undefined; }
  return value;
}

/** Reads the ticked fields. Unticked fields are absent from the patch, so each video keeps them. */
export function parseBulkForm(get: (key: string) => string | undefined, getAll: (key: string) => string[]): { ok: true; mediaIds: string[]; patch: SettingsPatch; lines: string[]; styleTemplateId?: string; copyTemplateTrim: boolean } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const mediaIds: string[] = [];
  for (const id of getAll("media")) {
    if (!ID.test(id)) problems.push("One selected video id is not valid.");
    else if (!mediaIds.includes(id)) mediaIds.push(id);
  }
  if (mediaIds.length === 0) problems.push("Choose at least one video.");
  const use = new Set(getAll("use").filter((field): field is BulkField => (BULK_FIELDS as readonly string[]).includes(field)));
  const styleTemplateId = get("styleTemplateId")?.trim() || undefined;
  const copyTemplateTrim = get("copyTemplateTrim") === "yes";
  if (styleTemplateId && !ID.test(styleTemplateId)) problems.push("Choose one of your saved styles.");
  if (styleTemplateId && use.size > 0) problems.push("Choose a saved style or individual settings, not both.");
  if (!styleTemplateId && use.size === 0) problems.push("Choose a saved style or at least one setting to apply.");
  if (copyTemplateTrim && !styleTemplateId) problems.push("Choose a saved style before copying its trim range.");
  const patch: SettingsPatch = {};
  const lines: string[] = [];
  if (use.has("aspect")) {
    const aspect = get("aspect");
    if (!aspect || !(ASPECT_RATIOS as readonly string[]).includes(aspect)) problems.push("Choose a supported aspect ratio.");
    else { patch.aspect = aspect as AspectRatio; lines.push(`Aspect ratio: ${aspect}`); }
  }
  if (use.has("background")) {
    const kind = get("bg");
    if (kind !== "solid" && kind !== "blur" && kind !== "image") problems.push("Choose a background type.");
    else { patch.backgroundKind = kind; lines.push(`Background type: ${kind === "blur" ? "blurred video" : kind === "solid" ? "solid colour" : "image"}`); }
  }
  if (use.has("bgColor")) {
    const color = get("bgColor") ?? "";
    if (!HEX.test(color)) problems.push("Background colour must look like #1A2B3C.");
    else { patch.solidColor = color; lines.push(`Solid colour: ${color}`); }
  }
  if (use.has("bgImage")) {
    const id = get("bgImage") ?? "";
    if (!ID.test(id)) problems.push("Choose one of your images for the background.");
    else { patch.backgroundImageId = id; lines.push("Background image: one of your images"); }
  }
  if (use.has("blur")) {
    const strength = num(get("blur"), "Blur strength", problems);
    if (strength !== undefined) { patch.blurStrength = strength; lines.push(`Blur strength: ${strength}`); }
  }
  if (use.has("zoom")) { const zoom = num(get("zoom"), "Zoom", problems); if (zoom !== undefined) { patch.zoom = zoom; lines.push(`Zoom: ${zoom}`); } }
  if (use.has("offsetX")) { const offsetX = num(get("offsetX"), "Horizontal position", problems); if (offsetX !== undefined) { patch.offsetX = offsetX; lines.push(`Horizontal position: ${offsetX}`); } }
  if (use.has("offsetY")) { const offsetY = num(get("offsetY"), "Vertical position", problems); if (offsetY !== undefined) { patch.offsetY = offsetY; lines.push(`Vertical position: ${offsetY}`); } }
  if (use.has("borderEnabled")) {
    const on = get("borderOn");
    if (on !== "yes" && on !== "no") problems.push("Choose whether the border is on or off.");
    else { patch.borderEnabled = on === "yes"; lines.push(on === "yes" ? "Border: on" : "Border: off"); }
  }
  if (use.has("borderColor")) {
    const color = get("borderColor") ?? "";
    if (!HEX.test(color)) problems.push("Border colour must look like #1A2B3C.");
    else { patch.borderColor = color; lines.push(`Border colour: ${color}`); }
  }
  if (use.has("borderThickness")) {
    const thickness = num(get("borderPx"), "Border thickness", problems);
    if (thickness !== undefined) { patch.borderThickness = thickness; lines.push(`Border thickness: ${thickness}px`); }
  }
  if (use.has("logo")) {
    const id = get("logoMedia") ?? "";
    if (id === "") { patch.clearLogo = true; lines.push("Logo: removed"); }
    else if (!ID.test(id)) problems.push("Choose one of your images for the logo.");
    else { patch.logoMediaId = id; lines.push("Logo image: one of your images"); }
  }
  if (use.has("logoPosition")) {
    const centerX = num(get("logoX"), "Logo horizontal position", problems);
    const centerY = num(get("logoY"), "Logo vertical position", problems);
    if (centerX !== undefined && centerY !== undefined) { patch.logoPosition = { centerX, centerY }; lines.push(`Logo position: ${centerX}, ${centerY}`); }
  }
  if (use.has("logoSize")) { const logoSize = num(get("logoWidth"), "Logo size", problems); if (logoSize !== undefined) { patch.logoSize = logoSize; lines.push(`Logo size: ${logoSize}`); } }
  if (use.has("logoOpacity")) { const logoOpacity = num(get("logoOpacity"), "Logo opacity", problems); if (logoOpacity !== undefined) { patch.logoOpacity = logoOpacity; lines.push(`Logo opacity: ${logoOpacity}`); } }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, mediaIds, patch, lines, ...(styleTemplateId ? { styleTemplateId } : {}), copyTemplateTrim };
}

/**
 * Applies only the fields in the patch. A ticked field that cannot apply (a colour on a blurred video, a logo
 * position when there is no logo) is reported and left unchanged.
 */
export function applySettingsPatch(current: EditingSettings, patch: SettingsPatch): { settings: EditingSettings; notes: string[] } {
  const notes: string[] = [];
  let next: EditingSettings = { ...current, border: { ...current.border }, logo: current.logo ? { ...current.logo } : null, background: current.background.kind === "solid" ? { ...current.background } : current.background.kind === "image" ? { ...current.background } : { ...current.background } };
  if (patch.aspect) next.aspect = patch.aspect;
  if (patch.zoom !== undefined) next.zoom = patch.zoom;
  if (patch.offsetX !== undefined) next.offsetX = patch.offsetX;
  if (patch.offsetY !== undefined) next.offsetY = patch.offsetY;
  if (patch.trim) next.trim = { ...patch.trim };

  let background = next.background;
  if (patch.backgroundKind === "solid") background = { kind: "solid", colorHex: patch.solidColor ?? (background.kind === "solid" ? background.colorHex : "#000000") };
  else if (patch.backgroundKind === "blur") background = { kind: "blur", strength: patch.blurStrength ?? (background.kind === "blur" ? background.strength : 20) };
  else if (patch.backgroundKind === "image") {
    if (patch.backgroundImageId) background = { kind: "image", mediaId: patch.backgroundImageId };
    else notes.push("Background type was not changed because no image was chosen.");
  }
  if (patch.solidColor && patch.backgroundKind !== "solid") {
    if (!patch.backgroundKind && background.kind === "solid") background = { kind: "solid", colorHex: patch.solidColor };
    else notes.push("Solid colour was left unchanged because this background is not a solid colour.");
  }
  if (patch.backgroundImageId && patch.backgroundKind !== "image") {
    if (!patch.backgroundKind && background.kind === "image") background = { kind: "image", mediaId: patch.backgroundImageId };
    else notes.push("Background image was left unchanged because this background is not an image.");
  }
  if (patch.blurStrength !== undefined && patch.backgroundKind !== "blur") {
    if (!patch.backgroundKind && background.kind === "blur") background = { kind: "blur", strength: patch.blurStrength };
    else notes.push("Blur strength was left unchanged because this background is not a blurred video.");
  }
  next.background = background;

  if (patch.borderEnabled === false) next.border = { ...next.border, thicknessPx: 0 };
  if (patch.borderEnabled === true && patch.borderThickness === undefined && next.border.thicknessPx === 0) next.border = { ...next.border, thicknessPx: 8 };
  if (patch.borderThickness !== undefined) next.border = { ...next.border, thicknessPx: patch.borderThickness };
  if (patch.borderColor) next.border = { ...next.border, colorHex: patch.borderColor };

  if (patch.clearLogo) next.logo = null;
  else if (patch.logoMediaId || patch.logoPosition || patch.logoSize !== undefined || patch.logoOpacity !== undefined) {
    if (!next.logo && !patch.logoMediaId) notes.push("Logo changes were left unchanged because this video has no logo.");
    else next.logo = {
      mediaId: patch.logoMediaId ?? next.logo!.mediaId,
      widthFraction: patch.logoSize ?? next.logo?.widthFraction ?? 0.2,
      centerX: patch.logoPosition?.centerX ?? next.logo?.centerX ?? 0.85,
      centerY: patch.logoPosition?.centerY ?? next.logo?.centerY ?? 0.1,
      opacity: patch.logoOpacity ?? next.logo?.opacity ?? 1,
    };
  }
  return { settings: next, notes };
}

/** Confirms the merged settings are still something the renderer can accept. */
export function checkedPatch(current: EditingSettings, patch: SettingsPatch): { ok: true; settings: EditingSettings; notes: string[] } | { ok: false; problems: string[] } {
  const applied = applySettingsPatch(current, patch);
  const parsed = parseEditingSettings(applied.settings);
  return parsed.ok ? { ok: true, settings: parsed.settings, notes: applied.notes } : { ok: false, problems: parsed.problems };
}

export const samplePreviewSettings = (patch: SettingsPatch): EditingSettings => applySettingsPatch(DEFAULT_EDITING_SETTINGS, patch).settings;
