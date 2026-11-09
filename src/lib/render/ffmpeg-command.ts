// Builds the FFmpeg command for ClipForge's video editor. PURE: it only returns an array of
// arguments; nothing is executed here (see render-runner.ts).
//
// SECURITY: every value that ends up inside the FFmpeg filter graph is a number we computed or a
// hex colour we validated with a strict pattern. User text never goes into the filter graph, and
// the command is run WITHOUT a shell, so file names cannot inject commands.

export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9", "original"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type MaxResolution = "720p" | "1080p" | "original";

export type BackgroundSettings =
  | { kind: "solid"; colorHex: string }
  | { kind: "blur"; strength?: number }
  /** A still image the server already stored. The file path is chosen by the server, never by the request. */
  | { kind: "image" };

export interface BorderSettings { thicknessPx: number; colorHex: string; }

export interface LogoOverlaySettings {
  /** Logo width as a fraction of the canvas width (0.05 - 0.5). */
  widthFraction: number;
  /** Logo CENTRE as a fraction of the canvas (0 = left/top, 1 = right/bottom). */
  centerX: number;
  centerY: number;
  opacity: number; // 0.1 - 1
}

export interface RenderSettings {
  aspect: AspectRatio;
  /** Comes from the user's plan (catalog.ts features.maxResolution). */
  maxResolution: MaxResolution;
  background: BackgroundSettings;
  /** 1 = fit inside the canvas. Up to 3. */
  zoom: number;
  /** Move the main video: -1 (left/up) to 1 (right/down), as a fraction of half the canvas. */
  offsetX: number;
  offsetY: number;
  /** Optional source-time range. Omitted or null end keeps the existing full-video export behavior. */
  trim?: { startSeconds: number; endSeconds: number | null };
  /** The border is drawn around the MAIN VIDEO itself, not around the whole canvas. */
  border: BorderSettings;
  logo?: LogoOverlaySettings;
}

export interface SourceVideoInfo { width: number; height: number; durationSeconds: number; }

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export class InvalidRenderSettingsError extends Error {
  problems: string[];
  constructor(problems: string[]) { super(`Invalid render settings: ${problems.join(" ")}`); this.name = "InvalidRenderSettingsError"; this.problems = problems; }
}

const makeEven = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const inRange = (n: number, min: number, max: number): boolean => Number.isFinite(n) && n >= min && n <= max;

export function validateRenderSettings(settings: RenderSettings, source: SourceVideoInfo): string[] {
  const problems: string[] = [];
  if (!(ASPECT_RATIOS as readonly string[]).includes(settings.aspect)) problems.push("Unsupported aspect ratio.");
  if (!["720p", "1080p", "original"].includes(settings.maxResolution)) problems.push("Unsupported resolution.");
  if (settings.background.kind === "solid") { if (!HEX_COLOR.test(settings.background.colorHex)) problems.push("Background colour must look like #1A2B3C."); }
  else if (settings.background.kind === "blur") { if (settings.background.strength !== undefined && !inRange(settings.background.strength, 1, 40)) problems.push("Blur strength must be 1 to 40."); }
  else if (settings.background.kind !== "image") problems.push("Unsupported background.");
  if (!inRange(settings.zoom, 1, 3)) problems.push("Zoom must be between 1 and 3.");
  if (!inRange(settings.offsetX, -1, 1) || !inRange(settings.offsetY, -1, 1)) problems.push("Position offsets must be between -1 and 1.");
  if (!Number.isInteger(settings.border.thicknessPx) || !inRange(settings.border.thicknessPx, 0, 40)) problems.push("Border thickness must be a whole number from 0 to 40.");
  if (settings.border.thicknessPx > 0 && !HEX_COLOR.test(settings.border.colorHex)) problems.push("Border colour must look like #1A2B3C.");
  if (settings.logo) {
    const l = settings.logo;
    if (!inRange(l.widthFraction, 0.05, 0.5)) problems.push("Logo width must be 5% to 50% of the video.");
    if (!inRange(l.centerX, 0, 1) || !inRange(l.centerY, 0, 1)) problems.push("Logo position must be inside the video.");
    if (!inRange(l.opacity, 0.1, 1)) problems.push("Logo opacity must be 10% to 100%.");
  }
  if (!(source.width > 0 && source.height > 0 && source.durationSeconds > 0)) problems.push("Source video information is missing.");
  const trimStart = settings.trim?.startSeconds ?? 0;
  const configuredTrimEnd = settings.trim?.endSeconds;
  const hasValidDuration = Number.isFinite(source.durationSeconds) && source.durationSeconds > 0;
  if (!Number.isFinite(trimStart) || trimStart < 0) problems.push("Trim start time cannot be negative.");
  if (configuredTrimEnd !== null && configuredTrimEnd !== undefined) {
    if (!Number.isFinite(configuredTrimEnd) || configuredTrimEnd <= trimStart) problems.push("Trim end time must be greater than the start time.");
    else if (hasValidDuration && configuredTrimEnd > source.durationSeconds) problems.push("The trim range cannot extend past the source video's duration.");
  } else if (hasValidDuration && source.durationSeconds <= trimStart) {
    problems.push("Trim end time must be greater than the start time.");
  }
  return problems;
}

/** Output canvas size for an aspect ratio, capped by the plan's maximum resolution. */
export function canvasSizeFor(aspect: AspectRatio, maxResolution: MaxResolution, source: SourceVideoInfo): { width: number; height: number } {
  const base: Record<AspectRatio, { width: number; height: number }> = {
    "9:16": { width: 1080, height: 1920 }, "4:5": { width: 1080, height: 1350 }, "1:1": { width: 1080, height: 1080 },
    "16:9": { width: 1920, height: 1080 }, original: { width: source.width, height: source.height },
  };
  const wanted = base[aspect];
  const shortSideCap = maxResolution === "720p" ? 720 : maxResolution === "1080p" ? 1080 : Infinity;
  const shortSide = Math.min(wanted.width, wanted.height);
  const scale = shortSide > shortSideCap ? shortSideCap / shortSide : 1;
  return { width: makeEven(wanted.width * scale), height: makeEven(wanted.height * scale) };
}

export interface RenderLayout {
  canvas: { width: number; height: number };
  videoWidth: number; videoHeight: number; border: number;
  /** The main video area INCLUDING its border, on the canvas (x/y may be negative when zoomed or moved past the edge). */
  box: { width: number; height: number; x: number; y: number };
  /** Logo width in pixels, or null when there is no logo. Its height depends on the logo image. */
  logoWidth: number | null;
}

/** The ONE place that decides where things go. Used by the real renderer AND the editor preview, so they cannot drift apart. */
export function computeRenderLayout(settings: RenderSettings, source: SourceVideoInfo): RenderLayout {
  const canvas = canvasSizeFor(settings.aspect, settings.maxResolution, source);
  const border = settings.border.thicknessPx;
  // Main video: fit inside the canvas, then apply zoom.
  const fitScale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const videoWidth = makeEven(source.width * fitScale * settings.zoom);
  const videoHeight = makeEven(source.height * fitScale * settings.zoom);
  const boxWidth = videoWidth + 2 * border;   // video + border = the "main video area"
  const boxHeight = videoHeight + 2 * border;
  const boxX = Math.round((canvas.width - boxWidth) / 2 + settings.offsetX * (canvas.width / 2));
  const boxY = Math.round((canvas.height - boxHeight) / 2 + settings.offsetY * (canvas.height / 2));
  return { canvas, videoWidth, videoHeight, border, box: { width: boxWidth, height: boxHeight, x: boxX, y: boxY }, logoWidth: settings.logo ? makeEven(canvas.width * settings.logo.widthFraction) : null };
}

export interface RenderPlan {
  canvas: { width: number; height: number };
  /** Size and top-left position of the main video INCLUDING its border, on the canvas. */
  mainVideo: { width: number; height: number; x: number; y: number };
  args: string[];
}

export function buildRenderArgs(args: {
  inputPath: string; outputPath: string; logoPath?: string; backgroundImagePath?: string; source: SourceVideoInfo; settings: RenderSettings;
}): RenderPlan {
  const { inputPath, outputPath, logoPath, backgroundImagePath, source, settings } = args;
  const problems = validateRenderSettings(settings, source);
  if (settings.logo && !logoPath) problems.push("A logo file is needed when a logo overlay is set.");
  if (settings.background.kind === "image" && !backgroundImagePath) problems.push("A background image is needed when an image background is set.");
  if (problems.length > 0) throw new InvalidRenderSettingsError(problems);

  const layout = computeRenderLayout(settings, source);
  const { canvas, border, videoWidth, videoHeight, box } = layout;
  const boxWidth = box.width, boxHeight = box.height, boxX = box.x, boxY = box.y;

  const trimStart = settings.trim?.startSeconds ?? 0;
  const trimEnd = settings.trim?.endSeconds ?? source.durationSeconds;
  const inputs: string[] = [...(trimStart > 0 ? ["-ss", trimStart.toFixed(3)] : []), "-i", inputPath];
  let nextInputIndex = 1;
  const filters: string[] = [];
  const mainChain = `scale=${videoWidth}:${videoHeight}` + (border > 0 ? `,pad=${boxWidth}:${boxHeight}:${border}:${border}:color=0x${settings.border.colorHex.slice(1)}` : "");

  if (settings.background.kind === "solid") {
    inputs.push("-f", "lavfi", "-i", `color=c=0x${settings.background.colorHex.slice(1)}:s=${canvas.width}x${canvas.height}:r=30`);
    filters.push(`[0:v]${mainChain}[fg]`, `[${nextInputIndex}:v][fg]overlay=${boxX}:${boxY}:shortest=1[composed]`);
    nextInputIndex++;
  } else if (settings.background.kind === "image") {
    inputs.push("-loop", "1", "-i", backgroundImagePath!);
    filters.push(
      `[${nextInputIndex}:v]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height}[bg]`,
      `[0:v]${mainChain}[fg]`,
      `[bg][fg]overlay=${boxX}:${boxY}[composed]`,
    );
    nextInputIndex++;
  } else {
    const strength = Math.round(settings.background.strength ?? 20);
    filters.push(
      "[0:v]split=2[bgsrc][fgsrc]",
      `[bgsrc]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},boxblur=${strength}:2[bg]`,
      `[fgsrc]${mainChain}[fg]`,
      `[bg][fg]overlay=${boxX}:${boxY}[composed]`,
    );
  }

  let lastLabel = "composed";
  if (settings.logo && logoPath) {
    const logo = settings.logo;
    const logoWidth = makeEven(canvas.width * logo.widthFraction);
    inputs.push("-loop", "1", "-i", logoPath);
    // The logo's height is unknown here, so its centre is positioned with FFmpeg expressions (w/h of the logo).
    const x = `${Math.round(canvas.width * logo.centerX)}-w/2`;
    const y = `${Math.round(canvas.height * logo.centerY)}-h/2`;
    filters.push(`[${nextInputIndex}:v]scale=${logoWidth}:-2,format=rgba,colorchannelmixer=aa=${logo.opacity.toFixed(2)}[logo]`, `[${lastLabel}][logo]overlay=${x}:${y}[withlogo]`);
    lastLabel = "withlogo";
  }
  filters.push(`[${lastLabel}]format=yuv420p[vout]`);

  const ffmpegArgs = [
    "-hide_banner", "-nostdin", "-y", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-t", (trimEnd - trimStart).toFixed(3),   // stops the endless colour / looped-logo inputs
    "-progress", "pipe:1", "-nostats",
    outputPath,
  ];
  return { canvas, mainVideo: { width: boxWidth, height: boxHeight, x: boxX, y: boxY }, args: ffmpegArgs };
}

/**
 * Read FFmpeg's `-progress` text and return how many seconds of output exist so far (or null).
 * We use the human-readable `out_time=HH:MM:SS.micro` line, which is the same across FFmpeg versions.
 */
export function parseProgressSeconds(progressText: string): number | null {
  const matches = [...progressText.matchAll(/^out_time=(\d+):(\d{2}):(\d{2})\.(\d+)/gm)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) + Number(`0.${last[4]}`);
}

/** Honest progress: only a real percentage when the duration is known; never above 99 until finished. */
export function progressPercent(secondsDone: number | null, totalSeconds: number): number | null {
  if (secondsDone === null || !(totalSeconds > 0)) return null;
  return Math.min(99, Math.max(0, Math.floor((secondsDone / totalSeconds) * 100)));
}

export interface ProbeResult { width: number; height: number; durationSeconds: number; hasAudio: boolean; videoCodec: string; }

/** Check a finished file before the job is marked complete. A "preview" is never a finished export. */
export function validateRenderOutput(probe: ProbeResult, expected: { width: number; height: number; durationSeconds: number }): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (probe.videoCodec !== "h264") problems.push(`Unexpected video codec "${probe.videoCodec}".`);
  if (probe.width !== expected.width || probe.height !== expected.height) problems.push(`Output is ${probe.width}x${probe.height}, expected ${expected.width}x${expected.height}.`);
  const tolerance = Math.max(0.5, expected.durationSeconds * 0.05);
  if (Math.abs(probe.durationSeconds - expected.durationSeconds) > tolerance) problems.push(`Output lasts ${probe.durationSeconds.toFixed(2)}s, expected about ${expected.durationSeconds.toFixed(2)}s.`);
  return { valid: problems.length === 0, problems };
}
